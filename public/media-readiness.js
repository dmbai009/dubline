(() => {
  let sceneId = null, hadReady = false, waiting = false;
  let transfer = { downloading: false, fallback: false, pct: 0, buckets: [], downloadRate: 0 };
  let latest = null, lastSent = 0, renderTimer = null;
  const overlay = document.createElement('div'); overlay.id = 'mediaReadinessOverlay'; overlay.setAttribute('role', 'status'); overlay.hidden = true;
  document.querySelector('.video-wrapper').append(overlay);
  function bufferedSeconds() {
    for (let index = 0; index < video.buffered.length; index++) if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) return video.buffered.end(index) - video.currentTime;
    return 0;
  }
  function report(force = false) {
    if (!session?.loaded || !socket.connected || !session.videoHash || !session.videoSize) { overlay.hidden = true; return; }
    if (sceneId !== session.activeSessionId) { sceneId = session.activeSessionId; hadReady = false; waiting = false; transfer = { downloading: false, fallback: false, pct: 0, buckets: [], downloadRate: 0 }; }
    const decodable = video.readyState >= 3 && !video.error;
    if (decodable) hadReady = true;
    const state = video.error ? 'failed' : transfer.downloading ? 'downloading' : waiting || hadReady && !decodable ? 'buffering' : decodable ? transfer.fallback ? 'fallback' : 'ready' : 'preparing';
    const pct = transfer.downloading ? transfer.pct : transfer.pct >= 100 ? 100 : hadReady ? 100 : 0;
    const data = { sessionId: sceneId, mediaId: `${session.videoHash}:${session.videoSize}:262144:1`, state, pct,
      bufferedSeconds: bufferedSeconds(), buckets: transfer.buckets, downloadRate: transfer.downloadRate,
      uploadRate: window.mediaUploadRate?.() || 0 };
    const changed = latest?.state !== state || latest?.sessionId !== sceneId;
    overlay.hidden = ['ready', 'fallback'].includes(state);
    overlay.textContent = t('media.' + state, { pct: Math.round(pct) });
    if (!force && !changed && performance.now() - lastSent < 1000) return;
    latest = data; lastSent = performance.now();
    socket.emit('media_presence_update', data);
  }
  window.updateMediaTransfer = data => { transfer = { ...transfer, ...data }; report(true); };
  for (const event of ['loadedmetadata', 'loadstart', 'emptied', 'error', 'progress', 'seeked']) video.addEventListener(event, () => report(true));
  for (const event of ['waiting', 'stalled']) video.addEventListener(event, () => { waiting = true; report(true); });
  for (const event of ['playing', 'canplay', 'canplaythrough']) video.addEventListener(event, () => { waiting = false; report(true); });
  socket.on('session_updated', () => report(true)); socket.on('connect', () => report(true));
  setInterval(() => report(), 5000);
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
