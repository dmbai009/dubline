(() => {
  let sceneId = null, sourceId = '', hadReady = false, waiting = false, sample = null;
  let transfer = { downloading: false, fallback: false, pct: 0, buckets: [], downloadRate: 0 };
  let latest = null, lastSent = 0, renderTimer = null;
  const overlay = document.createElement('div'); overlay.id = 'mediaReadinessOverlay'; overlay.setAttribute('role', 'status'); overlay.hidden = true;
  document.querySelector('.video-wrapper').append(overlay);
  function bufferedSeconds() {
    for (let index = 0; index < video.buffered.length; index++) if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) return video.buffered.end(index) - video.currentTime;
    return 0;
  }
  function scope() {
    if (sceneId !== session?.activeSessionId) {
      sceneId = session?.activeSessionId; sourceId = ''; hadReady = false; waiting = false; sample = null;
      transfer = { downloading: false, fallback: false, pct: 0, buckets: [], downloadRate: 0 };
    }
    const source = video.currentSrc || video.getAttribute('src') || '';
    if (source !== sourceId) { sourceId = source; waiting = false; sample = null; hadReady = false; }
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
    overlay.hidden = ['ready', 'fallback'].includes(state);
    overlay.textContent = t('media.' + state, { pct: Math.round(pct) });
    if (!force && !changed && performance.now() - lastSent < 1000) return;
    latest = data; lastSent = performance.now();
    socket.emit('media_presence_update', data);
  }
  window.updateMediaTransfer = data => { scope(); transfer = { ...transfer, ...data }; report(true); };
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
