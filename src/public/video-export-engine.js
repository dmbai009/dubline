(() => {
  const policy = window.DublineVideoExportPolicy;
  async function render(settings, snapshot, progress, job) {
    snapshot.exportRange = settings.range || null;
    // Arbitrary frame boundaries cannot safely copy inter-frame video packets.
    if (settings.range) settings = { ...settings, mode: 'custom' };
    const owned=!job.operations;
    if(owned) {job.operations=DublineExportOperations.create(job.abort.signal);const check=job.check;job.check=()=>{job.operations.check();check();};}
    snapshot.exportOperations=job.operations;
    try { return await renderAttempt(settings,snapshot,progress,job); }
    finally { if(owned)job.operations.close(); }
  }
  async function renderAttempt(settings, snapshot, progress, job) {
    if (settings.mode !== 'custom') return renderOnce(settings, snapshot, progress, job);
    const mb = await job.operations.run('engine-load',()=>import('/vendor/mediabunny/mediabunny.min.mjs'));
    const config = { width: settings.width, height: settings.height, frameRate: settings.fps || settings.sourceInfo.fps, bitrate: settings.bitrate };
    // Older desktop shells cannot restart an approved temporary file safely.
    const mode = job.destination && !window.dublineVideoExport?.reset ? 'off' : settings.acceleration ?? DublineVideoAcceleration.get();
    const hint = await job.operations.run('video-encoder-check',()=>DublineVideoAcceleration.encoderPreference(mb, settings.codec, config, mode, settings.sourceInfo)).catch(error => { throw Error(t(error.message)); });
    try { return await renderOnce({ ...settings, hardwareAcceleration: hint }, snapshot, progress, job); }
    catch (error) {
      if (hint === 'prefer-software' || !error.videoAcceleration || error.exportWrite || job.abort.signal.aborted || error.name === 'AbortError') throw error;
      job.check();
      if (!await job.operations.run('video-encoder-check',()=>mb.canEncodeVideo(settings.codec, { ...config, hardwareAcceleration: 'prefer-software' }))) throw error;
      if (job.destination) {
        const reset = await job.operations.run('file-reset',()=>dublineVideoExport.reset({ ticket: job.destination.ticket, sessionId: snapshot.scene.activeSessionId }));
        if (!reset.ok) throw Error(t(reset.key));
      }
      job.bytes = 0; job.percent = 0; job.resetProgress?.();
      return renderOnce({ ...settings, hardwareAcceleration: 'prefer-software', accelerationFallback: true }, snapshot, progress, job);
    }
  }
  async function renderOnce(settings, snapshot, progress, job) {
    snapshot.exportReport = job.report;
    const mb = await job.operations.run('engine-load',()=>import('/vendor/mediabunny/mediabunny.min.mjs'));
    const source = snapshot.videoBlob ? new mb.BlobSource(snapshot.videoBlob) : new mb.UrlSource(snapshot.videoUrl, { fetchFn: DublineExportOperations.fetchSource(job.abort.signal) });
    const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
    let output, audioIterator;
    const operations=job.operations, unownInput=operations.own(()=>input.dispose());
    try {
      job.check(); progress(1, t('render.readVideo'));
      const track = await operations.run('video-metadata',()=>input.getPrimaryVideoTrack());
      if (!track) throw Error(t('render.noVideo'));
      const codec = await operations.run('video-codec',()=>track.getCodec()), decoderConfig = await operations.run('video-decoder-config',()=>track.getDecoderConfig()), sourceDuration = await operations.run('video-duration',()=>track.computeDuration());
      if (!policy.valid(sourceDuration)) throw Error(t('render.noVideo'));
      const range = policy.range(settings.range, sourceDuration) || { start: 0, end: sourceDuration }, duration = range.end - range.start;
      if (!codec || !decoderConfig) throw Error(t('render.unknownCodec'));
      job.report?.('video', { current: 0, total: duration, label: settings.mode === 'custom' ? 'encoding' : 'copying', ...(settings.accelerationFallback ? { detail: t('acceleration.fallback') } : {}) });
      const format = settings.format === 'webm' ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat({ fastStart: false });
      if (settings.mode !== 'custom' && !format.getSupportedVideoCodecs().includes(codec)) throw Error(t('exportVideo.unsupported'));
      const encoding = policy.formats[settings.format];
      if (!await operations.run('audio-encoder-check',()=>mb.canEncodeAudio(encoding.audio, { numberOfChannels: 2, sampleRate: 48000, bitrate: policy.AUDIO_BITRATE }))) throw Error(t('render.noAudioCodec'));
      if (settings.mode === 'custom') {
        const [statistics, metrics] = await operations.run('video-statistics',()=>Promise.all([track.computePacketStats(Infinity, { metadataOnly: true }), track.computeFrameRateMetrics({ targetPacketCount: Infinity })]));
        const actual = { width: track.displayWidth, height: track.displayHeight, codedWidth: track.codedWidth, codedHeight: track.codedHeight, rotation: track.rotation, bitrate: statistics.averageBitrate,
          fps: metrics.frameRateIsConstant ? metrics.underlyingFrameRate : statistics.averagePacketRate };
        const reason = policy.validate(actual, settings); if (reason) throw Error(t(reason));
        if (!await operations.run('video-decoder-check',()=>track.canDecode()) || !await operations.run('video-encoder-check',()=>mb.canEncodeVideo(settings.codec, { width: settings.width, height: settings.height, frameRate: settings.fps || settings.sourceInfo.fps, bitrate: settings.bitrate, hardwareAcceleration: settings.hardwareAcceleration }))) throw Error(t('exportVideo.unsupported'));
      }
      const target = job.destination ? new mb.StreamTarget(new WritableStream({ write: async chunk => {
        for (let offset = 0; offset < chunk.data.byteLength; offset += 1024 * 1024) {
          job.check();
          let result;
          try { result = await operations.run('file-write',()=>dublineVideoExport.write({ ticket: job.destination.ticket, sessionId: snapshot.scene.activeSessionId, position: chunk.position + offset, bytes: chunk.data.slice(offset, offset + 1024 * 1024) }),{position:chunk.position+offset,bytes:Math.min(1024*1024,chunk.data.byteLength-offset)});
            if (!result.ok) throw Error(t(result.key));
          } catch (error) { error.exportWrite = true; throw error; }
          job.bytes = Math.max(job.bytes, result.bytes);
          job.report?.('saving', { current: job.bytes, unit: 'bytes' });
        }
      } }), { chunked: true, chunkSize: 1024 * 1024 }) : new mb.BufferTarget();
      output = new mb.Output({ format, target }); job.output = output;
      operations.own(()=>DublineExportOperations.abortOutput(output));
      const videoSource = settings.mode === 'custom' ? new mb.VideoSampleSource({ codec: settings.codec, bitrate: settings.bitrate, latencyMode: 'quality', hardwareAcceleration: settings.hardwareAcceleration }) : new mb.EncodedVideoPacketSource(codec);
      const audioSource = new mb.AudioBufferSource({ codec: encoding.audio, bitrate: policy.AUDIO_BITRATE });
      output.addVideoTrack(videoSource, settings.mode === 'custom' ? {} : { transformationMatrix: await operations.run('video-transform',()=>track.getTransformationMatrix()) }); output.addAudioTrack(audioSource);
      await operations.run('container-start',()=>output.start());
      snapshot.exportSignal = job.abort.signal;
      audioIterator = DublineVideoExportAudio.chunks(mb, snapshot, sourceDuration, text => progress(job.percent || 5, text), job.check)[Symbol.asyncIterator]();
      let audioEnd = 0, audioDone = false;
      const audioUntil = async timestamp => {
        while (!audioDone && audioEnd < Math.min(timestamp, duration)) {
          job.check(); const next = await operations.run('audio-window',()=>audioIterator.next(),{timestamp:audioEnd},{timeoutMs:Infinity});
          if (next.done) { audioDone = true; break; }
          await operations.run('audio-encode',()=>audioSource.add(next.value.buffer),{timestamp:audioEnd,end:next.value.end}); audioEnd = next.value.end;
        }
      };
      await audioUntil(0.01);
      if (settings.mode === 'custom') {
        const canvas = document.createElement('canvas'); canvas.width = settings.width; canvas.height = settings.height;
        const decoderHint = await operations.run('video-decoder-check',()=>DublineVideoAcceleration.decoderPreference(track, settings.hardwareAcceleration)).catch(error => { throw Error(t(error.message)); });
        const context = canvas.getContext('2d'), sink = new mb.VideoSampleSink(track, { hardwareAcceleration: decoderHint });
        let frameIndex = 0;
        const timestamps = function* () { for (let i = 0; i / settings.fps < duration; i++) yield range.start + i / settings.fps; };
        // Include the frame containing the left boundary, even between timestamps.
        const frames = settings.fps ? sink.samplesAtTimestamps(timestamps()) : sink.samples(range.start, range.end);
        const decode = async function* () { try { yield* frames; } catch (error) { error.videoAcceleration = true; throw error; } };
        for await (const sample of operations.iterate(decode(),'video-decode')) {
          const timestamp = settings.fps ? frameIndex++ / settings.fps : Math.max(0, sample?.timestamp - range.start);
          if (!sample) throw Error(t('render.playbackFailed'));
          try {
            job.check();
            sample.draw(context, 0, 0, canvas.width, canvas.height);
            const frame = new mb.VideoSample(canvas, { timestamp, duration: Math.min(duration - timestamp, settings.fps ? 1 / settings.fps : sample.timestamp + sample.duration - Math.max(range.start, sample.timestamp)) });
            try { await operations.run('video-encode',()=>videoSource.add(frame),{timestamp}); } catch (error) { error.videoAcceleration = true; throw error; } finally { frame.close(); } operations.video(timestamp);
            await audioUntil(timestamp + 1); job.report?.('video', { current: Math.min(duration, timestamp + (sample.duration || 0)), total: duration, label: 'encoding' }); progress(Math.min(95, 10 + 85 * timestamp / duration), t('exportVideo.processing'));
          } finally { sample.close(); }
        }
      } else {
        let first = true;
        const packetSink=new mb.EncodedPacketSink(track);
        for await (const packet of operations.iterate(packetSink.packets(),'video-packet-read')) {
          job.check(); await operations.run('video-packet-mux',()=>videoSource.add(packet, first ? { decoderConfig } : undefined),{timestamp:packet.timestamp,duration:packet.duration}); first = false; operations.video(packet.timestamp);
          await audioUntil(packet.timestamp + 1); job.report?.('video', { current: Math.min(duration, packet.timestamp + (packet.duration || 0)), total: duration, label: 'copying' }); progress(Math.min(95, 10 + 85 * packet.timestamp / duration), t('exportVideo.copying'));
        }
      }
      await audioUntil(Infinity); videoSource.close(); audioSource.close(); job.report?.('video', { current: duration, total: duration, state: 'done' }); job.report?.('finalizing', {}); progress(97, t('render.finalize'));
      try { await operations.run('container-finalize',()=>output.finalize()); } catch (error) { if (settings.mode === 'custom' && !error.exportWrite) error.videoAcceleration = true; throw error; }
      job.check(); job.report?.('finalizing', { state: 'done' });
      return job.destination ? { bytes: job.bytes, ext: settings.format } : { blob: new Blob([target.buffer], { type: encoding.mime }), ext: settings.format };
    } finally { input.dispose(); unownInput(); Promise.resolve(audioIterator?.return?.()).catch(()=>{}); if (output && output.state !== 'finalized') DublineExportOperations.abortOutput(output); job.output = null; }
  }
  async function realtime(settings,snapshot,progress,job) {
    const owned=!job.operations;if(owned)job.operations=DublineExportOperations.create(job.abort.signal);snapshot.exportOperations=job.operations;
    try{return await realtimeOnce(settings,snapshot,progress,job);}finally{if(owned)job.operations.close();}
  }
  async function realtimeOnce(settings, snapshot, progress, job) {
    if (settings.range || snapshot.exportRange) throw Error(t('range.unsupported'));
    snapshot.exportSignal = job.abort.signal; snapshot.exportReport = job.report;
    job.check?.(); job.abort.signal.throwIfAborted();
    const audioOnly = !!settings.audioOnly;
    if (!audioOnly && settings.acceleration === 'off') throw Error(t('exportVideo.unsupported'));
    const mime = audioOnly ? settings.audioMime : settings.format === 'mp4' ? 'video/mp4;codecs=avc1,mp4a.40.2' : 'video/webm;codecs=vp9,opus';
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mime) || !audioOnly && (!HTMLCanvasElement.prototype.captureStream || settings.fps != null)) throw Error(t('exportVideo.unsupported'));
    const duration = settings.sourceInfo.duration, elements = [], nodes = new Set(), timers = [], buffers = [], objectURLs = [];
    const context = new AudioContext(), destination = context.createMediaStreamDestination(), limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.1; limiter.connect(destination);
    const movie = document.createElement('video'); movie.playsInline = true; movie.preload = 'auto'; movie.muted = true;
    const localUrl = snapshot.videoBlob ? URL.createObjectURL(snapshot.videoBlob) : null;
    if (localUrl) objectURLs.push(localUrl);
    movie.src = localUrl || snapshot.videoUrl; elements.push(movie);
    const canvas = audioOnly ? null : document.createElement('canvas'); if (canvas) { canvas.width = settings.width; canvas.height = settings.height; }
    const drawing = canvas?.getContext('2d'), canvasStream = canvas?.captureStream(0), videoTrack = canvasStream?.getVideoTracks()[0];
    if (!audioOnly && (!videoTrack?.requestFrame || typeof movie.requestVideoFrameCallback !== 'function')) { movie.removeAttribute('src'); movie.load(); canvasStream?.getTracks().forEach(track => track.stop()); await context.close(); if (localUrl) URL.revokeObjectURL(localUrl); throw Error(t('exportVideo.unsupported')); }
    let recorder, stream, frame, watchdog, stopped, ended = false, scheduledClock = 0, queuedBytes = 0, writing = Promise.resolve(), failure = null, finish;
    const finished = new Promise((resolve, reject) => { finish = error => error ? reject(error) : resolve(); });
    finished.catch(() => {});
    const failed = error => { if (!failure) { failure = error; finish(error); } };
    const abort = () => failed(new DOMException('Export cancelled', 'AbortError'));
    job.abort.signal.addEventListener('abort', abort, { once: true });
    const loaded = element => new Promise((resolve, reject) => {
      job.abort.signal.throwIfAborted();
      if (element.readyState >= 3) return resolve();
      const done = error => { clearTimeout(timeout); element.removeEventListener('canplay', ready); element.removeEventListener('error', bad); job.abort.signal.removeEventListener('abort', cancelled); error ? reject(error) : resolve(); };
      const ready = () => done(), bad = () => done(exportAudioError(t('exportVideo.source'))), cancelled = () => done(new DOMException('Export cancelled', 'AbortError'));
      const timeout = setTimeout(() => done(exportAudioError(t('exportVideo.source'))), 15000);
      element.addEventListener('canplay', ready, { once: true }); element.addEventListener('error', bad, { once: true }); job.abort.signal.addEventListener('abort', cancelled, { once: true }); element.load();
    });
    try {
      progress(1, t('render.readVideo')); await loaded(movie); job.check();
      const prepared = await DublineVideoExportAudio.prepare(snapshot, duration, text => progress(2, text), job.check), sources = [];
      for (const name of ['original', 'backing']) {
        const url = snapshot[name + 'Url']; if (!url || snapshot.gains[name] <= 0) continue;
        const offset = snapshot.gains.mix[name].offset;
        const videoAudio = url === snapshot.videoUrl || url === mediaUrl(snapshot.videoUrl);
        const element = name === 'original' && offset === 0 && videoAudio ? movie : document.createElement('audio');
        if (element !== movie) {
          const blob = videoAudio ? snapshot.videoBlob : snapshot.assets?.[url]?.blob;
          const address = blob ? URL.createObjectURL(blob) : url; if (blob) objectURLs.push(address);
          element.src = address; element.preload = 'auto'; elements.push(element); await loaded(element);
        }
        element.muted = false;
        if (-offset >= element.duration) continue;
        element.currentTime = Math.max(0, -offset);
        const source = context.createMediaElementSource(element), bus = context.createGain(); source.connect(bus); bus.connect(limiter); nodes.add(source); nodes.add(bus); sources.push({ element, offset, name, bus });
      }
      const pending = prepared.takes.map(take => ({ ...take, scheduled: false }));
      const schedule = async (until, initial = false) => {
        for (const take of pending) if (!take.scheduled && take.start + take.from < until) {
          take.scheduled = true; job.check();
          const buffer = await job.operations.run('take-process',()=>requireExportTake(take.line,snapshot.exportSignal)); job.check(); if (ended) return;
          const from = Math.max(take.from, -take.start), to = Math.min(take.to, duration - take.start);
          if (to <= from) continue;
          const when = scheduledClock + Math.max(0, take.start + from);
          if (!initial && when < context.currentTime - 0.05) throw exportAudioError('#' + take.line.id);
          const source = context.createBufferSource(), level = context.createGain(); source.buffer = buffer; level.gain.value = snapshot.gains.dub;
          const graph = DublineAudioFx.connectTake(context, source, level, take.line); level.connect(limiter); nodes.add(source); nodes.add(level);
          source.onended = () => { source.disconnect(); level.disconnect(); graph.gain.disconnect(); graph.panner.disconnect(); source.buffer = null; nodes.delete(source); nodes.delete(level); delete take.prepared; };
          if (initial) take.prepared = { source, from, to }; else source.start(Math.max(context.currentTime, when), from, to - from);
        }
      };
      await schedule(5, true); await job.operations.run('audio-resume',()=>context.resume()); job.check();
      stream = new MediaStream([...(canvasStream?.getVideoTracks() || []), ...destination.stream.getAudioTracks()]);
      recorder = new MediaRecorder(stream, { mimeType: mime, ...(!audioOnly ? { videoBitsPerSecond: settings.mode === 'custom' ? settings.bitrate : Math.max(1, Math.floor(settings.sourceInfo.bitrate || 1)) } : {}), audioBitsPerSecond: policy.AUDIO_BITRATE });
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        if (!job.destination) { buffers.push(event.data); return; }
        queuedBytes += event.data.size;
        if (queuedBytes > 8 * 1024 * 1024) return failed(Error(t('exportVideo.fileError')));
        writing = writing.then(async () => {
          for (let offset = 0; offset < event.data.size; offset += 1024 * 1024) {
            job.check(); const bytes = new Uint8Array(await job.operations.run('file-buffer-read',()=>event.data.slice(offset, offset + 1024 * 1024).arrayBuffer()));
            const result = await job.operations.run('file-write',()=>dublineVideoExport.write({ ticket: job.destination.ticket, sessionId: snapshot.scene.activeSessionId, position: job.bytes, bytes }),{bytes:bytes.byteLength,position:job.bytes});
            if (!result.ok) throw Error(t(result.key)); job.bytes = result.bytes; job.report?.('saving', { current: job.bytes, unit: 'bytes' });
          }
          queuedBytes -= event.data.size;
        }).catch(failed);
      };
      recorder.onerror = () => failed(Error(t('exportVideo.unsupported')));
      stopped = new Promise(resolve => { recorder.onstop = resolve; });
      if (drawing) { drawing.drawImage(movie, 0, 0, canvas.width, canvas.height); videoTrack.requestFrame(); }
      scheduledClock = context.currentTime;
      for (const source of sources) {
        const automation = { setValueAtTime: (value, at) => source.bus.gain.setValueAtTime(value, scheduledClock + at), linearRampToValueAtTime: (value, at) => source.bus.gain.linearRampToValueAtTime(value, scheduledClock + at) };
        automation.setValueAtTime(snapshot.gains[source.name], 0);
        if (snapshot.gains.mix.autoDuckEnabled) DublineProjectAudio.automateDucking(automation, snapshot.gains[source.name], snapshot.gains.mix.autoDuckAmount, prepared.takes.map(take => [Math.max(0, take.start + take.from), Math.min(duration, take.start + take.to)]), duration);
      }
      recorder.start(250);
      await waitForRenderPlayback(snapshot, 8000, movie, job.abort.signal); job.check();
      scheduledClock = context.currentTime - movie.currentTime;
      for (const take of pending) if (take.prepared) take.prepared.source.start(scheduledClock + Math.max(0, take.start + take.prepared.from), take.prepared.from, take.prepared.to - take.prepared.from);
      for (const source of sources) if (source.element !== movie) {
        if (source.offset > 0) timers.push(setTimeout(() => { void source.element.play().catch(failed); }, source.offset * 1000));
        else void source.element.play().catch(failed);
      }
      const draw = () => { try { job.check(); if (drawing) { drawing.drawImage(movie, 0, 0, canvas.width, canvas.height); videoTrack.requestFrame(); } job.report?.(audioOnly ? 'audio' : 'video', { current: movie.currentTime, total: duration, label: audioOnly ? 'audio' : 'realtime' }); progress(Math.min(95, 10 + movie.currentTime / duration * 85), t('render.realtimeProgress', { current: Math.round(movie.currentTime), total: Math.round(duration) })); if (movie.ended || movie.currentTime >= duration) finish(); else if (movie.requestVideoFrameCallback) frame = movie.requestVideoFrameCallback(draw); } catch (error) { failed(error); } };
      if (movie.requestVideoFrameCallback) frame = movie.requestVideoFrameCallback(draw);
      let scheduling = false, lastTime = 0, lastProgress = performance.now();
      watchdog = setInterval(() => {
        try {
          job.check(); if (movie.error) throw Error(t('render.playbackFailed'));
          if (audioOnly) { job.report?.('audio', { current: movie.currentTime, total: duration }); progress(Math.min(95, 10 + movie.currentTime / duration * 85), t('render.encodeSoundtrack')); }
          if (audioOnly && !movie.requestVideoFrameCallback) draw();
          if (movie.currentTime !== lastTime) { lastTime = movie.currentTime; lastProgress = performance.now(); }
          if (movie.ended || movie.currentTime >= duration - 0.01) return finish();
          if (performance.now() - lastProgress > 10000) throw Error(t('render.playbackFailed'));
          for (const source of sources) { const expected = movie.currentTime - source.offset; if (expected > 0.2 && expected < source.element.duration - 0.1 && Math.abs(source.element.currentTime - expected) > 0.2) throw exportAudioError(t('exportVideo.source')); }
          if (!scheduling) { scheduling = true; void schedule(movie.currentTime + 5).catch(failed).finally(() => { scheduling = false; }); }
        } catch (error) { failed(error); }
      }, 100);
      await finished; recorder.stop(); await job.operations.run('recorder-stop',()=>stopped); await job.operations.run('file-drain',()=>writing); if (failure) throw failure; job.check(); job.report?.('audio', { current: duration, total: duration, state: 'done' }); if (!audioOnly) job.report?.('video', { current: duration, total: duration, state: 'done' });
      return job.destination ? { bytes: job.bytes, ext: settings.format } : { blob: new Blob(buffers, { type: audioOnly ? mime : policy.formats[settings.format].mime }), ext: audioOnly ? mime.includes('webm') ? 'webm' : 'm4a' : settings.format };
    } finally {
      ended = true;
      job.abort.signal.removeEventListener('abort', abort); clearInterval(watchdog); timers.forEach(clearTimeout); if (frame) movie.cancelVideoFrameCallback(frame);
      for (const element of elements) { element.pause(); element.removeAttribute('src'); element.load(); }
      if (recorder?.state !== 'inactive' && recorder) recorder.stop();
      const settle=async promise=>{let timer;try{await Promise.race([Promise.resolve(promise).catch(()=>{}),new Promise(resolve=>timer=setTimeout(resolve,1000))]);}finally{clearTimeout(timer);}};
      stream?.getTracks().forEach(track => track.stop()); canvasStream?.getTracks().forEach(track => track.stop());
      for (const node of nodes) { try { node.stop?.(); node.disconnect(); } catch { /* Already stopped. */ } }
      await settle(stopped); await settle(writing); await settle(context.close()); objectURLs.forEach(url => URL.revokeObjectURL(url));
    }
  }
  window.DublineVideoExportEngine = Object.freeze({ render, realtime });
})();
