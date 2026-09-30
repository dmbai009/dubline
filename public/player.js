// ==========================================
// PLAYER
// Shared helpers, video, mixer, prompter, timeline, waveforms and take dragging
// ==========================================
const i18n = window.DublineI18n;
const t = (key, params) => i18n.t(key, params);
i18n.apply();
const labelWidth = 180;

// Timeline zoom: pixels per second (Ctrl+wheel, the − / + / "Whole scene" buttons)
const ZOOM_DEFAULT = 60;
const ZOOM_MIN = 2;
const ZOOM_MAX = 400;
let pxPerSec = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(localStorage.getItem('dubline_zoom')) || ZOOM_DEFAULT));

const urlParams = new URLSearchParams(window.location.search);
const currentRoom = urlParams.get('room') || 'main';
const desktopHostToken = urlParams.get('desktopHost') || '';
if (desktopHostToken) {
  urlParams.delete('desktopHost');
  const cleanQuery = urlParams.toString();
  history.replaceState(null, '', `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}`);
}
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

// Who is recording which line right now (from the server): lineId -> nick
const liveRecordings = new Map();
// Players sharing the scene video over P2P (nicks)
const seedingNicks = new Set();
// Lines whose takes are recorded but haven't reached the server yet
const pendingTakeLines = new Set();
// Several selected lines (Ctrl/Shift+click) for assigning a character in bulk
const multiSelection = new Set();
let lastClickedLineId = null;
let revealLineId = null; // line to scroll the timeline to after a redraw (its character changed)

// Video/background picked from the player's own disk, so they don't go through the tunnel
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

const originalTrackAudio = document.getElementById('originalTrackAudio');

const audio = window.DublineAudio.createController({
  video,
  backing,
  originalTrack: originalTrackAudio,
  getSession: () => state.session,
  getVolumes: () => state.volumes,
  getSettings: () => ({
    autoDuckEnabled: state.autoDuckEnabled,
    autoDuckAmount: state.autoDuckAmount
  }),
  isRenderInProgress: () => state.renderInProgress,
  getRecordingLineId: () => state.recordingLineId,
  getLatency: nick => latencyFor(nick)
});

// The player's microphone delay correction in seconds (stored on the server in ms)
function latencyFor(nick) {
  const ms = nick && state.session && state.session.latency ? state.session.latency[nick] : 0;
  return (Number(ms) || 0) / 1000;
}

// Player color: the same for everyone, derived from the nick
function playerColor(nick) {
  let hash = 0;
  for (const ch of String(nick || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${hash % 360}, 62%, 52%)`;
}

// How many lines are dubbed: in total and per player
function sceneProgress() {
  const lines = (state.session && state.session.lines) || [];
  const perPlayer = new Map();
  const entry = nick => {
    if (!perPlayer.has(nick)) perPlayer.set(nick, { recorded: 0, claimed: 0 });
    return perPlayer.get(nick);
  };
  let recorded = 0;
  lines.forEach(line => {
    const owner = getLineOwner(line);
    if (owner) entry(owner).claimed++;
    if (line.audioUrl) {
      recorded++;
      const author = line.recordedBy || owner;
      if (author) entry(author).recorded++;
    }
  });
  return { total: lines.length, recorded, perPlayer };
}

const {
  applyVolumes,
  ensurePlayCtx,
  getProcessedTake,
  getRawTake,
  precacheTakes,
  rawTakeStart,
  resetLine,
  scheduleTakes,
  setDucking,
  stopAllTakes,
  takeBounds,
  takeDryBounds,
  takeStartTime
} = audio;

// Escape user text before inserting it into HTML
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Safe argument for onclick="fn(...)"
function jsArg(value) {
  return esc(JSON.stringify(value));
}

// A tunnel link (Cloudflare etc.) rejects large requests, around 100 MB
const TUNNEL_UPLOAD_MB = 95;

function isLocalAddress() {
  const host = location.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /\.localhost$/.test(host)
    || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

// Empty string: OK to upload; otherwise a readable reason why it won't work
function tunnelUploadError(files) {
  if (isLocalAddress()) return '';
  const bytes = files.filter(Boolean).reduce((sum, file) => sum + file.size, 0);
  if (bytes <= TUNNEL_UPLOAD_MB * 1024 * 1024) return '';
  return t('upload.tooBigTunnel', { size: Math.round(bytes / 1048576), max: TUNNEL_UPLOAD_MB });
}

async function readError(res) {
  const text = await res.text().catch(() => '');
  // The tunnel's error page (HTML) instead of our server's reply
  if (/^\s*</.test(text) || !text) {
    if (res.status === 413) return t('upload.rejectedByTunnel');
    return t('error.generic', { message: `HTTP ${res.status}` });
  }
  // Our server replies { error, key, params }: show the key in the player's language, else the English text
  try {
    const { error, key, params } = JSON.parse(text);
    const translated = key ? t(key, params || {}) : '';
    if (translated && translated !== key) return translated;
    if (error) return error;
  } catch (e) { /* not JSON */ }
  return text;
}

// Volume mixer
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
const PROMPTER_MAX_LINES = 4;
let prompterKey = '';

function updatePrompter() {
  // Prompter font is at most ~4.5% of the video width so it doesn't cover the picture in a small window
  videoPrompter.style.fontSize = `min(${prompterSize}px, 4.5cqw)`;
  if (!prompterEnabled || !session || !session.lines) {
    videoPrompter.style.display = 'none';
    return;
  }
  const current = video.currentTime || 0;
  // All lines playing right now (characters may speak at once);
  // while recording, your own line comes first and highlighted, the others dimmed
  const recording = recordingLineId != null ? session.lines.find(line => line.id === recordingLineId) : null;
  const active = session.lines
    .filter(line => line !== recording && current >= line.start && current <= line.end)
    .sort((a, b) => a.start - b.start || a.id - b.id);
  const shown = (recording ? [recording, ...active] : active).slice(0, PROMPTER_MAX_LINES);
  const hidden = (recording ? 1 : 0) + active.length - shown.length;
  if (!shown.length) {
    videoPrompter.style.display = 'none';
    prompterKey = '';
    return;
  }

  // Rebuild rows only when the set of lines changes; move the progress bars every frame
  const key = `${recording ? recording.id : ''}|${shown.map(line => line.id).join(',')}|${hidden}`;
  if (key !== prompterKey) {
    prompterKey = key;
    videoPrompter.innerHTML = shown.map(line => `
      <div class="prompter-line ${recording ? (line === recording ? 'recording' : 'dim') : ''}" data-line="${line.id}">
        <span class="prompter-char">${esc(line.character)}:</span>
        <span class="prompter-text">${esc(line.caption || '…')}</span>
        <div class="prompter-progress"></div>
      </div>`).join('') + (hidden > 0 ? `<div class="prompter-more">${t('prompter.more', { n: hidden })}</div>` : '');
  }
  videoPrompter.querySelectorAll('.prompter-line').forEach(row => {
    const line = shown.find(item => item.id === Number(row.dataset.line));
    const progress = line ? Math.max(0, Math.min(1, (current - line.start) / Math.max(0.05, line.end - line.start))) : 0;
    row.querySelector('.prompter-progress').style.width = `${progress * 100}%`;
  });
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
// TAKE PLAYBACK (Web Audio, with effects and trimming)
// ==========================================
video.addEventListener('play', () => {
  ensurePlayCtx();
  stopAllTakes();
  applyVolumes();
  backing.currentTime = video.currentTime;
  if (!renderInProgress) backing.play().catch(() => {});
  if (originalTrackAudio.getAttribute('src')) {
    originalTrackAudio.currentTime = video.currentTime;
    originalTrackAudio.play().catch(() => {});
  }
  requestAnimationFrame(syncPlayheadLoop);
});

video.addEventListener('pause', () => {
  backing.pause();
  originalTrackAudio.pause();
  stopAllTakes();
  playhead.style.left = `${labelWidth + video.currentTime * pxPerSec}px`;
  updatePrompter();
});

video.addEventListener('seeked', () => {
  backing.currentTime = video.currentTime;
  if (originalTrackAudio.getAttribute('src')) originalTrackAudio.currentTime = video.currentTime;
  stopAllTakes();
  playhead.style.left = `${labelWidth + video.currentTime * pxPerSec}px`;
  updatePrompter();
});
video.addEventListener('timeupdate', updatePrompter);
video.addEventListener('loadedmetadata', () => { if (session && session.loaded) renderTimeline(); });

function getLineOwner(line) {
  if (!session) return null;
  const charOwner = session.characterClaims && session.characterClaims[line.character];
  return charOwner || line.claimedBy || null;
}

// Learn the original line duration once per URL: previously every timeline redraw
// created a new <audio> per line and flooded the tunnel with requests
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

const MIN_TILE_PX = 22;
const LANE_HEIGHT = 54;  // tile height 48 + gap 6
const ROW_PADDING = 6;

// Greedy lane layout: each line goes to the first lane where the previous one has already ended
function assignLanes(lines) {
  const laneEnds = [];
  const laneOf = new Map();
  [...lines].sort((a, b) => a.start - b.start || a.id - b.id).forEach(line => {
    let lane = laneEnds.findIndex(end => end <= line.start + 0.001);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = Math.max(line.end, line.start + 0.05);
    laneOf.set(line.id, lane);
  });
  return laneOf;
}

let timelineRenderTimer = null;
function scheduleTimelineRender() {
  clearTimeout(timelineRenderTimer);
  timelineRenderTimer = setTimeout(() => { if (session && session.loaded) renderTimeline(); }, 150);
}
const TIMELINE_TAIL = 5; // seconds of empty space after the end of the scene

// Scene length on the timeline: up to the end of the video or the last line
function timelineSeconds() {
  const lastLine = Math.max(0, ...((session && session.lines) || []).map(l => l.end));
  const videoLength = Number.isFinite(video.duration) ? video.duration : 0;
  return Math.max(lastLine, videoLength, 30);
}

function renderTimeline() {
  timeline.innerHTML = '';
  timeline.appendChild(playhead);

  if (!session.lines || session.lines.length === 0) return;

  playhead.style.display = 'block';

  const maxTime = timelineSeconds();
  const trackWidth = (maxTime + TIMELINE_TAIL) * pxPerSec;
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

  const tickStep = [1, 2, 5, 10, 15, 30, 60].find(step => step * pxPerSec >= 70) || 120;
  for (let sec = 0; sec <= maxTime + TIMELINE_TAIL; sec += tickStep) {
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

    // Rename a whole track: the host always, others only if all its lines are free or their own
    const canRenameTrack = amHost() || session.lines.filter(l => l.character === char).every(l => { const owner = getLineOwner(l); return !owner || owner === myName; });
    const renameTrackBtn = canRenameTrack ? `<button class="track-rename" title="${esc(t('char.renameTrack', { name: char }))}" onclick="renameCharacterTrack(${jsArg(char)})">✎</button>` : '';
    label.innerHTML = `
      <div class="track-label-inner">
        <span class="char-name-row"><span class="char-name" title="${esc(char)}">${esc(char)}</span>${renameTrackBtn}</span>
        ${roleHtml}
      </div>
    `;

    const trackArea = document.createElement('div');
    trackArea.className = 'track-timeline';
    trackArea.style.width = `${trackWidth}px`;

    const charLines = session.lines.filter(l => l.character === char);
    // Lines overlapping in time are placed into sub-lanes (like clips on neighboring tracks),
    // otherwise they are drawn on top of each other. Uses real time, so the layout doesn't jump when zooming.
    const laneOf = assignLanes(charLines);
    const laneCount = laneOf.size ? Math.max(...laneOf.values()) + 1 : 1;
    row.style.height = `${ROW_PADDING + laneCount * LANE_HEIGHT}px`;
    charLines.forEach(line => {
      const block = document.createElement('div');
      block.className = 'line-block';
      block.id = `line-block-${line.id}`;
      block.style.left = `${line.start * pxPerSec}px`;
      block.style.top = `${ROW_PADDING + (laneOf.get(line.id) || 0) * LANE_HEIGHT}px`;
      block.style.width = `${Math.max((line.end - line.start) * pxPerSec, MIN_TILE_PX)}px`;

      updateLineBlockVisual(block, line);

      block.onclick = (e) => {
        if (block.dataset.justDragged) {
          delete block.dataset.justDragged;
          return;
        }
        if (e.ctrlKey || e.metaKey) toggleMultiSelect(line.id);
        else if (e.shiftKey && lastClickedLineId != null) selectLineRange(lastClickedLineId, line.id);
        else {
          clearMultiSelection();
          selectLine(session.lines.find(l => l.id === line.id) || line);
        }
        lastClickedLineId = line.id;
      };
      trackArea.appendChild(block);

      if (line.originalAudioUrl) {
        probeDuration(line.originalAudioUrl).then(seconds => {
          if (!seconds) return;
          const end = Number((line.start + seconds).toFixed(2));
          if (Math.abs(end - line.end) < 0.05) return;
          line.end = end;
          if (block.isConnected) block.style.width = `${Math.max((line.end - line.start) * pxPerSec, MIN_TILE_PX)}px`;
          if (selectedLine && selectedLine.id === line.id) showInspector(line);
          // The length changed: lines may now overlap, so redo the lanes
          scheduleTimelineRender();
        });
      }
    });

    row.appendChild(label);
    row.appendChild(trackArea);
    timeline.appendChild(row);
  });

  if (revealLineId != null) {
    const tile = document.getElementById(`line-block-${revealLineId}`);
    revealLineId = null;
    if (tile) {
      tile.scrollIntoView({ block: 'center', inline: 'nearest' });
      tile.classList.add('flash');
      setTimeout(() => tile.classList.remove('flash'), 1200);
    }
  }
}

function updateLineBlockVisual(el, line) {
  const owner = getLineOwner(line);

  el.className = 'line-block';
  if (selectedLine && selectedLine.id === line.id) el.classList.add('selected');
  if (multiSelection.has(line.id)) el.classList.add('multi-selected');
  if (line.audioUrl) el.classList.add('recorded');
  else if (owner === myName) el.classList.add('claimed-me');
  else if (owner) el.classList.add('claimed-other');

  let nickBadge = '';
  const liveNick = liveRecordings.get(line.id);
  if (pendingTakeLines.has(line.id)) {
    el.classList.add('pending-upload');
    el.title = t('take.pendingNotice');
    nickBadge = `<span class="tile-nick pending">${t('take.pending')}</span>`;
  } else if (liveNick) {
    el.classList.add('live-recording');
    el.title = t('recording.title', { nick: liveNick });
    nickBadge = `<span class="tile-nick live">🔴 ${liveNick === myName ? t('you') : esc(liveNick)}</span>`;
  } else if (owner) {
    const isMe = (owner === myName);
    nickBadge = isMe
      ? `<span class="tile-nick me">${t('you')}</span>`
      : `<span class="tile-nick other" style="background:${playerColor(owner)}">${esc(owner)}</span>`;
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
// DRAGGING A TAKE ALONG THE TIMELINE
// ==========================================
function enableTakeDrag(el, lineId) {
  el.classList.add('draggable');
  el.title = t('dragTitle');

  el.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const line = session.lines.find(l => l.id === lineId);
    if (!line) return;

    // Shift moves all your takes at once: that is the microphone delay correction
    if (e.shiftKey) return startLatencyDrag(e, el);

    const startX = e.clientX;
    const origRaw = rawTakeStart(line);
    const latency = latencyFor(line.recordedBy);
    let newRaw = origRaw;
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
      newRaw = Math.max(0, origRaw + dx / pxPerSec);
      if (canvas) canvas.style.left = `${(newRaw - latency - line.start) * pxPerSec}px`;
      const shift = newRaw - (line.recordedStart ?? origRaw);
      hint.innerText = `${shift >= 0 ? '+' : ''}${shift.toFixed(2)}s`;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.classList.remove('dragging');
      hint.remove();
      if (!moved) return;
      el.dataset.justDragged = '1';
      setTakeProps(lineId, { audioStart: Number(newRaw.toFixed(3)) });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
}

// Shift+drag: shifts all of the player's takes at once and saves it as their delay
function startLatencyDrag(e, grabbed) {
  const startX = e.clientX;
  const origMs = Math.round(latencyFor(myName) * 1000);
  let newMs = origMs;
  let moved = false;
  const mine = session.lines.filter(l => l.audioUrl && l.recordedBy === myName);
  const tiles = mine.map(line => ({ line, el: document.getElementById(`line-block-${line.id}`) })).filter(item => item.el);
  const hint = document.createElement('span');
  hint.className = 'drag-hint latency';

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 4) return;
    if (!moved) {
      moved = true;
      tiles.forEach(item => item.el.classList.add('latency-drag'));
      grabbed.appendChild(hint);
    }
    // Dragging right makes takes sound later, so the correction decreases
    newMs = Math.max(-1000, Math.min(1000, Math.round(origMs - (dx / pxPerSec) * 1000)));
    tiles.forEach(({ line, el }) => {
      const canvas = el.querySelector('.wave-canvas');
      if (canvas) canvas.style.left = `${(rawTakeStart(line) - newMs / 1000 - line.start) * pxPerSec}px`;
    });
    hint.innerText = t('latency.value', { ms: `${newMs > 0 ? '+' : ''}${newMs}` });
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    tiles.forEach(item => item.el.classList.remove('latency-drag'));
    hint.remove();
    if (!moved) return;
    grabbed.dataset.justDragged = '1';
    setMyLatency(newMs);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

window.setMyLatency = function(ms) {
  socket.emit('set_latency', { ms: Math.round(ms) });
};

window.nudgeLatency = function(deltaMs) {
  setMyLatency(Math.round(latencyFor(myName) * 1000) + deltaMs);
};

window.setTakeProps = function(lineId, props) {
  socket.emit('set_take_props', { lineId, ...props });
};

window.nudgeTake = function(lineId, delta) {
  const line = session.lines.find(l => l.id === lineId);
  if (line) setTakeProps(lineId, { audioStart: Number(Math.max(0, rawTakeStart(line) + delta).toFixed(3)) });
};

window.resetTakeShift = function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  if (line && line.recordedStart != null) setTakeProps(lineId, { audioStart: line.recordedStart });
};

// ==========================================
// WAVEFORM ON THE TIMELINE
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

  // Normalize, but don't blow silence up to full height
  let top = 0;
  for (let i = 0; i < count; i++) if (peaks[i] > top) top = peaks[i];
  const norm = Math.max(top, 0.1);
  for (let i = 0; i < count; i++) peaks[i] /= norm;
  return peaks;
}

function loadPeaks(url, isTake) {
  if (!peaksCache.has(url)) {
    // Takes are decoded once and reused for playback
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
  // A take starts earlier than the line by the pre-roll (and may be shifted manually)
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
  const trimmedColor = 'rgba(161, 161, 170, 0.12)'; // trimmed silence is paler

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
  document.querySelectorAll('.line-block.selected').forEach(el => el.classList.remove('selected'));
  const tile = document.getElementById(`line-block-${line.id}`);
  if (tile) tile.classList.add('selected');
  selectedLine = line;
  video.currentTime = line.start;
  showInspector(line);
}

window.playAudio = function(url) {
  audio.playAudio(url).catch(error => console.error(error));
};

// Play a take the way it will sound in the video: with effect, pitch and trimming
window.previewTake = async function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  if (!line) return;
  if (!await audio.previewTake(line)) alert(t('error.take'));
};

// ==========================================
// TIMELINE ZOOM
// ==========================================
const zoomLabel = document.getElementById('zoomLabel');
let zoomFrame = null;

function updateZoomLabel() {
  zoomLabel.textContent = `${Math.round((pxPerSec / ZOOM_DEFAULT) * 100)}%`;
}

// anchorX is the screen point whose time stays in place (the mouse cursor or the center)
function setTimelineZoom(next, anchorX = timelineContainer.clientWidth / 2) {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  if (Math.abs(clamped - pxPerSec) < 0.01) return;
  const anchorTime = Math.max(0, (timelineContainer.scrollLeft + anchorX - labelWidth) / pxPerSec);
  pxPerSec = clamped;
  localStorage.setItem('dubline_zoom', String(Math.round(pxPerSec * 100) / 100));
  updateZoomLabel();

  cancelAnimationFrame(zoomFrame);
  zoomFrame = requestAnimationFrame(() => {
    if (session && session.loaded) renderTimeline();
    playhead.style.left = `${labelWidth + video.currentTime * pxPerSec}px`;
    timelineContainer.scrollLeft = Math.max(0, anchorTime * pxPerSec + labelWidth - anchorX);
  });
}

window.zoomTimeline = function(factor) {
  setTimelineZoom(pxPerSec * factor);
};

window.fitTimeline = function() {
  if (!session || !session.lines || !session.lines.length) return;
  const available = timelineContainer.clientWidth - labelWidth - 16;
  setTimelineZoom(available / (timelineSeconds() + TIMELINE_TAIL), 0);
  requestAnimationFrame(() => { timelineContainer.scrollLeft = 0; });
};

timelineContainer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const rect = timelineContainer.getBoundingClientRect();
  setTimelineZoom(pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - rect.left);
}, { passive: false });

updateZoomLabel();

// ==========================================
// VIDEO AUDIO TRACKS
// If the video has several tracks (e.g. Japanese and Russian), the host picks which one plays
// as "Original" and which as "Background". The chosen original plays in a separate <audio> in sync
// with the video, and the video's own sound is muted (the browser player can play only one track).
// ==========================================
const trackPicker = document.getElementById('trackPicker');
const originalTrackSelect = document.getElementById('originalTrackSelect');
const backingTrackSelect = document.getElementById('backingTrackSelect');
const trackPickerNote = document.getElementById('trackPickerNote');

// undefined: the video has one track (the video itself plays); null: original is off; otherwise the chosen track
function selectedOriginalTrack() {
  const tracks = state.session && state.session.audioTracks;
  if (!tracks || tracks.length < 2) return undefined;
  const index = state.session.originalTrack ?? 0;
  return index >= 0 ? tracks[index] || null : null;
}

function setMediaSource(element, url) {
  const current = element.getAttribute('src') || '';
  if ((url || '') === current) return;
  if (!url) {
    element.pause();
    element.removeAttribute('src');
    element.load();
    return;
  }
  element.src = url;
  element.currentTime = video.currentTime;
  if (!video.paused) element.play().catch(() => {});
}

function applyAudioTracks() {
  if (!state.session || !state.session.loaded) return;
  const track = selectedOriginalTrack();
  video.muted = track !== undefined;
  setMediaSource(originalTrackAudio, track ? mediaUrl(track.url) : null);
  // The background may have switched to another video track
  setMediaSource(backing, mediaUrl(state.session.backingUrl) || null);
  renderTrackPicker();
}

function renderTrackPicker() {
  const tracks = (state.session && state.session.audioTracks) || [];
  const pending = !!(state.session && state.session.audioTracksPending);
  trackPicker.style.display = tracks.length >= 2 || pending ? 'flex' : 'none';
  if (!state.session || (tracks.length < 2 && !pending)) return;
  if (pending && tracks.length < 2) {
    trackPicker.querySelectorAll('label').forEach(label => { label.style.display = 'none'; });
    trackPickerNote.textContent = t('tracks.preparing');
    return;
  }
  trackPicker.querySelectorAll('label').forEach(label => { label.style.display = ''; });
  const options = selected => [`<option value="-1" ${selected === -1 ? 'selected' : ''}>${t('tracks.none')}</option>`]
    .concat(tracks.map(track => `<option value="${track.index}" ${selected === track.index ? 'selected' : ''}>${esc(t('tracks.label', { n: track.index + 1, name: track.label || DublineI18n.languageName(track.language) || '?' }))}</option>`))
    .join('');
  originalTrackSelect.innerHTML = options(state.session.originalTrack ?? 0);
  backingTrackSelect.innerHTML = options(state.session.backingTrack ?? -1);
  const host = amHost();
  originalTrackSelect.disabled = !host;
  backingTrackSelect.disabled = !host;
  trackPickerNote.textContent = host ? '' : t('tracks.onlyHost');
}

function sendTrackSelection() {
  socket.emit('host_set_audio_tracks', { original: Number(originalTrackSelect.value), backing: Number(backingTrackSelect.value) });
}
originalTrackSelect.addEventListener('change', sendTrackSelection);
backingTrackSelect.addEventListener('change', sendTrackSelection);

// ==========================================
// MULTI-LINE SELECTION AND TRACK RENAMING
// ==========================================
function refreshMultiSelection() {
  document.querySelectorAll('.line-block').forEach(el => {
    el.classList.toggle('multi-selected', multiSelection.has(Number(el.id.replace('line-block-', ''))));
  });
  if (multiSelection.size >= 2) showMultiInspector();
  else if (multiSelection.size === 1) {
    const only = session.lines.find(l => multiSelection.has(l.id));
    multiSelection.clear();
    if (only) selectLine(only);
  }
}

function toggleMultiSelect(lineId) {
  if (!multiSelection.size && selectedLine) multiSelection.add(selectedLine.id);
  if (multiSelection.has(lineId)) multiSelection.delete(lineId);
  else multiSelection.add(lineId);
  refreshMultiSelection();
}

// Shift+click: all lines in time between the previous click and this one
function selectLineRange(fromId, toId) {
  const ordered = [...session.lines].sort((a, b) => a.start - b.start || a.id - b.id);
  const a = ordered.findIndex(l => l.id === fromId);
  const b = ordered.findIndex(l => l.id === toId);
  if (a === -1 || b === -1) return;
  ordered.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(l => multiSelection.add(l.id));
  refreshMultiSelection();
}

window.clearMultiSelection = function() {
  if (!multiSelection.size) return;
  multiSelection.clear();
  document.querySelectorAll('.line-block.multi-selected').forEach(el => el.classList.remove('multi-selected'));
  if (selectedLine) showInspector(selectedLine);
  else inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p>${t('inspector.empty')}</p>`;
};

window.renameCharacterTrack = function(name) {
  const next = (prompt(t('char.renameTrack', { name }), name) || '').trim();
  if (!next || next === name) return;
  socket.emit('rename_character', { from: name, to: next }, result => {
    if (result && result.ok) showToast(t('char.trackRenamed', { from: name, to: next, n: result.moved }));
    else if (result && result.reason === 'denied') showToast(t('char.trackDenied'));
  });
};
