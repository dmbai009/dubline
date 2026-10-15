(() => {
  let sceneId = null, sourceId = '', hadReady = false, waiting = false, sample = null;
  let transfer = { downloading: false, fallback: false, pct: 0, buckets: [], downloadRate: 0 };
  let latest = null, lastSent = 0, renderTimer = null;
  let diagnosticGeneration = 0;
  window.videoPlaybackDiagnostic = null;
  const overlay = document.createElement('div'); overlay.id = 'mediaReadinessOverlay'; overlay.setAttribute('role', 'status'); overlay.hidden = true;
  overlay.innerHTML = '<div class="media-readiness-card"><span id="mediaReadinessMessage"></span><small id="mediaReadinessProgress"></small><div class="media-readiness-actions"><button type="button" id="mediaReadinessRetry" class="btn-outline"></button><button type="button" id="mediaReadinessCancel" class="btn-outline"></button></div><details id="mediaReadinessDetails"><summary></summary><p></p></details></div>';
  document.querySelector('.video-wrapper').append(overlay);
  const message = overlay.querySelector('span'), progress = overlay.querySelector('small'), retry = overlay.querySelector('#mediaReadinessRetry'), cancel = overlay.querySelector('#mediaReadinessCancel'), details = overlay.querySelector('details');
  retry.onclick = () => { if (!socket.connected || !window.hasSceneMediaAccess?.()) return; const time = video.currentTime; if (video.error && DublineMediaTransfer.stats().status !== 'failed') { video.load(); video.addEventListener('loadedmetadata', () => { if (Number.isFinite(video.duration)) video.currentTime = Math.min(time, video.duration); }, { once: true }); } else window.retrySceneMedia?.(); };
  cancel.onclick = () => cancelMediaDownload(true);
  function bufferedSeconds() {
    for (let index = 0; index < video.buffered.length; index++) if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) return video.buffered.end(index) - video.currentTime;
    return 0;
  }
  function scope() {
    if (sceneId !== session?.activeSessionId) {
      sceneId = session?.activeSessionId; sourceId = ''; hadReady = false; waiting = false; sample = null;
      transfer = { downloading: false, fallback: false, pct: 0, buckets: [], downloadRate: 0 };
      diagnosticGeneration++; window.videoPlaybackDiagnostic = null;
    }
    const source = video.currentSrc || video.getAttribute('src') || '';
    if (source !== sourceId) { sourceId = source; waiting = false; sample = null; hadReady = false; diagnosticGeneration++; window.videoPlaybackDiagnostic = null; }
  }
  function advancing() {
    const now = performance.now(), previous = sample;
    sample = { at: now, time: video.currentTime };
    if (!previous || video.paused || video.seeking || video.ended || video.error || video.readyState < 2) return false;
    const elapsed = (now - previous.at) / 1000, delta = video.currentTime - previous.time;
    // A seek/jump is not decoder progress. Waiting may recover without canplay,
    // but only from plausible continuous playback with data at the current frame.
    return elapsed > 0 && elapsed < 3 && delta > .005 && delta <= Math.max(.25, elapsed * video.playbackRate * 1.8) &&
      (video.readyState >= 3 || bufferedSeconds() > .02);
  }
  function report(force = false) {
    scope();
    if (!session?.loaded || !socket.connected || !session.videoHash || !session.videoSize) { overlay.hidden = true; sample = null; return; }
    const moving = advancing();
    if (moving) waiting = false;
    const decodable = (video.readyState >= 3 || moving) && !video.error;
    if (decodable) hadReady = true;
    const state = video.error ? 'failed' : transfer.downloading ? 'downloading' : waiting && (!video.paused || !decodable) || hadReady && !decodable ? 'buffering' : decodable ? transfer.fallback ? 'fallback' : 'ready' : 'preparing';
    const pct = transfer.downloading ? transfer.pct : transfer.pct >= 100 ? 100 : hadReady ? 100 : 0;
    const data = { sessionId: sceneId, mediaId: `${session.videoHash}:${session.videoSize}:262144:1`, state, pct,
      bufferedSeconds: bufferedSeconds(), buckets: transfer.buckets, downloadRate: transfer.downloadRate,
      uploadRate: window.mediaUploadRate?.() || 0 };
    const changed = latest?.state !== state || latest?.sessionId !== sceneId;
    overlay.hidden = ['ready', 'fallback'].includes(state) || state === 'downloading' && decodable && (window.isWatchingHostMedia?.() || transfer.videoReady);
    const errorKey = { 1: 'media.aborted', 2: 'media.networkFailed', 3: 'media.decodeFailed', 4: 'media.unsupported' }[video.error?.code];
    const media = window.DublineMediaTransfer?.stats(), errorStatus = media?.error?.status, failedTransfer = media?.status === 'failed' && !decodable;
    const preparation = window.sceneMediaPreparation?.(), authorization = media?.status === 'waiting_for_authorization' || [401, 403].includes(errorStatus), cancelled = media?.status === 'cancelled' && !decodable;
    const verifying = transfer.downloading && media?.diagnostic?.phase === 'verification';
    const key = authorization ? [401, 403].includes(errorStatus) ? 'media.transfer.error.403' : 'media.transfer.authorization' : cancelled ? 'media.transfer.state.cancelled' : failedTransfer ? 'media.transfer.error.' + ([403, 404, 409, 416, 429].includes(errorStatus) ? errorStatus : errorStatus >= 500 ? 'server' : 'network') : verifying ? 'media.transfer.phase.verification' : state === 'failed' && errorKey ? errorKey : preparation?.key ? preparation.loading ? 'media.preparingAudio' : preparation.key : 'media.' + state;
    if (authorization || cancelled || failedTransfer || preparation?.key) overlay.hidden = false;
    overlay.dataset.phase = verifying ? 'checking' : authorization ? 'access' : cancelled ? 'cancelled' : failedTransfer ? 'network' : state === 'failed' ? 'decode' : preparation?.key ? 'audio' : state;
    message.textContent = t(key, { pct: Math.round(pct), status: errorStatus, channels: (preparation?.channels || []).map(channel => t('studio.' + channel)).join(', ') });
    progress.hidden = !transfer.downloading || verifying; progress.textContent = transfer.downloading ? [Number.isFinite(transfer.totalBytes) && transfer.totalBytes > 0 ? `${formatSize(transfer.receivedBytes || 0)} / ${formatSize(transfer.totalBytes)}` : '', transfer.downloadRate > 0 ? `${formatSize(transfer.downloadRate)}/s` : ''].filter(Boolean).join(' · ') : '';
    retry.textContent = t('media.transfer.retry'); retry.hidden = !(state === 'failed' || failedTransfer || cancelled); retry.disabled = !socket.connected || !window.hasSceneMediaAccess?.();
    cancel.textContent = t('media.cancel'); cancel.hidden = !transfer.downloading;
    details.hidden = !(state === 'failed' || failedTransfer || authorization); details.querySelector('summary').textContent = t('media.details');
    const info = window.videoPlaybackDiagnostic;
    const safe = value => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9 ._+/:;-]/g, '').slice(0, 100) : '';
    details.querySelector('p').textContent = [info?.code ? `MediaError ${Number(info.code)}` : '', Number.isInteger(info?.status ?? errorStatus) ? `HTTP ${info?.status ?? errorStatus}` : '', safe(info?.codec), safe(info?.profile), safe(info?.pixelFormat), safe(info?.mime), media?.diagnostic?.phaseLabel || '', t('media.safeDetails')].filter(Boolean).join(' · '); overlay.title = '';
    if (!force && !changed && performance.now() - lastSent < 1000) return;
    latest = data; lastSent = performance.now();
    socket.emit('media_presence_update', data);
  }
  window.refreshMediaReadiness = () => report(true);
  window.addEventListener('dubline-language-changed', () => report(true));
  window.updateMediaTransfer = data => { scope(); transfer = { ...transfer, ...data }; report(true); };
  video.addEventListener('error', async () => {
    scope();
    if (typeof fetch !== 'function' || typeof clientId === 'undefined' || !session?.loaded || !socket.connected) return;
    const generation = ++diagnosticGeneration, id = session.activeSessionId, source = sourceId, url = session.videoUrl;
    const diagnostic = { code: video.error?.code };
    try {
      const response = await fetch(`/api/video-diagnostics?${new URLSearchParams({ room: currentRoom, sessionId: id, clientId })}`);
      if (response.ok) Object.assign(diagnostic, await response.json());
      const range = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      Object.assign(diagnostic, { status: range.status, mime: range.headers.get('Content-Type'), range: range.headers.get('Content-Range') });
      await range.body?.cancel();
    } catch { /* The MediaError still explains the observed failure when diagnostics are unavailable. */ }
    if (generation !== diagnosticGeneration || session.activeSessionId !== id || sourceId !== source) return;
    window.videoPlaybackDiagnostic = diagnostic; report(true);
  });
  for (const event of ['loadstart', 'emptied', 'seeking']) video.addEventListener(event, () => { sample = null; if (event !== 'seeking') { waiting = false; hadReady = false; } });
  for (const event of ['loadedmetadata', 'loadstart', 'emptied', 'error', 'progress', 'seeked']) video.addEventListener(event, () => report(true));
  for (const event of ['waiting', 'stalled']) video.addEventListener(event, () => { sample = null; waiting = true; report(true); });
  for (const event of ['playing', 'canplay', 'canplaythrough']) video.addEventListener(event, () => { waiting = false; report(true); });
  socket.on('session_updated', () => report(true)); socket.on('connect', () => report(true));
  video.addEventListener('timeupdate', () => report());
  setInterval(() => report(), 1000);
  socket.on('media_presence', data => {
    if (!data || data.sessionId !== session?.activeSessionId || !Array.isArray(data.players)) return;
    const terminal = data.players.some(player => ['ready', 'failed'].includes(player.state) && playerActivities.get(player.nick)?.state !== player.state);
    playerActivities.clear();
    for (const player of data.players) if (player.nick) playerActivities.set(player.nick, player);
    clearTimeout(renderTimer);
    if (terminal) renderLobby();
    else renderTimer = setTimeout(renderLobby, document.hidden ? 3000 : 150);
  });
})();
