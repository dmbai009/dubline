(function initDublineAudio(global) {
  'use strict';

  const fx = global.DublineAudioFx;

  function createController(options) {
    let voiceWarningAt = 0;
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
    const rawRequests = new Map();
    const processedRequests = new Map();
    const noiseFailedJobs = new WeakSet();
    const cancelled = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const processedTakeCache = global.DublineAudioMemory ? new global.DublineAudioMemory.ByteCache(256 * 1024 ** 2, pinned) : new Map();
    // Wet and final variants share the existing 256 MiB processed-audio budget.
    const noiseStats = { wetHits: 0, wetMisses: 0, mixMs: 0 };
    const sourceJobs = new Map();
    function retainSource(url) {
      let token = sourceJobs.get(url);
      if (!token) { token = { cancelled: false, users: 0 }; sourceJobs.set(url, token); }
      token.users++; return token;
    }
    function releaseSource(url, token) { if (--token.users === 0 && sourceJobs.get(url) === token) sourceJobs.delete(url); }
    function waitFor(job, signal) {
      if (!signal) return job;
      if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    }
    function wetKey(url, buffer) { return `wet|${url}|${global.DublineNoiseModel.PROCESSING_VERSION}|${buffer.sampleRate}|${buffer.numberOfChannels}|${buffer.length}`; }
    function getWet(url, buffer, request = {}) {
      const key = wetKey(url, buffer);
      if (!processedTakeCache.has(key)) {
        noiseStats.wetMisses++;
        const job = global.DublineNoiseAudio.wet(buffer, { key, priority: request.priority || (request.scene ? 'export' : 'playback') })
          .catch(error => { if (processedTakeCache.get(key) === job) processedTakeCache.delete(key); throw error; });
        processedTakeCache.set(key, job);
      } else { noiseStats.wetHits++; global.DublineNoiseAudio.promote?.(key, request.priority || 'playback'); }
      // A slider change cancels only its consumer, not useful shared neural work.
      return waitFor(processedTakeCache.get(key), request.signal);
    }
    function invalidateSource(url) {
      if (!url) return; const token = sourceJobs.get(url); if (token) token.cancelled = true; sourceJobs.delete(url); rawTakeCache.delete(url);
      for (const key of processedTakeCache.keys()) if (key.startsWith(url + '|') || key.includes('|' + url + '|')) processedTakeCache.delete(key);
    }
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
    let previewStarted = 0, previewOffset = 0, previewRate = 1;
    let previewGeneration = 0, previewGraph = null, previewPendingLine = null, previewEnded = null;
    let previewAudio = null;
    let referencePreview = false, referenceCleanup = null;
    let previewSource = null;

    function effectiveOriginalVolume() {
      const session = getSession();
      const volumes = getVolumes();
      return options.projectMix || !(session && !session.backingUrl) ? volumes.original : volumes.backing;
    }

    function ensurePlayCtx() {
      if (!playCtx) {
        playCtx = new (global.AudioContext || global.webkitAudioContext)();
        global.DublineAudioDevices?.registerContext(playCtx);
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
      if (playCtx.state === 'suspended') {
        if (global.DublineAudioDevices) global.DublineAudioDevices.resume(playCtx).catch(() => {});
        else playCtx.resume();
      }
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
      updateLevels();
      const volumes = getVolumes();
      if (previewAudio) previewAudio.volume = referencePreview ? referenceVolume() : volumes.isMuted ? 0 : Math.min(1, volumes.recorded);
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
      const tail = global.DublineVoiceChain ? global.DublineVoiceChain.resolve(line, getSession()).tail : fx.effectTailSeconds(line.effect || 'none', global.DublineTakeMix.normalize(line).effectAmount);
      const trimOn = line.trimEnabled !== false && line.trimStart != null && line.trimEnd != null;
      return {
        from: dry.from,
        to: trimOn ? Math.min(duration, dry.to + tail) : duration
      };
    }

    function getRawTake(url, { signal } = {}) {
      // Cancelling export must not abort a fetch also needed by local playback.
      if (!signal && rawRequests.has(url)) rawRequests.get(url).shared = true;
      if (!rawTakeCache.has(url)) {
        const request = signal ? { controller: new AbortController(), shared: false } : null;
        const abort = () => { if (!request.shared) request.controller.abort(); };
        if (request) { rawRequests.set(url, request); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
        const job = Promise.resolve().then(() => fx.fetchAndDecode(url, request ? { signal: request.controller.signal } : undefined)).catch(() => null).then(buffer => {
          if (!buffer && rawTakeCache.get(url) === job) rawTakeCache.delete(url);
          if (buffer) takeIndex = null; // Decoded duration replaces a conservative unknown-length bound.
          return buffer;
        }).finally(() => { if (request) { signal.removeEventListener('abort', abort); if (rawRequests.get(url) === request) rawRequests.delete(url); } });
        rawTakeCache.set(url, job);
      }
      return rawTakeCache.get(url);
    }

    function processingKey(line, request = {}) {
      const noise = Object.hasOwn(line, '_exportNoise') ? line._exportNoise : global.DublineNoiseModel?.resolve(line, request.scene || getSession());
      const voice = global.DublineVoiceChain?.resolve(line, request.scene || getSession());
      return `${line.audioUrl}|${voice ? global.DublineVoiceChain.key(voice) : `${line.effect || 'none'}|${line.pitch || 0}|${global.DublineTakeMix.normalize(line).effectAmount}`}|${line.trimEnabled !== false}|${line.trimStart}|${line.trimEnd}|${global.DublineNoiseModel?.settingKey(noise) || 'off'}`;
    }
    function getVoiceTake(line, request = {}) {
      if (!line.audioUrl) return Promise.resolve(null);
      if (!request.signal && rawRequests.has(line.audioUrl)) rawRequests.get(line.audioUrl).shared = true;
      line = { ...line };
      const key = processingKey(line, request);
      if (!request.signal && processedRequests.has(key)) processedRequests.get(key).shared = true;
      const resolvedNoise = Object.hasOwn(line, '_exportNoise') ? line._exportNoise : global.DublineNoiseModel?.resolve(line, request.scene || getSession());
      const noiseSetting = resolvedNoise?.enabled && resolvedNoise.strength > 0 ? resolvedNoise : null;
      const voiceSetting = global.DublineVoiceChain?.resolve(line, request.scene || getSession());
      const scope = getSession()?.activeSessionId;
      if (request.uncached || !processedTakeCache.has(key)) {
        const source = retainSource(line.audioUrl);
        const work = !request.uncached && request.signal ? { shared: false, controller: new AbortController() } : null;
        const abort = () => { if (!work.shared) work.controller.abort(); };
        if (work) { processedRequests.set(key, work); if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true }); }
        const pipelineRequest = work ? { ...request, signal: work.controller.signal } : request;
        let noiseFallback = false;
        const job = getRawTake(line.audioUrl, request)
          .then(async buffer => {
            if (pipelineRequest.signal?.aborted || !request.scene && (scope !== getSession()?.activeSessionId || source.cancelled)) throw cancelled();
            if (!buffer || !noiseSetting) return buffer;
            try {
              if (!global.DublineNoiseAudio) throw Error('noise.unavailable');
              const wet = await getWet(line.audioUrl, buffer, pipelineRequest), tick = performance.now();
              const mixed = global.DublineNoiseAudio.mix(buffer, wet, noiseSetting.strength);
              noiseStats.mixMs += performance.now() - tick; return mixed;
            } catch (error) {
              if (error.name === 'AbortError') throw error;
              noiseFallback = true; if (!request.strict) global.DublineNoiseAudio?.fallback(error); return buffer;
            }
          })
          .then(buffer => buffer && (voiceSetting && fx.renderChain ? fx.renderChain(buffer, voiceSetting, takeDryBounds(line, buffer.duration), pipelineRequest.signal) : fx.renderVoice(
            buffer,
            line.effect || 'none',
            line.pitch || 0,
            takeDryBounds(line, buffer.duration),
            global.DublineTakeMix.normalize(line).effectAmount
          )))
          .catch(error => {
            if (error.message !== 'Stale CPU job' && error.name !== 'AbortError') console.error('[Dubline] Failed to process take:', error);
            if (error.message.startsWith('fx.') && Date.now() - voiceWarningAt > 5000) { voiceWarningAt = Date.now(); global.showToast?.(global.DublineI18n?.t(error.message) || error.message); }
            return null;
          }).then(buffer => {
            if (!request.scene && (scope !== getSession()?.activeSessionId || source.cancelled)) buffer = null;
            if (noiseFallback) noiseFailedJobs.add(job);
            if ((!buffer || noiseFallback) && processedTakeCache.get(key) === job) processedTakeCache.delete(key);
            return buffer;
          }).finally(() => {
            releaseSource(line.audioUrl, source);
            if (work) { request.signal.removeEventListener('abort', abort); if (processedRequests.get(key) === work) processedRequests.delete(key); }
          });
        if (request.uncached) return request.strict ? job.then(buffer => noiseFailedJobs.has(job) ? null : buffer) : job;
        processedTakeCache.set(key, job);
      }
      const result = processedTakeCache.get(key);
      return request.strict ? result.then(buffer => noiseFailedJobs.has(result) ? null : buffer) : result;
    }

    const levelsEnabled = (line, scene = getSession()) => Object.hasOwn(line, '_exportLevel') ? line._exportLevel : (global.DublineProjectAudio ? global.DublineProjectAudio.normalize(scene || {}).normalizeVoices : scene?.projectAudio?.normalizeVoices === true);
    function getLevelGain(buffer, line, scene = getSession()) { return levelsEnabled(line, scene) && buffer ? global.DublineSpeechAnalysis.factor(buffer, takeBounds(line, buffer.duration)) : 1; }
    async function prepareTake(line, request = {}) {
      const buffer = await getVoiceTake(line, request); let gain = 1;
      if (buffer && levelsEnabled(line, request.scene || getSession())) { try { gain = global.DublineSpeechModel.gain(await global.DublineSpeechAnalysis.measure(buffer, takeBounds(line, buffer.duration), 'level', request.signal)); } catch (error) { if (request.strict || request.uncached || error.name === 'AbortError') throw error; global.showToast?.(global.DublineI18n.t('level.unavailable')); global.DublineSceneReview?.processingError(line, true); return { buffer: null, gain: 1 }; } }
      if (buffer) global.DublineSceneReview?.processingError(line, false);
      return { buffer, gain };
    }
    async function getProcessedTake(line, request = {}) { return (await prepareTake(line, request)).buffer; }
    function updateLevels() {
      const graphs = [...activeTakeGraphs.values(), previewGraph].filter(Boolean);
      for (const graph of graphs) {
        const line = graph.line, enabled = levelsEnabled(line); if (graph.levelEnabled === enabled || graph.levelPending === enabled) continue; graph.levelPending = enabled;
        const captured = graph; Promise.resolve(enabled ? global.DublineSpeechAnalysis.measure(graph.baseBuffer, takeBounds(line, graph.baseBuffer.duration)) : null).then(measurement => {
          const latest = captured.line; if (captured !== previewGraph && captured !== activeTakeGraphs.get(line.id) || levelsEnabled(latest) !== enabled) return;
          const gain = enabled ? global.DublineSpeechModel.gain(measurement) : 1; graph.scale = (graph.baseBuffer.numberOfChannels === 1 ? Math.SQRT2 : 1) * gain; graph.levelEnabled = enabled; rampGain(graph.gain.gain, global.DublineTakeMix.normalize(latest).volume * graph.scale, .03, false);
        }).catch(() => global.showToast?.(global.DublineI18n.t('level.unavailable'))).finally(() => { delete captured.levelPending; });
      }
    }
    function indexedTakes() {
      const session = getSession();
      if (!session?.lines) return null;
      if (indexedLines !== session.lines || indexedSession !== session || !takeIndex) {
        indexedLines = session.lines; indexedSession = session;
        takeIndex = global.DublineAudioMemory ? new global.DublineAudioMemory.IntervalIndex(session.lines.filter(line => line.audioUrl).map(line => {
          const start = takeStartTime(line), rawDuration = rawTakeCache.duration?.(line.audioUrl) || Infinity;
          const tail = global.DublineVoiceChain?.resolve(line, session).tail || fx.effectTailSeconds(line.effect || 'none', global.DublineTakeMix.normalize(line).effectAmount);
          const bounds = takeBounds(line, rawDuration + tail);
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
        const baseKey = processingKey(line);
        const key = playbackRate() === 1 ? baseKey : `rate:${playbackRate()}|${baseKey}`;
        if (processedTakeCache.has(key)) continue;
        if (prefetching.has(key)) continue;
        prefetching.add(key); getPlaybackTake(line, playbackRate(), { priority: 'prefetch' }).finally(() => prefetching.delete(key));
      }
    }

    function getPlaybackTake(line, rate = playbackRate(), request = {}) {
      if (rate === 1) return getProcessedTake(line, request);
      const key = `rate:${rate}|${processingKey(line)}`;
      if (!processedTakeCache.has(key)) {
        const scope = getSession()?.activeSessionId;
        const job = getProcessedTake(line, request).then(buffer => buffer && fx.stretchPreview(buffer, rate, scope)).catch(error => {
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
      const { buffer: normal, gain: levelGain } = await prepareTake(line);
      const buffer = normal && (rate === 1 ? normal : await getPlaybackTake(line, rate));
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
      const graph = fx.connectTake(ctx, source, fade, { ...line, _levelGain: levelGain });
      graph.line = line; graph.baseBuffer = normal; graph.levelEnabled = levelsEnabled(line);
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

    function stopTake(lineId, smooth = false) {
      lineGenerations.set(lineId, (lineGenerations.get(lineId) || 0) + 1);
      const timer = duckStartTimers.get(lineId);
      if (timer) clearTimeout(timer);
      duckStartTimers.delete(lineId);
      const source = activeTakeSources.get(lineId);
      if (source) {
        activeTakeSources.delete(lineId);
        const graph = activeTakeGraphs.get(lineId);
        const release = () => { source.disconnect(); if (graph) { graph.gain.disconnect(); graph.panner.disconnect(); graph.fade.disconnect(); } };
        if (smooth && graph && playCtx) { source.onended = release; rampGain(graph.fade.gain, 0, .03, false); try { source.stop(playCtx.currentTime + .035); } catch { release(); } }
        else { try { source.stop(); } catch {} release(); }
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

    function resetLine(lineId, smooth = false) {
      stopTake(lineId, smooth);
      startedTakes.delete(lineId);
    }

    function stopPreview(smooth = false) {
      previewGeneration++; const ended = previewEnded; previewEnded = null; previewPendingLine = null;
      referenceCleanup?.(); referenceCleanup = null; referencePreview = false;
      const graph = previewGraph, source = previewSource; previewGraph = null; previewSource = null;
      const release = () => { source?.disconnect(); if (graph) { graph.gain.disconnect(); graph.panner.disconnect(); } };
      if (source) { source.onended = null; if (smooth && graph && playCtx) { rampGain(graph.gain.gain, 0, .03, false); source.onended = release; try { source.stop(playCtx.currentTime + .035); } catch { release(); } } else { try { source.stop(); } catch {} release(); } } else release();
      if (previewAudio) { previewAudio.pause(); global.DublineAudioDevices?.unregisterElement(previewAudio); previewAudio = null; }
      ended?.();
    }

    function referenceVolume() { return getVolumes().isMuted ? 0 : Math.max(0, Math.min(1, global.localMasterVolume?.() ?? 1)); }
    async function previewReference(reference, options = {}) {
      stopPreview();
      if (!reference?.url) return false;
      const generation = previewGeneration, current = new Audio();
      previewAudio = current; referencePreview = true; previewEnded = options.onEnded || null;
      global.DublineAudioDevices?.registerElement(current);
      current.preload = 'metadata'; current.volume = referenceVolume(); current.playbackRate = 1;
      let interval, deadline, rejectWait, until = Infinity;
      const checkEnd = () => { if (Number.isFinite(until) && current.currentTime >= until) stopPreview(); };
      const failed = () => { if (previewAudio === current) { options.onError?.(); rejectWait?.(new Error('reference.failed')); stopPreview(); } };
      const ended = () => { if (previewAudio === current) stopPreview(); };
      current.addEventListener('error', failed); current.addEventListener('ended', ended); current.addEventListener('timeupdate', checkEnd);
      referenceCleanup = () => {
        clearInterval(interval); clearTimeout(deadline); rejectWait?.(cancelled()); rejectWait = null;
        current.removeEventListener('error', failed); current.removeEventListener('ended', ended); current.removeEventListener('timeupdate', checkEnd);
        current.pause(); current.removeAttribute('src'); current.load();
      };
      try {
        const metadata = new Promise((resolve, reject) => {
          const ready = () => { rejectWait = null; clearTimeout(deadline); current.removeEventListener('loadedmetadata', ready); resolve(); };
          rejectWait = error => { current.removeEventListener('loadedmetadata', ready); reject(error); };
          deadline = setTimeout(failed, 15000); current.addEventListener('loadedmetadata', ready, { once: true });
        });
        current.src = reference.url;
        await metadata; await global.DublineAudioDevices?.ready();
        if (generation !== previewGeneration) return false;
        const from = Math.max(0, reference.from || 0);
        until = Math.min(Number.isFinite(current.duration) ? current.duration : Infinity, reference.to ?? Infinity);
        if (from >= until) { options.onError?.(); stopPreview(); return false; }
        current.currentTime = from;
        await current.play();
        if (generation !== previewGeneration) { current.pause(); return false; }
        interval = setInterval(checkEnd, 20);
        return true;
      } catch (error) {
        if (generation !== previewGeneration || error.name === 'AbortError') return false;
        options.onError?.(); stopPreview(); throw error;
      }
    }

    function playAudio(url) {
      stopPreview();
      previewAudio = new Audio(url);
      global.DublineAudioDevices?.registerElement(previewAudio);
      const volumes = getVolumes();
      previewAudio.volume = volumes.isMuted ? 0 : Math.min(1, volumes.recorded);
      const current = previewAudio;
      return Promise.resolve(global.DublineAudioDevices?.ready())
        .then(() => { if (previewAudio === current) return current.play(); })
        .catch(error => { if (previewAudio === current) throw error; });
    }

    async function previewTake(line, options = {}) {
      stopPreview();
      if (!line) return false;
      const generation = previewGeneration;
      line = { ...line };
      line.historicalPreview = options.historical === true;
      previewEnded = options.onEnded || null;
      previewPendingLine = line;
      const rate = playbackRate();
      const ctx = ensurePlayCtx();
      const { buffer: normal, gain: levelGain } = await prepareTake(line);
      const buffer = normal && (rate === 1 ? normal : await getPlaybackTake(line, rate));
      if (generation !== previewGeneration) return false;
      if (!buffer) { stopPreview(); return false; }
      const { from, to } = takeBounds(line, normal.duration);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      previewGraph = fx.connectTake(ctx, source, takesBus, { ...line, _levelGain: levelGain });
      previewGraph.line = line; previewGraph.baseBuffer = normal; previewGraph.levelEnabled = levelsEnabled(line);
      previewGraph.lineId = line.id; previewGraph.audioUrl = line.audioUrl;
      previewGraph.historicalPreview = line.historicalPreview;
      previewPendingLine = null;
      const offset = Math.max(0, Number(options.position) || 0), at = from + offset < to - .05 ? from + offset : from; previewOffset = at - from; previewStarted = ctx.currentTime; previewRate = rate;
      source.start(0, at / rate, Math.max(0.05, to - at) / rate);
      previewSource = source;
      source.onended = () => { if (previewSource === source) stopPreview(); };
      return true;
    }

    function updateLine(before, after) {
      const retained = new Set([after.audioUrl, ...(after.takeHistory || []).map(take => take.audioUrl),
        ...(getSession()?.lines || []).flatMap(line => [line.audioUrl, ...(line.takeHistory || []).map(take => take.audioUrl)])]);
      for (const url of [before.audioUrl, ...(before.takeHistory || []).map(take => take.audioUrl)]) if (url && !retained.has(url)) invalidateSource(url);
      takeIndex = null;
      global.invalidatePrompterIndex?.();
      const processing = ['audioUrl', 'audioStart', 'start', 'character', 'recordedBy', 'blindRevealed', 'effect', 'pitch', 'effectAmount', 'trimEnabled', 'trimStart', 'trimEnd', 'effects', 'pitchMode', 'inheritRoleEffects', 'excludedRoleEffectIds', 'voicePresetId', 'usePresetPitch', 'presetModified'];
      const defaults = { effect: 'none', pitch: 0, effectAmount: 1, trimEnabled: true };
      const changed = processing.some(key => JSON.stringify(before[key] ?? defaults[key]) !== JSON.stringify(after[key] ?? defaults[key]));
      if (changed) {
        resetLine(after.id);
        if (previewGraph?.lineId === after.id && !previewGraph.historicalPreview || previewPendingLine?.id === after.id && !previewPendingLine.historicalPreview) stopPreview();
        return;
      }
      const mix = global.DublineTakeMix.normalize(after);
      function update(graph) {
        if (!graph) return;
        rampGain(graph.gain.gain, mix.volume * graph.scale, 0.02, false);
        rampGain(graph.panner.pan, mix.pan, 0.02, false);
        graph.volume = mix.volume; graph.line = Object.hasOwn(graph.line, '_exportLevel') ? { ...after, _exportLevel: graph.line._exportLevel } : after;
      }
      const graph = activeTakeGraphs.get(after.id);
      update(graph);
      if (!graph && startedTakes.has(after.id)) resetLine(after.id);
      if (previewPendingLine?.id === after.id && !previewPendingLine.historicalPreview) Object.assign(previewPendingLine, mix);
      if (previewGraph?.lineId === after.id && !previewGraph.historicalPreview) update(previewGraph);
      if (graph && !duckStartTimers.has(after.id)) {
        if (mix.volume > 0) duckingTakes.add(after.id);
        else duckingTakes.delete(after.id);
        updateDuckingState();
      }
    }

    return Object.freeze({
      previewPosition: () => previewSource && playCtx ? previewOffset + (playCtx.currentTime - previewStarted) * previewRate : 0,
      cacheStats: () => ({ raw: rawTakeCache.stats?.(), processed: processedTakeCache.stats?.(), noise: { ...noiseStats,
        wetEntries: [...processedTakeCache.keys()].filter(key => key.startsWith('wet|')).length }, prefetching: prefetching.size, indexVisited: takeIndex?.visited || 0 }),
      getNoiseWet: (line, request = {}) => getRawTake(line.audioUrl, request).then(buffer => buffer && getWet(line.audioUrl, buffer, request)),
      invalidateSource,
      updateLine,
      invalidatePresets: (previousPresets, previousRoles) => {
        const scene = getSession(), previous = { ...scene, voicePresets: previousPresets, roleEffects: previousRoles || scene.roleEffects }, changed = [];
        const changedPresets = new Set([...Object.keys(previousPresets || {}), ...Object.keys(scene.voicePresets || {})].filter(id => { const a = previousPresets?.[id], b = scene.voicePresets?.[id]; return JSON.stringify([a?.effects, a?.pitch]) !== JSON.stringify([b?.effects, b?.pitch]); }));
        const changedRoles = new Set([...Object.keys(previous.roleEffects || {}), ...Object.keys(scene.roleEffects || {})].filter(name => JSON.stringify(previous.roleEffects?.[name]) !== JSON.stringify(scene.roleEffects?.[name]) || changedPresets.has(previous.roleEffects?.[name]?.voicePresetId) || changedPresets.has(scene.roleEffects?.[name]?.voicePresetId)));
        for (const line of scene.lines || []) {
          let affected = false;
          for (const take of [line, ...(line.takeHistory || [])]) {
            if (!changedPresets.has(take.voicePresetId) && !changedRoles.has(line.character)) continue;
            const variant = { ...line, ...take };
            if (global.DublineVoiceChain.key(global.DublineVoiceChain.resolve(variant, previous)) !== global.DublineVoiceChain.key(global.DublineVoiceChain.resolve(variant, scene))) { affected = true; if (take === line) resetLine(line.id, true); }
          }
          if (affected) changed.push(line.id);
        }
        if (changed.length) takeIndex = null;
        // Resolved processing keys select the new variant. Bounded old variants
        // remain valid for independent copies and frozen in-flight exports.
        processedTakeCache.trim?.();
        const changedPreview = item => item && global.DublineVoiceChain.key(global.DublineVoiceChain.resolve(item, previous)) !== global.DublineVoiceChain.key(global.DublineVoiceChain.resolve(item, scene));
        if (changedPreview(previewPendingLine) || changedPreview(previewGraph?.line)) stopPreview(true);
        return changed;
      },
      invalidateRole: (name, previousRoles) => {
        takeIndex = null;
        const urls = new Set();
        for (const line of getSession()?.lines || []) if (line.character === name) {
          if (previousRoles && global.DublineVoiceChain.key(global.DublineVoiceChain.resolve(line, { ...getSession(), roleEffects: previousRoles })) === global.DublineVoiceChain.key(global.DublineVoiceChain.resolve(line, getSession()))) continue;
          if (line.audioUrl) { urls.add(line.audioUrl); resetLine(line.id); }
          for (const take of line.takeHistory || []) urls.add(take.audioUrl);
        }
        for (const key of processedTakeCache.keys()) if (!key.startsWith('wet|') && [...urls].some(url => key.startsWith(url + '|') || key.includes('|' + url + '|'))) processedTakeCache.delete(key);
        if (urls.has(previewPendingLine?.audioUrl) || urls.has(previewGraph?.audioUrl)) stopPreview();
      },
      invalidateNoise: author => {
        const lines = getSession()?.lines || [], urls = new Set();
        for (const line of lines) {
          if (line.recordedBy === author && line.audioUrl) {
            urls.add(line.audioUrl);
            if (!activeTakeSources.has(line.id)) { lineGenerations.set(line.id, (lineGenerations.get(line.id) || 0) + 1); startedTakes.delete(line.id); }
          }
          for (const take of line.takeHistory || []) if (take.recordedBy === author) urls.add(take.audioUrl);
        }
        for (const key of processedTakeCache.keys()) if (!key.startsWith('wet|') && [...urls].some(url => key.startsWith(url + '|') || key.includes('|' + url + '|'))) processedTakeCache.delete(key);
        if (!previewGraph && previewPendingLine?.recordedBy === author) stopPreview();
      },
      applyVolumes,
      ensurePlayCtx,
      getLevelGain,
      prepareTake,
      connectAudition: (source, fade, line) => { const ctx = ensurePlayCtx(); const graph = fx.connectTake(ctx, source, fade, { ...line, _levelGain: Number.isFinite(line._levelGain) ? line._levelGain : getLevelGain(source.buffer, line) }); fade.connect(takesBus); return graph; },
      getProcessedTake,
      getRawTake,
      playAudio,
      previewReference,
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
