(() => {
  const policy = DublineVideoExportPolicy, panel = document.getElementById('videoExportPanel');
  const el = suffix => document.getElementById('videoExport' + suffix);
  let metadataAbort=null;
  let metadata = null, metadataKey = '', metadataJob = null, metadataError = '', generation = 0, capabilities = null, active = null, planning = false, lastSaved = null, lastResult = null;
  const resultCard = document.createElement('section'); resultCard.id = 'videoExportResult'; resultCard.className = 'setting-card'; resultCard.hidden = true; resultCard.setAttribute('role', 'status'); document.getElementById('renderProgressBox').after(resultCard);
  let exportNotice=null;
  const clock = seconds => { const n = Math.max(0, Math.floor(seconds || 0)); return (n >= 3600 ? Math.floor(n / 3600) + ':' + String(Math.floor(n / 60) % 60).padStart(2, '0') : Math.floor(n / 60)) + ':' + String(n % 60).padStart(2, '0'); };
  function paintProgress(tracker, terminal = false) {
    const view = tracker.snapshot(), area = document.getElementById('renderProgressDetails');
    for (const item of view.rows) {
      let row = area.querySelector('[data-phase="' + item.phase + '"]');
      if (!row) {
        row = document.createElement('div'); row.className = 'export-progress-row'; row.dataset.phase = item.phase; row.append(document.createElement('span'), document.createElement('strong'), document.createElement('progress'));
        const order = ['checking', 'opening', 'takes', 'audio', 'uploading', 'video', 'finalizing', 'saving'];
        area.insertBefore(row, [...area.children].find(node => order.indexOf(node.dataset.phase) > order.indexOf(item.phase)) || null);
      }
      row.dataset.state = terminal && item.state === 'running' ? 'stopped' : item.state; row.children[0].textContent = t('exportProgress.' + (item.label || item.phase));
      row.hidden = ['checking', 'opening'].includes(item.phase) && item.state === 'done';
      const amount = value => item.unit === 'bytes' ? formatSize(value) : item.unit === 'count' ? String(value || 0) : clock(value);
      row.children[1].textContent = Number.isFinite(item.current) ? amount(item.current) + (Number.isFinite(item.total) ? ' / ' + amount(item.total) : '') + (item.detail ? ' · ' + item.detail : '') : t('exportProgress.pending');
      const meter = row.children[2]; meter.setAttribute('aria-label', row.children[0].textContent); meter.max = item.total || 1;
      if (item.state === 'done') meter.value = meter.max; else if (item.total > 0) meter.value = Math.min(item.current || 0, item.total); else if (terminal) meter.value = 0; else meter.removeAttribute('value');
    }
    const activity = document.getElementById('renderProgressActivity'); activity.dataset.waiting = String(!terminal && view.stalled);
    activity.textContent = t('exportProgress.elapsed', { time: clock(view.elapsed / 1000) }) + (terminal ? '' : ' · ' + t(view.waitingForUser ? 'exportProgress.chooseDestination' : view.stalled ? 'exportProgress.waiting' : 'exportProgress.lastAdvance', { seconds: Math.floor(view.quiet / 1000) }));
    area.dataset.stage = view.current;
    if(exportNotice) {
      if(terminal)exportNotice.final=view;
      window.DublineBackgroundOperations?.refresh();
    }
  }
  function paintResult() { resultCard.replaceChildren(); resultCard.hidden = !lastResult; if (!lastResult) return; const title = document.createElement('strong'), file = document.createElement('p'), details = document.createElement('p'); title.textContent = t(lastResult.saved ? 'review.exportSaved' : 'review.exportPrepared'); file.textContent = lastResult.file; file.className = 'setting-sub'; details.className = 'setting-sub'; details.textContent = t('review.exportDetails', { duration: Math.floor(lastResult.duration / 60) + ':' + String(Math.floor(lastResult.duration % 60)).padStart(2, '0'), format: lastResult.format + ' · ' + lastResult.width + '×' + lastResult.height, size: formatSize(lastResult.bytes), n: lastResult.takes }); resultCard.append(title, file, details); if (lastResult.warnings) { const warning = document.createElement('p'); warning.className = 'setting-sub'; warning.textContent = t('review.exportWarnings', { n: lastResult.warnings }); resultCard.append(warning); } }
  const mode = () => panel.querySelector('input[name=videoExportMode]:checked')?.value || 'fast';
  const key = () => `${currentRoom}:${session?.activeSessionId}:${session?.videoUrl}:${amHost()}`;
  const info = () => mode() === 'original' || mode() === 'custom' && el('Source').value === 'original' ? metadata?.original : metadata?.working;
  const native = () => !!window.dublineVideoExport;
  const unknown = value => policy.valid(value) ? value : t('exportVideo.unknown');
  const number=(value,digits=2)=>new Intl.NumberFormat(DublineI18n.getLanguage(),{maximumFractionDigits:digits}).format(value);
  function syncBitrate(){
    const source=info(),automatic=el('BitrateMode').value==='auto',bounds=policy.bitrateBounds(source||{});
    el('Bitrate').setAttribute('aria-label',t('exportVideo.bitrate'));el('BitrateSlider').setAttribute('aria-label',t('exportVideo.bitrate'));el('Bitrate').readOnly=automatic;el('BitrateSlider').hidden=automatic;
    el('Bitrate').max=bounds.max?String(bounds.max/1000000):'';el('BitrateSlider').max=String(Math.max(.1,bounds.max/1000000));
    if(automatic&&source){const size=policy.dimensions(source,el('Resolution').value==='source'?Math.min(source.width,source.height):Number(el('Resolution').value));const value=policy.recommendedBitrate(source,{...size,fps:el('Fps').value==='source'?null:Number(el('Fps').value),codec:policy.formats[el('Format').value]?.codec});el('Bitrate').value=value?String(value/1000000):'';}
    el('BitrateSlider').value=el('Bitrate').value;
  }
  function settings() {
    const sourceInfo = info(), custom = mode() === 'custom';
    const format = custom ? el('Format').value : mode() === 'original' ? sourceInfo?.extension || 'mp4' : capabilities?.copyFormat || capabilities?.realtimeFormat || 'mp4';
    const dimensions = custom ? policy.dimensions(sourceInfo || {}, el('Resolution').value !== 'source' ? Number(el('Resolution').value) : Math.min(sourceInfo?.width || 0, sourceInfo?.height || 0)) : { width: sourceInfo?.width, height: sourceInfo?.height };
    return { mode: mode(), acceleration: DublineVideoAcceleration.get(), source: mode() === 'original' ? 'original' : custom ? el('Source').value : 'working', format,
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
      ['fps', policy.valid(source.fps) ? `${number(source.fps,3)}${source.variableFrameRate ? ' · VFR' : ''}` : t('exportVideo.unknown')],
      ['codec', ({ avc: 'H.264', hevc: 'H.265 (HEVC)' })[source.codec] || source.codec?.toUpperCase() || t('exportVideo.unknown')],
      ['bitrate', policy.valid(source.bitrate) ? number(source.bitrate / 1000000) + ' ' + t('exportVideo.mbps') : t('exportVideo.unknown')],
      ['file', `${source.container || t('exportVideo.unknown')} · ${formatSize(source.fileSize) || t('exportVideo.unknown')}`]];
    el('Metadata').replaceChildren(...values.map(([label, value]) => { const box = document.createElement('div'), name = document.createElement('span'), text = document.createElement('strong'); name.textContent = t('exportVideo.' + label); text.textContent = value; box.append(name, text); return box; }));
  }
  function configureSource() {
    const source = info(); if (!source) return;
    for (const option of el('Resolution').options) option.hidden = option.disabled = option.value !== 'source' && Number(option.value) > Math.min(source.width || 0, source.height || 0);
    for (const option of el('Fps').options) option.hidden = option.disabled = option.value !== 'source' && (!policy.valid(source.fps) || Number(option.value) > source.fps);
    if (el('Resolution').selectedOptions[0]?.disabled) el('Resolution').value = 'source';
    if (el('Fps').selectedOptions[0]?.disabled) el('Fps').value = 'source';
    syncBitrate();
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
    syncBitrate();
    const attempt = ++generation, chosen = settings(), source = chosen.sourceInfo;
    if (source) { for (const option of el('Fps').options) option.hidden = option.disabled = option.value !== 'source' && (!policy.valid(source.fps) || Number(option.value) > source.fps); }
    el('Custom').hidden = chosen.mode !== 'custom'; el('SoundLabel').hidden = !native();
    panel.querySelector('fieldset').setAttribute('aria-label', t('exportVideo.mode'));
    const originalOption = el('Source').querySelector('[value=original]'); originalOption.disabled = !amHost() || !metadata?.original; originalOption.dataset.disabledReason = t(!amHost() ? 'onlyHost' : !metadata ? 'exportVideo.loading' : metadata?.originalError || 'exportVideo.sourceMissing');
    if (chosen.mode === 'custom' && chosen.source === 'original' && originalOption.disabled) { el('Source').value = 'working'; configureSource(); return paint(); }
    const originalAudio = metadata?.original?.extension === 'webm' ? 'webm' : 'mp4';
    const original = panel.querySelector('input[value=original]'); original.disabled = !amHost() || !metadata?.original || !(capabilities?.audio[originalAudio] || capabilities?.audioMimes[originalAudio]);
    original.title = !amHost() ? t('onlyHost') : !metadata ? t('exportVideo.loading') : !metadata.original ? t(metadata.originalError || 'exportVideo.sourceMissing') : original.disabled ? t('exportVideo.unsupported') : ''; window.setControlHelp?.(original, original.disabled ? original.title : '');
    original.closest('label')?.setAttribute('aria-description', original.title);
    showMetadata();
    const bytes = source && policy.estimate(source, chosen);
    el('Estimate').textContent = bytes ? t('exportVideo.estimate', { size: formatSize(bytes) }) : t('exportVideo.noEstimate');
    let reason = !source || !capabilities ? 'exportVideo.loading' : !policy.valid(source.duration) ? 'exportVideo.sourceMissing' : null;
    const allowRealtimeVideo = chosen.acceleration !== 'off';
    let realtime = chosen.mode === 'fast' && !capabilities?.copyFormat;
    if (realtime && !allowRealtimeVideo) reason = 'exportVideo.unsupported';
    if (chosen.mode === 'original') reason = original.disabled ? !amHost() ? 'onlyHost' : 'exportVideo.unsupported' : null;
    if (chosen.mode === 'custom' && source && capabilities) {
      reason = policy.validate(source, chosen);
      const localEncoding = {};
      for (const option of el('Format').options) {
        const format = policy.formats[option.value];
        let supported = false;
        if (!reason && capabilities.webcodecs && capabilities.audio[option.value]) try {
          await DublineVideoAcceleration.encoderPreference(capabilities.mb, format.codec, { width: chosen.width, height: chosen.height, frameRate: chosen.fps || source.fps, bitrate: chosen.bitrate }, chosen.acceleration, source); supported = true;
        } catch { /* Another output format or the existing real-time path may be available. */ }
        localEncoding[option.value] = supported;
        const available = chosen.source === 'original' ? amHost() && (capabilities.audio[option.value] || capabilities.audioMimes[option.value]) : localEncoding[option.value] || allowRealtimeVideo && capabilities.realtime[option.value];
        if (attempt !== generation) return;
        option.disabled = !available; option.dataset.disabledReason = available ? '' : t(chosen.source === 'original' && !amHost() ? 'onlyHost' : 'exportVideo.unsupported');
      }
      if (el('Format').selectedOptions[0]?.disabled) { const available = [...el('Format').options].find(option => !option.disabled); if (available) { el('Format').value = available.value; return paint(); } reason = 'exportVideo.unsupported'; }
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
    el('Limits').textContent = chosen.mode === 'custom' && source ? t('exportVideo.limits', { width: unknown(source.width), height: unknown(source.height), fps:policy.valid(source.fps)?number(source.fps,3):unknown(source.fps), bitrate:policy.valid(source.bitrate)?number(policy.bitrateBounds(source).max/1000000) : t('exportVideo.unknown') }) : !native() ? t('exportVideo.browserMemory') : '';
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
    metadataAbort?.abort();metadataAbort=new AbortController();
    metadataKey = next; metadata = null; capabilities = null; metadataError = ''; ++generation;
    panel.dataset.ready = 'false'; panel.dataset.realtime = 'false';
    el('Retry').hidden = true;
    document.getElementById('startRenderBtn').disabled = true; el('Metadata').textContent = t('exportVideo.loading');
    const job = (async () => { try {
      const response = await fetch(`/api/video-export-info?room=${encodeURIComponent(currentRoom)}&clientId=${encodeURIComponent(clientId)}&sessionId=${encodeURIComponent(session.activeSessionId)}`,{signal:metadataAbort.signal});
      if (!response.ok) throw Error(await readError(response));
      const loaded = await response.json(); if (next !== key()) return;
      const available = await probe(loaded); if (next !== key()) return;
      metadata = loaded; capabilities = available;
      el('Source').value=amHost()&&loaded.original?'original':'working';
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
  el('BitrateSlider').addEventListener('input',()=>{el('Bitrate').value=el('BitrateSlider').value;void paint();});
  window.addEventListener('dubline-acceleration-changed', () => { if (!renderInProgress && capabilities) void paint(); });
  el('Retry').onclick = () => { void open(); };
  try { el('Sound').checked = localStorage.getItem('dubline_export_sound') !== '0'; } catch { /* Default sound remains available. */ }
  document.getElementById('revealVideoExportBtn').onclick = () => { if (lastSaved) void dublineVideoExport.reveal({ ticket: lastSaved.ticket }).catch(() => showToast(t('exportVideo.destinationExpired'))); };
  let planningAbort = null;
  window.cancelVideoRender = () => {
    if(document.getElementById('cancelVideoExportBtn').disabled)return;
    if(planningAbort || active) {document.getElementById('renderStatusText').dataset.state='cancelling';document.getElementById('renderStatusText').textContent=t('exportVideo.cancelling');document.getElementById('cancelVideoExportBtn').disabled=true;DublineBackgroundOperations.refresh();}
    planningAbort?.abort(); active?.abort.abort();
  };
  window.startVideoRender = async () => {
    if (planning || renderInProgress || recordState !== 'idle') return showToast(t('studio.mediaBusy'));
    if (pendingTakeLines.size || processingRecordings.size || editorQueue.length) return showToast(t('project.pendingTakes'));
    if (!session?.loaded) return showToast(t('error.noScene'));
    planning = true; lastResult = null; paintResult(); document.getElementById('renderProgressBox').style.display = 'block'; document.getElementById('revealVideoExportBtn').hidden = true; document.getElementById('renderStatusText').style.color = 'var(--text-secondary)'; document.getElementById('renderStatusText').dataset.state = 'preparing';
    let destination, job, lease, elapsedTimer, lastDetailedPaint = 0;
    const tracker = DublineExportProgress.create(), controller = new AbortController(); planningAbort = controller;
    const operations=DublineExportOperations.create(controller.signal);operations.own(()=>{if(metadataJob)metadataAbort?.abort();});
    document.getElementById('renderProgressDetails').replaceChildren(); document.getElementById('renderProgressBar').style.width = '0%';
    document.getElementById('cancelVideoExportBtn').hidden = false;
    const reportProgress = (phase, data = {}) => { tracker.update(phase, data); if (performance.now() - lastDetailedPaint >= 100 || data.state === 'done') { paintProgress(tracker); lastDetailedPaint = performance.now(); } };
    exportNotice={tracker,final:null};
    DublineBackgroundOperations.setLocal('export',()=>{
      const view=exportNotice.final||tracker.snapshot(),status=document.getElementById('renderStatusText').dataset.state;
      const state=['success','error','cancelled','cancelling'].includes(status)?status:'running';
      const row=[...view.rows].reverse().find(row=>row.phase!=='saving'&&row.state!=='done')||view.rows.at(-1);
      const amount=row?.unit==='count'?String(row.current||0):row?.unit==='bytes'?formatSize(row.current||0):clock(row?.current);
      const total=row?.unit==='count'?String(row.total||0):clock(row?.total);
      return {title:t(state==='success'?(lastResult?.saved?'review.exportSaved':'review.exportPrepared'):'exportVideo.title'),state,elapsed:view.elapsed,quiet:view.waitingForUser?0:view.quiet,percent:state==='success'?100:row?.total>0?100*(row.current||0)/row.total:null,text:state==='running'?(view.waitingForUser?t('exportProgress.chooseDestination'):row?t('exportProgress.'+(row.label||row.phase))+(Number.isFinite(row.current)?' · '+amount+(row.total?' / '+total:''):''):t('exportProgress.checking')):state==='success'?lastResult?.file||document.getElementById('renderStatusText').textContent:document.getElementById('renderStatusText').textContent,details:()=>{openFilesModal();switchFilesTab('export');},cancel:state==='running'||state==='cancelling'?()=>cancelVideoRender():null,canCancel:!document.getElementById('cancelVideoExportBtn').disabled,reveal:state==='success'&&lastSaved?()=>document.getElementById('revealVideoExportBtn').click():null};
    });
    reportProgress('checking', { unit: 'count' }); document.getElementById('renderStatusText').textContent = t('exportProgress.checking');
    elapsedTimer = setInterval(() => { paintProgress(tracker); job?.renew?.(); }, 1000);
    try {
      await operations.run('export-check',()=>open()); controller.signal.throwIfAborted(); if (panel.dataset.ready !== 'true') return;
      if (window.DublineSceneReview) await operations.run('file-check',()=>DublineSceneReview.checkFiles({ signal: controller.signal }));
      const report = window.DublineSceneReview?.snapshot(), dubGain = readRenderGains().dub; const inactiveTakeIssue = issue => issue.lineId != null && (dubGain <= 0 || DublineTakeMix.normalize(session.lines.find(line => line.id === issue.lineId)).volume <= 0); const fatal = report?.errors.find(issue => issue.key !== 'review.processing' && !inactiveTakeIssue(issue)); if (fatal) throw Error(t(fatal.key, fatal.params));
      // A known DSP failure is retried by strict preparation; it cannot fall back
      // to dry audio, and a successful retry clears that configuration's warning.
      const chosen = settings(); let snapshot = createExportSnapshot();
      // Hidden takes stay outside the exported guest mix. The existing reveal rules remain authoritative.
      snapshot.takes = snapshot.scene.lines.filter(line => line.audioUrl && canHearLine(line));
      const room = currentRoom, scene = session.activeSessionId;
      const reason = chosen.mode === 'custom' && policy.validate(chosen.sourceInfo, chosen); if (reason) throw Error(t(reason));
      if (panel.dataset.realtime === 'true' && !await askConfirm(t('exportVideo.realtimeConfirm', { format: chosen.format.toUpperCase() }))) return;
      if (chosen.audioRealtime && !await askConfirm(t('exportVideo.originalRealtime'))) return;
      reportProgress('checking', { state: 'done' });
      if (native()) {
        tracker.waiting(true); paintProgress(tracker);
        destination = await dublineVideoExport.choose({ extension: chosen.format, title: snapshot.scene.title, sessionId: scene, estimatedBytes: policy.estimate(chosen.sourceInfo, chosen) });
        tracker.waiting(false); controller.signal.throwIfAborted(); if (destination.canceled) return;
        if (!destination.ok) throw Error(t(destination.key));
        el('Destination').hidden = false; el('Destination').textContent = destination.directory + ' · ' + destination.name;
      }
      if (recordState !== 'idle' || room !== currentRoom || scene !== session?.activeSessionId) throw Error(t('render.sceneChanged'));
      const abort = controller; abort.signal.throwIfAborted();
      job = { id: newUploadId(), tracker, operations, report: reportProgress, destination, abort, sessionId: scene, bytes: 0, percent: 0, check: () => { operations.check(); abort.signal.throwIfAborted(); assertExportScene(snapshot); if (!socket.connected || room !== currentRoom) throw Error(t('exportVideo.authorization')); if (chosen.source === 'original' && !amHost()) throw Error(t('onlyHost')); } };
      active = job; renderInProgress = true; video.pause(); refreshStudioTransport(); applyVolumes();
      job.resetProgress = () => { tracker.restart(); lastDetailedPaint = 0; document.getElementById('renderProgressDetails').replaceChildren(); reportProgress('video', { current: 0, total: chosen.sourceInfo.duration, detail: t('acceleration.fallback') }); };
      const startedAt = performance.now(), progressBox = document.getElementById('renderProgressBox'); progressBox.style.display = 'block';
      let stage = t('render.readVideo'), lastPaint = 0;
      const showStage = () => { document.getElementById('renderStatusText').textContent = `${stage} · ${Math.floor((performance.now() - startedAt) / 1000)} ${t('takeHistory.seconds')}`; };
      let lastRenewal = performance.now(), renewing = false;
      job.renew = () => {
        if (lease?.ticket && !renewing && performance.now() - lastRenewal >= 60000) {
          renewing = true; lastRenewal = performance.now();
          void fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ room, clientId, ticket: lease.ticket }) }).then(response => { if (!response.ok) abort.abort(); }).catch(() => abort.abort()).finally(() => { renewing = false; });
        }
      };
      const progress = (percent, text) => {
        job.percent = Math.max(job.percent, Math.min(99, percent)); stage = text;
        if (percent < 97 && performance.now() - lastPaint < 100) return;
        lastPaint = performance.now(); document.getElementById('renderProgressBar').style.width = job.percent + '%'; showStage();
      };
      document.getElementById('cancelVideoExportBtn').hidden = false; document.getElementById('revealVideoExportBtn').hidden = true;
      await paint();
      progress(1, t('render.readVideo'));
      reportProgress('opening', {});
      const leaseResponse = await operations.run('export-lease',()=>fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ room, clientId, sessionId: scene, videoUrl: snapshot.videoUrl }) }));
      if (!leaseResponse.ok) throw Error(await readError(leaseResponse));
      lease = { ...await leaseResponse.json(), room }; job.check();
      const permitted = new Set(lease.takeIds);
      snapshot.scene = lease.scene; snapshot.takes = lease.scene.lines.filter(line => permitted.has(line.id));
      snapshot.takes.forEach(line => { line._exportNoise = window.DublineNoiseModel?.resolve(line, lease.scene) || null; line._exportVoice = window.DublineVoiceChain?.resolve(line, lease.scene); line._exportLevel = DublineProjectAudio.normalize(lease.scene).normalizeVoices; });
      snapshot.gains = readRenderGains(lease.scene);
      const sources = DublineProjectAudio.sources(lease.scene); snapshot.originalUrl = sources.original; snapshot.backingUrl = sources.backing;
      job.permitted = permitted;
      job.check = () => { operations.check(); abort.signal.throwIfAborted(); assertExportScene(snapshot); if (!socket.connected || room !== currentRoom || job.permissionInvalid) throw Error(t('exportVideo.authorization')); if (chosen.source === 'original' && !amHost()) throw Error(t('onlyHost')); };
      await operations.run('source-check',()=>waitForExportVideo(snapshot, job));
      reportProgress('opening', { state: 'done' });
      let result;
      if (chosen.source === 'original') result = await renderOriginalVideo(progress, snapshot, chosen, job);
      else if (panel.dataset.realtime === 'true') result = await renderRealtime(progress, snapshot, chosen, job);
      else result = await DublineVideoExportEngine.render(chosen, snapshot, progress, job);
      job.check(); progress(99, t('exportVideo.saving')); reportProgress('saving', { current: job.bytes, unit: 'bytes' });
      if (destination) {
        if (result.downloadUrl) {
          const response = await operations.run('file-download',()=>fetch(result.downloadUrl, { signal: abort.signal })); if (!response.ok) throw Error(await readError(response));
          const reader = response.body.getReader(), releaseReader=operations.own(()=>reader.cancel());
          try { for (;;) { const { done, value } = await operations.run('file-download-read',()=>reader.read()); if (done) break; for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) { job.check(); const saved = await operations.run('file-write',()=>dublineVideoExport.write({ ticket: destination.ticket, sessionId: scene, position: job.bytes, bytes: value.slice(offset, offset + 1024 * 1024) }),{position:job.bytes,bytes:Math.min(1024*1024,value.byteLength-offset)}); if (!saved.ok) throw Error(t(saved.key)); job.bytes = saved.bytes; reportProgress('saving', { current: job.bytes, total: result.bytes, unit: 'bytes' }); } } }
          finally { releaseReader(); void reader.cancel().catch(() => {}); }
        } else if (result.blob) {
          for (let offset = 0; offset < result.blob.size; offset += 1024 * 1024) { job.check(); const bytes=new Uint8Array(await operations.run('file-buffer-read',()=>result.blob.slice(offset, offset + 1024 * 1024).arrayBuffer())); const saved = await operations.run('file-write',()=>dublineVideoExport.write({ ticket: destination.ticket, sessionId: scene, position: offset, bytes }),{position:offset,bytes:bytes.byteLength}); if (!saved.ok) throw Error(t(saved.key)); job.bytes = saved.bytes; reportProgress('saving', { current: job.bytes, total: result.blob.size, unit: 'bytes' }); }
        }
        job.check(); document.getElementById('cancelVideoExportBtn').disabled = true;
        const saved = await dublineVideoExport.commit({ ticket: destination.ticket, sessionId: scene, bytes: job.bytes }); if (!saved.ok) throw Error(t(saved.key));
        job.bytes = saved.bytes; reportProgress('saving', { current: job.bytes, total: job.bytes, unit: 'bytes', state: 'done' }); lastSaved = destination; document.getElementById('revealVideoExportBtn').hidden = false;
        document.getElementById('renderProgressBar').style.width = '100%'; document.getElementById('renderStatusText').textContent = t('exportVideo.saved', { size: formatSize(saved.bytes) });
        if (el('Sound').checked && !saved.alreadySaved) await completionSound();
      } else {
        if (result.downloadUrl) { const link = document.createElement('a'); link.href = result.downloadUrl; link.download = result.filename; link.click(); }
        else downloadBlob(result.blob, result.ext, snapshot.scene.title);
        reportProgress('saving', { current: result.bytes || result.blob?.size, unit: 'bytes', state: 'done', label: 'download' });
        document.getElementById('renderStatusText').textContent = t('exportVideo.download', { size: formatSize(result.bytes || result.blob?.size) });
      }
      document.getElementById('renderProgressBar').style.width = '100%';
      document.getElementById('renderStatusText').style.color = 'var(--success)'; document.getElementById('renderStatusText').dataset.state = 'success';
      lastResult = { saved: !!destination, file: destination?.name || result.filename || policy.filename(snapshot.scene.title, result.ext || chosen.format), duration: chosen.sourceInfo.duration, format: String(result.ext || chosen.format).toUpperCase(), width: chosen.width, height: chosen.height, bytes: destination ? job.bytes : result.bytes || result.blob?.size, takes: snapshot.gains.dub > 0 ? snapshot.takes.filter(line => DublineTakeMix.normalize(line).volume > 0).length : 0, warnings: (report?.warnings.length || 0) + (report?.errors.filter(issue => issue.key !== 'review.processing' && inactiveTakeIssue(issue)).length || 0) }; paintResult();
    } catch (error) { const cancelled = error.name === 'AbortError' || job?.abort.signal.aborted; document.getElementById('renderStatusText').style.color = cancelled ? 'var(--text-secondary)' : 'var(--danger)'; document.getElementById('renderStatusText').dataset.state = cancelled ? 'cancelled' : 'error'; document.getElementById('renderProgressBox').style.display = 'block'; document.getElementById('renderStatusText').textContent = error.name === 'AbortError' || job?.abort.signal.aborted ? t('exportVideo.cancelled') : error.code === 'export-timeout' ? t('exportVideo.operationTimeout') : error.message; }
    finally {
      clearInterval(elapsedTimer); paintProgress(tracker, true); planningAbort = null; controller.abort(); operations.close();
      if (lease?.ticket) {
        const cleanup = new AbortController(), timer = setTimeout(() => cleanup.abort(), 3000);
        try { await fetch('/api/video-export-lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: cleanup.signal, body: JSON.stringify({ room: lease.room, clientId, ticket: lease.ticket, release: true }) }); } catch { /* Disconnect/expiry also releases server-side references. */ } finally { clearTimeout(timer); }
      }
      if (destination?.ticket && lastSaved?.ticket !== destination.ticket) await Promise.race([dublineVideoExport.cancel({ ticket: destination.ticket }).catch(() => {}),new Promise(resolve=>setTimeout(resolve,3000))]);
      if (job) { active = null; renderInProgress = false; refreshStudioTransport(); applyVolumes(); }
      if (!job && document.getElementById('renderStatusText').dataset.state === 'preparing') { document.getElementById('renderStatusText').dataset.state = 'cancelled'; document.getElementById('renderStatusText').textContent = t('exportVideo.cancelled'); }
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

  socket.on('video_export_progress', data => {
    if (!active || data?.progressId !== active.id || data.sessionId !== active.sessionId || !Number.isFinite(data.current) || !Number.isFinite(data.total)) return;
    if (Number.isSafeInteger(data.attempt)) {
      if (data.attempt < (active.remoteAttempt || 0)) return;
      if (data.attempt > (active.remoteAttempt || 0)) { if (data.attempt > 1) active.tracker.resetPhase('video'); active.remoteAttempt = data.attempt; }
    }
    active.report('video', { current: data.current, total: data.total, state: data.done ? 'done' : 'running', ...(data.backend ? { detail: t(data.backend === 'cpu-fallback' ? 'acceleration.fallback' : data.backend === 'gpu' ? 'acceleration.gpu' : 'acceleration.cpu') } : {}) });
  });
  const checkPermissions = () => { if (active?.permitted) active.permissionInvalid = !session?.lines || session.lines.some(line => active.permitted.has(line.id) && !canHearLine(line)); };
  socket.on('session_updated', () => { checkPermissions(); if (active && session?.activeSessionId !== active.sessionId) window.cancelVideoRender(); if (document.getElementById('tabContentExport').classList.contains('active')) void open(); });
  socket.on('line_updated', checkPermissions);
  socket.on('takes_updated', checkPermissions);
  socket.on('room_users_updated', checkPermissions);
  socket.on('disconnect', () => { window.cancelVideoRender(); });
  window.addEventListener('dubline-language-changed', () => { if (active?.tracker) paintProgress(active.tracker); void paint(); });
  window.DublineVideoExportPanel = Object.freeze({ open, refresh: paint, settings, completionSound, diagnostics:()=>active?.operations.snapshot()||null });
})();
