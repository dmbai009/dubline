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
  if (reason === 'banned' || reason === 'singlePlayer') return showAccessDenied();
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
  if (myName && window.onRecordingNickConfirmed) window.onRecordingNickConfirmed(myName);
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
  const activity = playerActivities.get(nick);
  const classes = ['player-card', isMe ? 'me' : '', online ? '' : 'offline', recordingLine ? 'recording' : ''].filter(Boolean).join(' ');

  const tags = [
    nick === roomHost ? `<span class="tag host">👑 ${t('lobby.host')}</span>` : '',
    online && !isMe && session?.mode === 'edit' ? `<button class="btn-icon" title="${esc(t('cursor.jump'))}" onclick="jumpToCollaborator(${jsArg(nick)})">↗</button>` : '',
    isMe ? `<span class="tag you">${t('lobby.you')}</span>` : '',
    online && !isMe && amHost() ? `<button class="kick-btn" title="${esc(t('kick.button'))}" onclick="kickPlayer(${jsArg(nick)})">✖</button>` : ''
  ].join('');

  const extra = [
    recordingLine ? `<span class="tag rec">${t('lobby.recording', { id: recordingLine[0] })}</span>` : '',
    seedingNicks.has(nick) ? `<span class="tag seed">${t('lobby.seeding')}</span>` : '',
    activity ? `<span class="tag seed">${t('media.' + activity.state, { pct: Math.round(activity.pct) })}</span>` : ''
  ].filter(Boolean).join(' ');
  const activityProgress = activity && activity.state === 'downloading'
    ? `<div class="progress"><div style="width:${activity.pct}%;background:var(--accent)"></div></div>` +
      (activity.buckets?.length ? '<div class="media-chunk-map">' + activity.buckets.map(value => `<i style="opacity:${.2 + value / 125}"></i>`).join('') + '</div>' : '') : '';

  let latencyHtml = '';
  if (isMe) {
    latencyHtml = `
      <div class="player-latency" title="${esc(t('latency.help'))}">
        <span>${t('latency.label')}</span>
        <b>${formatMs(latencyMs)}</b>
      </div>`;
  } else if (latencyMs) {
    latencyHtml = `<div class="player-latency"><span>${t('latency.label')}</span><b>${formatMs(latencyMs)}</b></div>`;
  }

  return `
    <div class="${classes}" title="${esc(nick)} · ${esc(t(online ? 'online' : 'studio.offline'))}">
      <div class="player-head">
        <div class="avatar" style="background:${playerColor(nick)}">${esc(initials(nick))}<span class="dot"></span></div>
        <div class="player-name" title="${esc(nick)}">${esc(nick)}</div>
        <div class="player-tags">${tags}</div>
      </div>
      <div class="player-stats"><span>${t('lobby.recorded', { n: stats.recorded })}</span><span>${t('lobby.claimed', { n: stats.claimed })}</span></div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="player-status-icons">
        ${nick === roomHost ? `<span title="${esc(t('lobby.host'))}">👑</span>` : ''}
        ${isMe ? `<span title="${esc(t('lobby.you'))}">●</span>` : ''}
        ${recordingLine ? `<span title="${esc(t('lobby.recording', { id: recordingLine[0] }))}">🎙</span>` : ''}
        ${seedingNicks.has(nick) ? `<span title="${esc(t('lobby.seeding'))}">↑</span>` : ''}
        ${activity && activity.state === 'downloading' ? `<span title="${esc(t('lobby.downloading', { pct: activity.pct }))}">↓${activity.pct}%</span>` : ''}
        ${!online ? `<span title="${esc(t('studio.offline'))}">○</span>` : ''}
        ${stats.claimed && stats.recorded >= stats.claimed ? `<span title="${esc(t('studio.done'))}">✓</span>` : ''}
      </div>
      ${activityProgress}
      ${extra ? `<div class="player-status-text">${extra}</div>` : ''}
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
  socket.emit('host_undo_delete', { sessionId: session?.activeSessionId });
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
  const sessionId = session?.activeSessionId;
  socket.emit('host_trash_list', {}, list => {
    if (session?.activeSessionId !== sessionId) return;
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
  socket.emit('host_trash_restore', { lineIds: [...trashSelected], sessionId: session?.activeSessionId });
  trashSelected.clear();
};

window.restoreTrashAll = function() {
  if (!trashItems.length) return;
  socket.emit('host_trash_restore', { lineIds: trashItems.map(item => item.lineId), sessionId: session?.activeSessionId });
  trashSelected.clear();
};

window.purgeTrashSelected = async function() {
  if (!trashSelected.size) return;
  const sessionId = session.activeSessionId;
  const lineIds = [...trashSelected];
  const entries = trashItems.filter(item => lineIds.includes(item.lineId)).map(item => ({ lineId: item.lineId, at: item.at, revision: item.revision, audioUrl: item.audioUrl }));
  const takes = trashItems.filter(item => trashSelected.has(item.lineId) && item.hasTake).length;
  if (!await askConfirm(t('trash.purgeConfirm', { n: trashSelected.size, takes }))) return;
  if (session.activeSessionId !== sessionId || entries.some(entry => !trashItems.some(item => item.lineId === entry.lineId && item.at === entry.at && item.revision === entry.revision && item.audioUrl === entry.audioUrl))) return showToast(t('editor.dialogChanged'));
  socket.emit('host_trash_purge', { lineIds, sessionId, entries });
  trashSelected.clear();
};

socket.on('lines_deleted', ({ count }) => {
  // In Edit Mode anyone may delete, and everyone undoes their own deletion
  const undo = () => (session && session.mode === 'edit' ? editorUndo() : undoDelete());
  showToast(t('undo.toast', { n: count }), { label: t('undo.action'), onClick: undo });
});

socket.on('lines_restored', ({ count }) => {
  showToast(t('undo.done', { n: count }));
});

window.kickPlayer = async function(nick) {
  const text = t('kick.confirm', { nick }) + (session && session.hasPassword ? '' : '\n\n' + t('kick.noPassword'));
  if (!await askConfirm(text)) return;
  socket.emit('host_kick', { nick });
};

// Room password in settings: the host changes it, others see the status
function updateRoomSecurityUi() {
  const has = !!(session && session.hasPassword);
  const host = amHost();
  document.getElementById('roomLockIcon').style.display = has ? 'inline' : 'none';
  document.getElementById('passwordHostControls').style.display = 'flex';
  document.querySelectorAll('#passwordHostControls input, #passwordHostControls button').forEach(control => {
    control.disabled = !host;
    control.title = host ? '' : t('pw.onlyHost');
  });
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
  session.latency = Object.assign(Object.create(null), latency);
  if (!video.paused) stopAllTakes();
  if (session.loaded) renderTimeline();
  if (selectedLine) showInspector(selectedLine);
  renderLobby();
});

socket.on('room_users_updated', ({ users, host, hostOnline: online }) => {
  roomHost = host;
  hostOnline = online;
  lastOnlineUsers = users;
  for (const nick of playerActivities.keys()) if (!users.includes(nick)) playerActivities.delete(nick);
  renderLobby();
  updateHostUi();
});

// Who is recording right now: highlight tiles and nicks
socket.on('recording_state', (payload) => {
  if (!session || payload?.sessionId !== session.activeSessionId || !Array.isArray(payload.recordings)) return;
  const list = payload.recordings;
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
  const single = !!session?.singlePlayer;
  document.body.classList.toggle('single-player', single);
  document.getElementById('singleMultiplayerBtn').hidden = !single;
  document.getElementById('singleModeLabel').hidden = !single;
  if (amHost()) {
    hostPanel.className = 'host-panel';
    const watchBtn = session && session.mode === 'edit' ? '' : watchMode
      ? `<button class="btn-host" onclick="hostWatchStop()">${t('host.watchStop')}</button>`
      : `<button class="btn-host" onclick="hostWatchStart()">${t('host.watch')}</button>`;
    const dubControls = session && session.mode === 'edit' ? '' : `
      <button class="btn-host cast" onclick="randomCast()">${t('randomCast')}</button>
      ${(session && (session.blindMode || (session.blindPlayers || []).length)) ? `<button class="btn-host reveal" onclick="revealAllTakes()">${t('blind.reveal')}</button>` : ''}
      <button class="btn-host pause" onclick="hostForcePause()">${t('host.pause')}</button>
      <span class="host-sep"></span>
      <button class="btn-host reset" onclick="hostResetClaims()">${t('host.reset')}</button>`;
    hostPanel.innerHTML = `
      ${t('host.you')}
      ${watchBtn}
      ${dubControls}
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
  window.updateModeUi?.();
  const canManagePacks = amHost();
  uploadLabel.classList.toggle('disabled', !canManagePacks);
  zipInput.disabled = !canManagePacks;
  uploadLabel.title = canManagePacks ? t('chooseZip') : t('onlyHost');
  const projectLabel = document.getElementById('projectOpenLabel');
  projectLabel.classList.toggle('disabled', !canManagePacks);
  projectLabel.title = canManagePacks ? t('project.choose') : t('onlyHost');
  document.getElementById('projectInput').disabled = !canManagePacks || projectImportBusy;
  const projectSave = document.getElementById('projectExportBtn');
  projectSave.disabled = !canManagePacks || projectExportBusy;
  projectSave.title = canManagePacks ? t('project.saveHelp') : t('onlyHost');

  if (renderedAsHost !== canManagePacks) {
    renderedAsHost = canManagePacks;
    refreshViews();
  }
}

window.hostForcePause = async function() {
  const sessionId = session?.activeSessionId;
  const others = [...new Set(liveRecordings.values())].filter(nick => nick !== myName);
  if (others.length && !await askConfirm(t('host.pauseConfirm', { names: others.join(', ') }))) return;
  if (session?.activeSessionId !== sessionId) return;
  socket.emit('host_force_pause', { sessionId });
};
window.claimHost = function() { socket.emit('claim_host'); };
window.hostResetClaims = async function() {
  const sessionId = session?.activeSessionId;
  if (!await askConfirm(t('confirm.reset'))) return;
  if (session?.activeSessionId !== sessionId) return showToast(t('editor.dialogChanged'));
  socket.emit('host_reset_claims', { sessionId });
};

socket.on('force_pause', ({ sessionId } = {}) => {
  if (sessionId !== session?.activeSessionId) return;
  if (recordState !== 'idle') finishRecording({ discard: true });
  video.pause();
});

let latestSessionProtocol = null;
const previousEditorEpochs = new Set();
function acceptSessionProtocol(protocol) {
  if (!protocol) return true; // compatibility with existing snapshots/tests
  if (latestSessionProtocol?.room !== currentRoom) { latestSessionProtocol = null; previousEditorEpochs.clear(); }
  if (previousEditorEpochs.has(protocol.epoch)) return false;
  if (latestSessionProtocol?.epoch === protocol.epoch && protocol.version < latestSessionProtocol.version) return false;
  if (latestSessionProtocol && latestSessionProtocol.epoch !== protocol.epoch) previousEditorEpochs.add(latestSessionProtocol.epoch);
  while (previousEditorEpochs.size > 8) previousEditorEpochs.delete(previousEditorEpochs.values().next().value);
  latestSessionProtocol = { room: currentRoom, epoch: protocol.epoch, version: protocol.version };
  return true;
}
let sceneResyncJob = null;
window.requestSceneResync = () => {
  if (sceneResyncJob || !socket.connected) return;
  sceneResyncJob = Promise.resolve().then(() => resyncEditor()).finally(() => { sceneResyncJob = null; });
  if (window.DublineDiagnostics) window.DublineDiagnostics.counters.lastResyncAt = Date.now();
};
window.acceptSceneDelta = (sessionId, lines) => {
  if (!session || sessionId !== session.activeSessionId || !Array.isArray(lines)) return false;
  if (lines.some(line => { const current = session.lines.find(item => item.id === line.id); return !current || Number(line.revision || 0) > Number(current.revision || 0) + 1; })) { window.requestSceneResync(); return false; }
  return true;
};
function applySessionUpdate(data) {
  if (!acceptSessionProtocol(data.editorProtocol)) return;
  data.characterClaims = Object.assign(Object.create(null), data.characterClaims);
  data.latency = Object.assign(Object.create(null), data.latency);
  const sessionChanged = !session || session.activeSessionId !== data.activeSessionId;
  if (sessionChanged) {
    audio.stopAllTakes();
    audio.stopPreview();
    if (watchMode) exitWatchMode();
    cancelMediaDownload();
    loadedVideoUrl = null;
    liveRecordings.clear();
    if (recordState !== 'idle') finishRecording({ discard: true });
    multiSelection.clear();
    selectedLine = null;
  }
  session = data;
  window.DublineCpuJobs?.cancelStale();
  window.acceptEditorSnapshot?.(data);
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
  const mediaSources = JSON.stringify([session.activeSessionId, session.videoUrl, window.DublineProjectAudio.sources(session)]);
  if (loadedVideoUrl !== session.videoUrl || loadedMediaSources !== mediaSources) {
    loadedVideoUrl = session.videoUrl;
    loadedMediaSources = mediaSources;
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
    } else {
      selectedLine = null;
      inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p>${t('inspector.empty')}</p>`;
    }
  }
  updatePrompter();
}

socket.on('session_updated', applySessionUpdate);

function applyTakeUpdates(sessionId, lines, protocol) {
  if (!window.acceptSceneDelta(sessionId, lines) || !acceptSessionProtocol(protocol)) return;
  let changed = false, selectedChanged = false;
  for (const updatedLine of lines) {
    const idx = session.lines.findIndex(line => line.id === updatedLine.id);
    if (idx === -1) continue;
    audio.updateLine(session.lines[idx], updatedLine);
    session.lines[idx] = updatedLine;
    window.acceptEditorTake?.(updatedLine);
    const visibleLine = session.lines.find(line => line.id === updatedLine.id) || updatedLine;
    updateLineBlock(visibleLine);
    if (updatedLine.audioUrl) getProcessedTake(updatedLine);
    changed = true;
    if (selectedLine?.id === updatedLine.id) { selectedLine = visibleLine; selectedChanged = true; }
  }
  if (!changed) return;
  if (window.refreshStudioWaves) window.refreshStudioWaves();
  renderLobby();
  if (multiSelection.size >= 2 && lines.some(line => multiSelection.has(line.id))) showMultiInspector();
  else if (selectedChanged) showInspector(selectedLine);
}
socket.on('line_updated', data => {
  if (data?.line) applyTakeUpdates(data.sessionId, [data.line], data.editorProtocol);
});
socket.on('takes_updated', data => {
  if (data) applyTakeUpdates(data.sessionId, data.lines, data.editorProtocol);
});

window.claimCharacter = function(char) { socket.emit('claim_character', { character: char, sessionId: session?.activeSessionId }); };
window.unclaimCharacter = function(char) { socket.emit('unclaim_character', { character: char, sessionId: session?.activeSessionId }); };
window.claimSingleLine = function(lineId) { socket.emit('claim_line', { lineId, sessionId: session?.activeSessionId }); };
window.unclaimSingleLine = function(lineId) { socket.emit('unclaim_line', { lineId, sessionId: session?.activeSessionId }); };

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
  if (window.refreshStudioTransport) window.refreshStudioTransport();
  clearTimeout(watchStartTimer);
  clearInterval(watchCountdownTimer);
  clearInterval(hostSyncTimer);
  watchOverlay.style.display = 'none';
  watchCountdown.style.display = 'none';
  updateHostUi();
}

socket.on('watch_start', ({ sessionId, position, at, rate = 1 }) => {
  if (sessionId !== session?.activeSessionId) return;
  window.setPreviewRate?.(rate, true);
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
socket.on('watch_sync', ({ sessionId, playing, position, at, rate = 1 }) => {
  if (sessionId !== session?.activeSessionId) return;
  if (amHost() || watchLeftLocally) return;
  if (!watchMode) enterWatchMode();
  window.setPreviewRate?.(rate, true);
  const expected = position + (playing ? Math.max(0, serverNow() - at) / 1000 * rate : 0);
  if (Math.abs(video.currentTime - expected) > WATCH_DRIFT_LIMIT) video.currentTime = expected;
  if (playing && video.paused) video.play().catch(() => {});
  if (!playing && !video.paused) video.pause();
});

socket.on('watch_stop', ({ sessionId } = {}) => {
  if (sessionId !== session?.activeSessionId) return;
  const wasWatching = watchMode;
  exitWatchMode();
  if (wasWatching) video.pause();
});

let lastHostScrubSync = 0, lastHostSync = null;
function sendHostSync(transient = false) {
  if (!watchMode || !amHost()) return;
  transient = transient === true || !!window.transportScrubbing;
  const now = performance.now(), data = { playing: !video.paused, position: video.currentTime, rate: video.playbackRate, transient, sessionId: session?.activeSessionId };
  if (transient && now - lastHostScrubSync < 100) return;
  if (!transient && lastHostSync && !lastHostSync.data.transient && now - lastHostSync.at < 150 && JSON.stringify(data) === JSON.stringify(lastHostSync.data)) return;
  if (transient) lastHostScrubSync = now;
  lastHostSync = { at: now, data };
  (transient ? socket.volatile : socket).emit('host_watch_sync', data);
}
window.sendHostSync = sendHostSync;

function startHostSync() {
  clearInterval(hostSyncTimer);
  hostSyncTimer = setInterval(sendHostSync, 3000);
}

video.addEventListener('play', sendHostSync);
video.addEventListener('pause', sendHostSync);
video.addEventListener('seeked', sendHostSync);
video.addEventListener('ended', () => {
  if (watchMode && amHost()) socket.emit('host_watch_stop', { sessionId: session?.activeSessionId });
});

window.hostWatchStart = async function() {
  if (!session || !session.loaded) return alert(t('error.noScene'));
  const sessionId = session.activeSessionId;
  if (!await askConfirm(t('host.watchConfirm'))) return;
  if (session?.activeSessionId !== sessionId) return;
  socket.emit('host_watch_start', { position: 0, rate: video.playbackRate, sessionId });
};

window.hostWatchStop = function() {
  socket.emit('host_watch_stop', { sessionId: session?.activeSessionId });
};

window.leaveWatch = function() {
  watchLeftLocally = true;
  exitWatchMode();
};
