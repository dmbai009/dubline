const socket = io();
const i18n = window.DublineI18n;
const t = (key, params) => i18n.t(key, params);
i18n.apply();
const pxPerSec = 60;
const labelWidth = 180;

const urlParams = new URLSearchParams(window.location.search);
const currentRoom = urlParams.get('room') || 'main';
document.getElementById('roomNameLabel').innerText = currentRoom;

const state = window.DublineState.data;

const video = document.getElementById('mainVideo');
const backing = document.getElementById('backingAudio');
const timelineContainer = document.getElementById('timelineContainer');
const timeline = document.getElementById('timeline');
const inspector = document.getElementById('inspector');
const zipInput = document.getElementById('zipInput');
const nickModal = document.getElementById('nickModal');
const modalNickInput = document.getElementById('modalNickInput');
const downloadPackBtn = document.getElementById('downloadOriginalPackBtn');
const downloadPackNone = document.getElementById('downloadOriginalPackNone');
const usersOnlineText = document.getElementById('usersOnlineText');
const nickError = document.getElementById('nickError');
const hostPanel = document.getElementById('hostPanel');
const uploadLabel = document.getElementById('uploadLabel');

const audio = window.DublineAudio.createController({
  video,
  backing,
  getSession: () => state.session,
  getVolumes: () => state.volumes,
  getSettings: () => ({
    autoDuckEnabled: state.autoDuckEnabled,
    autoDuckAmount: state.autoDuckAmount
  }),
  isRenderInProgress: () => state.renderInProgress,
  getRecordingLineId: () => state.recordingLineId
});

const {
  applyVolumes,
  ensurePlayCtx,
  getProcessedTake,
  getRawTake,
  precacheTakes,
  resetLine,
  scheduleTakes,
  setDucking,
  stopAllTakes,
  takeBounds,
  takeDryBounds,
  takeStartTime
} = audio;

// Экранирование пользовательского текста перед вставкой в HTML
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Безопасный аргумент для onclick="fn(...)"
function jsArg(value) {
  return esc(JSON.stringify(value));
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  return text || t('error.generic', { message: `HTTP ${res.status}` });
}

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

function refreshViews() {
  if (!session || !session.loaded) return;
  renderTimeline();
  if (selectedLine) showInspector(selectedLine);
}

// ==========================================
// ПРАВА ХОСТА
// ==========================================
function amHost() {
  return !!myName && roomHost === myName;
}

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

  refreshViews();
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

window.copyInviteLink = function() {
  navigator.clipboard.writeText(window.location.href);
  alert(t('invite.copied'));
};

// ==========================================
// НАСТРОЙКИ И ФАЙЛЫ
// ==========================================
const settingsModal = document.getElementById('settingsModal');
const filesModal = document.getElementById('filesModal');
const settingsNickInput = document.getElementById('settingsNickInput');
const settingsNickStatus = document.getElementById('settingsNickStatus');
const settingsMicGain = document.getElementById('settingsMicGain');
const settingsMicGainVal = document.getElementById('settingsMicGainVal');
const settingsNoiseSuppression = document.getElementById('settingsNoiseSuppression');
const settingsAutoDuck = document.getElementById('settingsAutoDuck');
const settingsAutoDuckAmount = document.getElementById('settingsAutoDuckAmount');
const settingsAutoDuckVal = document.getElementById('settingsAutoDuckVal');
const settingsPrompter = document.getElementById('settingsPrompter');
const settingsPrompterSize = document.getElementById('settingsPrompterSize');
const settingsPrompterSizeVal = document.getElementById('settingsPrompterSizeVal');
const settingsLanguage = document.getElementById('settingsLanguage');

function syncSettingsUi() {
  settingsNickInput.value = myName;
  settingsMicGain.value = Math.round(userMicGain * 100);
  settingsMicGainVal.textContent = `${settingsMicGain.value}%`;
  settingsNoiseSuppression.checked = noiseSuppression;
  settingsAutoDuck.checked = autoDuckEnabled;
  settingsAutoDuckAmount.value = Math.round(autoDuckAmount * 100);
  settingsAutoDuckVal.textContent = `${settingsAutoDuckAmount.value}%`;
  document.getElementById('autoDuckSubRow').style.opacity = autoDuckEnabled ? '1' : '0.45';
  settingsPrompter.checked = prompterEnabled;
  settingsPrompterSize.value = prompterSize;
  settingsPrompterSizeVal.textContent = `${prompterSize}px`;
  document.getElementById('prompterSubRow').style.opacity = prompterEnabled ? '1' : '0.45';
  settingsLanguage.value = i18n.getLanguage();
  updatePrompter();
}

window.openSettingsModal = function() { syncSettingsUi(); settingsModal.style.display = 'flex'; };
window.closeSettingsModal = function() { settingsModal.style.display = 'none'; };
window.switchSettingsTab = function(tab) {
  ['user', 'player'].forEach(name => {
    const active = name === tab;
    document.getElementById(`tabBtn${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle('active', active);
    document.getElementById(`tabContent${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle('active', active);
  });
};

window.saveNickFromSettings = function() {
  const next = settingsNickInput.value.trim();
  if (!next || next === myName) return;
  socket.emit('rename_user', { newName: next });
  settingsNickStatus.textContent = t('nick.saved');
  settingsNickStatus.style.display = 'block';
  setTimeout(() => { settingsNickStatus.style.display = 'none'; }, 1800);
};

settingsMicGain.addEventListener('input', () => {
  userMicGain = settingsMicGain.value / 100;
  localStorage.setItem('dubline_mic_gain', userMicGain);
  settingsMicGainVal.textContent = `${settingsMicGain.value}%`;
});
settingsNoiseSuppression.addEventListener('change', () => {
  noiseSuppression = settingsNoiseSuppression.checked;
  localStorage.setItem('dubline_noise_suppression', noiseSuppression ? '1' : '0');
});
settingsAutoDuck.addEventListener('change', () => {
  autoDuckEnabled = settingsAutoDuck.checked;
  localStorage.setItem('dubline_auto_duck', autoDuckEnabled ? '1' : '0');
  syncSettingsUi();
  setDucking(false, true);
});
settingsAutoDuckAmount.addEventListener('input', () => {
  autoDuckAmount = settingsAutoDuckAmount.value / 100;
  localStorage.setItem('dubline_auto_duck_amount', autoDuckAmount);
  settingsAutoDuckVal.textContent = `${settingsAutoDuckAmount.value}%`;
});
settingsPrompter.addEventListener('change', () => {
  prompterEnabled = settingsPrompter.checked;
  localStorage.setItem('dubline_prompter', prompterEnabled ? '1' : '0');
  syncSettingsUi();
});
settingsPrompterSize.addEventListener('input', () => {
  prompterSize = Number(settingsPrompterSize.value);
  localStorage.setItem('dubline_prompter_size', prompterSize);
  settingsPrompterSizeVal.textContent = `${prompterSize}px`;
  updatePrompter();
});
settingsLanguage.addEventListener('change', () => i18n.setLanguage(settingsLanguage.value));

window.openFilesModal = function() { filesModal.style.display = 'flex'; switchFilesTab('import'); };
window.closeFilesModal = function() { filesModal.style.display = 'none'; };
window.switchFilesTab = function(tab) {
  const names = ['import', 'library', 'export'];
  names.forEach(name => {
    const suffix = name[0].toUpperCase() + name.slice(1);
    document.getElementById(`tabBtn${suffix}`).classList.toggle('active', name === tab);
    document.getElementById(`tabContent${suffix}`).classList.toggle('active', name === tab);
  });
  if (tab === 'library') loadServerPacks();
};

window.addEventListener('dubline-language-changed', () => {
  updateHostUi();
  if (session && session.loaded) renderTimeline();
  if (selectedLine) showInspector(selectedLine);
  renderChatHistory();
});

// ==========================================
// ГОРЯЧИЕ КЛАВИШИ (HOTKEYS)
// ==========================================
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

  // Пробел — плей/пауза
  if (e.code === 'Space') {
    e.preventDefault();
    if (video.paused) video.play();
    else video.pause();
  }

  // R или К — запись выбранной реплики
  if (e.code === 'KeyR') {
    e.preventDefault();
    if (selectedLine) handleStudioRecord(selectedLine.id);
  }

  // Стрелки — перемотка на 3 секунды
  if (e.code === 'ArrowLeft') {
    e.preventDefault();
    video.currentTime = Math.max(0, video.currentTime - 3);
  }
  if (e.code === 'ArrowRight') {
    e.preventDefault();
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 3);
  }

  // Esc — закрыть модалки
  if (e.code === 'Escape') {
    closeSettingsModal();
    closeFilesModal();
  }
});

// Микшер громкости
const muteAllCheckbox = document.getElementById('muteAllCheckbox');
const volOriginal = document.getElementById('volOriginal');
const volBacking = document.getElementById('volBacking');
const volRecorded = document.getElementById('volRecorded');
const volOriginalVal = document.getElementById('volOriginalVal');
const volBackingVal = document.getElementById('volBackingVal');
const volRecordedVal = document.getElementById('volRecordedVal');

muteAllCheckbox.addEventListener('change', (e) => { volumes.isMuted = e.target.checked; applyVolumes(); });
volOriginal.addEventListener('input', (e) => { volumes.original = e.target.value / 100; volOriginalVal.innerText = `${e.target.value}%`; applyVolumes(); });
volBacking.addEventListener('input', (e) => { volumes.backing = e.target.value / 100; volBackingVal.innerText = `${e.target.value}%`; applyVolumes(); });
volRecorded.addEventListener('input', (e) => { volumes.recorded = e.target.value / 100; volRecordedVal.innerText = `${e.target.value}%`; applyVolumes(); });

const playhead = document.createElement('div');
playhead.id = 'playhead';
playhead.style.cssText = `
  position: absolute; top: 0; bottom: 0; width: 2px; background: #ef4444;
  z-index: 22; pointer-events: none; left: ${labelWidth}px; display: none;
`;
timeline.appendChild(playhead);
const videoPrompter = document.getElementById('videoPrompter');
const prompterChar = document.getElementById('prompterChar');
const prompterText = document.getElementById('prompterText');
const prompterProgress = document.getElementById('prompterProgress');

function updatePrompter() {
  videoPrompter.style.fontSize = `${prompterSize}px`;
  if (!prompterEnabled || !session || !session.lines) {
    videoPrompter.style.display = 'none';
    return;
  }
  const current = video.currentTime || 0;
  const recording = recordingLineId != null && session.lines.find(line => line.id === recordingLineId);
  const line = recording || session.lines.find(item => current >= item.start && current <= item.end);
  if (!line) {
    videoPrompter.style.display = 'none';
    return;
  }
  prompterChar.textContent = `${line.character}:`;
  prompterText.textContent = line.caption || '…';
  const progress = Math.max(0, Math.min(1, (current - line.start) / Math.max(0.05, line.end - line.start)));
  prompterProgress.style.width = `${progress * 100}%`;
  videoPrompter.style.display = 'block';
}

function syncPlayheadLoop() {
  if (video && !video.paused && !video.ended) {
    const current = video.currentTime;
    const currentPos = labelWidth + current * pxPerSec;
    playhead.style.left = `${currentPos}px`;

    const scrollRight = timelineContainer.scrollLeft + timelineContainer.clientWidth;
    if (currentPos > scrollRight - 200) {
      timelineContainer.scrollLeft = currentPos - 300;
    }

    if (session && session.lines && !renderInProgress) scheduleTakes(current);
    updatePrompter();
    requestAnimationFrame(syncPlayheadLoop);
  }
}

// ==========================================
// ВОСПРОИЗВЕДЕНИЕ ДУБЛЕЙ (Web Audio, с эффектами и обрезкой)
// ==========================================
video.addEventListener('play', () => {
  ensurePlayCtx();
  stopAllTakes();
  applyVolumes();
  backing.currentTime = video.currentTime;
  if (!renderInProgress) backing.play().catch(() => {});
  requestAnimationFrame(syncPlayheadLoop);
});

video.addEventListener('pause', () => {
  backing.pause();
  stopAllTakes();
  playhead.style.left = `${labelWidth + video.currentTime * pxPerSec}px`;
  updatePrompter();
});

video.addEventListener('seeked', () => {
  backing.currentTime = video.currentTime;
  stopAllTakes();
  playhead.style.left = `${labelWidth + video.currentTime * pxPerSec}px`;
  updatePrompter();
});
video.addEventListener('timeupdate', updatePrompter);

// Загрузка нового пака
zipInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('clientId', clientId);
  formData.append('pack', file);
  zipInput.value = '';

  const res = await fetch(`/api/upload-pack?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: formData });
  if (!res.ok) alert(await readError(res));
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

function getLineOwner(line) {
  if (!session) return null;
  const charOwner = session.characterClaims && session.characterClaims[line.character];
  return charOwner || line.claimedBy || null;
}

function renderTimeline() {
  timeline.innerHTML = '';
  timeline.appendChild(playhead);

  if (!session.lines || session.lines.length === 0) return;

  playhead.style.display = 'block';

  const maxTime = Math.max(...session.lines.map(l => l.end), 200);
  const trackWidth = (maxTime + 15) * pxPerSec;
  const characters = [...new Set(session.lines.map(l => l.character))];
  const allowCharacterClaims = characters.length > 1;

  const rulerRow = document.createElement('div');
  rulerRow.className = 'ruler-row';

  const rulerCorner = document.createElement('div');
  rulerCorner.className = 'ruler-corner';
  rulerCorner.innerText = allowCharacterClaims ? t('rolesTrack') : t('linesTrack');

  const rulerTicks = document.createElement('div');
  rulerTicks.className = 'ruler-ticks';
  rulerTicks.style.width = `${trackWidth}px`;

  rulerTicks.onclick = (e) => {
    const rect = rulerTicks.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    video.currentTime = Math.max(0, clickX / pxPerSec);
  };

  for (let sec = 0; sec <= maxTime + 10; sec += 5) {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = `${sec * pxPerSec}px`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    tick.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
    rulerTicks.appendChild(tick);
  }

  rulerRow.appendChild(rulerCorner);
  rulerRow.appendChild(rulerTicks);
  timeline.appendChild(rulerRow);

  characters.forEach(char => {
    const row = document.createElement('div');
    row.className = 'track-row';

    const label = document.createElement('div');
    label.className = 'track-label';

    const charClaimedBy = session.characterClaims ? session.characterClaims[char] : null;

    let roleHtml = '';
    if (allowCharacterClaims) {
      if (!charClaimedBy) {
        roleHtml = `<button class="role-btn" onclick="claimCharacter(${jsArg(char)})">${t('claimRoleShort')}</button>`;
      } else if (charClaimedBy === myName) {
        roleHtml = `<span class="role-badge me">🎭 ${t('you')} <button class="role-btn" style="margin-left:4px" onclick="unclaimCharacter(${jsArg(char)})">✖</button></span>`;
      } else {
        const kickBtn = amHost()
          ? `<button class="role-btn" style="margin-left:4px" title="${t('host.releaseRole', { owner: esc(charClaimedBy) })}" onclick="unclaimCharacter(${jsArg(char)})">✖</button>`
          : '';
        roleHtml = `<span class="role-badge other">🔒 ${esc(charClaimedBy)}${kickBtn}</span>`;
      }
    }

    label.innerHTML = `
      <span class="char-name" title="${esc(char)}">${esc(char)}</span>
      ${roleHtml}
    `;

    const trackArea = document.createElement('div');
    trackArea.className = 'track-timeline';
    trackArea.style.width = `${trackWidth}px`;

    const charLines = session.lines.filter(l => l.character === char);
    charLines.forEach(line => {
      const block = document.createElement('div');
      block.className = 'line-block';
      block.id = `line-block-${line.id}`;
      block.style.left = `${line.start * pxPerSec}px`;
      block.style.width = `${Math.max((line.end - line.start) * pxPerSec, 75)}px`;

      updateLineBlockVisual(block, line);

      block.onclick = () => {
        if (block.dataset.justDragged) {
          delete block.dataset.justDragged;
          return;
        }
        selectLine(session.lines.find(l => l.id === line.id) || line);
      };
      trackArea.appendChild(block);

      if (line.originalAudioUrl) {
        const audioProbe = new Audio(line.originalAudioUrl);
        audioProbe.onloadedmetadata = () => {
          if (audioProbe.duration && isFinite(audioProbe.duration) && audioProbe.duration > 0.1) {
            line.end = Number((line.start + audioProbe.duration).toFixed(2));
            block.style.width = `${Math.max((line.end - line.start) * pxPerSec, 75)}px`;
            if (selectedLine && selectedLine.id === line.id) showInspector(line);
          }
        };
      }
    });

    row.appendChild(label);
    row.appendChild(trackArea);
    timeline.appendChild(row);
  });
}

function updateLineBlockVisual(el, line) {
  const owner = getLineOwner(line);

  el.className = 'line-block';
  if (line.audioUrl) el.classList.add('recorded');
  else if (owner === myName) el.classList.add('claimed-me');
  else if (owner) el.classList.add('claimed-other');

  let nickBadge = '';
  if (owner) {
    const isMe = (owner === myName);
    nickBadge = `<span class="tile-nick ${isMe ? 'me' : 'other'}">${isMe ? t('you') : esc(owner)}</span>`;
  }

  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">
      <strong>#${line.id}</strong>
      ${nickBadge}
    </div>
    <span style="white-space:nowrap; text-overflow:ellipsis; overflow:hidden; font-size:11px; opacity:0.9;">
      ${esc(line.caption || t('lineFallback'))}
    </span>
  `;

  attachWaveform(el, line);
  if (line.audioUrl && owner === myName) enableTakeDrag(el, line.id);
}

// ==========================================
// ПЕРЕТАСКИВАНИЕ ДУБЛЯ ПО ТАЙМЛАЙНУ
// ==========================================
function enableTakeDrag(el, lineId) {
  el.classList.add('draggable');
  el.title = t('dragTitle');

  el.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const line = session.lines.find(l => l.id === lineId);
    if (!line) return;

    const startX = e.clientX;
    const origStart = takeStartTime(line);
    let newStart = origStart;
    let moved = false;
    const canvas = el.querySelector('.wave-canvas');
    const hint = document.createElement('span');
    hint.className = 'drag-hint';

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) {
        moved = true;
        el.classList.add('dragging');
        el.appendChild(hint);
      }
      newStart = Math.max(0, origStart + dx / pxPerSec);
      if (canvas) canvas.style.left = `${(newStart - line.start) * pxPerSec}px`;
      const shift = newStart - (line.recordedStart ?? origStart);
      hint.innerText = `${shift >= 0 ? '+' : ''}${shift.toFixed(2)}с`;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.classList.remove('dragging');
      hint.remove();
      if (!moved) return;
      el.dataset.justDragged = '1';
      setTakeProps(lineId, { audioStart: Number(newStart.toFixed(3)) });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
}

window.setTakeProps = function(lineId, props) {
  socket.emit('set_take_props', { lineId, ...props });
};

window.nudgeTake = function(lineId, delta) {
  const line = session.lines.find(l => l.id === lineId);
  if (line) setTakeProps(lineId, { audioStart: Number(Math.max(0, takeStartTime(line) + delta).toFixed(3)) });
};

window.resetTakeShift = function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  if (line && line.recordedStart != null) setTakeProps(lineId, { audioStart: line.recordedStart });
};

// ==========================================
// ФОРМА ВОЛНЫ НА ТАЙМЛАЙНЕ
// ==========================================
const PEAKS_PER_SEC = 100;
const peaksCache = new Map(); // url -> Promise<Float32Array | null>

function computePeaks(audio) {
  const bucket = Math.max(1, Math.floor(audio.sampleRate / PEAKS_PER_SEC));
  const count = Math.ceil(audio.length / bucket);
  const peaks = new Float32Array(count);

  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < count; i++) {
      let max = peaks[i];
      const end = Math.min(data.length, (i + 1) * bucket);
      for (let j = i * bucket; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
  }

  // Нормализуем, но тишину не раздуваем до полной высоты
  let top = 0;
  for (let i = 0; i < count; i++) if (peaks[i] > top) top = peaks[i];
  const norm = Math.max(top, 0.1);
  for (let i = 0; i < count; i++) peaks[i] /= norm;
  return peaks;
}

function loadPeaks(url, isTake) {
  if (!peaksCache.has(url)) {
    // Дубли декодируются один раз и переиспользуются для воспроизведения
    const decoded = isTake ? getRawTake(url) : fetchAndDecode(url);
    const job = decoded.then(buf => (buf ? computePeaks(buf) : null)).catch(() => null);
    peaksCache.set(url, job);
  }
  return peaksCache.get(url);
}

function attachWaveform(block, line) {
  const url = line.audioUrl || line.originalAudioUrl;
  if (!url) return;

  const isTake = !!line.audioUrl;
  // Дубль начинается раньше реплики на длину pre-roll (и может быть сдвинут вручную)
  const offsetSec = isTake ? takeStartTime(line) - line.start : 0;
  const bounds = isTake ? takeDryBounds(line) : { from: 0, to: Infinity };

  const canvas = document.createElement('canvas');
  canvas.className = 'wave-canvas';
  block.prepend(canvas);

  loadPeaks(url, isTake).then(peaks => {
    if (peaks && canvas.isConnected) drawWaveform(canvas, peaks, offsetSec, isTake, bounds);
  });
}

function drawWaveform(canvas, peaks, offsetSec, isTake, bounds = { from: 0, to: Infinity }) {
  const width = Math.max(1, Math.round((peaks.length / PEAKS_PER_SEC) * pxPerSec));
  const height = canvas.parentElement.clientHeight || 46;
  const dpr = window.devicePixelRatio || 1;

  canvas.style.left = `${offsetSec * pxPerSec}px`;
  canvas.style.width = `${width}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const activeColor = isTake ? 'rgba(52, 211, 153, 0.55)' : 'rgba(161, 161, 170, 0.22)';
  const trimmedColor = 'rgba(161, 161, 170, 0.12)'; // обрезанная тишина — бледнее

  const mid = height / 2;
  const perPx = PEAKS_PER_SEC / pxPerSec;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * perPx);
    const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((x + 1) * perPx)));
    let peak = 0;
    for (let i = from; i < to; i++) if (peaks[i] > peak) peak = peaks[i];
    const h = Math.max(1, peak * (height - 6));
    const t = x / pxPerSec;
    ctx.fillStyle = (t >= bounds.from && t <= bounds.to) ? activeColor : trimmedColor;
    ctx.fillRect(x, mid - h / 2, 1, h);
  }
}

function updateLineBlock(line) {
  const el = document.getElementById(`line-block-${line.id}`);
  if (!el) return;
  updateLineBlockVisual(el, line);
}

function selectLine(line) {
  selectedLine = line;
  video.currentTime = line.start;
  showInspector(line);
}

function showInspector(line) {
  const duration = Number((line.end - line.start).toFixed(2));
  const characters = [...new Set(session.lines.map(l => l.character))];
  const allowCharacterClaims = characters.length > 1;

  const charOwner = session.characterClaims ? session.characterClaims[line.character] : null;
  const owner = getLineOwner(line);

  const isOwnedByMe = (owner === myName);
  const isOwnedByOther = (owner && owner !== myName);
  const isFree = !owner;

  let statusText = '';
  if (isOwnedByMe) {
    statusText = `<span style="color:#10b981; font-weight:bold;">${t('owned.you')} ${charOwner ? t('owned.role') : ''}</span>`;
  } else if (isOwnedByOther) {
    statusText = `<span style="color:#f59e0b; font-weight:bold;">${t('owned.other', { owner: esc(owner) })}</span>`;
  } else {
    statusText = `<span style="color:#a1a1aa;">${t('free')}</span>`;
  }

  let actionsHtml = '';

  if (isFree) {
    actionsHtml += `<button class="btn-claim" onclick="claimSingleLine(${line.id})">${t('claim.line')}</button>`;
    if (allowCharacterClaims) {
      actionsHtml += `<button class="btn-outline" onclick="claimCharacter(${jsArg(line.character)})">${t('claim.role', { character: esc(line.character) })}</button>`;
    }
  } else if (isOwnedByMe) {
    if (!charOwner) {
      actionsHtml += `<button class="btn-unclaim" onclick="unclaimSingleLine(${line.id})">${t('release.line')}</button>`;
      if (allowCharacterClaims) {
        actionsHtml += `<button class="btn-outline" onclick="claimCharacter(${jsArg(line.character)})">${t('claim.role', { character: esc(line.character) })}</button>`;
      }
    } else {
      actionsHtml += `<button class="btn-unclaim" onclick="unclaimCharacter(${jsArg(line.character)})">${t('release.role', { character: esc(line.character) })}</button>`;
    }
  } else if (isOwnedByOther && amHost()) {
    actionsHtml += charOwner
      ? `<button class="btn-host" onclick="unclaimCharacter(${jsArg(line.character)})">${t('host.releaseRole', { owner: esc(owner) })}</button>`
      : `<button class="btn-host" onclick="unclaimSingleLine(${line.id})">${t('host.releaseLine', { owner: esc(owner) })}</button>`;
  }

  let recordBtnHtml = '';
  if (isOwnedByMe) {
    if (!line.audioUrl) {
      recordBtnHtml = `<button class="btn-record" id="recBtn" onclick="handleStudioRecord(${line.id})">${t('record')}</button>`;
    } else {
      recordBtnHtml = `
        <div style="display:flex; gap:6px;">
          <button class="btn-play" style="flex:2;" onclick="previewTake(${line.id})">${t('playTake')}</button>
          <button class="btn-record" id="recBtn" style="flex:2;" onclick="handleStudioRecord(${line.id})">${t('rerecord')}</button>
          <button class="btn-delete" style="flex:1;" onclick="deleteLineAudio(${line.id})" title="${t('confirm.delete')}">🗑️</button>
        </div>
      `;
    }
  } else if (isOwnedByOther) {
    recordBtnHtml = `<button class="btn-record" disabled>${t('owned.other', { owner: esc(owner) })}</button>`;
    if (line.audioUrl) {
      recordBtnHtml += `<button class="btn-play" onclick="previewTake(${line.id})">${t('listenTake', { owner: esc(owner) })}</button>`;
    }
  } else {
    recordBtnHtml = `<button class="btn-record" disabled>${t('claimFirst')}</button>`;
  }

  inspector.innerHTML = `
    <h3>${esc(line.character)} (${t('line')} #${line.id})</h3>
    <p><strong>${t('timing')}</strong> ${line.start}s — ${line.end}s <span style="color:#a1a1aa">(${duration}s)</span></p>
    <p style="background:#27272a; padding:8px; border-radius:6px; margin: 4px 0; max-height:75px; overflow-y:auto;">
      <em>"${esc(line.caption || '...')}"</em>
    </p>
    <p><strong>${t('status')}</strong> ${statusText}</p>
    
    <canvas id="visualizerCanvas" width="320" height="32"></canvas>

    <div style="background:#202024; padding:6px 10px; border-radius:6px; margin-top:2px;">
      <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:bold; color:#a1a1aa;">
        <span>${t('micLevel')}</span>
        <span id="gainDisplay">${Math.round(userMicGain * 100)}%</span>
      </div>
      <input type="range" min="30" max="300" step="10" value="${Math.round(userMicGain * 100)}" 
        style="width:100%; accent-color:#8257e5; cursor:pointer;"
        oninput="updateUserMicGain(this.value)">
    </div>

    ${takePanelHtml(line, isOwnedByMe)}

    <div style="display:flex; flex-direction:column; gap:6px; margin-top:4px;">
      ${line.originalAudioUrl ? `<button class="btn-outline" onclick="playAudio(${jsArg(line.originalAudioUrl)})">${t('listenOriginal')}</button>` : ''}
      ${actionsHtml}
      ${recordBtnHtml}
    </div>
  `;
}

// Настройки записанного дубля: голос, питч, обрезка тишины, сдвиг
function takePanelHtml(line, editable) {
  if (!line.audioUrl) return '';
  const effect = line.effect || 'none';
  const pitch = line.pitch || 0;
  const shift = line.recordedStart != null ? takeStartTime(line) - line.recordedStart : 0;
  const hasTrim = line.trimStart != null && line.trimEnd != null;
  const signed = (v, digits) => `${v > 0 ? '+' : ''}${Number(v).toFixed(digits)}`;

  if (!editable) {
    const parts = [t(`effect.${effect}`) || effect];
    if (pitch) parts.push(`${t('pitch')} ${signed(pitch, 0)}`);
    if (Math.abs(shift) >= 0.005) parts.push(`${t('shift')} ${signed(shift, 2)}s`);
    return `<p style="font-size:11px; color:#a1a1aa;">${t('voice')} ${esc(parts.join(', '))}</p>`;
  }

  const options = Object.entries(VOICE_EFFECTS)
    .map(([key]) => `<option value="${key}" ${key === effect ? 'selected' : ''}>${t(`effect.${key}`)}</option>`)
    .join('');

  return `
    <div class="take-panel">
      <div class="take-row">
        <span>${t('voice')}</span>
        <select onchange="setTakeProps(${line.id}, { effect: this.value })">${options}</select>
      </div>
      <div class="take-row">
        <span>${t('pitch')}</span>
        <input type="range" min="-12" max="12" step="1" value="${pitch}" style="flex:1; accent-color:#8257e5;"
          oninput="document.getElementById('pitchVal').innerText = (this.value > 0 ? '+' : '') + this.value"
          onchange="setTakeProps(${line.id}, { pitch: Number(this.value) })">
        <span id="pitchVal" class="take-val">${signed(pitch, 0)}</span>
      </div>
      <label class="take-row" style="cursor:pointer;">
        <input type="checkbox" ${line.trimEnabled !== false ? 'checked' : ''} ${hasTrim ? '' : 'disabled'}
          onchange="setTakeProps(${line.id}, { trimEnabled: this.checked })">
        <span>${t('trim')}</span>
        <span class="take-val">${hasTrim ? t('speech', { from: line.trimStart.toFixed(2), to: line.trimEnd.toFixed(2) }) : t('speechMissing')}</span>
      </label>
      <div class="take-row">
        <span>${t('shift')} <b>${signed(shift, 2)}s</b></span>
        <button class="btn-outline" onclick="nudgeTake(${line.id}, -0.05)">${t('earlier')}</button>
        <button class="btn-outline" onclick="nudgeTake(${line.id}, 0.05)">${t('later')}</button>
        <button class="btn-outline" onclick="resetTakeShift(${line.id})" ${Math.abs(shift) < 0.005 ? 'disabled' : ''}>${t('reset')}</button>
      </div>
      <p class="take-hint">${t('dragHint')}</p>
    </div>
  `;
}

window.deleteLineAudio = async function(lineId) {
  if (!confirm(t('confirm.delete'))) return;
  const res = await fetch('/api/delete-line-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lineId, userName: myName, clientId, room: currentRoom })
  });
  if (!res.ok) alert(await readError(res));
};

window.updateUserMicGain = function(val) {
  userMicGain = val / 100;
  localStorage.setItem('dubline_mic_gain', userMicGain);
  const disp = document.getElementById('gainDisplay');
  if (disp) disp.innerText = `${val}%`;
};

window.claimCharacter = function(char) { socket.emit('claim_character', { character: char }); };
window.unclaimCharacter = function(char) { socket.emit('unclaim_character', { character: char }); };
window.claimSingleLine = function(lineId) { socket.emit('claim_line', { lineId }); };
window.unclaimSingleLine = function(lineId) { socket.emit('unclaim_line', { lineId }); };

window.playAudio = function(url) {
  audio.playAudio(url).catch(error => console.error(error));
};

// Прослушать дубль так, как он прозвучит в ролике: с эффектом, питчем и обрезкой
window.previewTake = async function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  if (!line) return;
  if (!await audio.previewTake(line)) alert(t('error.take'));
};

function startVisualizer(stream) {
  const canvas = document.getElementById('visualizerCanvas');
  if (!canvas) return;
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  isVisualizerRunning = true;

  function draw() {
    if (!isVisualizerRunning) return;
    requestAnimationFrame(draw);

    analyser.getByteFrequencyData(dataArray);
    ctx.fillStyle = '#121214';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 1.5;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * canvas.height;
      if (dataArray[i] > 200) ctx.fillStyle = '#ef4444';
      else if (dataArray[i] > 120) ctx.fillStyle = '#f59e0b';
      else ctx.fillStyle = '#10b981';

      ctx.fillRect(x, canvas.height - barHeight, barWidth - 2, barHeight);
      x += barWidth;
    }
  }
  draw();
}

function stopVisualizer() {
  isVisualizerRunning = false;
  const canvas = document.getElementById('visualizerCanvas');
  if (canvas) canvas.style.display = 'none';
}

window.handleStudioRecord = async function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  const btn = document.getElementById('recBtn');
  if (!line || !btn) return;

  const owner = getLineOwner(line);
  if (owner !== myName) {
    alert(t('error.notOwner'));
    return;
  }

  if (recordState === 'recording' || recordState === 'preparing') {
    finishRecording();
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: noiseSuppression,
        noiseSuppression,
        autoGainControl: false,
        channelCount: 1
      }
    });
  } catch (err) {
    alert(t('error.mic'));
    return;
  }

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const micSource = audioCtx.createMediaStreamSource(micStream);
  const gainNode = audioCtx.createGain();
  gainNode.gain.value = userMicGain;
  const audioDest = audioCtx.createMediaStreamDestination();
  micSource.connect(gainNode);
  gainNode.connect(audioDest);

  startVisualizer(micStream);

  const preRoll = Math.min(1.0, line.start);
  const startTime = Number((line.start - preRoll).toFixed(2));
  currentRecordingStartTime = startTime;
  video.currentTime = startTime;

  recordState = 'preparing';
  audioChunks = [];
  discardTake = false;
  recordingLineId = lineId;

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  mediaRecorder = mimeType ? new MediaRecorder(audioDest.stream, { mimeType }) : new MediaRecorder(audioDest.stream);

  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }

    recordingLineId = null;

    // Запись прервана хостом — дубль не сохраняем
    if (discardTake) {
      discardTake = false;
      if (selectedLine) showInspector(selectedLine);
      return;
    }

    const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (audioBlob.size === 0) {
      alert(t('error.emptyAudio'));
      btn.className = 'btn-record';
      btn.innerText = t('record.retry');
      return;
    }

    // Автоопределение тишины: ищем, где в записи начинается и заканчивается речь
    btn.innerText = t('record.trim');
    let speech = null;
    try {
      speech = detectSpeechBounds(await decodeAudio(await audioBlob.arrayBuffer()));
    } catch (err) {
      console.warn('[Dubline] Не удалось проанализировать дубль:', err);
    }

    const formData = new FormData();
    formData.append('lineId', lineId);
    formData.append('userName', myName);
    formData.append('clientId', clientId);
    formData.append('audioStart', currentRecordingStartTime);
    if (speech) {
      formData.append('trimStart', speech.start);
      formData.append('trimEnd', speech.end);
    }
    formData.append('audio', audioBlob);

    btn.innerText = t('record.saving');
    const res = await fetch(`/api/upload-line-audio?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: formData });
    if (!res.ok) {
      alert(await readError(res));
      showInspector(line);
      return;
    }
    const resData = await res.json();

    if (resData.success) {
      const fresh = session.lines.find(l => l.id === lineId) || line;
      selectedLine = fresh;
      showInspector(fresh);
    }
  };

  mediaRecorder.start(100);
  btn.className = 'btn-prep';
  btn.innerText = t('record.preparing');
  video.play();

  const checkSpeechInterval = setInterval(() => {
    if (video.currentTime >= line.start - 0.05) {
      clearInterval(checkSpeechInterval);
      if (recordState === 'preparing') {
        recordState = 'recording';
        btn.className = 'btn-record recording-active';
        btn.innerText = t('record.speak');
      }
    }
  }, 25);

  const lineDuration = Math.max(0.5, line.end - line.start);
  const totalRecordTimeMs = (preRoll + lineDuration + 1.0) * 1000;

  recordStopTimeout = setTimeout(() => {
    if (recordState === 'recording' || recordState === 'preparing') finishRecording();
  }, totalRecordTimeMs);
};

function finishRecording({ discard = false } = {}) {
  clearTimeout(recordStopTimeout);
  recordState = 'idle';
  if (discard) discardTake = true;

  video.pause();
  stopVisualizer();

  const btn = document.getElementById('recBtn');
  if (btn) {
    btn.className = 'btn-stop';
    btn.innerText = t('record.processing');
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

// ==========================================
// ИМПОРТ И БИБЛИОТЕКА МОДОВ
// ==========================================
const libraryList = document.getElementById('filesLibraryList');

async function loadServerPacks() {
  libraryList.innerHTML = `<span style="color:#a1a1aa; padding:10px;">${t('packs.loading')}</span>`;
  const res = await fetch('/api/server-packs');
  const list = await res.json();

  if (list.length === 0) {
    libraryList.innerHTML = `<span style="color:#71717a; padding:10px;">${t('packs.empty')}</span>`;
    return;
  }

  libraryList.innerHTML = '';
  list.forEach(item => {
    const div = document.createElement('div');
    div.className = 'pack-item';
    div.innerHTML = `
      <div>
        <strong>${esc(item.title)}</strong>
        <div style="font-size:10px; color:#71717a;">${esc(item.sizeMb)} МБ</div>
      </div>
      <div style="display:flex; gap:6px;">
        <a href="${esc(item.url)}" class="btn-share" download style="text-decoration:none; padding:4px 8px;">${t('download')}</a>
        ${amHost()
          ? `<button class="btn-play" onclick="loadSavedPack(${jsArg(item.filename)})">${t('launch')}</button>`
          : `<button class="btn-play" disabled title="${t('onlyHost')}">🔒 ${t('onlyHost')}</button>`}
      </div>
    `;
    libraryList.appendChild(div);
  });
}

window.loadSavedPack = async function(filename) {
  closeFilesModal();
  const res = await fetch('/api/load-server-pack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, room: currentRoom, clientId })
  });
  if (!res.ok) alert(await readError(res));
};

window.uploadCustomScene = async function() {
  if (!amHost()) return alert(t('onlyHost'));
  const videoFile = document.getElementById('customVideoInput').files[0];
  const subtitleFile = document.getElementById('customSubInput').files[0];
  const status = document.getElementById('customUploadStatus');
  const button = document.getElementById('customUploadBtn');
  if (!videoFile) return alert(t('error.generic', { message: t('videoFile') }));
  if (!subtitleFile && !/\.mkv$/i.test(videoFile.name)) return alert(t('error.generic', { message: t('subtitleFile') }));

  const form = new FormData();
  form.append('clientId', clientId);
  form.append('title', document.getElementById('customSceneTitle').value.trim());
  form.append('video', videoFile);
  if (subtitleFile) form.append('subtitles', subtitleFile);
  status.textContent = t('uploading');
  status.style.cssText = 'display:block;color:#a78bfa;font-size:11px;';
  button.disabled = true;
  try {
    const res = await fetch(`/api/upload-custom?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(await readError(res));
    status.textContent = t('upload.done');
    status.style.color = '#10b981';
    setTimeout(closeFilesModal, 700);
  } catch (err) {
    status.textContent = t('error.generic', { message: err.message });
    status.style.color = '#ef4444';
  } finally {
    button.disabled = false;
  }
};

// ==========================================
// БЕЗОПАСНЫЙ СТУДИЙНЫЙ РЕНДЕР
// ==========================================
const renderDubVol = document.getElementById('renderDubVol');
const renderBackingVol = document.getElementById('renderBackingVol');
const renderOrigVol = document.getElementById('renderOrigVol');
const renderDubVal = document.getElementById('renderDubVal');
const renderBackingVal = document.getElementById('renderBackingVal');
const renderOrigVal = document.getElementById('renderOrigVal');

renderDubVol.oninput = () => renderDubVal.innerText = `${renderDubVol.value}%`;
renderBackingVol.oninput = () => renderBackingVal.innerText = `${renderBackingVol.value}%`;
renderOrigVol.oninput = () => renderOrigVal.innerText = `${renderOrigVol.value}%`;

window.openRenderModal = function() {
  if (!session || !session.loaded) {
    alert(t('error.noScene'));
    return;
  }
  openFilesModal();
  switchFilesTab('export');
};

window.closeRenderModal = function() {
  closeFilesModal();
};

function readRenderGains() {
  return {
    dub: renderDubVol.value / 100,
    backing: renderBackingVol.value / 100,
    original: renderOrigVol.value / 100
  };
}

function downloadBlob(blob, ext) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Dubline_${session.title}_export.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Офлайн-сведение всей звуковой дорожки: интершум + оригинал + дубли с эффектами и обрезкой
async function mixSoundtrack(duration, gains, onStep) {
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * rate)), rate);

  // Мягкий лимитер на мастере, чтобы громкие места не хрипели после кодирования
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  limiter.connect(ctx.destination);

  const backingBus = ctx.createGain();
  const originalBus = ctx.createGain();
  backingBus.connect(limiter);
  originalBus.connect(limiter);
  const hasSeparateBacking = !!session.backingUrl;
  const backingBase = hasSeparateBacking ? gains.backing : 0;
  const originalBase = hasSeparateBacking ? gains.original : gains.backing;
  backingBus.gain.value = backingBase;
  originalBus.gain.value = originalBase;

  const place = (buffer, gain, when, from = 0, to = buffer ? buffer.duration : 0, destination = limiter) => {
    if (!buffer || gain <= 0) return;
    to = Math.min(to, buffer.duration);
    if (to <= from) return;
    const skip = Math.max(0, -when);
    if (from + skip >= to) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(destination);
    src.start(Math.max(0, when), from + skip, to - from - skip);
  };

  if (session.backingUrl && backingBase > 0) {
    onStep(t('render.decodeBackground'));
    place(await fetchAndDecode(session.backingUrl).catch(() => null), 1, 0, 0, Infinity, backingBus);
  }
  if (session.videoUrl && originalBase > 0) {
    onStep(t('render.decodeOriginal'));
    place(await fetchAndDecode(session.videoUrl).catch(() => null), 1, 0, 0, Infinity, originalBus);
  }

  const takes = session.lines.filter(l => l.audioUrl);
  const duckIntervals = [];
  for (let i = 0; i < takes.length; i++) {
    onStep(t('render.takes', { current: i + 1, total: takes.length }));
    const line = takes[i];
    const buffer = await getProcessedTake(line);
    if (!buffer) continue;
    const { from, to } = takeBounds(line, buffer.duration);
    place(buffer, gains.dub, takeStartTime(line) + from, from, to);
    duckIntervals.push([Math.max(0, takeStartTime(line) + from), Math.min(duration, takeStartTime(line) + to)]);
  }

  if (autoDuckEnabled && autoDuckAmount > 0 && duckIntervals.length) {
    duckIntervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const interval of duckIntervals) {
      const last = merged[merged.length - 1];
      if (last && interval[0] <= last[1] + 0.25) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const automateDuck = (param, base) => {
      if (base <= 0) return;
      const ducked = base * (1 - autoDuckAmount);
      param.setValueAtTime(base, 0);
      merged.forEach(([start, end]) => {
        param.setValueAtTime(base, Math.max(0, start));
        param.linearRampToValueAtTime(ducked, Math.min(duration, start + 0.08));
        param.setValueAtTime(ducked, Math.max(start + 0.08, end));
        param.linearRampToValueAtTime(base, Math.min(duration, end + 0.25));
      });
    };
    automateDuck(backingBus.gain, backingBase);
    automateDuck(originalBus.gain, originalBase);
  }

  onStep(t('render.mix'));
  return ctx.startRendering();
}

function audioBufferToWav(buffer) {
  const channels = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true); write(36, 'data');
  view.setUint32(40, dataBytes, true);
  const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}

async function renderCharacterStem(lines, duration, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.connect(ctx.destination);
  for (const line of lines) {
    const buffer = await getProcessedTake(line);
    if (!buffer) continue;
    const { from, to } = takeBounds(line, buffer.duration);
    const when = takeStartTime(line) + from;
    const skip = Math.max(0, -when);
    if (from + skip >= to) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(limiter);
    source.start(Math.max(0, when), from + skip, to - from - skip);
  }
  return ctx.startRendering();
}

window.downloadReaperStems = async function() {
  if (!session || !session.loaded) return alert(t('error.noScene'));
  const takes = session.lines.filter(line => line.audioUrl);
  if (!takes.length) return alert(t('error.noTakes'));
  const grouped = new Map();
  takes.forEach(line => {
    if (!grouped.has(line.character)) grouped.set(line.character, []);
    grouped.get(line.character).push(line);
  });
  const status = document.getElementById('stemsStatus');
  const button = document.getElementById('downloadStemsBtn');
  status.style.display = 'block';
  status.style.color = '#a78bfa';
  button.disabled = true;
  try {
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      await new Promise(resolve => {
        const done = () => resolve();
        video.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 5000);
        video.load();
      });
    }
    const duration = Math.max(Number(video.duration) || 0, ...takes.map(line => takeStartTime(line) + Math.max(1, line.end - line.start) + 1));
    const zip = new JSZip();
    const manifest = [];
    let index = 0;
    for (const [character, lines] of grouped) {
      index++;
      status.textContent = t('stems.progress', { current: index, total: grouped.size, name: character });
      const stem = await renderCharacterStem(lines, duration);
      const safeName = String(character || `Character_${index}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80);
      zip.file(`${String(index).padStart(2, '0')}_${safeName}.wav`, audioBufferToWav(stem));
      lines.forEach(line => manifest.push(`${character}\t${takeStartTime(line).toFixed(3)}\t${line.id}\t${line.caption || ''}`));
    }
    zip.file('timeline.tsv', `character\tstart_seconds\tline_id\tcaption\n${manifest.join('\n')}\n`);
    status.textContent = t('stems.mixing');
    const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    const safeProject = String(session.title || 'dubline').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    const url = URL.createObjectURL(archive);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeProject}_stems.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = t('stems.done');
    status.style.color = '#10b981';
  } catch (err) {
    status.textContent = t('error.generic', { message: err.message });
    status.style.color = '#ef4444';
  } finally {
    button.disabled = false;
  }
};

function sliceAudioBuffer(buffer, fromSample, toSample) {
  const length = Math.max(1, toSample - fromSample);
  const chunk = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    chunk.copyToChannel(buffer.getChannelData(c).subarray(fromSample, toSample), c);
  }
  return chunk;
}

function supportsWebCodecsRender() {
  return typeof window.AudioEncoder === 'function' && typeof window.EncodedVideoChunk === 'function';
}

// Рендер через WebCodecs: видеодорожка копируется без перекодирования, звук кодируется AudioEncoder'ом.
// Работает в разы быстрее реального времени и не зависит от того, свернута ли вкладка.
async function renderWithWebCodecs(progress) {
  const mb = await import('/vendor/mediabunny/mediabunny.min.mjs');

  progress(1, t('render.readVideo'));
  const input = new mb.Input({ source: new mb.UrlSource(session.videoUrl), formats: mb.ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error(t('render.noVideo'));
  const videoCodec = await videoTrack.getCodec();
  const decoderConfig = await videoTrack.getDecoderConfig();
  const duration = await videoTrack.computeDuration();
  if (!videoCodec || !decoderConfig) throw new Error(t('render.unknownCodec'));

  const soundtrack = await mixSoundtrack(duration, readRenderGains(), text => progress(5, text));

  const audioCodec = await mb.getFirstEncodableAudioCodec(['aac', 'opus'], {
    numberOfChannels: soundtrack.numberOfChannels,
    sampleRate: soundtrack.sampleRate
  });
  if (!audioCodec) throw new Error(t('render.noAudioCodec'));

  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new mb.BufferTarget()
  });
  const videoSource = new mb.EncodedVideoPacketSource(videoCodec);
  const audioSource = new mb.AudioBufferSource({ codec: audioCodec, quality: mb.QUALITY_HIGH });
  output.addVideoTrack(videoSource);
  output.addAudioTrack(audioSource);
  await output.start();

  // Звук добавляем порциями вперемешку с видео, чтобы дорожки в файле шли чередуясь
  const rate = soundtrack.sampleRate;
  let audioPos = 0;
  const pushAudioUntil = async (seconds) => {
    const target = Math.min(soundtrack.length, Math.ceil(seconds * rate));
    while (audioPos < target) {
      const next = Math.min(target, audioPos + rate);
      await audioSource.add(sliceAudioBuffer(soundtrack, audioPos, next));
      audioPos = next;
    }
  };

  const sink = new mb.EncodedPacketSink(videoTrack);
  let first = true;
  let lastUiUpdate = 0;
  for await (const packet of sink.packets()) {
    await videoSource.add(packet, first ? { decoderConfig } : undefined);
    first = false;
    await pushAudioUntil(packet.timestamp + 1);

    const now = performance.now();
    if (now - lastUiUpdate > 100) {
      lastUiUpdate = now;
      const pct = Math.min(95, 10 + 85 * (packet.timestamp / duration));
      progress(pct, t('render.mp4Progress', { current: Math.round(packet.timestamp), total: Math.round(duration) }));
    }
  }
  await pushAudioUntil(Infinity);

  videoSource.close();
  audioSource.close();
  progress(97, t('render.finalize'));
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

// Запасной вариант для браузеров без WebCodecs: запись с экрана в реальном времени
async function renderRealtime(progress) {
  const duration = video.duration;
  const soundtrack = await mixSoundtrack(duration, readRenderGains(), text => progress(2, text));

  const renderCanvas = document.createElement('canvas');
  renderCanvas.width = video.videoWidth || 1280;
  renderCanvas.height = video.videoHeight || 720;
  const ctx = renderCanvas.getContext('2d');

  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = actx.createMediaStreamDestination();
  const mixSource = actx.createBufferSource();
  mixSource.buffer = soundtrack;
  mixSource.connect(dest);

  const combinedStream = new MediaStream([
    ...renderCanvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
    ? 'video/mp4;codecs=avc1,mp4a.40.2'
    : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm');

  const recorder = new MediaRecorder(combinedStream, { mimeType });
  const recordedChunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
  const stopped = new Promise(resolve => { recorder.onstop = resolve; });

  const savedMuted = video.muted;
  video.muted = true;
  video.currentTime = 0;
  await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));

  recorder.start();
  await video.play();
  mixSource.start();

  await new Promise(resolve => {
    function drawRenderFrame() {
      ctx.drawImage(video, 0, 0, renderCanvas.width, renderCanvas.height);
      const pct = (video.currentTime / duration) * 100;
      progress(pct, t('render.realtimeProgress', { current: Math.round(video.currentTime), total: Math.round(duration) }));
      if (video.ended || video.currentTime >= duration - 0.1) return resolve();
      requestAnimationFrame(drawRenderFrame);
    }
    requestAnimationFrame(drawRenderFrame);
  });

  video.pause();
  video.muted = savedMuted;
  recorder.stop();
  await stopped;
  actx.close();

  return { blob: new Blob(recordedChunks, { type: mimeType }), ext: mimeType.includes('mp4') ? 'mp4' : 'webm' };
}

window.startVideoRender = async function() {
  const startBtn = document.getElementById('startRenderBtn');
  const progressBox = document.getElementById('renderProgressBox');
  const progressBar = document.getElementById('renderProgressBar');
  const statusText = document.getElementById('renderStatusText');

  const progress = (pct, text) => {
    progressBar.style.width = `${pct}%`;
    statusText.innerText = `⏳ ${text}`;
  };

  startBtn.disabled = true;
  progressBox.style.display = 'block';
  video.pause();
  renderInProgress = true;
  applyVolumes();
  const startedAt = performance.now();

  try {
    let result = null;
    if (supportsWebCodecsRender()) {
      try {
        result = { blob: await renderWithWebCodecs(progress), ext: 'mp4' };
      } catch (err) {
        console.error('[Dubline] WebCodecs-рендер не удался, переключаюсь на запись в реальном времени:', err);
        progress(0, t('render.fallback'));
      }
    }
    if (!result) result = await renderRealtime(progress);

    downloadBlob(result.blob, result.ext);
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    progressBar.style.width = '100%';
    statusText.innerText = t('render.done', { seconds });
    setTimeout(() => {
      closeRenderModal();
      progressBox.style.display = 'none';
    }, 2000);
  } catch (err) {
    console.error('[Dubline] Ошибка рендера:', err);
    statusText.innerText = t('render.error', { message: err.message });
  } finally {
    renderInProgress = false;
    applyVolumes();
    startBtn.disabled = false;
  }
};

// ==========================================
// ТЕКСТОВЫЙ ЧАТ
// ==========================================
const chatPanel = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const chatEmpty = document.getElementById('chatEmpty');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatToggleBtn = document.getElementById('chatToggleBtn');
const chatUnread = document.getElementById('chatUnread');
let unreadCount = 0;
let currentChatHistory = [];

function isChatOpen() {
  return chatPanel.style.display !== 'none';
}

function setChatOpen(open) {
  chatPanel.style.display = open ? 'flex' : 'none';
  chatToggleBtn.classList.toggle('active', open);
  localStorage.setItem('dubline_chat_open', open ? '1' : '0');
  if (open) {
    unreadCount = 0;
    chatUnread.style.display = 'none';
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

window.toggleChat = function() {
  setChatOpen(!isChatOpen());
};

function appendChatMessage(msg) {
  chatEmpty.style.display = 'none';
  const atBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 40;

  const el = document.createElement('div');
  if (msg.system) {
    el.className = 'chat-msg system';
    el.textContent = msg.key ? t(msg.key, msg.params || {}) : msg.text;
  } else {
    const time = new Date(msg.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    el.className = 'chat-msg' + (msg.nick === myName ? ' me' : '');
    el.innerHTML = `<span class="chat-time">${time}</span> <strong class="chat-nick">${esc(msg.nick)}:</strong> <span>${esc(msg.text)}</span>`;
  }
  chatMessages.appendChild(el);

  if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChatHistory() {
  chatMessages.querySelectorAll('.chat-msg').forEach(el => el.remove());
  chatEmpty.style.display = currentChatHistory.length ? 'none' : 'block';
  currentChatHistory.forEach(appendChatMessage);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

socket.on('chat_history', (history) => {
  currentChatHistory = history;
  renderChatHistory();
});

socket.on('chat_message', (msg) => {
  currentChatHistory.push(msg);
  if (currentChatHistory.length > 100) currentChatHistory.shift();
  appendChatMessage(msg);
  if (!isChatOpen() && msg.nick !== myName) {
    unreadCount++;
    chatUnread.innerText = unreadCount > 99 ? '99+' : unreadCount;
    chatUnread.style.display = 'inline-block';
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (!myName) {
    showNickModal();
    return;
  }
  socket.emit('chat_message', { text });
  chatInput.value = '';
});

setChatOpen(localStorage.getItem('dubline_chat_open') !== '0');
syncSettingsUi();
