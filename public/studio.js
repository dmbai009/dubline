// Project mix is shared. Monitoring, ADR and layout are private to this device.
(() => {
  'use strict';
  const model = window.DublineProjectAudio;
  const pending = new Map(), waves = new Map();
  const sourcePositions = new WeakMap();
  let busy = false, inFlight = null, generation = 0, sceneId = '', waveFrame = 0;
  let mixMode = localStorage.getItem('dubline_mix_mode') === 'monitor' ? 'monitor' : 'project';
  let monitors = {};
  try { monitors = JSON.parse(localStorage.getItem('dubline_monitor_mix') || '{}') || {}; } catch { /* invalid preference */ }
  if (typeof monitors !== 'object' || Array.isArray(monitors)) monitors = {};
  const project = () => model.normalize(session || {});
  const projectIntent = (channel, field) => {
    const queued = pending.get(`${channel}:${field}`);
    if (queued) return queued.value;
    if (inFlight && inFlight.channel === channel && inFlight.field === field) return inFlight.value;
    return project()[channel][field];
  };
  const monitorKey = () => `${currentRoom}:${session && session.activeSessionId || ''}`;
  const personal = () => monitors[monitorKey()] ? model.normalize({ ...session, projectAudio: monitors[monitorKey()] }) : project();
  const canMix = () => !!(session && session.loaded && socket.connected && (amHost() || session.mode === 'edit'));
  window.studioAudioEnd = () => {
    if (!session || !session.loaded) return 0;
    const sources = model.sources(session), mix = project();
    return Math.max(0, ...['original', 'backing'].map(channel => {
      const duration = waves.get(sources[channel])?.duration || session.audioMetadata?.[channel]?.duration || 0;
      return duration ? duration + mix[channel].offset : 0;
    }));
  };
  function saveMonitors() {
    const keys = Object.keys(monitors);
    for (const key of keys.slice(0, Math.max(0, keys.length - 20))) delete monitors[key];
    localStorage.setItem('dubline_monitor_mix', JSON.stringify(monitors));
  }
  // Auto-ducking: the project setting is shared and used by export; a player may turn on
  // their own setting, which then applies only to what they hear
  let localDuck = { enabled: false, autoDuckEnabled: true, autoDuckAmount: 0.4 };
  try { localDuck = { ...localDuck, ...JSON.parse(localStorage.getItem('dubline_local_duck') || '{}') }; } catch { /* invalid preference */ }
  localDuck.autoDuckAmount = Math.max(0, Math.min(0.8, Number(localDuck.autoDuckAmount) || 0));
  window.studioLocalDuck = () => ({ ...localDuck });
  window.setStudioLocalDuck = changes => {
    localDuck = { ...localDuck, ...changes };
    localDuck.autoDuckAmount = Math.max(0, Math.min(0.8, Number(localDuck.autoDuckAmount) || 0));
    localStorage.setItem('dubline_local_duck', JSON.stringify(localDuck));
    applyVolumes(); window.syncStudioSettings();
  };
  window.studioPlaybackSettings = () => {
    if (localDuck.enabled) return { autoDuckEnabled: !!localDuck.autoDuckEnabled, autoDuckAmount: localDuck.autoDuckAmount };
    const mix = project();
    return { autoDuckEnabled: mix.autoDuckEnabled, autoDuckAmount: mix.autoDuckAmount };
  };
  window.studioPlaybackVolumes = () => {
    const gain = model.gains(mixMode === 'monitor' ? personal() : project());
    return { original: gain.original, backing: gain.backing, recorded: gain.dub, isMuted: volumes.isMuted };
  };
  function applyMix(result) {
    if (!session || result.sessionId !== session.activeSessionId || !result.mix || result.mix.revision < project().revision) return;
    const previousEnd = window.studioAudioEnd();
    session.projectAudio = model.normalize({ ...session, projectAudio: result.mix });
    autoDuckEnabled = session.projectAudio.autoDuckEnabled;
    autoDuckAmount = session.projectAudio.autoDuckAmount;
    applyVolumes(); window.syncProjectSources(); refreshControls(); drawWaves();
    if (previousEnd !== window.studioAudioEnd()) renderTimeline();
  }
  window.updateProjectAudio = (channel, field, value) => {
    if (!canMix()) { refreshControls(); return showToast(t('studio.mixLocked')); }
    pending.set(`${channel}:${field}`, { channel, field, value }); pump();
  };
  function pump() {
    if (busy || !pending.size || !canMix()) return;
    const [key, change] = pending.entries().next().value;
    pending.delete(key);
    const id = session.activeSessionId, token = generation;
    busy = true; inFlight = change;
    const { retries, ...request } = change;
    socket.timeout(5000).emit('project_audio_update', { ...request, sessionId: id, revision: project().revision }, (error, result) => {
      if (token !== generation || !session || session.activeSessionId !== id) return;
      busy = false; inFlight = null;
      if (result && result.mix) applyMix(result);
      // Someone else changed the mix first: each change sets one field, so it is safe to
      // send it again on top of their revision (unless a newer value for it is already queued)
      if (result && result.reason === 'conflict' && (change.retries || 0) < 3) {
        const key = `${change.channel}:${change.field}`;
        if (!pending.has(key)) pending.set(key, { ...change, retries: (change.retries || 0) + 1 });
        return pump();
      }
      if (error || !result || !result.ok) { pending.clear(); showToast(t('studio.mixConflict')); refreshControls(); return; }
      pump();
    });
  }
  function update(channel, field, value) {
    if (mixMode === 'project' && field !== 'offset' && !canMix() && session && session.loaded) {
      // Start the personal mix from what they hear now (the project mix), then change it
      if (!monitors[monitorKey()]) monitors[monitorKey()] = project();
      mixMode = 'monitor';
      localStorage.setItem('dubline_mix_mode', mixMode);
      showToast(t('studio.switchedToMonitor'));
    }
    if (mixMode === 'project' || field === 'offset') return window.updateProjectAudio(channel, field, value);
    const mix = personal(); mix[channel][field] = value; monitors[monitorKey()] = mix;
    saveMonitors(); applyVolumes(); refreshControls();
  }
  socket.on('project_audio_updated', applyMix);
  socket.on('disconnect', () => { generation++; pending.clear(); busy = false; inFlight = null; refreshControls(); });
  const retryWaves = () => {
    for (const entry of waves.values()) if (entry.retryable) { clearTimeout(entry.retryTimer); entry.retryAt = 0; entry.failures = 0; }
    drawWaves();
  };
  socket.on('connect', retryWaves);
  window.addEventListener('online', retryWaves);
  socket.on('session_updated', () => {
    const next = session && session.activeSessionId || '';
    if (sceneId !== next) { generation++; pending.clear(); busy = false; inFlight = null; sceneId = next; }
    if (session && session.loaded) applyMix({ sessionId: next, mix: project() });
    refreshTransport();
  });
  socket.on('room_users_updated', () => { refreshControls(); refreshTransport(); });
  socket.on('latency_updated', () => window.syncStudioSettings());
  for (const event of ['watch_start', 'watch_stop', 'watch_sync']) socket.on(event, refreshTransport);
  window.studioCanTransport = () => !!(session && session.loaded && recordState === 'idle' && !renderInProgress && (!watchMode || amHost()));
  window.studioTransport = action => {
    if (action === 'expand') return toggleExpandedVideo();
    if (action === 'fullscreen') return toggleVideoFullscreen();
    if (!window.studioCanTransport()) return;
    if (action === 'play') { ensurePlayCtx(); if (video.paused) video.play().catch(() => {}); else video.pause(); }
    if (action === 'pause') video.pause();
    if (action === 'back' || action === 'forward') video.currentTime = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : 43200, video.currentTime + (action === 'back' ? -3 : 3)));
  };
  function refreshTransport() {
    const recordButton = document.getElementById('recBtn'); if (recordButton) recordButton.disabled = renderInProgress;
    const exportButton = document.getElementById('startRenderBtn'); if (exportButton) exportButton.disabled = renderInProgress || recordState !== 'idle';
    const time = value => `${Math.floor((value || 0) / 60)}:${String(Math.floor((value || 0) % 60)).padStart(2, '0')}`;
    document.querySelector('[data-studio-time]').textContent = `${time(video.currentTime)} / ${time(Number.isFinite(video.duration) ? video.duration : 0)}`;
    for (const button of document.querySelectorAll('.studio-transport [data-studio-action]')) {
      const action = button.dataset.studioAction;
      if (['play', 'back', 'forward'].includes(action)) button.disabled = !window.studioCanTransport();
      if (action === 'play') button.textContent = video.paused ? '▶' : 'Ⅱ';
    }
  }
  window.refreshStudioTransport = refreshTransport;
  // Offsets are shared even when a listener has a personal volume override.
  window.syncProjectSources = (force = false) => {
    if (!session || !session.loaded) return;
    const mix = project();
    for (const [channel, element] of [['original', originalTrackAudio], ['backing', backing]]) {
      if (!element.getAttribute('src') || element.readyState < 1) continue;
      const wanted = model.sourceTime(video.currentTime, mix[channel].offset);
      const duration = Number.isFinite(element.duration) ? element.duration : Infinity;
      const inRange = wanted >= 0 && wanted < duration;
      const next = Math.max(0, Math.min(duration, wanted));
      const src = element.getAttribute('src'), previous = sourcePositions.get(element);
      const changed = !previous || previous.src !== src || previous.offset !== mix[channel].offset;
      sourcePositions.set(element, { src, offset: mix[channel].offset });
      // Lip sync: a drift over 40 ms is audible. Up to 250 ms it is pulled in by playing the
      // source up to 5 % faster or slower (no audible jump); a larger one, a source change or
      // an explicit resync (play / seek) jumps straight to the right position.
      const drift = element.currentTime - next;
      const jump = changed ? 0.001 : force ? 0.015 : 0.25;
      let rate = video.playbackRate;
      if (Math.abs(drift) > jump) element.currentTime = next;
      else if (Math.abs(drift) > 0.02 && !video.paused) rate = video.playbackRate * (1 - Math.max(-0.05, Math.min(0.05, drift * 0.5)));
      if (Math.abs(element.playbackRate - rate) > 0.001) element.playbackRate = rate;
      if (video.paused || video.seeking || video.ended || video.readyState < 3 || renderInProgress || !inRange) element.pause();
      else if (element.paused) element.play().catch(() => {});
    }
  };
  for (const element of [backing, originalTrackAudio]) element.addEventListener('loadedmetadata', () => window.syncProjectSources(true));
  for (const event of ['play', 'pause', 'seeked', 'timeupdate', 'loadedmetadata']) video.addEventListener(event, refreshTransport);
  video.addEventListener('waiting', () => { backing.pause(); originalTrackAudio.pause(); });
  video.addEventListener('playing', () => window.syncProjectSources(true));
  // The audio group starts collapsed: the role tracks with the lines are what most people need
  const audioCollapsed = () => localStorage.getItem('dubline_audio_collapsed') !== '0';
  window.renderStudioAudio = trackWidth => {
    // Detach the persistent picker before the timeline's next innerHTML reset.
    const header = document.createElement('div'); header.className = 'studio-audio-header';
    header.style.width = `${timelineContainer.clientWidth}px`;
    const collapsed = audioCollapsed();
    header.innerHTML = `<button class="btn-icon" data-studio-action="audio" aria-expanded="${!collapsed}">${collapsed ? '▶' : '▼'} ${esc(t('studio.audio'))}</button>
      <select class="text-input studio-select" data-studio-mix aria-label="${esc(t('studio.mixMode'))}"><option value="project">${esc(t('studio.projectMix'))}</option><option value="monitor">${esc(t('studio.monitor'))}</option></select>
      <button class="btn-icon" data-studio-action="monitor-reset" title="${esc(t('studio.monitorReset'))}">⟲</button><span class="studio-mix-note"></span>`;
    timeline.appendChild(header);
    header.after(trackPicker); trackPicker.hidden = collapsed;
    if (!collapsed) for (const channel of model.CHANNELS) {
      const row = document.createElement('div'); row.className = 'studio-audio-row'; row.dataset.audioChannel = channel;
      const names = { original: 'Original', backing: 'Intershum / M&E', dub: 'Dub' };
      const ids = { original: 'volOriginal', backing: 'volBacking', dub: 'volRecorded' };
      row.innerHTML = `<div class="track-label"><div class="studio-channel-head"><b>${names[channel]}</b>
        <button class="btn-icon" data-audio-field="muted" title="${esc(t('studio.mute'))}">M</button><button class="btn-icon" data-audio-field="solo" title="${esc(t('studio.solo'))}">S</button></div>
        <label class="studio-channel-volume"><input type="range" id="${ids[channel]}" min="0" max="${model.MAX_VOLUME * 100}" data-audio-field="volume" aria-label="${names[channel]} volume"><output></output></label>
        ${channel !== 'dub' ? `<label class="studio-channel-offset"><span>${esc(t('studio.offset'))}</span><input class="text-input" type="number" min="-43200" max="43200" step="0.001" data-audio-field="offset" aria-label="${names[channel]} offset"><span>s</span></label>` : ''}
        </div><div class="studio-wave-area" style="width:${trackWidth}px"><canvas></canvas><span class="studio-wave-status"></span><div class="studio-wave-source"></div></div>`;
      timeline.appendChild(row);
    }
    refreshControls(); drawWaves();
  };
  function refreshControls() {
    if (!session) return;
    const mix = mixMode === 'monitor' ? personal() : project();
    const select = document.querySelector('[data-studio-mix]'); if (select) select.value = mixMode;
    const note = document.querySelector('.studio-mix-note');
    if (note) note.textContent = t(mixMode === 'monitor' ? 'studio.monitorHelp' : canMix() ? 'studio.projectHelp' : 'studio.mixLocked');
    for (const row of document.querySelectorAll('.studio-audio-row')) {
      const channel = row.dataset.audioChannel;
      for (const control of row.querySelectorAll('[data-audio-field]')) {
        const field = control.dataset.audioField;
        // Offsets belong to the project. Volume / mute / solo stay usable for everyone: without
        // the right to change the project mix they switch this player to My monitoring.
        control.disabled = field === 'offset' ? !canMix() : false;
        if (control.tagName === 'BUTTON') {
          const value = mixMode === 'project' ? projectIntent(channel, field) : mix[channel][field];
          control.classList.toggle('active', value); control.setAttribute('aria-pressed', String(value));
        }
        else if (document.activeElement !== control && !pending.has(`${channel}:${field}`)) control.value = field === 'volume' ? Math.round(mix[channel][field] * 100) : project()[channel][field];
      }
      row.querySelector('output').textContent = `${Math.round(mix[channel].volume * 100)}%`;
    }
    const gain = model.gains(project());
    for (const [id, channel] of [['renderOrig', 'original'], ['renderBacking', 'backing'], ['renderDub', 'dub']]) {
      const slider = document.querySelector(`#${id}Vol`), label = document.querySelector(`#${id}Val`);
      if (slider) { slider.value = Math.round(gain[channel] * 100); slider.disabled = true; }
      if (label) label.textContent = `${Math.round(gain[channel] * 100)}%`;
    }
    if (typeof syncSettingsUi === 'function') syncSettingsUi();
  }
  function requestWave(channel, url) {
    const entry = waves.get(url) || { failures: 0 };
    if (waves.has(url) && (entry.loading || !entry.retryable || !socket.connected || Date.now() < entry.retryAt)) return entry;
    clearTimeout(entry.retryTimer);
    entry.loading = true; entry.unavailable = false; waves.set(url, entry);
    const id = session.activeSessionId;
    const previousEnd = window.studioAudioEnd();
    fetch(`/api/audio-waveform?${new URLSearchParams({ room: currentRoom, sessionId: id, channel })}`).then(async res => {
      if (!res.ok) { const error = new Error('No waveform'); error.permanent = res.status === 404 || res.status === 422; throw error; }
      const data = await res.json();
      if (data.source !== url || data.sessionId !== id) throw new Error('Stale waveform');
      Object.assign(entry, data, { loading: false, retryable: false, failures: 0 });
    }).catch(error => {
      entry.loading = false; entry.unavailable = true; entry.retryable = !error.permanent;
      if (entry.retryable) {
        const delay = Math.min(30000, 1000 * 2 ** Math.min(entry.failures++, 5));
        entry.retryAt = Date.now() + delay;
        entry.retryTimer = setTimeout(() => { if (waves.get(url) === entry) drawWaves(); }, delay + 10);
      }
    }).finally(() => {
      while (waves.size > 12) { const key = waves.keys().next().value; clearTimeout(waves.get(key).retryTimer); waves.delete(key); }
      if (session && session.activeSessionId === id && previousEnd !== window.studioAudioEnd()) renderTimeline();
      else drawWaves();
    });
    return entry;
  }
  function sourceCaption(channel, url) {
    if (!url) return '';
    const tracks = session.audioTracks || [];
    const track = tracks.find(item => item.url === url);
    if ((channel === 'original' && !session.externalOriginalUrl) || track) {
      const detail = track && tracks.length > 1
        ? t('tracks.label', { n: track.index + 1, name: track.label || DublineI18n.languageName(track.language) || '?' }) : '';
      return [t('studio.videoAudio'), detail].filter(Boolean).join(' · ');
    }
    return session.audioMetadata?.[channel]?.name || t('studio.separateAudio');
  }
  function drawWaves() {
    if (!session || !session.loaded) return;
    const sources = model.sources(session), mix = project();
    const left = Math.max(0, timelineContainer.scrollLeft - labelWidth);
    const width = Math.max(1, Math.min(1800, timelineContainer.clientWidth));
    for (const row of document.querySelectorAll('.studio-audio-row')) {
      const channel = row.dataset.audioChannel, canvas = row.querySelector('canvas');
      canvas.width = width; canvas.height = 88; canvas.style.width = `${width}px`; canvas.style.left = `${left}px`;
      const ctx = canvas.getContext('2d');
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6'; ctx.fillStyle = ctx.strokeStyle;
      const status = row.querySelector('.studio-wave-status');
      if (channel === 'dub') {
        status.textContent = '';
        for (const line of session.lines.filter(canHearLine)) {
          const start = takeStartTime(line) + (line.trimEnabled !== false ? line.trimStart || 0 : 0);
          const length = line.trimEnabled !== false && line.trimEnd != null ? line.trimEnd - (line.trimStart || 0) : Math.max(0.1, line.end - line.start);
          ctx.fillRect(start * pxPerSec - left, 29, Math.max(2, length * pxPerSec), 30);
        }
        continue;
      }
      const url = sources[channel], wave = url && requestWave(channel, url);
      status.textContent = !url ? t('studio.noSource') : wave.loading ? t('studio.waveLoading') : wave.unavailable ? t('studio.noWave') : '';
      const caption = row.querySelector('.studio-wave-source');
      caption.textContent = sourceCaption(channel, url); caption.title = caption.textContent;
      if (!wave || !wave.peaks) continue;
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const from = (left + x) / pxPerSec - mix[channel].offset, to = from + 1 / pxPerSec;
        if (to <= 0 || from >= wave.duration) continue;
        const a = Math.max(0, Math.floor(from / wave.step)), b = Math.min(wave.peaks.length - 1, Math.floor(to / wave.step));
        let peak = 0; for (let i = a; i <= b; i++) peak = Math.max(peak, wave.peaks[i]);
        const h = Math.max(1, peak * 36); ctx.moveTo(x + 0.5, 44 - h); ctx.lineTo(x + 0.5, 44 + h);
      }
      ctx.stroke();
    }
  }
  const fitAudioHeader = () => {
    const header = timeline.querySelector('.studio-audio-header');
    if (header) header.style.width = `${timelineContainer.clientWidth}px`;
  };
  if (window.ResizeObserver) new ResizeObserver(() => { fitAudioHeader(); drawWaves(); }).observe(timelineContainer);
  timelineContainer.addEventListener('scroll', () => { cancelAnimationFrame(waveFrame); waveFrame = requestAnimationFrame(drawWaves); });
  window.refreshStudioWaves = drawWaves;
  window.addEventListener('resize', drawWaves);
  window.syncStudioSettings = () => {
    const adr = document.querySelector('[data-studio-setting=adr]'); if (adr) adr.value = localStorage.getItem('dubline_adr') === 'three' ? 'three' : 'off';
    const delay = document.querySelector('[data-studio-setting=latency]');
    if (delay && document.activeElement !== delay) delay.value = Math.round(latencyFor(myName) * 1000);
    if (delay) delay.disabled = !myName || !socket.connected || recordState !== 'idle';
    for (const field of ['settingsAutoDuck', 'settingsAutoDuckAmount']) { const control = document.querySelector(`#${field}`); if (control) control.disabled = !canMix(); }
    const own = document.getElementById('settingsLocalDuck');
    if (own) {
      own.checked = localDuck.enabled;
      document.getElementById('settingsLocalDuckOn').checked = !!localDuck.autoDuckEnabled;
      document.getElementById('settingsLocalDuckAmount').value = Math.round(localDuck.autoDuckAmount * 100);
      document.getElementById('settingsLocalDuckVal').textContent = `${Math.round(localDuck.autoDuckAmount * 100)}%`;
      document.getElementById('localDuckSubRow').style.opacity = localDuck.enabled ? '1' : '0.45';
      for (const id of ['settingsLocalDuckOn', 'settingsLocalDuckAmount']) document.getElementById(id).disabled = !localDuck.enabled;
    }
  };
  document.body.classList.toggle('lobby-compact', localStorage.getItem('dubline_lobby_compact') === '1');
  document.addEventListener('click', event => {
    const control = event.target.closest('[data-audio-field], [data-studio-action]'); if (!control || control.disabled) return;
    if (control.dataset.audioField && control.tagName === 'BUTTON') {
      const channel = control.closest('[data-audio-channel]').dataset.audioChannel, field = control.dataset.audioField;
      update(channel, field, !(mixMode === 'monitor' ? personal()[channel][field] : projectIntent(channel, field)));
      return refreshControls();
    }
    const action = control.dataset.studioAction;
    if (action === 'audio') { localStorage.setItem('dubline_audio_collapsed', audioCollapsed() ? '0' : '1'); return renderTimeline(); }
    if (action === 'lobby') { const collapsed = document.body.classList.toggle('lobby-compact'); localStorage.setItem('dubline_lobby_compact', collapsed ? '1' : '0'); return; }
    if (action === 'monitor-reset') { delete monitors[monitorKey()]; saveMonitors(); applyVolumes(); return refreshControls(); }
    if (action === 'latency-minus') return nudgeLatency(-10);
    if (action === 'latency-plus') return nudgeLatency(10);
    if (action === 'latency-reset') return setMyLatency(0);
    if (action) window.studioTransport(action);
  });
  document.addEventListener('input', event => {
    const control = event.target;
    if (control.id === 'settingsLocalDuckAmount') document.getElementById('settingsLocalDuckVal').textContent = `${control.value}%`;
    if (control.dataset.audioField === 'volume') {
      control.nextElementSibling.textContent = `${control.value}%`;
      if (mixMode === 'monitor' || !canMix()) update(control.closest('[data-audio-channel]').dataset.audioChannel, 'volume', Number(control.value) / 100);
    }
  });
  document.addEventListener('change', event => {
    const control = event.target, field = control.dataset.audioField;
    if (field && control.value.trim() !== '' && control.validity.valid) update(control.closest('[data-audio-channel]').dataset.audioChannel, field, Number(control.value) / (field === 'volume' ? 100 : 1));
    if (control.hasAttribute('data-studio-mix')) { mixMode = control.value; localStorage.setItem('dubline_mix_mode', mixMode); applyVolumes(); refreshControls(); }
    if (control.dataset.studioSetting === 'adr') localStorage.setItem('dubline_adr', control.value);
    if (control.id === 'settingsLocalDuck') window.setStudioLocalDuck({ enabled: control.checked });
    if (control.id === 'settingsLocalDuckOn') window.setStudioLocalDuck({ autoDuckEnabled: control.checked });
    if (control.id === 'settingsLocalDuckAmount') window.setStudioLocalDuck({ autoDuckAmount: Number(control.value) / 100 });
    if (control.dataset.studioSetting === 'latency' && control.validity.valid && recordState === 'idle') setMyLatency(Number(control.value));
  });
  window.addEventListener('dubline-language-changed', () => { refreshControls(); refreshTransport(); drawWaves(); });
  refreshTransport();
})();
