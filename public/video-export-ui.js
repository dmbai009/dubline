(() => {
  const policy = DublineVideoExportPolicy, panel = document.getElementById('videoExportPanel');
  const el = suffix => document.getElementById('videoExport' + suffix);
  let metadata = null, metadataKey = '', metadataJob = null, metadataError = '', generation = 0, capabilities = null, active = null, planning = false, lastSaved = null;
  const mode = () => panel.querySelector('input[name=videoExportMode]:checked')?.value || 'fast';
  const key = () => `${currentRoom}:${session?.activeSessionId}:${session?.videoUrl}:${amHost()}`;
  const info = () => mode() === 'original' || mode() === 'custom' && el('Source').value === 'original' ? metadata?.original : metadata?.working;
  const native = () => !!window.dublineVideoExport;
  const unknown = value => policy.valid(value) ? value : t('exportVideo.unknown');
  function settings() {
    const sourceInfo = info(), custom = mode() === 'custom';
    const format = custom ? el('Format').value : mode() === 'original' ? sourceInfo?.extension || 'mp4' : capabilities?.copyFormat || capabilities?.realtimeFormat || 'mp4';
    const dimensions = custom ? policy.dimensions(sourceInfo || {}, el('Resolution').value !== 'source' ? Number(el('Resolution').value) : Math.min(sourceInfo?.width || 0, sourceInfo?.height || 0)) : { width: sourceInfo?.width, height: sourceInfo?.height };
    return { mode: mode(), source: mode() === 'original' ? 'original' : custom ? el('Source').value : 'working', format,
      codec: policy.formats[format]?.codec, sourceInfo, ...dimensions,
      audioRealtime: (mode() === 'original' || custom && el('Source').value === 'original') && !capabilities?.audio[format === 'webm' ? 'webm' : 'mp4'],
      audioMime: capabilities?.audioMimes[format === 'webm' ? 'webm' : 'mp4'],
      fps: custom && el('Fps').value !== 'source' ? Number(el('Fps').value) : null,
      bitrate: Math.floor(Number(el('Bitrate').value) * 1000000) };
  }
  function showMetadata() {
    const source = info(); if (!source) { el('Metadata').textContent = metadataError || t('exportVideo.loading'); return; }
    const values = [['resolution', source.width && source.height ? `${source.width} × ${source.height}` : t('exportVideo.unknown')],
      ['duration', policy.valid(source.duration) ? Math.floor(source.duration / 60) + ':' + String(Math.floor(source.duration % 60)).padStart(2, '0') : t('exportVideo.unknown')],
      ['fps', policy.valid(source.fps) ? `${source.fps.toFixed(3).replace(/\.?0+$/, '')}${source.variableFrameRate ? ' · VFR' : ''}` : t('exportVideo.unknown')],
      ['codec', ({ avc: 'H.264', hevc: 'H.265 (HEVC)' })[source.codec] || source.codec?.toUpperCase() || t('exportVideo.unknown')],
      ['bitrate', policy.valid(source.bitrate) ? (source.bitrate / 1000000).toFixed(source.bitrate < 1000 ? 6 : 3) + ' Mbps' : t('exportVideo.unknown')],
      ['file', `${source.container || t('exportVideo.unknown')} · ${formatSize(source.fileSize) || t('exportVideo.unknown')}`]];
    el('Metadata').replaceChildren(...values.map(([label, value]) => { const box = document.createElement('div'), name = document.createElement('span'), text = document.createElement('strong'); name.textContent = t('exportVideo.' + label); text.textContent = value; box.append(name, text); return box; }));
  }
  function configureSource() {
    const source = info(); if (!source) return;
    for (const option of el('Resolution').options) option.disabled = option.value !== 'source' && Number(option.value) > Math.min(source.width || 0, source.height || 0);
    for (const option of el('Fps').options) option.disabled = option.value !== 'source' && (!policy.valid(source.fps) || Number(option.value) > source.fps);
    if (el('Resolution').selectedOptions[0]?.disabled) el('Resolution').value = 'source';
    if (el('Fps').selectedOptions[0]?.disabled) el('Fps').value = 'source';
    el('Bitrate').max = policy.valid(source.bitrate) ? String(source.bitrate / 1000000) : '';
    el('Bitrate').disabled = !policy.valid(source.bitrate);
    el('Bitrate').value = policy.valid(source.bitrate) ? String(Math.floor(source.bitrate) / 1000000) : '';
  }
  async function probe(loaded) {
    const mb = await import('/vendor/mediabunny/mediabunny.min.mjs'), working = loaded.working;
    const webcodecs = isSecureContext && typeof AudioEncoder === 'function' && typeof AudioDecoder === 'function';
    const audio = {};
    for (const format of ['mp4', 'webm']) audio[format] = webcodecs && await mb.canEncodeAudio(policy.formats[format].audio, { numberOfChannels: 2, sampleRate: 48000, bitrate: policy.AUDIO_BITRATE });
    const copyFormat = audio.mp4 && new mb.Mp4OutputFormat().getSupportedVideoCodecs().includes(working.codec) ? 'mp4' : audio.webm && new mb.WebMOutputFormat().getSupportedVideoCodecs().includes(working.codec) ? 'webm' : null;
    const realtimeTypes = { mp4: 'video/mp4;codecs=avc1,mp4a.40.2', webm: 'video/webm;codecs=vp9,opus' };
    let frameCapture = false;
    if (typeof HTMLCanvasElement.prototype.captureStream === 'function') {
      const stream = document.createElement('canvas').captureStream(0);
      frameCapture = typeof stream.getVideoTracks()[0]?.requestFrame === 'function' && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
      stream.getTracks().forEach(track => track.stop());
    }
    const realtime = Object.fromEntries(Object.entries(realtimeTypes).map(([name, type]) => [name, !!window.MediaRecorder && frameCapture && MediaRecorder.isTypeSupported(type)]));
    const audioTypes = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus'];
    const supported = audioTypes.filter(type => window.MediaRecorder && typeof AudioContext === 'function' && MediaRecorder.isTypeSupported(type));
    const audioMimes = { mp4: supported.find(type => type.includes('mp4')) || supported[0], webm: supported.find(type => type.includes('webm')) || supported[0] };
    return { mb, audio, audioMimes, webcodecs, copyFormat, realtime, realtimeTypes, realtimeFormat: realtime.mp4 ? 'mp4' : realtime.webm ? 'webm' : null };
  }
  async function paint() {
    const attempt = ++generation, chosen = settings(), source = chosen.sourceInfo;
    el('Custom').hidden = chosen.mode !== 'custom'; el('SoundLabel').hidden = !native();
    panel.querySelector('fieldset').setAttribute('aria-label', t('exportVideo.mode'));
    el('Source').querySelector('[value=original]').disabled = !amHost() || !metadata?.original;
    const originalAudio = metadata?.original?.extension === 'webm' ? 'webm' : 'mp4';
    const original = panel.querySelector('input[value=original]'); original.disabled = !amHost() || !metadata?.original || !(capabilities?.audio[originalAudio] || capabilities?.audioMimes[originalAudio]);
    original.title = !amHost() ? t('onlyHost') : !metadata?.original ? t(metadata?.originalError || 'exportVideo.sourceMissing') : '';
    showMetadata();
    const bytes = source && policy.estimate(source, chosen);
    el('Estimate').textContent = bytes ? t('exportVideo.estimate', { size: formatSize(bytes) }) : t('exportVideo.noEstimate');
    let reason = !source || !capabilities ? 'exportVideo.loading' : !policy.valid(source.duration) ? 'exportVideo.sourceMissing' : null;
    let realtime = chosen.mode === 'fast' && !capabilities?.copyFormat;
    if (chosen.mode === 'original') reason = original.disabled ? !amHost() ? 'onlyHost' : 'exportVideo.unsupported' : null;
    if (chosen.mode === 'custom' && source && capabilities) {
      reason = policy.validate(source, chosen);
      const localEncoding = {};
      for (const option of el('Format').options) {
        const format = policy.formats[option.value];
        localEncoding[option.value] = !reason && capabilities.webcodecs && capabilities.audio[option.value] && await capabilities.mb.canEncodeVideo(format.codec, { width: chosen.width, height: chosen.height, frameRate: chosen.fps || source.fps, bitrate: chosen.bitrate });
        const available = chosen.source === 'original' ? amHost() && (capabilities.audio[option.value] || capabilities.audioMimes[option.value]) : localEncoding[option.value] || capabilities.realtime[option.value];
        if (attempt !== generation) return;
        option.disabled = !available;
      }
      if (el('Format').selectedOptions[0]?.disabled) reason = 'exportVideo.unsupported';
      realtime = chosen.source === 'working' && !reason && !localEncoding[chosen.format];
      if (realtime) {
        for (const option of el('Fps').options) option.disabled = option.value !== 'source';
        if (chosen.fps != null) reason = 'exportVideo.fpsUnsupported';
      }
    }
    if (realtime && !capabilities?.realtime[chosen.format]) reason = 'exportVideo.unsupported';
    if (attempt !== generation) return;
    if (chosen.source === 'original' && !amHost()) reason = 'onlyHost';
    if (source && !policy.valid(source.duration)) reason = 'exportVideo.sourceMissing';
    el('Method').textContent = !source && metadataError ? metadataError : reason ? t(reason) : chosen.audioRealtime ? t('exportVideo.originalRealtime') : realtime ? t('exportVideo.realtime') : chosen.mode === 'custom' ? t('exportVideo.reencode') : chosen.mode === 'original' ? t(metadata.originalSame ? 'exportVideo.sameSource' : 'exportVideo.originalMethod') : t(metadata.originalSame ? 'exportVideo.copySame' : 'exportVideo.copyMethod');
    el('Limits').textContent = chosen.mode === 'custom' && source ? t('exportVideo.limits', { width: unknown(source.width), height: unknown(source.height), fps: unknown(source.fps), bitrate: policy.valid(source.bitrate) ? (source.bitrate / 1000000).toFixed(3) : t('exportVideo.unknown') }) : !native() ? t('exportVideo.browserMemory') : '';
    document.getElementById('startRenderBtn').disabled = !!reason || planning || renderInProgress || recordState !== 'idle';
    panel.dataset.ready = String(!reason); panel.dataset.realtime = String(realtime);
    panel.querySelector('fieldset').disabled = planning || renderInProgress;
    for (const control of el('Custom').querySelectorAll('select,input')) control.disabled = planning || renderInProgress || control === el('Bitrate') && !policy.valid(source?.bitrate);
  }
  function open() {
    if (!session?.loaded) return;
    const next = key();
    if (metadata && metadataKey === next) return paint();
    if (metadataJob && metadataKey === next) return metadataJob;
    metadataKey = next; metadata = null; capabilities = null; metadataError = ''; ++generation;
    panel.dataset.ready = 'false'; panel.dataset.realtime = 'false';
    el('Retry').hidden = true;
    document.getElementById('startRenderBtn').disabled = true; el('Metadata').textContent = t('exportVideo.loading');
    const job = (async () => { try {
      const response = await fetch(`/api/video-export-info?room=${encodeURIComponent(currentRoom)}&clientId=${encodeURIComponent(clientId)}&sessionId=${encodeURIComponent(session.activeSessionId)}`);
      if (!response.ok) throw Error(await readError(response));
      const loaded = await response.json(); if (next !== key()) return;
      const available = await probe(loaded); if (next !== key()) return;
      metadata = loaded; capabilities = available;
      configureSource(); await paint();
    } catch (error) { if (next === key()) { metadataKey = ''; metadataError = error.message; panel.dataset.ready = 'false'; el('Retry').hidden = false; el('Metadata').textContent = error.message; el('Method').textContent = error.message; } }
    finally { if (metadataJob === job) metadataJob = null; } })();
    metadataJob = job; return job;
  }
  panel.addEventListener('change', event => {
    if (event.target.matches('[name=videoExportMode],#videoExportSource')) configureSource();
    if (event.target.id === 'videoExportSound') try { localStorage.setItem('dubline_export_sound', el('Sound').checked ? '1' : '0'); } catch { /* Optional preference. */ }
    void paint();
  });
  el('Bitrate').addEventListener('input', () => { void paint(); });
  el('Retry').onclick = () => { void open(); };
  try { el('Sound').checked = localStorage.getItem('dubline_export_sound') !== '0'; } catch { /* Default sound remains available. */ }
  document.getElementById('revealVideoExportBtn').onclick = () => { if (lastSaved) void dublineVideoExport.reveal({ ticket: lastSaved.ticket }).catch(() => showToast(t('exportVideo.destinationExpired'))); };
  window.cancelVideoRender = () => { if (active) { active.abort.abort(); void active.output?.cancel().catch(() => {}); } };
  window.startVideoRender = async () => {
    if (planning || renderInProgress || recordState !== 'idle') return showToast(t('studio.mediaBusy'));
    if (pendingTakeLines.size || processingRecordings.size || editorQueue.length) return showToast(t('project.pendingTakes'));
    if (!session?.loaded) return showToast(t('error.noScene'));
    planning = true;
    let destination, job, lease, elapsedTimer;
    try {
      await open(); if (panel.dataset.ready !== 'true') return;
      const chosen = settings(); let snapshot = createExportSnapshot();
      // Hidden takes stay outside the exported guest mix. The existing reveal rules remain authoritative.
      snapshot.takes = snapshot.scene.lines.filter(line => line.audioUrl && canHearLine(line));
      const room = currentRoom, scene = session.activeSessionId;
      const reason = chosen.mode === 'custom' && policy.validate(chosen.sourceInfo, chosen); if (reason) throw Error(t(reason));
      if (panel.dataset.realtime === 'true' && !await askConfirm(t('exportVideo.realtimeConfirm', { format: chosen.format.toUpperCase() }))) return;
      if (chosen.audioRealtime && !await askConfirm(t('exportVideo.originalRealtime'))) return;
      if (native()) {
        destination = await dublineVideoExport.choose({ extension: chosen.format, title: snapshot.scene.title, sessionId: scene, estimatedBytes: policy.estimate(chosen.sourceInfo, chosen) });
        if (destination.canceled) return;
        if (!destination.ok) throw Error(t(destination.key));
        el('Destination').hidden = false; el('Destination').textContent = destination.directory + ' · ' + destination.name;
      }
      if (recordState !== 'idle' || room !== currentRoom || scene !== session?.activeSessionId) throw Error(t('render.sceneChanged'));
      const abort = new AbortController();
      job = { destination, abort, sessionId: scene, bytes: 0, percent: 0, check: () => { abort.signal.throwIfAborted(); assertExportScene(snapshot); if (!socket.connected || room !== currentRoom) throw Error(t('exportVideo.authorization')); if (chosen.source === 'original' && !amHost()) throw Error(t('onlyHost')); } };
      active = job; renderInProgress = true; video.pause(); refreshStudioTransport(); applyVolumes();
      const startedAt = performance.now(), progressBox = document.getElementById('renderProgressBox'); progressBox.style.display = 'block';
      let stage = t('render.readVideo'), lastPaint = 0;
      const showStage = () => { document.getElementById('renderStatusText').textContent = `${stage} · ${Math.floor((performance.now() - startedAt) / 1000)} ${t('takeHistory.seconds')}`; };
      let lastRenewal = performance.now(), renewing = false;
      elapsedTimer = setInterval(() => {
        showStage();
        if (lease?.ticket && !renewing && performance.now() - lastRenewal >= 60000) {
          renewing = true; lastRenewal = performance.now();
          void fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ room, clientId, ticket: lease.ticket }) }).then(response => { if (!response.ok) abort.abort(); }).catch(() => abort.abort()).finally(() => { renewing = false; });
        }
      }, 1000);
      const progress = (percent, text) => {
        job.percent = Math.max(job.percent, Math.min(99, percent)); stage = text;
        if (percent < 97 && performance.now() - lastPaint < 100) return;
        lastPaint = performance.now(); document.getElementById('renderProgressBar').style.width = job.percent + '%'; showStage();
      };
      document.getElementById('cancelVideoExportBtn').hidden = false; document.getElementById('revealVideoExportBtn').hidden = true;
      await paint();
      progress(1, t('render.readVideo'));
      const leaseResponse = await fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ room, clientId, sessionId: scene, videoUrl: snapshot.videoUrl }) });
      if (!leaseResponse.ok) throw Error(await readError(leaseResponse));
      lease = { ...await leaseResponse.json(), room }; job.check();
      const permitted = new Set(lease.takeIds);
      snapshot.scene = lease.scene; snapshot.takes = lease.scene.lines.filter(line => permitted.has(line.id));
      snapshot.gains = readRenderGains(lease.scene);
      const sources = DublineProjectAudio.sources(lease.scene); snapshot.originalUrl = sources.original; snapshot.backingUrl = sources.backing;
      job.permitted = permitted;
      job.check = () => { abort.signal.throwIfAborted(); assertExportScene(snapshot); if (!socket.connected || room !== currentRoom || job.permissionInvalid) throw Error(t('exportVideo.authorization')); if (chosen.source === 'original' && !amHost()) throw Error(t('onlyHost')); };
      await waitForExportVideo(snapshot, job);
      let result;
      if (chosen.source === 'original') result = await renderOriginalVideo(progress, snapshot, chosen, job);
      else if (panel.dataset.realtime === 'true') result = await renderRealtime(progress, snapshot, chosen, job);
      else result = await DublineVideoExportEngine.render(chosen, snapshot, progress, job);
      job.check(); progress(99, t('exportVideo.saving'));
      if (destination) {
        if (result.downloadUrl) {
          const response = await fetch(result.downloadUrl, { signal: abort.signal }); if (!response.ok) throw Error(await readError(response));
          const reader = response.body.getReader();
          try { for (;;) { const { done, value } = await reader.read(); if (done) break; for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) { job.check(); const saved = await dublineVideoExport.write({ ticket: destination.ticket, sessionId: scene, position: job.bytes, bytes: value.slice(offset, offset + 1024 * 1024) }); if (!saved.ok) throw Error(t(saved.key)); job.bytes = saved.bytes; } } }
          finally { await reader.cancel().catch(() => {}); }
        } else if (result.blob) {
          for (let offset = 0; offset < result.blob.size; offset += 1024 * 1024) { job.check(); const saved = await dublineVideoExport.write({ ticket: destination.ticket, sessionId: scene, position: offset, bytes: new Uint8Array(await result.blob.slice(offset, offset + 1024 * 1024).arrayBuffer()) }); if (!saved.ok) throw Error(t(saved.key)); job.bytes = saved.bytes; }
        }
        job.check(); document.getElementById('cancelVideoExportBtn').disabled = true;
        const saved = await dublineVideoExport.commit({ ticket: destination.ticket, sessionId: scene, bytes: job.bytes }); if (!saved.ok) throw Error(t(saved.key));
        lastSaved = destination; document.getElementById('revealVideoExportBtn').hidden = false;
        document.getElementById('renderProgressBar').style.width = '100%'; document.getElementById('renderStatusText').textContent = t('exportVideo.saved', { size: formatSize(saved.bytes) });
        if (el('Sound').checked && !saved.alreadySaved) await completionSound();
      } else {
        if (result.downloadUrl) { const link = document.createElement('a'); link.href = result.downloadUrl; link.download = result.filename; link.click(); }
        else downloadBlob(result.blob, result.ext, snapshot.scene.title);
        document.getElementById('renderStatusText').textContent = t('exportVideo.download', { size: formatSize(result.bytes || result.blob?.size) });
      }
    } catch (error) { document.getElementById('renderProgressBox').style.display = 'block'; document.getElementById('renderStatusText').textContent = error.name === 'AbortError' || job?.abort.signal.aborted ? t('exportVideo.cancelled') : error.message; }
    finally {
      clearInterval(elapsedTimer); job?.abort.abort();
      if (lease?.ticket) {
        const cleanup = new AbortController(), timer = setTimeout(() => cleanup.abort(), 3000);
        try { await fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: cleanup.signal, body: JSON.stringify({ room: lease.room, clientId, ticket: lease.ticket, release: true }) }); } catch { /* Disconnect/expiry also releases server-side references. */ } finally { clearTimeout(timer); }
      }
      if (destination?.ticket && lastSaved?.ticket !== destination.ticket) await dublineVideoExport.cancel({ ticket: destination.ticket }).catch(() => {});
      if (job) { active = null; renderInProgress = false; refreshStudioTransport(); applyVolumes(); }
      planning = false; document.getElementById('cancelVideoExportBtn').hidden = true; document.getElementById('cancelVideoExportBtn').disabled = false; await paint();
    }
  };
  async function completionSound() {
    let context, timer;
    const close = () => { clearTimeout(timer); if (context?.state !== 'closed') void context?.close().catch(() => {}); };
    try {
      context = new AudioContext(); timer = setTimeout(close, 2000);
      const output = window.DublineAudioDevices?.getSelection().outputId;
      if (output && context.setSinkId) await context.setSinkId(output).catch(() => {});
      await context.resume(); if (context.state === 'closed') return;
      const oscillator = context.createOscillator(), level = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = 660;
      level.gain.setValueAtTime(0, context.currentTime); level.gain.linearRampToValueAtTime(0.04, context.currentTime + 0.025); level.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.25);
      oscillator.connect(level); level.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.26); oscillator.onended = close;
    } catch { close(); /* A sound-device failure cannot undo the saved file. */ }
  }

  const checkPermissions = () => { if (active?.permitted) active.permissionInvalid = !session?.lines || session.lines.some(line => active.permitted.has(line.id) && !canHearLine(line)); };
  socket.on('session_updated', () => { checkPermissions(); if (active && session?.activeSessionId !== active.sessionId) window.cancelVideoRender(); if (document.getElementById('tabContentExport').classList.contains('active')) void open(); });
  socket.on('line_updated', checkPermissions);
  socket.on('takes_updated', checkPermissions);
  socket.on('room_users_updated', checkPermissions);
  socket.on('disconnect', () => { window.cancelVideoRender(); });
  window.addEventListener('dubline-language-changed', () => { void paint(); });
  window.DublineVideoExportPanel = Object.freeze({ open, refresh: paint, settings, completionSound });
})();
