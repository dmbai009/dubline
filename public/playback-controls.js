(() => {
  const allowedRates = [1, 1.25, 1.5, 2, 3, 4];
  const transport = document.querySelector('.studio-transport');
  let master = 1;
  try { const value = localStorage.getItem('dubline_master_volume'); if (value !== null && Number.isFinite(Number(value))) master = Math.max(0, Math.min(1, Number(value))); } catch { /* private mode */ }
  window.localMasterVolume = () => master;
  const masterSlider = document.createElement('input');
  Object.assign(masterSlider, { type: 'range', id: 'masterVolume', min: '0', max: '100', step: '1', value: String(Math.round(master * 100)) });
  masterSlider.dataset.resetValue = '100'; masterSlider.dataset.resetEvent = 'input'; masterSlider.setAttribute('aria-label', t('playback.master'));
  const masterLabel = document.createElement('label'); masterLabel.className = 'transport-master';
  const mute = document.createElement('button'); mute.type = 'button'; mute.id = 'masterMute'; mute.className = 'btn-icon';
  const speaker = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/>' ;
  function syncMute() {
    mute.innerHTML = speaker + (volumes.isMuted ? '<path d="m17 9 5 6m0-6-5 6"/>' : '<path d="M17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>') + '</svg>';
    mute.setAttribute('aria-pressed', String(volumes.isMuted));
    mute.title = t(volumes.isMuted ? 'playback.unmute' : 'playback.mute'); mute.setAttribute('aria-label', mute.title);
  }
  mute.onclick = () => window.setListeningMuted(!volumes.isMuted);
  window.addEventListener('dubline-listening-volume-changed', syncMute); window.addEventListener('dubline-language-changed', syncMute);
  syncMute(); masterLabel.append(mute, masterSlider); const masterValue = document.createElement('output'); masterValue.textContent = masterSlider.value + '%'; masterLabel.append(masterValue);
  masterSlider.addEventListener('input', () => { master = Number(masterSlider.value) / 100; try { localStorage.setItem('dubline_master_volume', String(master)); } catch { /* private mode */ } masterValue.textContent = masterSlider.value + '%'; applyVolumes(); window.dispatchEvent(new Event('dubline-listening-volume-changed'));  });
  transport.append(masterLabel);
  const cc = document.createElement('button'); cc.className = 'btn-icon'; cc.id = 'transportCC'; cc.textContent = 'CC'; cc.setAttribute('aria-label', t('playback.cc'));
  function syncCC() { cc.classList.toggle('active', prompterEnabled); cc.setAttribute('aria-pressed', String(prompterEnabled)); }
  cc.addEventListener('click', () => { prompterEnabled = !prompterEnabled; try { localStorage.setItem('dubline_prompter', prompterEnabled ? '1' : '0'); } catch { /* private mode */ } updatePrompter(); syncCC(); });
  transport.append(cc); syncCC(); document.getElementById('settingsPrompter').addEventListener('change', syncCC);
  const speed = document.createElement('select'); speed.id = 'previewRate'; speed.className = 'text-input'; speed.setAttribute('aria-label', t('playback.speed'));
  for (const rate of allowedRates) { const option = document.createElement('option'); option.value = String(rate); option.textContent = `${rate}×`; speed.append(option); }
  window.setPreviewRate = (rate, remote = false) => {
    if (!allowedRates.includes(rate) || !remote && (recordState !== 'idle' || watchMode && !amHost())) return false;
    if (video.playbackRate === rate) { speed.value = String(rate); return true; }
    stopAllTakes(); audio.stopPreview();
    video.preservesPitch = true; video.playbackRate = rate; speed.value = String(rate);
    backing.preservesPitch = true; originalTrackAudio.preservesPitch = true;
    window.syncProjectSources?.(true); precacheTakes();
    if (!remote) window.sendHostSync?.();
    return true;
  };
  speed.addEventListener('change', () => { if (!setPreviewRate(Number(speed.value))) speed.value = String(video.playbackRate); }); transport.append(speed);
  const seek = document.createElement('input'); Object.assign(seek, { type: 'range', id: 'transportSeek', min: '0', max: '1', step: '0.001', value: '0' }); seek.setAttribute('aria-label', t('playback.seek'));
  seek.addEventListener('input', () => { if (studioCanTransport()) { window.transportScrubbing = true; video.currentTime = Number(seek.value); window.sendHostSync?.(true); } });
  const finishSeek = () => { if (window.transportScrubbing) { window.transportScrubbing = false; window.sendHostSync?.(false); } };
  for (const event of ['change', 'blur']) seek.addEventListener(event, finishSeek);
  for (const event of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(event, finishSeek);
  transport.prepend(seek);
  window.addEventListener('dubline-language-changed', () => {
    for (const [control, key] of [[masterSlider, 'master'], [cc, 'cc'], [speed, 'speed'], [seek, 'seek']]) control.setAttribute('aria-label', t('playback.' + key));
  });
  function refresh() {
    seek.max = String(Number.isFinite(video.duration) ? video.duration : 0);
    if (!window.transportScrubbing) seek.value = String(video.currentTime);
    seek.disabled = !studioCanTransport(); speed.disabled = recordState !== 'idle' || !!(watchMode && !amHost()) || !!renderInProgress;
  }
  for (const event of ['timeupdate', 'loadedmetadata', 'play', 'pause', 'ratechange']) video.addEventListener(event, refresh);
  let sceneId = session?.activeSessionId;
  socket.on('session_updated', () => { if (sceneId !== session?.activeSessionId) { finishSeek(); sceneId = session?.activeSessionId; setPreviewRate(1, true); } refresh(); });
  for (const event of ['watch_start', 'watch_stop', 'watch_sync']) socket.on(event, refresh);
  refresh(); applyVolumes();
  let idleTimer = null, pointerDown = false;
  const wrapper = document.querySelector('.video-wrapper');
  function reveal() {
    wrapper.classList.remove('fullscreen-idle'); clearTimeout(idleTimer);
    if (document.fullscreenElement !== wrapper || video.paused || recordState !== 'idle') return;
    idleTimer = setTimeout(() => {
      if (pointerDown || transport.matches(':hover') || transport.contains(document.activeElement) || video.paused || recordState !== 'idle') return;
      wrapper.classList.add('fullscreen-idle');
    }, 2500);
  }
  wrapper.addEventListener('pointermove', reveal); wrapper.addEventListener('pointerdown', () => { pointerDown = true; reveal(); });
  window.addEventListener('pointerup', () => { pointerDown = false; reveal(); }); window.addEventListener('pointercancel', () => { pointerDown = false; reveal(); });
  window.addEventListener('keydown', reveal); document.addEventListener('fullscreenchange', reveal);
  video.addEventListener('play', reveal); video.addEventListener('pause', reveal); transport.addEventListener('focusin', reveal); transport.addEventListener('focusout', reveal); transport.addEventListener('pointerleave', reveal);
})();
