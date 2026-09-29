// ==========================================
// PLAYER
// Общие помощники, видео, микшер, суфлёр, таймлайн, волны и перетаскивание дублей
// ==========================================
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

// Кто сейчас записывает какую реплику (приходит от сервера): lineId -> ник
const liveRecordings = new Map();

// Видео/интершум, выбранные игроком со своего диска, чтобы не качать их через туннель
let localMedia = null; // { forVideoUrl, videoUrl, videoBlob, backingUrl, backingBlob, size }
let loadedVideoUrl = null;

function mediaUrl(serverUrl) {
  if (!serverUrl) return serverUrl;
  if (localMedia && localMedia.forVideoUrl === (state.session && state.session.videoUrl)) {
    if (serverUrl === state.session.videoUrl) return localMedia.videoUrl;
    if (serverUrl === state.session.backingUrl && localMedia.backingUrl) return localMedia.backingUrl;
  }
  return serverUrl;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return t('mb', { value: (bytes / 1048576).toFixed(1) });
}
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

function getLineOwner(line) {
  if (!session) return null;
  const charOwner = session.characterClaims && session.characterClaims[line.character];
  return charOwner || line.claimedBy || null;
}

// Длительность оригинальной реплики узнаем один раз на адрес: раньше каждая перерисовка
// таймлайна создавала новый <audio> на каждую реплику и заваливала туннель запросами
const durationCache = new Map(); // url -> Promise<number | null>

function probeDuration(url) {
  if (!durationCache.has(url)) {
    durationCache.set(url, new Promise(resolve => {
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => {
        resolve(Number.isFinite(probe.duration) && probe.duration > 0.1 ? probe.duration : null);
        probe.removeAttribute('src');
      };
      probe.onerror = () => resolve(null);
      probe.src = url;
    }));
  }
  return durationCache.get(url);
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
        probeDuration(line.originalAudioUrl).then(seconds => {
          if (!seconds) return;
          line.end = Number((line.start + seconds).toFixed(2));
          if (block.isConnected) block.style.width = `${Math.max((line.end - line.start) * pxPerSec, 75)}px`;
          if (selectedLine && selectedLine.id === line.id) showInspector(line);
        });
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
  const liveNick = liveRecordings.get(line.id);
  if (liveNick) {
    el.classList.add('live-recording');
    el.title = t('recording.title', { nick: liveNick });
    nickBadge = `<span class="tile-nick live">🔴 ${liveNick === myName ? t('you') : esc(liveNick)}</span>`;
  } else if (owner) {
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

window.playAudio = function(url) {
  audio.playAudio(url).catch(error => console.error(error));
};

// Прослушать дубль так, как он прозвучит в ролике: с эффектом, питчем и обрезкой
window.previewTake = async function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  if (!line) return;
  if (!await audio.previewTake(line)) alert(t('error.take'));
};
