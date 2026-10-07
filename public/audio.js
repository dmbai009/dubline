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
    const playbackRate = () => [1, 1.25, 1.5, 2, 3, 4].includes(video?.playbackRate) ? video.playbackRate : 1;
    const gainTargets = new WeakMap();
    let duckReleaseTimer = null;
    const pinnedUrls = new Set();
    const pinned = key => [...pinnedUrls, previewPendingLine?.audioUrl, previewGraph?.audioUrl].filter(Boolean).some(url => key === url || key.includes('|' + url + '|') || key.startsWith(url + '|'));
    const rawTakeCache = global.DublineAudioMemory ? new global.DublineAudioMemory.ByteCache(128 * 1024 ** 2, pinned) : new Map();
    const processedTakeCache = global.DublineAudioMemory ? new global.DublineAudioMemory.ByteCache(256 * 1024 ** 2, pinned) : new Map();
    let takeIndex = null, indexedLines = null, indexedSession = null, prefetchAt = -Infinity;
    const prefetching = new Set();
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
    const activeTakeGraphs = new Map();
    const lineGenerations = new Map();
    let previewGeneration = 0, previewGraph = null, previewPendingLine = null;
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
      const seconds = (duckingActive ? duck.attack : duck.release) / playbackRate();
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
      else duckReleaseTimer=setTimeout(()=>{duckReleaseTimer=null;setDucking(false);},duck.hold*1000/playbackRate());
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
      const tail = fx.effectTailSeconds(line.effect || 'none', global.DublineTakeMix.normalize(line).effectAmount);
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
          if (buffer) takeIndex = null; // Decoded duration replaces a conservative unknown-length bound.
          return buffer;
        });
        rawTakeCache.set(url, job);
      }
      return rawTakeCache.get(url);
    }

    function getProcessedTake(line) {
      if (!line.audioUrl) return Promise.resolve(null);
      line = { ...line };
      const key = `${line.audioUrl}|${line.effect || 'none'}|${line.pitch || 0}|${global.DublineTakeMix.normalize(line).effectAmount}|${line.trimEnabled !== false}|${line.trimStart}|${line.trimEnd}`;
      if (!processedTakeCache.has(key)) {
        const job = getRawTake(line.audioUrl)
          .then(buffer => buffer && fx.renderVoice(
            buffer,
            line.effect || 'none',
            line.pitch || 0,
            takeDryBounds(line, buffer.duration),
            global.DublineTakeMix.normalize(line).effectAmount
          ))
          .catch(error => {
            if (error.message !== 'Stale CPU job') console.error('[Dubline] Failed to process take:', error);
            return null;
          }).then(buffer => {
            if (!buffer && processedTakeCache.get(key) === job) processedTakeCache.delete(key);
            return buffer;
          });
        processedTakeCache.set(key, job);
      }
      return processedTakeCache.get(key);
    }

    function indexedTakes() {
      const session = getSession();
      if (!session?.lines) return null;
      if (indexedLines !== session.lines || indexedSession !== session || !takeIndex) {
        indexedLines = session.lines; indexedSession = session;
        takeIndex = global.DublineAudioMemory ? new global.DublineAudioMemory.IntervalIndex(session.lines.filter(line => line.audioUrl).map(line => {
          const start = takeStartTime(line), duration = rawTakeCache.duration?.(line.audioUrl) || Infinity, bounds = takeBounds(line, duration);
          return { start: start + bounds.from, end: Number.isFinite(bounds.to) ? start + bounds.to : start + Math.max(60, Number(line.end - line.start) || 0), value: line };
        })) : null;
      }
      return takeIndex;
    }
    function precacheTakes() {
      const session = getSession();
      if (!session || !session.lines) return;
      const current = video?.currentTime || 0;
      const index = indexedTakes(), nearby = index ? index.query(current - 5, current + 30) : session.lines.filter(line => line.audioUrl && line.end >= current - 5 && line.start <= current + 30);
      pinnedUrls.clear(); nearby.forEach(line => pinnedUrls.add(line.audioUrl));
      for (const id of activeTakeSources.keys()) { const line = session.lines.find(item => item.id === id); if (line?.audioUrl) pinnedUrls.add(line.audioUrl); }
      if (previewPendingLine?.audioUrl) pinnedUrls.add(previewPendingLine.audioUrl);
      rawTakeCache.trim?.(); processedTakeCache.trim?.();
      for (const line of nearby) {
        if (prefetching.size >= 4) break;
        const baseKey = `${line.audioUrl}|${line.effect || 'none'}|${line.pitch || 0}|${global.DublineTakeMix.normalize(line).effectAmount}|${line.trimEnabled !== false}|${line.trimStart}|${line.trimEnd}`;
        const key = playbackRate() === 1 ? baseKey : `rate:${playbackRate()}|${baseKey}`;
        if (processedTakeCache.has(key)) continue;
        if (prefetching.has(key)) continue;
        prefetching.add(key); getPlaybackTake(line).finally(() => prefetching.delete(key));
      }
    }

    function getPlaybackTake(line, rate = playbackRate()) {
      if (rate === 1) return getProcessedTake(line);
      const key = `rate:${rate}|${line.audioUrl}|${line.effect || 'none'}|${line.pitch || 0}|${global.DublineTakeMix.normalize(line).effectAmount}|${line.trimEnabled !== false}|${line.trimStart}|${line.trimEnd}`;
      if (!processedTakeCache.has(key)) {
        const scope = getSession()?.activeSessionId;
        const job = getProcessedTake(line).then(buffer => buffer && fx.stretchPreview(buffer, rate, scope)).catch(error => {
          console.error('[DubLine] Preview rate processing failed:', error); return null;
        }).then(buffer => { if (!buffer && processedTakeCache.get(key) === job) processedTakeCache.delete(key); return buffer; });
        processedTakeCache.set(key, job);
      }
      return processedTakeCache.get(key);
    }

    function scheduleTakes(current) {
      const session = getSession();
      if (!session || !session.lines) return;
      if (Math.abs(current - prefetchAt) >= 1) { prefetchAt = current; precacheTakes(); }
      const index = indexedTakes();
      (index ? index.query(current, current + TAKE_LOOKAHEAD * playbackRate()) : session.lines).forEach(line => {
        if (!line.audioUrl || startedTakes.has(line.id) || line.id === getRecordingLineId()) return;
        const start = takeStartTime(line);
        const { from, to } = takeBounds(line);
        const end = Number.isFinite(to) ? start + to : start + (rawTakeCache.duration?.(line.audioUrl) || Math.max(60, Number(line.end - line.start) || 0));
        if (current >= start + from - TAKE_LOOKAHEAD * playbackRate() && current < end) startTake(line);
      });
    }

    async function startTake(line) {
      startedTakes.add(line.id);
      const generation = playGeneration, lineGeneration = lineGenerations.get(line.id);
      const rate = playbackRate();
      line = { ...line };
      const normal = await getProcessedTake(line);
      const buffer = normal && await getPlaybackTake(line, rate);
      if (!buffer || generation !== playGeneration || lineGeneration !== lineGenerations.get(line.id) || video.paused || playbackRate() !== rate) return;

      const ctx = ensurePlayCtx();
      const start = takeStartTime(line);
      const { from, to } = takeBounds(line, normal.duration);
      const now = video.currentTime;
      const when = start + from;
      const offset = from + Math.max(0, now - when);
      if (offset >= to) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const fade = ctx.createGain();
      const at = ctx.currentTime + Math.max(0, when - now) / rate;
      fade.gain.setValueAtTime(0, at);
      fade.gain.linearRampToValueAtTime(1, at + 0.012);
      const graph = fx.connectTake(ctx, source, fade, line);
      graph.volume = global.DublineTakeMix.normalize(line).volume;
      graph.fade = fade;
      fade.connect(takesBus);
      source.start(at, offset / rate, (to - offset) / rate);

      stopTake(line.id);
      activeTakeSources.set(line.id, source);
      activeTakeGraphs.set(line.id, graph);
      const delay = Math.max(0, (at - ctx.currentTime - duck.attack / rate) * 1000);
      const timer = setTimeout(() => {
        duckStartTimers.delete(line.id);
        if (activeTakeSources.get(line.id) === source && graph.volume > 0) {
          duckingTakes.add(line.id);
          updateDuckingState();
        }
      }, delay);
      duckStartTimers.set(line.id, timer);
      source.onended = () => {
        if (activeTakeSources.get(line.id) !== source) return;
        activeTakeSources.delete(line.id);
        activeTakeGraphs.delete(line.id);
        source.disconnect(); graph.gain.disconnect(); graph.panner.disconnect(); fade.disconnect();
        duckingTakes.delete(line.id);
        updateDuckingState();
      };
    }

    function stopTake(lineId) {
      lineGenerations.set(lineId, (lineGenerations.get(lineId) || 0) + 1);
      const timer = duckStartTimers.get(lineId);
      if (timer) clearTimeout(timer);
      duckStartTimers.delete(lineId);
      const source = activeTakeSources.get(lineId);
      if (source) {
        activeTakeSources.delete(lineId);
        try { source.stop(); } catch (error) {}
        source.disconnect();
        const graph = activeTakeGraphs.get(lineId);
        if (graph) { graph.gain.disconnect(); graph.panner.disconnect(); graph.fade.disconnect(); }
        activeTakeGraphs.delete(lineId);
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
      previewGeneration++;
      previewPendingLine = null;
      if (previewGraph) { previewGraph.gain.disconnect(); previewGraph.panner.disconnect(); previewGraph = null; }
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
      const generation = previewGeneration;
      line = { ...line };
      previewPendingLine = line;
      const rate = playbackRate();
      const ctx = ensurePlayCtx();
      const normal = await getProcessedTake(line);
      const buffer = normal && await getPlaybackTake(line, rate);
      if (!buffer || generation !== previewGeneration) return false;
      const { from, to } = takeBounds(line, normal.duration);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      previewGraph = fx.connectTake(ctx, source, takesBus, line);
      previewGraph.lineId = line.id; previewGraph.audioUrl = line.audioUrl;
      previewPendingLine = null;
      source.start(0, from / rate, Math.max(0.05, to - from) / rate);
      previewSource = source;
      return true;
    }

    function updateLine(before, after) {
      takeIndex = null;
      global.invalidatePrompterIndex?.();
      const processing = ['audioUrl', 'audioStart', 'start', 'recordedBy', 'blindRevealed', 'effect', 'pitch', 'effectAmount', 'trimEnabled', 'trimStart', 'trimEnd'];
      const defaults = { effect: 'none', pitch: 0, effectAmount: 1, trimEnabled: true };
      const changed = processing.some(key => (before[key] ?? defaults[key]) !== (after[key] ?? defaults[key]));
      if (changed) {
        resetLine(after.id);
        if (previewGraph?.lineId === after.id || previewPendingLine?.id === after.id) stopPreview();
        return;
      }
      const mix = global.DublineTakeMix.normalize(after);
      function update(graph) {
        if (!graph) return;
        rampGain(graph.gain.gain, mix.volume * graph.scale, 0.02, false);
        rampGain(graph.panner.pan, mix.pan, 0.02, false);
        graph.volume = mix.volume;
      }
      const graph = activeTakeGraphs.get(after.id);
      update(graph);
      if (!graph && startedTakes.has(after.id)) resetLine(after.id);
      if (previewPendingLine?.id === after.id) Object.assign(previewPendingLine, mix);
      if (previewGraph?.lineId === after.id) update(previewGraph);
      if (graph && !duckStartTimers.has(after.id)) {
        if (mix.volume > 0) duckingTakes.add(after.id);
        else duckingTakes.delete(after.id);
        updateDuckingState();
      }
    }

    return Object.freeze({
      cacheStats: () => ({ raw: rawTakeCache.stats?.(), processed: processedTakeCache.stats?.(), prefetching: prefetching.size, indexVisited: takeIndex?.visited || 0 }),
      updateLine,
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
