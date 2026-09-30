// ==========================================
// ROOM
// Socket, joining the room, nicks, host rights, state sync
// ==========================================
const socket = io();

// Join the room (and rejoin after the socket reconnects)
let pendingRoomPassword = '';
let accessDenied = false;

function joinRoom() {
  if (accessDenied) return;
  socket.emit('join_room', {
    room: currentRoom,
    nick: myName,
    clientId,
    password: pendingRoomPassword || undefined,
    desktopHostToken: desktopHostToken || undefined
  });
}

// ==========================================
// ROOM PASSWORD / KICKED
// ==========================================
const passwordModal = document.getElementById('passwordModal');
const passwordInput = document.getElementById('passwordInput');
const passwordNickInput = document.getElementById('passwordNickInput');
const passwordError = document.getElementById('passwordError');
const deniedModal = document.getElementById('deniedModal');
let roomUsesPin = false;

function showAccessDenied() {
  accessDenied = true;
  passwordModal.style.display = 'none';
  nickModal.style.display = 'none';
  deniedModal.style.display = 'flex';
}

socket.on('join_denied', ({ reason, pin }) => {
  if (reason === 'banned') return showAccessDenied();
  roomUsesPin = !!pin;
  const errors = { wrongPassword: t('pw.wrong'), tooMany: t('pw.tooMany') };
  passwordError.textContent = errors[reason] || '';
  passwordError.style.display = errors[reason] ? 'block' : 'none';
  document.getElementById('passwordTitle').dataset.i18n = roomUsesPin ? 'pin.title' : 'pw.title';
  document.getElementById('passwordHelp').dataset.i18n = roomUsesPin ? 'pin.help' : 'pw.help';
  passwordInput.dataset.i18nPlaceholder = roomUsesPin ? 'pin.placeholder' : 'pw.placeholder';
  document.getElementById('passwordTitle').textContent = t(roomUsesPin ? 'pin.title' : 'pw.title');
  document.getElementById('passwordHelp').textContent = t(roomUsesPin ? 'pin.help' : 'pw.help');
  passwordInput.placeholder = t(roomUsesPin ? 'pin.placeholder' : 'pw.placeholder');
  passwordInput.maxLength = roomUsesPin ? 4 : 64;
  passwordInput.style.textTransform = roomUsesPin ? 'uppercase' : '';
  passwordNickInput.value = myName;
  passwordModal.style.display = 'flex';
  nickModal.style.display = 'none';
  passwordInput.value = '';
  passwordInput.focus();
});

window.submitRoomPassword = function(e) {
  e.preventDefault();
  const nick = passwordNickInput.value.trim();
  if (!nick) return passwordNickInput.focus();
  myName = nick;
  localStorage.setItem('dubline_nick', myName);
  document.getElementById('settingsNickInput').value = myName;
  pendingRoomPassword = roomUsesPin ? passwordInput.value.trim().toUpperCase() : passwordInput.value;
  if (roomUsesPin && !/^[A-Z0-9]{4}$/.test(pendingRoomPassword)) return passwordInput.focus();
  joinRoom();
};

socket.on('kicked', () => {
  showAccessDenied();
  socket.disconnect();
});
socket.on('connect', () => {
  joinRoom();
  syncClock();
  setConnectionState('online');
  onConnectionRestored();
});

// ==========================================
// "NO CONNECTION" BANNER
// ==========================================
const connectionBanner = document.getElementById('connectionBanner');
let connectionState = 'connecting';
let reconnectAttempt = 0;
let bannerHideTimer = null;

function setConnectionState(next) {
  const wasOffline = connectionState === 'offline';
  connectionState = next;
  clearTimeout(bannerHideTimer);
  if (next === 'offline') {
    connectionBanner.className = 'connection-banner offline';
    connectionBanner.textContent = t('conn.lost') + (reconnectAttempt > 1 ? ' ' + t('conn.attempt', { n: reconnectAttempt }) : '');
    connectionBanner.style.display = 'block';
  } else if (next === 'online' && wasOffline) {
    reconnectAttempt = 0;
    connectionBanner.className = 'connection-banner online';
    connectionBanner.textContent = t('conn.restored');
    connectionBanner.style.display = 'block';
    bannerHideTimer = setTimeout(() => { connectionBanner.style.display = 'none'; }, 2500);
  } else if (next === 'online') {
    reconnectAttempt = 0;
    connectionBanner.style.display = 'none';
  }
}

socket.on('disconnect', reason => {
  console.warn(`[Dubline] Lost connection to the server: ${reason}`);
  // The server can no longer tell we are recording: a recording made offline won't be saved
  liveRecordings.clear();
  setConnectionState('offline');
});
socket.on('connect_error', () => setConnectionState('offline'));
socket.io.on('reconnect_attempt', attempt => {
  reconnectAttempt = attempt;
  if (connectionState === 'offline') setConnectionState('offline');
});

// ==========================================
// HOST LOG (browser console, F12)
// ==========================================
socket.on('host_log', ({ ts, level, text }) => {
  const time = new Date(ts).toLocaleTimeString('ru-RU', { hour12: false });
  const style = level === 'error' ? 'color:#ef4444' : level === 'warn' ? 'color:#f59e0b' : 'color:#a78bfa';
  console.log(`%c[Dubline ${time}] ${text}`, style);
});

// ==========================================
// CLOCK SYNC (for watch-together)
// ==========================================
let clockOffset = 0; // serverTime - localTime, ms

function serverNow() {
  return Date.now() + clockOffset;
}

async function syncClock() {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const sample = await new Promise(resolve => {
      const sent = Date.now();
      const timer = setTimeout(() => resolve(null), 2000);
      socket.emit('time_sync', sent, serverTs => {
        clearTimeout(timer);
        const received = Date.now();
        resolve({ rtt: received - sent, offset: serverTs - (sent + received) / 2 });
      });
    });
    if (sample && (!best || sample.rtt < best.rtt)) best = sample;
  }
  if (best) clockOffset = best.offset;
}

function showNickModal(error) {
  nickError.style.display = error ? 'block' : 'none';
  nickError.innerText = error || '';
  nickModal.style.display = 'flex';
  modalNickInput.focus();
}

// The server tells us which nick is actually ours
socket.on('nick_state', ({ nick, error, errorKey, errorParams }) => {
  // Let into the room: the password is no longer needed
  passwordModal.style.display = 'none';
  pendingRoomPassword = '';
  if (errorKey) error = t(errorKey, errorParams || {});
  myName = nick || '';
  const settingsNick = document.getElementById('settingsNickInput');
  if (settingsNick) settingsNick.value = myName;
  if (myName) localStorage.setItem('dubline_nick', myName);

  if (!myName) showNickModal(error);
  else if (error) alert(error);
  renderLobby();

  updateHostUi();
});

let lastOnlineUsers = [];

// ==========================================
// LOBBY: player list, progress, delay
// ==========================================
const lobbyList = document.getElementById('lobbyList');
const lobbyProgressCount = document.getElementById('lobbyProgressCount');
const lobbyProgressTotal = document.getElementById('lobbyProgressTotal');
const lobbyProgressBar = document.getElementById('lobbyProgressBar');
const sceneProgressText = document.getElementById('sceneProgressText');
const sceneProgressBar = document.getElementById('sceneProgressBar');
const sceneProgressPct = document.getElementById('sceneProgressPct');

function initials(nick) {
  const words = String(nick).trim().split(/[\s_.-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : String(nick).slice(0, 2);
  return letters.toUpperCase();
}

function formatMs(ms) {
  return t('latency.value', { ms: `${ms > 0 ? '+' : ''}${ms}` });
}

function playerCardHtml(nick, stats, online) {
  const isMe = nick === myName;
  const recordingLine = [...liveRecordings.entries()].find(([, who]) => who === nick);
  const latencyMs = Math.round(latencyFor(nick) * 1000);
  const pct = stats.claimed ? Math.round((stats.recorded / stats.claimed) * 100) : (stats.recorded ? 100 : 0);
  const classes = ['player-card', isMe ? 'me' : '', online ? '' : 'offline', recordingLine ? 'recording' : ''].filter(Boolean).join(' ');

  const tags = [
    nick === roomHost ? `<span class="tag host">👑 ${t('lobby.host')}</span>` : '',
    isMe ? `<span class="tag you">${t('lobby.you')}</span>` : '',
    online && !isMe && amHost() ? `<button class="kick-btn" title="${esc(t('kick.button'))}" onclick="kickPlayer(${jsArg(nick)})">✖</button>` : ''
  ].join('');

  const extra = [
    recordingLine ? `<span class="tag rec">${t('lobby.recording', { id: recordingLine[0] })}</span>` : '',
    seedingNicks.has(nick) ? `<span class="tag seed">${t('lobby.seeding')}</span>` : ''
  ].filter(Boolean).join(' ');

  let latencyHtml = '';
  if (isMe) {
    latencyHtml = `
      <div class="player-latency" title="${esc(t('latency.help'))}">
        <span>${t('latency.label')}</span>
        <b>${formatMs(latencyMs)}</b>
        <button class="btn-icon" onclick="nudgeLatency(-10)">−10</button>
        <button class="btn-icon" onclick="nudgeLatency(10)">+10</button>
        <button class="btn-icon" onclick="setMyLatency(0)" ${latencyMs ? '' : 'disabled'} title="${esc(t('reset'))}">⟲</button>
      </div>`;
  } else if (latencyMs) {
    latencyHtml = `<div class="player-latency"><span>${t('latency.label')}</span><b>${formatMs(latencyMs)}</b></div>`;
  }

  return `
    <div class="${classes}">
      <div class="player-head">
        <div class="avatar" style="background:${playerColor(nick)}">${esc(initials(nick))}<span class="dot"></span></div>
        <div class="player-name" title="${esc(nick)}">${esc(nick)}</div>
        <div class="player-tags">${tags}</div>
      </div>
      <div class="player-stats"><span>${t('lobby.recorded', { n: stats.recorded })}</span><span>${t('lobby.claimed', { n: stats.claimed })}</span></div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      ${extra ? `<div>${extra}</div>` : ''}
      ${latencyHtml}
    </div>`;
}

function renderLobby() {
  const progress = sceneProgress();
  const pct = progress.total ? Math.round((progress.recorded / progress.total) * 100) : 0;
  usersOnlineText.textContent = String(lastOnlineUsers.length);
  lobbyProgressCount.textContent = progress.recorded;
  lobbyProgressTotal.textContent = progress.total;
  lobbyProgressBar.style.width = `${pct}%`;
  sceneProgressText.textContent = `${progress.recorded} / ${progress.total}`;
  sceneProgressBar.style.width = `${pct}%`;
  sceneProgressPct.textContent = `${pct}%`;

  const empty = { recorded: 0, claimed: 0 };
  const online = [...new Set(lastOnlineUsers)];
  const order = nick => (nick === myName ? 0 : nick === roomHost ? 1 : 2);
  online.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  // Offline players who claimed or recorded something are shown too, so their contribution stays visible
  const offline = [...progress.perPlayer.keys()].filter(nick => !online.includes(nick)).sort((a, b) => a.localeCompare(b));

  let html = `<div class="lobby-section">${t('lobby.online', { n: online.length })}</div>`;
  html += online.map(nick => playerCardHtml(nick, progress.perPlayer.get(nick) || empty, true)).join('');
  if (offline.length) {
    html += `<div class="lobby-section">${t('lobby.offline', { n: offline.length })}</div>`;
    html += offline.map(nick => playerCardHtml(nick, progress.perPlayer.get(nick) || empty, false)).join('');
  }
  lobbyList.innerHTML = html;
}

// ==========================================
// UNDOING LINE DELETION
// ==========================================
window.undoDelete = function() {
  socket.emit('host_undo_delete');
};

function updateUndoButton() {
  const button = document.getElementById('undoDeleteBtn');
  const count = (session && session.trashCount) || 0;
  button.style.display = amHost() && count ? '' : 'none';
  button.textContent = t('trash.button', { n: count });
  if (trashModal.style.display === 'flex') {
    if (amHost()) loadTrash();
    else closeTrashModal();
  }
}

// ==========================================
// TRASH OF DELETED LINES (host)
// ==========================================
const trashModal = document.getElementById('trashModal');
const trashList = document.getElementById('trashList');
const trashFilter = document.getElementById('trashFilter');
const trashSelectAll = document.getElementById('trashSelectAll');
let trashItems = [];
const trashSelected = new Set();

window.openTrashModal = function() {
  trashSelected.clear();
  trashFilter.value = '';
  trashModal.style.display = 'flex';
  loadTrash();
};

window.closeTrashModal = function() {
  trashModal.style.display = 'none';
};

function loadTrash() {
  socket.emit('host_trash_list', {}, list => {
    trashItems = Array.isArray(list) ? list : [];
    const alive = new Set(trashItems.map(item => item.lineId));
    [...trashSelected].forEach(id => { if (!alive.has(id)) trashSelected.delete(id); });
    renderTrash();
  });
}

function visibleTrashItems() {
  const query = trashFilter.value.trim().toLowerCase();
  if (!query) return trashItems;
  return trashItems.filter(item => `${item.character} ${item.caption} #${item.lineId}`.toLowerCase().includes(query));
}

function renderTrash() {
  const items = visibleTrashItems();
  const time = ts => new Date(ts).toLocaleTimeString(i18n.getLanguage(), { hour: '2-digit', minute: '2-digit' });
  trashList.innerHTML = items.length ? items.map(item => `
    <label class="trash-item">
      <input type="checkbox" data-id="${item.lineId}" ${trashSelected.has(item.lineId) ? 'checked' : ''}>
      <b>#${item.lineId}</b>
      <span class="trash-char">${esc(item.character)}</span>
      <span class="trash-text" title="${esc(item.caption)}">${esc(item.caption || '…')}</span>
      <span class="trash-meta">${item.hasTake ? '🎙 ' : ''}${esc(item.by || '')} · ${time(item.at)}</span>
    </label>`).join('') : `<div class="trash-empty">${t(trashItems.length ? 'trash.nothingFound' : 'trash.empty')}</div>`;
  trashSelectAll.checked = items.length > 0 && items.every(item => trashSelected.has(item.lineId));
  document.getElementById('trashRestoreBtn').textContent = t('trash.restore', { n: trashSelected.size });
  document.getElementById('trashRestoreBtn').disabled = !trashSelected.size;
  document.getElementById('trashPurgeBtn').textContent = t('trash.purge', { n: trashSelected.size });
  document.getElementById('trashPurgeBtn').disabled = !trashSelected.size;
  document.getElementById('trashRestoreAllBtn').textContent = t('trash.restoreAll', { n: trashItems.length });
  document.getElementById('trashRestoreAllBtn').disabled = !trashItems.length;
}

trashList.addEventListener('change', (e) => {
  const id = Number(e.target.dataset.id);
  if (!id && id !== 0) return;
  if (e.target.checked) trashSelected.add(id);
  else trashSelected.delete(id);
  renderTrash();
});

trashSelectAll.addEventListener('change', () => {
  visibleTrashItems().forEach(item => {
    if (trashSelectAll.checked) trashSelected.add(item.lineId);
    else trashSelected.delete(item.lineId);
  });
  renderTrash();
});

trashFilter.addEventListener('input', renderTrash);

window.restoreTrashSelected = function() {
  if (!trashSelected.size) return;
  socket.emit('host_trash_restore', { lineIds: [...trashSelected] });
  trashSelected.clear();
};

window.restoreTrashAll = function() {
  if (!trashItems.length) return;
  socket.emit('host_trash_restore', { lineIds: trashItems.map(item => item.lineId) });
  trashSelected.clear();
};

window.purgeTrashSelected = function() {
  if (!trashSelected.size) return;
  const takes = trashItems.filter(item => trashSelected.has(item.lineId) && item.hasTake).length;
  if (!confirm(t('trash.purgeConfirm', { n: trashSelected.size, takes }))) return;
  socket.emit('host_trash_purge', { lineIds: [...trashSelected] });
  trashSelected.clear();
};

socket.on('lines_deleted', ({ count }) => {
  showToast(t('undo.toast', { n: count }), { label: t('undo.action'), onClick: undoDelete });
});

socket.on('lines_restored', ({ count }) => {
  showToast(t('undo.done', { n: count }));
});

window.kickPlayer = function(nick) {
  const text = t('kick.confirm', { nick }) + (session && session.hasPassword ? '' : '\n\n' + t('kick.noPassword'));
  if (!confirm(text)) return;
  socket.emit('host_kick', { nick });
};

// Room password in settings: the host changes it, others see the status
function updateRoomSecurityUi() {
  const has = !!(session && session.hasPassword);
  const host = amHost();
  document.getElementById('roomLockIcon').style.display = has ? 'inline' : 'none';
  document.getElementById('passwordHostControls').style.display = host ? 'flex' : 'none';
  document.getElementById('removePasswordBtn').style.display = host && has ? '' : 'none';
  const status = document.getElementById('passwordStatus');
  status.textContent = (has ? t('pw.statusOn') : t('pw.statusOff')) + (host ? '' : ' · ' + t('pw.onlyHost'));
  const unban = document.getElementById('unbanBtn');
  const banned = (session && session.bannedCount) || 0;
  unban.style.display = host && banned ? '' : 'none';
  unban.textContent = t('pw.unban', { n: banned });
}

window.setRoomPassword = function() {
  const input = document.getElementById('roomPasswordInput');
  const value = input.value.trim();
  if (!value) return input.focus();
  socket.emit('host_set_password', { password: value });
  input.value = '';
  showToast(t('pw.saved'));
};

window.removeRoomPassword = function() {
  socket.emit('host_set_password', { password: '' });
};

window.unbanAll = function() {
  socket.emit('host_unban_all');
};

// A player's delay correction changed: their takes shift for everyone
socket.on('latency_updated', (latency) => {
  if (!session) return;
  session.latency = latency || {};
  if (!video.paused) stopAllTakes();
  if (session.loaded) renderTimeline();
  if (selectedLine) showInspector(selectedLine);
  renderLobby();
});

socket.on('room_users_updated', ({ users, host, hostOnline: online }) => {
  roomHost = host;
  hostOnline = online;
  lastOnlineUsers = users;
  renderLobby();
  updateHostUi();
});

// Who is recording right now: highlight tiles and nicks
socket.on('recording_state', (list) => {
  const changed = new Set([...liveRecordings.keys(), ...list.map(item => item.lineId)]);
  liveRecordings.clear();
  list.forEach(item => liveRecordings.set(item.lineId, item.nick));
  if (session && session.lines) {
    changed.forEach(lineId => {
      const line = session.lines.find(l => l.id === lineId);
      if (line) updateLineBlock(line);
    });
  }
  renderLobby();
});

// Wait for the server response before choosing a modal: protected guests get one combined
// nickname + PIN form, while an unprotected room answers with nick_state and opens the nick form.
if (myName) modalNickInput.value = myName;

window.handleNickSubmit = function(e) {
  e.preventDefault();
  const val = modalNickInput.value.trim();
  if (!val) return;

  myName = val;
  localStorage.setItem('dubline_nick', myName);
  document.getElementById('settingsNickInput').value = myName;
  nickModal.style.display = 'none';

  joinRoom();
  refreshViews();
  maybeShowHelp();
};

// ==========================================
// HOST RIGHTS
// ==========================================
function amHost() {
  return !!myName && roomHost === myName;
}

// The timeline and inspector depend on host rights (role release buttons), so they are
// redrawn only when those rights actually change, not on every player join
let renderedAsHost = null;

function updateHostUi() {
  if (amHost()) {
    hostPanel.className = 'host-panel';
    const watchBtn = watchMode
      ? `<button class="btn-host" onclick="hostWatchStop()">${t('host.watchStop')}</button>`
      : `<button class="btn-host" onclick="hostWatchStart()">${t('host.watch')}</button>`;
    hostPanel.innerHTML = `
      ${t('host.you')}
      ${watchBtn}
      <button class="btn-host" onclick="hostForcePause()">${t('host.pause')}</button>
      <button class="btn-host" onclick="hostResetClaims()">${t('host.reset')}</button>
    `;
  } else if (!hostOnline) {
    hostPanel.className = 'host-panel offline';
    hostPanel.innerHTML = `
      ${t('host.offline')}
      <button class="btn-host" onclick="claimHost()">${t('host.claim')}</button>
    `;
  } else {
    hostPanel.className = 'host-panel';
    hostPanel.innerHTML = t('host.name', { name: esc(roomHost) });
  }

  renderSessions();
  updateRoomSecurityUi();
  renderTrackPicker();
  updateUndoButton();
  const canManagePacks = amHost();
  uploadLabel.classList.toggle('disabled', !canManagePacks);
  zipInput.disabled = !canManagePacks;
  uploadLabel.title = canManagePacks ? t('chooseZip') : t('onlyHost');

  if (renderedAsHost !== canManagePacks) {
    renderedAsHost = canManagePacks;
    refreshViews();
  }
}

window.hostForcePause = function() {
  const others = [...new Set(liveRecordings.values())].filter(nick => nick !== myName);
  if (others.length && !confirm(t('host.pauseConfirm', { names: others.join(', ') }))) return;
  socket.emit('host_force_pause');
};
window.claimHost = function() { socket.emit('claim_host'); };
window.hostResetClaims = function() {
  if (!confirm(t('confirm.reset'))) return;
  socket.emit('host_reset_claims');
};

socket.on('force_pause', () => {
  if (recordState !== 'idle') finishRecording({ discard: true });
  video.pause();
});

socket.on('session_updated', (data) => {
  session = data;
  if (!session || !session.loaded) {
    // The room has no session (e.g. the last one was deleted): clear the studio
    cancelMediaDownload();
    setMediaSource(originalTrackAudio, null);
    trackPicker.style.display = 'none';
    loadedVideoUrl = null;
    video.removeAttribute('src');
    backing.removeAttribute('src');
    video.load();
    selectedLine = null;
    timeline.innerHTML = '';
    timeline.appendChild(playhead);
    playhead.style.display = 'none';
    inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p>${t('inspector.empty')}</p>`;
    updateDownloadButtons();
    renderLobby();
    renderSessions();
    updateRoomSecurityUi();
    updateUndoButton();
    return;
  }

  // Don't reload the video if the pack hasn't changed (e.g. on role changes)
  if (loadedVideoUrl !== session.videoUrl) {
    loadedVideoUrl = session.videoUrl;
    // A new pack: watch-together of the old one is definitely over
    if (watchMode) exitWatchMode();
    forgetStaleLocalMedia();
    loadSceneMedia();
    selectedLine = null;
    inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p style="color: #71717a;">${t('inspector.empty')}</p>`;
  }

  updateDownloadButtons();
  updateLocalMediaStatus();
  renderLobby();
  renderSessions();
  updateRoomSecurityUi();
  applyAudioTracks();
  updateUndoButton();

  applyVolumes();
  renderTimeline();
  precacheTakes();
  if (selectedLine) {
    const updated = session.lines.find(l => l.id === selectedLine.id);
    if (updated) {
      selectedLine = updated;
      showInspector(updated);
    }
  }
  updatePrompter();
});

socket.on('line_updated', (updatedLine) => {
  if (!session || !session.lines) return;
  const idx = session.lines.findIndex(l => l.id === updatedLine.id);
  if (idx !== -1) {
    // Shift/effects change on the fly: if the take is playing, restart it with the new settings
    if (!video.paused) {
      resetLine(updatedLine.id);
    }
    session.lines[idx] = updatedLine;
    updateLineBlock(updatedLine);
    renderLobby();
    if (updatedLine.audioUrl) getProcessedTake(updatedLine);
    if (selectedLine && selectedLine.id === updatedLine.id) {
      selectedLine = updatedLine;
      showInspector(updatedLine);
    }
  }
});

window.claimCharacter = function(char) { socket.emit('claim_character', { character: char }); };
window.unclaimCharacter = function(char) { socket.emit('unclaim_character', { character: char }); };
window.claimSingleLine = function(lineId) { socket.emit('claim_line', { lineId }); };
window.unclaimSingleLine = function(lineId) { socket.emit('unclaim_line', { lineId }); };

// ==========================================
// WATCH TOGETHER: the host starts the video for everyone at once
// ==========================================
const watchOverlay = document.getElementById('watchOverlay');
const watchCountdown = document.getElementById('watchCountdown');
const watchLabel = document.getElementById('watchLabel');
const watchLeaveBtn = document.getElementById('watchLeaveBtn');
const WATCH_DRIFT_LIMIT = 0.35; // seconds of drift after which we catch up with the host
let watchMode = false;
let watchLeftLocally = false;
let watchStartTimer = null;
let watchCountdownTimer = null;
let hostSyncTimer = null;

function showWatchOverlay() {
  watchOverlay.style.display = 'flex';
  watchLabel.textContent = amHost() ? t('watch.banner') : `${t('watch.banner')} · ${t('watch.hostControls')}`;
  watchLeaveBtn.style.display = amHost() ? 'none' : 'inline-flex';
}

function enterWatchMode() {
  watchMode = true;
  watchLeftLocally = false;
  if (recordState !== 'idle') finishRecording({ discard: true });
  showWatchOverlay();
  updateHostUi();
  if (amHost()) startHostSync();
}

function exitWatchMode() {
  watchMode = false;
  clearTimeout(watchStartTimer);
  clearInterval(watchCountdownTimer);
  clearInterval(hostSyncTimer);
  watchOverlay.style.display = 'none';
  watchCountdown.style.display = 'none';
  updateHostUi();
}

socket.on('watch_start', ({ position, at }) => {
  enterWatchMode();
  video.pause();
  video.currentTime = position;

  // Countdown, then start by the server clock: at the same moment for everyone
  const tick = () => {
    // The player's clock may lag the server's by milliseconds: don't show "4" on a three-second countdown
    const left = Math.min(3, Math.ceil((at - serverNow()) / 1000));
    watchCountdown.textContent = left > 0 ? String(left) : '';
    watchCountdown.style.display = left > 0 ? 'block' : 'none';
  };
  tick();
  clearInterval(watchCountdownTimer);
  watchCountdownTimer = setInterval(tick, 200);
  clearTimeout(watchStartTimer);
  watchStartTimer = setTimeout(() => {
    clearInterval(watchCountdownTimer);
    watchCountdown.style.display = 'none';
    if (watchMode) video.play().catch(() => {});
  }, Math.max(0, at - serverNow()));
});

// Periodic check against the host: pause, seeking and time drift
socket.on('watch_sync', ({ playing, position, at }) => {
  if (amHost() || watchLeftLocally) return;
  if (!watchMode) enterWatchMode();
  const expected = position + (playing ? Math.max(0, serverNow() - at) / 1000 : 0);
  if (Math.abs(video.currentTime - expected) > WATCH_DRIFT_LIMIT) video.currentTime = expected;
  if (playing && video.paused) video.play().catch(() => {});
  if (!playing && !video.paused) video.pause();
});

socket.on('watch_stop', () => {
  const wasWatching = watchMode;
  exitWatchMode();
  if (wasWatching) video.pause();
});

function sendHostSync() {
  if (!watchMode || !amHost()) return;
  socket.emit('host_watch_sync', { playing: !video.paused, position: video.currentTime });
}

function startHostSync() {
  clearInterval(hostSyncTimer);
  hostSyncTimer = setInterval(sendHostSync, 3000);
}

video.addEventListener('play', sendHostSync);
video.addEventListener('pause', sendHostSync);
video.addEventListener('seeked', sendHostSync);
video.addEventListener('ended', () => {
  if (watchMode && amHost()) socket.emit('host_watch_stop');
});

window.hostWatchStart = function() {
  if (!session || !session.loaded) return alert(t('error.noScene'));
  if (!confirm(t('host.watchConfirm'))) return;
  socket.emit('host_watch_start', { position: 0 });
};

window.hostWatchStop = function() {
  socket.emit('host_watch_stop');
};

window.leaveWatch = function() {
  watchLeftLocally = true;
  exitWatchMode();
};
