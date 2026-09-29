// ==========================================
// ROOM
// Сокет, вход в комнату, ники, права хоста, синхронизация состояния
// ==========================================
const socket = io();

// Подключение к комнате (и повторное — после переподключения сокета)
let pendingRoomPassword = '';
let accessDenied = false;

function joinRoom() {
  if (accessDenied) return;
  socket.emit('join_room', { room: currentRoom, nick: myName, clientId, password: pendingRoomPassword || undefined });
}

// ==========================================
// ПАРОЛЬ КОМНАТЫ / ВЫГНАЛИ
// ==========================================
const passwordModal = document.getElementById('passwordModal');
const passwordInput = document.getElementById('passwordInput');
const passwordError = document.getElementById('passwordError');
const deniedModal = document.getElementById('deniedModal');

function showAccessDenied() {
  accessDenied = true;
  passwordModal.style.display = 'none';
  nickModal.style.display = 'none';
  deniedModal.style.display = 'flex';
}

socket.on('join_denied', ({ reason }) => {
  if (reason === 'banned') return showAccessDenied();
  const errors = { wrongPassword: t('pw.wrong'), tooMany: t('pw.tooMany') };
  passwordError.textContent = errors[reason] || '';
  passwordError.style.display = errors[reason] ? 'block' : 'none';
  passwordModal.style.display = 'flex';
  nickModal.style.display = 'none';
  passwordInput.value = '';
  passwordInput.focus();
});

window.submitRoomPassword = function(e) {
  e.preventDefault();
  pendingRoomPassword = passwordInput.value;
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
// ПЛАШКА «НЕТ СВЯЗИ»
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
  console.warn(`[Dubline] Связь с сервером потеряна: ${reason}`);
  // Сервер больше не узнает, что мы записываем, — запись без связи не сохранится
  liveRecordings.clear();
  setConnectionState('offline');
});
socket.on('connect_error', () => setConnectionState('offline'));
socket.io.on('reconnect_attempt', attempt => {
  reconnectAttempt = attempt;
  if (connectionState === 'offline') setConnectionState('offline');
});

// ==========================================
// ЖУРНАЛ ДЛЯ ХОСТА (консоль браузера, F12)
// ==========================================
socket.on('host_log', ({ ts, level, text }) => {
  const time = new Date(ts).toLocaleTimeString('ru-RU', { hour12: false });
  const style = level === 'error' ? 'color:#ef4444' : level === 'warn' ? 'color:#f59e0b' : 'color:#a78bfa';
  console.log(`%c[Dubline ${time}] ${text}`, style);
});

// ==========================================
// СИНХРОНИЗАЦИЯ ЧАСОВ (для совместного просмотра)
// ==========================================
let clockOffset = 0; // serverTime - localTime, мс

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

// Сервер сообщает, какой ник за нами закреплен на самом деле
socket.on('nick_state', ({ nick, error, errorKey, errorParams }) => {
  // Пустили в комнату — пароль больше не нужен
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
// ЛОББИ: список игроков, прогресс, задержка
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
  // Не в сети, но что-то заняли или записали — тоже показываем, чтобы был виден их вклад
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
// ОТМЕНА УДАЛЕНИЯ РЕПЛИК
// ==========================================
window.undoDelete = function() {
  socket.emit('host_undo_delete');
};

function updateUndoButton() {
  const button = document.getElementById('undoDeleteBtn');
  const count = (session && session.undoCount) || 0;
  button.style.display = amHost() && count ? '' : 'none';
  button.textContent = t('undo.toolbar', { n: count });
}

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

// Пароль комнаты в настройках: хост меняет, остальные видят статус
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

// Поправка задержки игрока поменялась — у всех сдвигаются его дубли
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

// Кто сейчас пишет дубль: подсвечиваем плитки и ники
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

if (!myName) {
  showNickModal();
} else {
  modalNickInput.value = myName;
}

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
// ПРАВА ХОСТА
// ==========================================
function amHost() {
  return !!myName && roomHost === myName;
}

// Таймлайн и инспектор зависят от прав хоста (кнопки снятия ролей), поэтому их
// перерисовываем только когда эти права действительно поменялись, а не на каждый вход игрока
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
    // В комнате нет сессии (например, удалили последнюю) — очищаем студию
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

  // Не перезагружаем видео, если пак не поменялся (например, при смене ролей)
  if (loadedVideoUrl !== session.videoUrl) {
    loadedVideoUrl = session.videoUrl;
    // Новый пак — совместный просмотр старого точно закончился
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
    // Сдвиг/эффекты меняются на лету: если дубль сейчас звучит, перезапускаем его с новыми параметрами
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
// «СМОТРИМ ВМЕСТЕ»: хост запускает ролик у всех одновременно
// ==========================================
const watchOverlay = document.getElementById('watchOverlay');
const watchCountdown = document.getElementById('watchCountdown');
const watchLabel = document.getElementById('watchLabel');
const watchLeaveBtn = document.getElementById('watchLeaveBtn');
const WATCH_DRIFT_LIMIT = 0.35; // секунд расхождения, после которых подтягиваемся к хосту
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

  // Обратный отсчет, затем старт по серверным часам — у всех в один момент
  const tick = () => {
    // Часы игрока могут отставать от серверных на миллисекунды — не показываем «4» на трехсекундном отсчете
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

// Периодическая сверка с хостом: пауза, перемотка и расхождение во времени
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
