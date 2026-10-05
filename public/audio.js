(function initDublineAudio(global) {
  'use strict';

  const fx = global.DublineAudioFx;

  function createController(options) {
    const {
      video,
      backing,
      getSession,
      getVolumes,
      getSettings,
      isRenderInProgress,
      getRecordingLineId,
      getLatency = () => 0,
      originalTrack = null   // a separate <audio> with the chosen video audio track (if there are several)
    } = options;

    const duck = global.DublineProjectAudio?.DUCK || {attack:0.3,hold:0.15,release:0.85};
    const TAKE_LOOKAHEAD = duck.attack;
    const gainTargets = new WeakMap();
    let duckReleaseTimer = null;
    const rawTakeCache = new Map();
    const processedTakeCache = new Map();
    let playCtx = null;
    let takesBus = null;
    let videoSourceNode = null;
    let backingSourceNode = null;
    let videoGain = null;
    let backingGain = null;
    let duckingActive = false;
    const duckingTakes = new Set();
    const duckStartTimers = new Map();
    let playGeneration = 0;
    const startedTakes = new Set();
    const activeTakeSources = new Map();
    let previewAudio = null;
    let previewSource = null;

    function effectiveOriginalVolume() {
      const session = getSession();
      const volumes = getVolumes();
      return options.projectMix || !(session && !session.backingUrl) ? volumes.original : volumes.backing;
    }

    function ensurePlayCtx() {
      if (!playCtx) {
        playCtx = new (global.AudioContext || global.webkitAudioContext)();
        takesBus = playCtx.createGain();
        const limiter = playCtx.createDynamicsCompressor();
        limiter.threshold.value = -2;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.1;
        limiter.connect(playCtx.destination);
        takesBus.connect(limiter);
        videoSourceNode = playCtx.createMediaElementSource(video);
        backingSourceNode = playCtx.createMediaElementSource(backing);
        videoGain = playCtx.createGain();
        backingGain = playCtx.createGain();
        videoSourceNode.connect(videoGain).connect(limiter);
        backingSourceNode.connect(backingGain).connect(limiter);
        // The chosen video track goes to the same "Original" channel as the video's own sound
        if (originalTrack) {
          playCtx.createMediaElementSource(originalTrack).connect(videoGain);
          originalTrack.volume = 1;
        }
        video.volume = 1;
        backing.volume = 1;
        applyVolumes();
      }
      if (playCtx.state === 'suspended') playCtx.resume();
      return playCtx;
    }

    function rampGain(param, value, seconds, immediate) {
      if (!playCtx) return;
      if (!immediate && gainTargets.get(param) === value) return;
      gainTargets.set(param,value);
      const now = playCtx.currentTime;
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
      else {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
      }
      if (immediate) param.setValueAtTime(value, now);
      else if(global.DublineProjectAudio) global.DublineProjectAudio.smoothRamp(param,param.value,value,now,seconds);
      else param.linearRampToValueAtTime(value, now + seconds);
    }

    function setDucking(active, immediate = false) {
      const settings = getSettings();
      const volumes = getVolumes();
      duckingActive = !!active && settings.autoDuckEnabled && volumes.recorded > 0;
      if (!playCtx || !videoGain || !backingGain) return;
      const factor = duckingActive ? 1 - settings.autoDuckAmount : 1;
      const seconds = duckingActive ? duck.attack : duck.release;
      rampGain(videoGain.gain, volumes.isMuted ? 0 : effectiveOriginalVolume() * factor, seconds, immediate);
      rampGain(
        backingGain.gain,
        volumes.isMuted || isRenderInProgress() ? 0 : volumes.backing * factor,
        seconds,
        immediate
      );
    }

    function updateDuckingState() {
      clearTimeout(duckReleaseTimer); duckReleaseTimer=null;
      if(duckingTakes.size) setDucking(true);
      else duckReleaseTimer=setTimeout(()=>{duckReleaseTimer=null;setDucking(false);},duck.hold*1000);
    }

    function applyVolumes() {
      const volumes = getVolumes();
      if (videoGain && backingGain && playCtx) {
        setDucking(duckingTakes.size > 0 || !!duckReleaseTimer, volumes.isMuted || isRenderInProgress());
        takesBus.gain.setValueAtTime(volumes.isMuted ? 0 : volumes.recorded, playCtx.currentTime);
      } else {
        // Media elements accept only 0..1; louder levels need the Web Audio graph above
        video.volume = volumes.isMuted ? 0 : Math.min(1, effectiveOriginalVolume());
        if (originalTrack) originalTrack.volume = video.volume;
        backing.volume = volumes.isMuted || isRenderInProgress() ? 0 : Math.min(1, volumes.backing);
      }
    }

    // Where the take sits on the timeline according to the server (with the manual shift)
    function rawTakeStart(line) {
      return (line.audioStart !== null && line.audioStart !== undefined) ? line.audioStart : line.start;
    }

    // Where the take actually sounds: minus the microphone delay correction of whoever recorded it
    function takeStartTime(line) {
      return rawTakeStart(line) - (Number(getLatency(line.recordedBy)) || 0);
    }

    function takeDryBounds(line, duration = Infinity) {
      const trimOn = line.trimEnabled !== false && line.trimStart != null && line.trimEnd != null;
      const from = trimOn ? Math.max(0, line.trimStart) : 0;
      const to = trimOn ? Math.min(duration, line.trimEnd) : duration;
      return { from, to };
    }

    function takeBounds(line, duration = Infinity) {
      const dry = takeDryBounds(line, duration);
      const tail = fx.effectTailSeconds(line.effect || 'none');
      const trimOn = line.trimEnabled !== false && line.trimStart != null && line.trimEnd != null;
      return {
        from: dry.from,
        to: trimOn ? Math.min(duration, dry.to + tail) : duration
      };
    }

    function getRawTake(url) {
      if (!rawTakeCache.has(url)) {
        const job = Promise.resolve().then(() => fx.fetchAndDecode(url)).catch(() => null).then(buffer => {
          if (!buffer && rawTakeCache.get(url) === job) rawTakeCache.delete(url);
          return buffer;
        });
        rawTakeCache.set(url, job);
      }
      return rawTakeCache.get(url);
    }

    function getProcessedTake(line) {
      if (!line.audioUrl) return Promise.resolve(null);
      const key = `${line.audioUrl}|${line.effect || 'none'}|${line.pitch || 0}|${line.trimEnabled !== false}|${line.trimStart}|${line.trimEnd}`;
      if (!processedTakeCache.has(key)) {
        const job = getRawTake(line.audioUrl)
          .then(buffer => buffer && fx.renderVoice(
            buffer,
            line.effect || 'none',
            line.pitch || 0,
            takeDryBounds(line, buffer.duration)
          ))
          .catch(error => {
            console.error('[Dubline] Failed to process take:', error);
            return null;
          }).then(buffer => {
            if (!buffer && processedTakeCache.get(key) === job) processedTakeCache.delete(key);
            return buffer;
          });
        processedTakeCache.set(key, job);
      }
      return processedTakeCache.get(key);
    }

    function precacheTakes() {
      const session = getSession();
      if (!session || !session.lines) return;
      session.lines.forEach(line => { if (line.audioUrl) getProcessedTake(line); });
    }

    function scheduleTakes(current) {
      const session = getSession();
      if (!session || !session.lines) return;
      session.lines.forEach(line => {
        if (!line.audioUrl || startedTakes.has(line.id) || line.id === getRecordingLineId()) return;
        const start = takeStartTime(line);
        const { from, to } = takeBounds(line);
        const end = Number.isFinite(to) ? start + to : start + 60;
        if (current >= start + from - TAKE_LOOKAHEAD && current < end) startTake(line);
      });
    }

    async function startTake(line) {
      startedTakes.add(line.id);
      const generation = playGeneration;
      const buffer = await getProcessedTake(line);
      if (!buffer || generation !== playGeneration || video.paused) return;

      const ctx = ensurePlayCtx();
      const start = takeStartTime(line);
      const { from, to } = takeBounds(line, buffer.duration);
      const now = video.currentTime;
      const when = start + from;
      const offset = from + Math.max(0, now - when);
      if (offset >= to) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const fade = ctx.createGain();
      const at = ctx.currentTime + Math.max(0, when - now);
      fade.gain.setValueAtTime(0, at);
      fade.gain.linearRampToValueAtTime(1, at + 0.012);
      source.connect(fade);
      fade.connect(takesBus);
      source.start(at, offset, to - offset);

      stopTake(line.id);
      activeTakeSources.set(line.id, source);
      const delay = Math.max(0, (at - ctx.currentTime - duck.attack) * 1000);
      const timer = setTimeout(() => {
        duckStartTimers.delete(line.id);
        if (activeTakeSources.get(line.id) === source) {
          duckingTakes.add(line.id);
          updateDuckingState();
        }
      }, delay);
      duckStartTimers.set(line.id, timer);
      source.onended = () => {
        if (activeTakeSources.get(line.id) !== source) return;
        activeTakeSources.delete(line.id);
        duckingTakes.delete(line.id);
        updateDuckingState();
      };
    }

    function stopTake(lineId) {
      const timer = duckStartTimers.get(lineId);
      if (timer) clearTimeout(timer);
      duckStartTimers.delete(lineId);
      const source = activeTakeSources.get(lineId);
      if (source) {
        activeTakeSources.delete(lineId);
        try { source.stop(); } catch (error) {}
      }
      duckingTakes.delete(lineId);
      updateDuckingState();
    }

    function stopAllTakes() {
      playGeneration++;
      startedTakes.clear();
      [...activeTakeSources.keys()].forEach(stopTake);
      duckStartTimers.forEach(clearTimeout);
      duckStartTimers.clear();
      duckingTakes.clear();
      clearTimeout(duckReleaseTimer); duckReleaseTimer=null;
      setDucking(false);
    }

    function resetLine(lineId) {
      stopTake(lineId);
      startedTakes.delete(lineId);
    }

    function stopPreview() {
      if (previewAudio) {
        previewAudio.pause();
        previewAudio = null;
      }
      if (previewSource) {
        try { previewSource.stop(); } catch (error) {}
        previewSource = null;
      }
    }

    function playAudio(url) {
      stopPreview();
      previewAudio = new Audio(url);
      const volumes = getVolumes();
      previewAudio.volume = volumes.isMuted ? 0 : Math.min(1, volumes.recorded);
      return previewAudio.play();
    }

    async function previewTake(line) {
      stopPreview();
      if (!line) return false;
      const ctx = ensurePlayCtx();
      const buffer = await getProcessedTake(line);
      if (!buffer) return false;
      const { from, to } = takeBounds(line, buffer.duration);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(takesBus);
      source.start(0, from, Math.max(0.05, to - from));
      previewSource = source;
      return true;
    }

    return Object.freeze({
      applyVolumes,
      ensurePlayCtx,
      getProcessedTake,
      getRawTake,
      playAudio,
      precacheTakes,
      previewTake,
      rawTakeStart,
      resetLine,
      scheduleTakes,
      setDucking,
      stopAllTakes,
      stopPreview,
      takeBounds,
      takeDryBounds,
      takeStartTime
    });
  }

  global.DublineAudio = Object.freeze({ createController });
})(window);
