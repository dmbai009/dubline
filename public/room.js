// ==========================================
// ROOM
// Сокет, вход в комнату, ники, права хоста, синхронизация состояния
// ==========================================
const socket = io();

// Подключение к комнате (и повторное — после переподключения сокета)
function joinRoom() {
  socket.emit('join_room', { room: currentRoom, nick: myName, clientId });
}
socket.on('connect', joinRoom);

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

socket.on('room_users_updated', ({ users, host, hostOnline: online }) => {
  roomHost = host;
  hostOnline = online;
  usersOnlineText.innerHTML = `${users.length} (${users.map(u => (u === host ? '👑 ' : '') + esc(u)).join(', ')})`;
  updateHostUi();
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
    hostPanel.innerHTML = `
      ${t('host.you')}
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

window.hostForcePause = function() { socket.emit('host_force_pause'); };
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
    downloadPackBtn.style.display = 'none';
    downloadPackNone.style.display = 'inline';
    return;
  }

  // Не перезагружаем видео, если пак не поменялся (например, при смене ролей)
  if (video.getAttribute('src') !== session.videoUrl) {
    video.src = session.videoUrl;
    backing.src = session.backingUrl;
    selectedLine = null;
    inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p style="color: #71717a;">${t('inspector.empty')}</p>`;
  }

  if (session.zipUrl) {
    downloadPackBtn.href = session.zipUrl;
    downloadPackBtn.style.display = 'inline-block';
    downloadPackNone.style.display = 'none';
  } else {
    downloadPackBtn.style.display = 'none';
    downloadPackNone.style.display = 'inline';
  }

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
