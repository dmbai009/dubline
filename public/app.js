const socket = io();
const pxPerSec = 60;
const labelWidth = 180;

const urlParams = new URLSearchParams(window.location.search);
const currentRoom = urlParams.get('room') || 'main';
document.getElementById('roomNameLabel').innerText = currentRoom;

let session = null;
let selectedLine = null;
let mediaRecorder = null;
let audioChunks = [];

let myName = localStorage.getItem('dubline_nick') || '';
const clientId = getClientId();
let roomHost = null;
let hostOnline = false;
let discardTake = false;
let userMicGain = parseFloat(localStorage.getItem('dubline_mic_gain')) || 1.0;

let audioCtx = null;
let analyser = null;
let micStream = null;
let isVisualizerRunning = false;
let recordState = 'idle';
let recordStopTimeout = null;
let previewAudio = null;
let activeAudios = [];
let lastPlayTime = 0;
let currentRecordingStartTime = 0;

const volumes = { original: 0.0, backing: 1.0, recorded: 1.0, isMuted: false };

const video = document.getElementById('mainVideo');
const backing = document.getElementById('backingAudio');
const timelineContainer = document.getElementById('timelineContainer');
const timeline = document.getElementById('timeline');
const inspector = document.getElementById('inspector');
const zipInput = document.getElementById('zipInput');
const nickInput = document.getElementById('nickInput');
const nickModal = document.getElementById('nickModal');
const modalNickInput = document.getElementById('modalNickInput');
const downloadPackBtn = document.getElementById('downloadPackBtn');
const usersOnlineText = document.getElementById('usersOnlineText');
const nickError = document.getElementById('nickError');
const hostPanel = document.getElementById('hostPanel');
const uploadLabel = document.getElementById('uploadLabel');

// Постоянный секретный ID устройства: к нему сервер привязывает ник и права хоста
function getClientId() {
  let id = localStorage.getItem('dubline_client_id');
  if (!id) {
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    localStorage.setItem('dubline_client_id', id);
  }
  return id;
}

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
  return text || `Ошибка сервера (${res.status})`;
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
socket.on('nick_state', ({ nick, error }) => {
  myName = nick || '';
  nickInput.value = myName;
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
  nickInput.value = myName;
}

window.handleNickSubmit = function(e) {
  e.preventDefault();
  const val = modalNickInput.value.trim();
  if (!val) return;

  myName = val;
  localStorage.setItem('dubline_nick', myName);
  nickInput.value = myName;
  nickModal.style.display = 'none';

  joinRoom();
  refreshViews();
};

nickInput.addEventListener('change', (e) => {
  const nextVal = e.target.value.trim();
  if (!nextVal || nextVal === myName) {
    nickInput.value = myName;
    return;
  }

  socket.emit('rename_user', { newName: nextVal });
});

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
      👑 Вы хост
      <button class="btn-host" onclick="hostForcePause()" title="Поставить видео на паузу у всех игроков">⏸ Пауза у всех</button>
      <button class="btn-host" onclick="hostResetClaims()" title="Освободить все роли и реплики (дубли останутся)">♻ Сбросить роли</button>
    `;
  } else if (!hostOnline) {
    hostPanel.className = 'host-panel offline';
    hostPanel.innerHTML = `
      👑 Хост не в сети
      <button class="btn-host" onclick="claimHost()">Стать хостом</button>
    `;
  } else {
    hostPanel.className = 'host-panel';
    hostPanel.innerHTML = `👑 Хост: ${esc(roomHost)}`;
  }

  const canManagePacks = amHost();
  uploadLabel.classList.toggle('disabled', !canManagePacks);
  zipInput.disabled = !canManagePacks;
  uploadLabel.title = canManagePacks ? 'Загрузить новый пак в комнату' : 'Менять пак может только хост';

  refreshViews();
}

window.hostForcePause = function() { socket.emit('host_force_pause'); };
window.claimHost = function() { socket.emit('claim_host'); };
window.hostResetClaims = function() {
  if (!confirm('Освободить все роли и реплики? Записанные дубли останутся.')) return;
  socket.emit('host_reset_claims');
};

socket.on('force_pause', () => {
  if (recordState !== 'idle') finishRecording({ discard: true });
  video.pause();
});

window.copyInviteLink = function() {
  navigator.clipboard.writeText(window.location.href);
  alert(`Ссылка на комнату скопирована в буфер! Отправьте её друзьям.`);
};

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
    closeRenderModal();
    closeLibraryModal();
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

function applyVolumes() {
  if (volumes.isMuted) {
    video.volume = 0;
    backing.volume = 0;
    activeAudios.forEach(a => a.volume = 0);
  } else {
    video.volume = volumes.original;
    backing.volume = volumes.backing;
    activeAudios.forEach(a => a.volume = volumes.recorded);
  }
}

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

function syncPlayheadLoop() {
  if (video && !video.paused && !video.ended) {
    const current = video.currentTime;
    const currentPos = labelWidth + current * pxPerSec;
    playhead.style.left = `${currentPos}px`;

    const scrollRight = timelineContainer.scrollLeft + timelineContainer.clientWidth;
    if (currentPos > scrollRight - 200) {
      timelineContainer.scrollLeft = currentPos - 300;
    }

    if (session && session.lines && current > lastPlayTime && (current - lastPlayTime) < 0.5) {
      session.lines.forEach(line => {
        if (line.audioUrl) {
          const triggerTime = (line.audioStart !== null && line.audioStart !== undefined) ? line.audioStart : line.start;
          if (lastPlayTime <= triggerTime && current >= triggerTime) {
            playSceneLine(line);
          }
        }
      });
    }

    lastPlayTime = current;
    requestAnimationFrame(syncPlayheadLoop);
  }
}

function playSceneLine(line) {
  const sound = new Audio(line.audioUrl);
  const targetVol = volumes.isMuted ? 0 : volumes.recorded;
  sound.volume = 0;

  sound.play().then(() => {
    let v = 0;
    const fadeTimer = setInterval(() => {
      v += targetVol * 0.25;
      if (v >= targetVol) {
        sound.volume = targetVol;
        clearInterval(fadeTimer);
      } else {
        sound.volume = v;
      }
    }, 12);
  }).catch(() => {});

  activeAudios.push(sound);
  sound.onended = () => {
    activeAudios = activeAudios.filter(a => a !== sound);
  };
}

video.addEventListener('play', () => {
  lastPlayTime = video.currentTime;
  applyVolumes();
  backing.currentTime = video.currentTime;
  backing.play().catch(() => {});
  requestAnimationFrame(syncPlayheadLoop);
});

video.addEventListener('pause', () => {
  backing.pause();
  activeAudios.forEach(a => { a.pause(); a.currentTime = 0; });
  activeAudios = [];
  playhead.style.left = `${labelWidth + video.currentTime * pxPerSec}px`;
});

video.addEventListener('seeked', () => {
  lastPlayTime = video.currentTime;
  backing.currentTime = video.currentTime;
  activeAudios.forEach(a => { a.pause(); a.currentTime = 0; });
  activeAudios = [];
  playhead.style.left = `${labelWidth + video.currentTime * pxPerSec}px`;
});

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
    return;
  }

  // Не перезагружаем видео, если пак не поменялся (например, при смене ролей)
  if (video.getAttribute('src') !== session.videoUrl) {
    video.src = session.videoUrl;
    backing.src = session.backingUrl;
    selectedLine = null;
    inspector.innerHTML = '<h3>Инспектор реплики</h3><p style="color: #71717a;">Выберите реплику на таймлайне снизу для записи. (Пробел — плей/пауза, R — запись)</p>';
  }

  if (session.zipUrl) {
    downloadPackBtn.href = session.zipUrl;
    downloadPackBtn.style.display = 'inline-block';
  } else {
    downloadPackBtn.style.display = 'none';
  }

  applyVolumes();
  renderTimeline();
  if (selectedLine) {
    const updated = session.lines.find(l => l.id === selectedLine.id);
    if (updated) {
      selectedLine = updated;
      showInspector(updated);
    }
  }
});

socket.on('line_updated', (updatedLine) => {
  if (!session || !session.lines) return;
  const idx = session.lines.findIndex(l => l.id === updatedLine.id);
  if (idx !== -1) {
    session.lines[idx] = updatedLine;
    updateLineBlock(updatedLine);
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
  rulerCorner.innerText = allowCharacterClaims ? 'Роли и персонажи' : 'Дорожка реплик';

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
        roleHtml = `<button class="role-btn" onclick="claimCharacter(${jsArg(char)})">+ Взять роль</button>`;
      } else if (charClaimedBy === myName) {
        roleHtml = `<span class="role-badge me">🎭 Вы <button class="role-btn" style="margin-left:4px" onclick="unclaimCharacter(${jsArg(char)})">✖</button></span>`;
      } else {
        const kickBtn = amHost()
          ? `<button class="role-btn" style="margin-left:4px" title="Снять роль (хост)" onclick="unclaimCharacter(${jsArg(char)})">✖</button>`
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

      block.onclick = () => selectLine(line);
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
    nickBadge = `<span class="tile-nick ${isMe ? 'me' : 'other'}">${isMe ? 'Вы' : esc(owner)}</span>`;
  }

  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">
      <strong>#${line.id}</strong>
      ${nickBadge}
    </div>
    <span style="white-space:nowrap; text-overflow:ellipsis; overflow:hidden; font-size:11px; opacity:0.9;">
      ${esc(line.caption || '(реплика)')}
    </span>
  `;

  attachWaveform(el, line);
}

// ==========================================
// ФОРМА ВОЛНЫ НА ТАЙМЛАЙНЕ
// ==========================================
const PEAKS_PER_SEC = 100;
const peaksCache = new Map(); // url -> Promise<Float32Array | null>
let decodeCtx = null;

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

function loadPeaks(url) {
  if (!peaksCache.has(url)) {
    const job = fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(res.status);
        return res.arrayBuffer();
      })
      .then(buf => {
        // OfflineAudioContext умеет декодировать без жеста пользователя
        if (!decodeCtx) decodeCtx = new OfflineAudioContext(1, 1, 44100);
        return decodeCtx.decodeAudioData(buf);
      })
      .then(computePeaks)
      .catch(() => null);
    peaksCache.set(url, job);
  }
  return peaksCache.get(url);
}

function attachWaveform(block, line) {
  const url = line.audioUrl || line.originalAudioUrl;
  if (!url) return;

  const isTake = !!line.audioUrl;
  // Дубль начинается раньше реплики на длину pre-roll, поэтому сдвигаем волну влево
  const takeStart = (line.audioStart !== null && line.audioStart !== undefined) ? line.audioStart : line.start;
  const offsetSec = isTake ? takeStart - line.start : 0;

  const canvas = document.createElement('canvas');
  canvas.className = 'wave-canvas';
  block.prepend(canvas);

  loadPeaks(url).then(peaks => {
    if (peaks && canvas.isConnected) drawWaveform(canvas, peaks, offsetSec, isTake);
  });
}

function drawWaveform(canvas, peaks, offsetSec, isTake) {
  const width = Math.max(1, Math.round((peaks.length / PEAKS_PER_SEC) * pxPerSec));
  const height = canvas.parentElement.clientHeight || 46;
  const dpr = window.devicePixelRatio || 1;

  canvas.style.left = `${offsetSec * pxPerSec}px`;
  canvas.style.width = `${width}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = isTake ? 'rgba(52, 211, 153, 0.55)' : 'rgba(161, 161, 170, 0.22)';

  const mid = height / 2;
  const perPx = PEAKS_PER_SEC / pxPerSec;
  for (let x = 0; x < width; x++) {
    const from = Math.floor(x * perPx);
    const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((x + 1) * perPx)));
    let peak = 0;
    for (let i = from; i < to; i++) if (peaks[i] > peak) peak = peaks[i];
    const h = Math.max(1, peak * (height - 6));
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
    statusText = `<span style="color:#10b981; font-weight:bold;">✅ Занято вами ${charOwner ? '(роль)' : ''}</span>`;
  } else if (isOwnedByOther) {
    statusText = `<span style="color:#f59e0b; font-weight:bold;">🔒 Занято игроком ${esc(owner)}</span>`;
  } else {
    statusText = `<span style="color:#a1a1aa;">⚪ Свободно для записи</span>`;
  }

  let actionsHtml = '';

  if (isFree) {
    actionsHtml += `<button class="btn-claim" onclick="claimSingleLine(${line.id})">🙋 Занять эту реплику</button>`;
    if (allowCharacterClaims) {
      actionsHtml += `<button class="btn-outline" onclick="claimCharacter(${jsArg(line.character)})">🎭 Взять всю роль (${esc(line.character)})</button>`;
    }
  } else if (isOwnedByMe) {
    if (!charOwner) {
      actionsHtml += `<button class="btn-unclaim" onclick="unclaimSingleLine(${line.id})">❌ Освободить реплику</button>`;
      if (allowCharacterClaims) {
        actionsHtml += `<button class="btn-outline" onclick="claimCharacter(${jsArg(line.character)})">🎭 Взять всю роль (${esc(line.character)})</button>`;
      }
    } else {
      actionsHtml += `<button class="btn-unclaim" onclick="unclaimCharacter(${jsArg(line.character)})">🚪 Отказаться от всей роли (${esc(line.character)})</button>`;
    }
  } else if (isOwnedByOther && amHost()) {
    actionsHtml += charOwner
      ? `<button class="btn-host" onclick="unclaimCharacter(${jsArg(line.character)})">👑 Снять роль с игрока ${esc(owner)}</button>`
      : `<button class="btn-host" onclick="unclaimSingleLine(${line.id})">👑 Освободить реплику игрока ${esc(owner)}</button>`;
  }

  let recordBtnHtml = '';
  if (isOwnedByMe) {
    if (!line.audioUrl) {
      recordBtnHtml = `<button class="btn-record" id="recBtn" onclick="handleStudioRecord(${line.id})">🎙️ Записать дубль (R)</button>`;
    } else {
      recordBtnHtml = `
        <div style="display:flex; gap:6px;">
          <button class="btn-play" style="flex:2;" onclick="playAudio(${jsArg(line.audioUrl)})">▶ Дубль</button>
          <button class="btn-record" id="recBtn" style="flex:2;" onclick="handleStudioRecord(${line.id})">Переписать (R)</button>
          <button class="btn-delete" style="flex:1;" onclick="deleteLineAudio(${line.id})" title="Стереть дубль">🗑️</button>
        </div>
      `;
    }
  } else if (isOwnedByOther) {
    recordBtnHtml = `<button class="btn-record" disabled title="Реплика занята другим игроком">🔒 Занято игроком ${esc(owner)}</button>`;
    if (line.audioUrl) {
      recordBtnHtml += `<button class="btn-play" onclick="playAudio(${jsArg(line.audioUrl)})">▶ Послушать дубль игрока ${esc(owner)}</button>`;
    }
  } else {
    recordBtnHtml = `<button class="btn-record" disabled title="Сначала займите реплику">Сначала займите реплику для записи</button>`;
  }

  inspector.innerHTML = `
    <h3>${esc(line.character)} (Реплика #${line.id})</h3>
    <p><strong>Тайминг:</strong> ${line.start}с — ${line.end}с <span style="color:#a1a1aa">(${duration}с)</span></p>
    <p style="background:#27272a; padding:8px; border-radius:6px; margin: 4px 0; max-height:75px; overflow-y:auto;">
      <em>"${esc(line.caption || '...')}"</em>
    </p>
    <p><strong>Статус:</strong> ${statusText}</p>
    
    <canvas id="visualizerCanvas" width="320" height="32"></canvas>

    <div style="background:#202024; padding:6px 10px; border-radius:6px; margin-top:2px;">
      <div style="display:flex; justify-content:space-between; font-size:11px; font-weight:bold; color:#a1a1aa;">
        <span>🎙️ Громкость микрофона:</span>
        <span id="gainDisplay">${Math.round(userMicGain * 100)}%</span>
      </div>
      <input type="range" min="30" max="300" step="10" value="${Math.round(userMicGain * 100)}" 
        style="width:100%; accent-color:#8257e5; cursor:pointer;"
        oninput="updateUserMicGain(this.value)">
    </div>

    <div style="display:flex; flex-direction:column; gap:6px; margin-top:4px;">
      ${line.originalAudioUrl ? `<button class="btn-outline" onclick="playAudio(${jsArg(line.originalAudioUrl)})">🎧 Слушать оригинал</button>` : ''}
      ${actionsHtml}
      ${recordBtnHtml}
    </div>
  `;
}

window.deleteLineAudio = async function(lineId) {
  if (!confirm('Удалить эту запись дубля?')) return;
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
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  previewAudio = new Audio(url);
  previewAudio.volume = volumes.isMuted ? 0 : volumes.recorded;
  previewAudio.play().catch(err => console.error(err));
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
    alert('Вы не можете записывать эту реплику, так как она не занята вами!');
    return;
  }

  if (recordState === 'recording' || recordState === 'preparing') {
    finishRecording();
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
    });
  } catch (err) {
    alert('Нет доступа к микрофону!');
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

    // Запись прервана хостом — дубль не сохраняем
    if (discardTake) {
      discardTake = false;
      if (selectedLine) showInspector(selectedLine);
      return;
    }

    const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    if (audioBlob.size === 0) {
      alert('Микрофон не записал звук (0 байт).');
      btn.className = 'btn-record';
      btn.innerText = '🎙️ Повторить запись';
      return;
    }

    const formData = new FormData();
    formData.append('lineId', lineId);
    formData.append('userName', myName);
    formData.append('clientId', clientId);
    formData.append('audioStart', currentRecordingStartTime);
    formData.append('audio', audioBlob);

    btn.innerText = 'Сохранение...';
    const res = await fetch(`/api/upload-line-audio?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: formData });
    if (!res.ok) {
      alert(await readError(res));
      showInspector(line);
      return;
    }
    const resData = await res.json();

    if (resData.success) {
      line.audioUrl = resData.audioUrl;
      line.audioStart = currentRecordingStartTime;
      selectedLine = line;
      showInspector(line);
    }
  };

  mediaRecorder.start(100);
  btn.className = 'btn-prep';
  btn.innerText = '⏳ Подготовка (микрофон уже пишет)...';
  video.play();

  const checkSpeechInterval = setInterval(() => {
    if (video.currentTime >= line.start - 0.05) {
      clearInterval(checkSpeechInterval);
      if (recordState === 'preparing') {
        recordState = 'recording';
        btn.className = 'btn-record recording-active';
        btn.innerText = '🔴 ГОВОРИТЕ! (Стоп)';
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
    btn.innerText = '⏳ Обработка звука...';
  }

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

// ==========================================
// БИБЛИОТЕКА МОДОВ НА СЕРВЕРЕ
// ==========================================
const libraryModal = document.getElementById('libraryModal');
const libraryList = document.getElementById('libraryList');

window.openLibraryModal = async function() {
  libraryModal.style.display = 'flex';
  libraryList.innerHTML = '<span style="color:#a1a1aa; padding:10px;">Загрузка списка модов...</span>';

  const res = await fetch('/api/server-packs');
  const list = await res.json();

  if (list.length === 0) {
    libraryList.innerHTML = '<span style="color:#71717a; padding:10px;">На сервере пока нет сохраненных модов. Загрузите первый через кнопку "⬆ Загрузить .ZIP"!</span>';
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
        <a href="${esc(item.url)}" class="btn-share" download style="text-decoration:none; padding:4px 8px;">📥 Скачать</a>
        ${amHost()
          ? `<button class="btn-play" onclick="loadSavedPack(${jsArg(item.filename)})">▶ Запустить в комнате</button>`
          : `<button class="btn-play" disabled title="Менять пак может только хост">🔒 Только хост</button>`}
      </div>
    `;
    libraryList.appendChild(div);
  });
};

window.closeLibraryModal = function() {
  libraryModal.style.display = 'none';
};

window.loadSavedPack = async function(filename) {
  closeLibraryModal();
  const res = await fetch('/api/load-server-pack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, room: currentRoom, clientId })
  });
  if (!res.ok) alert(await readError(res));
};

// ==========================================
// БЕЗОПАСНЫЙ СТУДИЙНЫЙ РЕНДЕР
// ==========================================
const renderModal = document.getElementById('renderModal');
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
    alert('Сначала загрузите видео-пак!');
    return;
  }
  renderModal.style.display = 'flex';
};

window.closeRenderModal = function() {
  renderModal.style.display = 'none';
};

window.startVideoRender = async function() {
  const startBtn = document.getElementById('startRenderBtn');
  const progressBox = document.getElementById('renderProgressBox');
  const progressBar = document.getElementById('renderProgressBar');
  const statusText = document.getElementById('renderStatusText');

  startBtn.disabled = true;
  progressBox.style.display = 'block';
  statusText.innerText = '⏳ Подготовка видео и аудиодорожек...';

  const renderCanvas = document.createElement('canvas');
  renderCanvas.width = video.videoWidth || 1280;
  renderCanvas.height = video.videoHeight || 720;
  const ctx = renderCanvas.getContext('2d');

  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = actx.createMediaStreamDestination();

  const dubGain = actx.createGain();
  dubGain.gain.value = renderDubVol.value / 100;
  dubGain.connect(dest);

  const backingGain = actx.createGain();
  backingGain.gain.value = renderBackingVol.value / 100;
  backingGain.connect(dest);

  const origGain = actx.createGain();
  origGain.gain.value = renderOrigVol.value / 100;
  origGain.connect(dest);

  // Используем независимые аудио-элементы, чтобы не ломать основной плеер!
  const renderBacking = new Audio(session.backingUrl);
  renderBacking.crossOrigin = 'anonymous';
  const backSource = actx.createMediaElementSource(renderBacking);
  backSource.connect(backingGain);

  let renderOrig = null;
  if (renderOrigVol.value > 0 && session.videoUrl) {
    renderOrig = new Audio(session.videoUrl);
    renderOrig.crossOrigin = 'anonymous';
    const origSource = actx.createMediaElementSource(renderOrig);
    origSource.connect(origGain);
  }

  const canvasStream = renderCanvas.captureStream(30);
  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
    ? 'video/mp4;codecs=avc1,mp4a.40.2'
    : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm');

  const recorder = new MediaRecorder(combinedStream, { mimeType });
  const recordedChunks = [];

  recorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
  recorder.onstop = () => {
    actx.close();
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(recordedChunks, { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `Dubline_${session.title}_export.${ext}`;
    a.click();

    statusText.innerText = '✅ Видео успешно сохранено!';
    progressBar.style.width = '100%';
    setTimeout(() => {
      closeRenderModal();
      startBtn.disabled = false;
      progressBox.style.display = 'none';
    }, 1500);
  };

  video.currentTime = 0;
  renderBacking.currentTime = 0;
  if (renderOrig) renderOrig.currentTime = 0;

  recorder.start();
  video.play();
  renderBacking.play().catch(() => {});
  if (renderOrig) renderOrig.play().catch(() => {});

  let isRendering = true;
  let renderLastTime = 0;

  function drawRenderFrame() {
    if (!isRendering) return;
    ctx.drawImage(video, 0, 0, renderCanvas.width, renderCanvas.height);

    const progress = (video.currentTime / video.duration) * 100;
    progressBar.style.width = `${progress}%`;
    statusText.innerText = `⏳ Рендеринг: ${Math.round(progress)}% (${Math.round(video.currentTime)}с / ${Math.round(video.duration)}с)`;

    const cur = video.currentTime;
    if (cur > renderLastTime && (cur - renderLastTime) < 0.5) {
      session.lines.forEach(line => {
        if (line.audioUrl) {
          const trigger = (line.audioStart !== null && line.audioStart !== undefined) ? line.audioStart : line.start;
          if (renderLastTime <= trigger && cur >= trigger) {
            const dubSound = new Audio(line.audioUrl);
            dubSound.crossOrigin = 'anonymous';
            const dubSrc = actx.createMediaElementSource(dubSound);
            dubSrc.connect(dubGain);
            dubSound.play().catch(() => {});
          }
        }
      });
    }
    renderLastTime = cur;

    if (video.ended || video.currentTime >= video.duration - 0.1) {
      isRendering = false;
      video.pause();
      renderBacking.pause();
      if (renderOrig) renderOrig.pause();
      recorder.stop();
      return;
    }

    requestAnimationFrame(drawRenderFrame);
  }

  requestAnimationFrame(drawRenderFrame);
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
    el.textContent = msg.text;
  } else {
    const time = new Date(msg.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    el.className = 'chat-msg' + (msg.nick === myName ? ' me' : '');
    el.innerHTML = `<span class="chat-time">${time}</span> <strong class="chat-nick">${esc(msg.nick)}:</strong> <span>${esc(msg.text)}</span>`;
  }
  chatMessages.appendChild(el);

  if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}

socket.on('chat_history', (history) => {
  chatMessages.querySelectorAll('.chat-msg').forEach(el => el.remove());
  chatEmpty.style.display = history.length ? 'none' : 'block';
  history.forEach(appendChatMessage);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

socket.on('chat_message', (msg) => {
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
