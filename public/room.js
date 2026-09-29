// ==========================================
// ROOM
// Сокет, вход в комнату, ники, права хоста, синхронизация состояния
// ==========================================
const socket = io();

// Подключение к комнате (и повторное — после переподключения сокета)
function joinRoom() {
  socket.emit('join_room', { room: currentRoom, nick: myName, clientId });
}
socket.on('connect', () => {
  joinRoom();
  syncClock();
  setConnectionState('online');
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
  if (errorKey) error = t(errorKey, errorParams || {});
  myName = nick || '';
  const settingsNick = document.getElementById('settingsNickInput');
  if (settingsNick) settingsNick.value = myName;
  if (myName) localStorage.setItem('dubline_nick', myName);

  if (!myName) showNickModal(error);
  else if (error) alert(error);

  updateHostUi();
});

let lastOnlineUsers = [];

function renderOnlineUsers() {
  const recordingNicks = new Set(liveRecordings.values());
  usersOnlineText.innerHTML = `${lastOnlineUsers.length} (${lastOnlineUsers.map(u =>
    (u === roomHost ? '👑 ' : '') + (recordingNicks.has(u) ? '🔴 ' : '') + esc(u)).join(', ')})`;
}

socket.on('room_users_updated', ({ users, host, hostOnline: online }) => {
  roomHost = host;
  hostOnline = online;
  lastOnlineUsers = users;
  renderOnlineUsers();
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
  renderOnlineUsers();
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
    updateDownloadButtons();
    return;
  }

  // Не перезагружаем видео, если пак не поменялся (например, при смене ролей)
  if (loadedVideoUrl !== session.videoUrl) {
    loadedVideoUrl = session.videoUrl;
    forgetStaleLocalMedia();
    video.src = mediaUrl(session.videoUrl);
    backing.src = mediaUrl(session.backingUrl);
    selectedLine = null;
    inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p style="color: #71717a;">${t('inspector.empty')}</p>`;
  }

  updateDownloadButtons();
  updateLocalMediaStatus();

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
    const left = Math.ceil((at - serverNow()) / 1000);
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
