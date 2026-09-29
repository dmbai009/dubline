// ==========================================
// UI
// Модалки настроек и файлов, инспектор реплики, горячие клавиши, запуск приложения
// ==========================================
function refreshViews() {
  if (!session || !session.loaded) return;
  renderTimeline();
  if (selectedLine) showInspector(selectedLine);
}

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
  settingsCue.checked = cueEnabled;
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
  renderLobby();
  updateP2pStatus();
  updateDownloadButtons();
  updateLocalMediaStatus();
  if (watchMode) showWatchOverlay();
  if (connectionState === 'offline') setConnectionState('offline');
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
    else showToast(t('toast.selectLine'));
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
    closeSessionsModal();
    closeHelpModal();
  }
});

function showInspector(line) {
  const duration = Number((line.end - line.start).toFixed(2));
  const characters = [...new Set(session.lines.map(l => l.character))];
  const allowCharacterClaims = characters.length > 1;

  const charOwner = session.characterClaims ? session.characterClaims[line.character] : null;
  const owner = getLineOwner(line);
  const isOwnedByMe = owner === myName;
  const isOwnedByOther = !!owner && owner !== myName;
  const isFree = !owner;
  const author = line.recordedBy || owner;

  // Статус — компактной плашкой в заголовке
  const chip = isOwnedByMe
    ? `<span class="insp-chip me">${t(charOwner ? 'chip.role' : 'chip.you')}</span>`
    : isOwnedByOther
      ? `<span class="insp-chip other">${t('chip.other', { owner: esc(owner) })}</span>`
      : `<span class="insp-chip free">${t('chip.free')}</span>`;

  const originalBtn = line.originalAudioUrl
    ? `<button class="btn-outline" onclick="playAudio(${jsArg(line.originalAudioUrl)})" title="${esc(t('listenOriginal'))}">${t('insp.original')}</button>`
    : '';

  // Главные действия — одной строкой сразу под текстом реплики
  let primary = '';
  if (isOwnedByMe) {
    primary = line.audioUrl
      ? `<button class="btn-play" onclick="previewTake(${line.id})">${t('playTake')}</button>
         <button class="btn-record grow" id="recBtn" onclick="handleStudioRecord(${line.id})">${t('rerecord')}</button>
         ${originalBtn}
         <button class="btn-delete" onclick="deleteLineAudio(${line.id})" title="${esc(t('confirm.delete'))}">🗑</button>`
      : `<button class="btn-record grow" id="recBtn" onclick="handleStudioRecord(${line.id})">${t('record')}</button>${originalBtn}`;
  } else {
    // Готовый дубль можно послушать всегда — даже если реплика освобождена или роли сброшены
    const listen = line.audioUrl
      ? `<button class="btn-play grow" onclick="previewTake(${line.id})">${author ? t('listenTake', { owner: esc(author) }) : t('listenTakeAnon')}</button>`
      : '';
    const claim = isFree ? `<button class="btn-claim grow" onclick="claimSingleLine(${line.id})">${t('claim.line')}</button>` : '';
    primary = claim + listen + originalBtn;
  }

  // Второстепенные действия — мелкими кнопками
  const secondary = [];
  if (isFree && allowCharacterClaims) {
    secondary.push(`<button class="btn-outline" onclick="claimCharacter(${jsArg(line.character)})">${t('claim.role', { character: esc(line.character) })}</button>`);
  } else if (isOwnedByMe && !charOwner) {
    secondary.push(`<button class="btn-outline" onclick="unclaimSingleLine(${line.id})">${t('release.line')}</button>`);
    if (allowCharacterClaims) secondary.push(`<button class="btn-outline" onclick="claimCharacter(${jsArg(line.character)})">${t('claim.role', { character: esc(line.character) })}</button>`);
  } else if (isOwnedByMe && charOwner) {
    secondary.push(`<button class="btn-outline" onclick="unclaimCharacter(${jsArg(line.character)})">${t('release.role', { character: esc(line.character) })}</button>`);
  } else if (isOwnedByOther && amHost()) {
    secondary.push(charOwner
      ? `<button class="btn-host" onclick="unclaimCharacter(${jsArg(line.character)})">${t('host.releaseRole', { owner: esc(owner) })}</button>`
      : `<button class="btn-host" onclick="unclaimSingleLine(${line.id})">${t('host.releaseLine', { owner: esc(owner) })}</button>`);
  }

  // Подсказка новичкам: запись начинается не сразу, а после отсчёта (пока нет своего дубля)
  const hint = isOwnedByMe && !line.audioUrl && recordState === 'idle' ? `<p class="take-hint">${t('record.hint')}</p>` : '';

  const micRow = isOwnedByMe ? `
    <div class="insp-row" title="${esc(t('micLevel'))}">
      <span class="insp-label">🎙</span>
      <input type="range" min="30" max="300" step="10" value="${Math.round(userMicGain * 100)}" oninput="updateUserMicGain(this.value)">
      <span id="gainDisplay" class="take-val">${Math.round(userMicGain * 100)}%</span>
    </div>` : '';

  inspector.innerHTML = `
    <div class="insp-head">
      <div class="insp-title"><b>${esc(line.character)}</b><span>#${line.id}</span></div>
      ${chip}
    </div>
    <div class="insp-meta">${line.start}–${line.end} s · ${duration} s${line.audioUrl && author ? ` · ${t('recordedBy', { owner: esc(author) })}` : ''}</div>
    <div class="insp-caption">${esc(line.caption || '…')}</div>
    <div class="insp-actions">${primary}</div>
    ${secondary.length ? `<div class="insp-actions secondary">${secondary.join('')}</div>` : ''}
    ${hint}
    <canvas id="visualizerCanvas" width="320" height="28"></canvas>
    ${micRow}
    ${takePanelHtml(line, isOwnedByMe)}
  `;
}

// Настройки записанного дубля: голос, питч, обрезка тишины, сдвиг — плотной сеткой
function takePanelHtml(line, editable) {
  if (!line.audioUrl) return '';
  const effect = line.effect || 'none';
  const pitch = line.pitch || 0;
  const shift = line.recordedStart != null ? rawTakeStart(line) - line.recordedStart : 0;
  const hasTrim = line.trimStart != null && line.trimEnd != null;
  const signed = (v, digits) => `${v > 0 ? '+' : ''}${Number(v).toFixed(digits)}`;

  if (!editable) {
    const parts = [t(`effect.${effect}`) || effect];
    if (pitch) parts.push(`${t('pitch')} ${signed(pitch, 0)}`);
    if (Math.abs(shift) >= 0.005) parts.push(`${t('shift')} ${signed(shift, 2)}s`);
    return `<div class="insp-meta">${t('voice')} ${esc(parts.join(', '))}</div>`;
  }

  const options = Object.entries(VOICE_EFFECTS)
    .map(([key]) => `<option value="${key}" ${key === effect ? 'selected' : ''}>${t(`effect.${key}`)}</option>`)
    .join('');

  return `
    <div class="take-panel" title="${esc(t('dragHint'))}">
      <div class="take-row">
        <select title="${esc(t('voice'))}" onchange="setTakeProps(${line.id}, { effect: this.value })">${options}</select>
        <span class="insp-label" title="${esc(t('pitch'))}">♯</span>
        <input type="range" min="-12" max="12" step="1" value="${pitch}" class="pitch-range" title="${esc(t('pitch'))}"
          oninput="document.getElementById('pitchVal').innerText = (this.value > 0 ? '+' : '') + this.value"
          onchange="setTakeProps(${line.id}, { pitch: Number(this.value) })">
        <span id="pitchVal" class="take-val narrow">${signed(pitch, 0)}</span>
      </div>
      <div class="take-row">
        <label class="insp-check" title="${esc(hasTrim ? t('speech', { from: line.trimStart.toFixed(2), to: line.trimEnd.toFixed(2) }) : t('speechMissing'))}">
          <input type="checkbox" ${line.trimEnabled !== false ? 'checked' : ''} ${hasTrim ? '' : 'disabled'}
            onchange="setTakeProps(${line.id}, { trimEnabled: this.checked })">
          <span>${t('trim')}</span>
        </label>
        <span class="insp-shift">
          <button class="btn-icon" onclick="nudgeTake(${line.id}, -0.05)" title="${esc(t('earlier'))}">◀</button>
          <b title="${esc(t('shift'))}">${signed(shift, 2)}s</b>
          <button class="btn-icon" onclick="nudgeTake(${line.id}, 0.05)" title="${esc(t('later'))}">▶</button>
          <button class="btn-icon" onclick="resetTakeShift(${line.id})" ${Math.abs(shift) < 0.005 ? 'disabled' : ''} title="${esc(t('reset'))}">⟲</button>
        </span>
      </div>
    </div>
  `;
}

// ==========================================
// ВСПЛЫВАЮЩИЕ ПОДСКАЗКИ И «КАК ИГРАТЬ»
// ==========================================
const toastEl = document.getElementById('toast');
const helpModal = document.getElementById('helpModal');
let toastTimer = null;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 3000);
}

window.openHelpModal = function() {
  helpModal.style.display = 'flex';
};

window.closeHelpModal = function() {
  helpModal.style.display = 'none';
  localStorage.setItem('dubline_help_seen', '1');
};

// При первом заходе показываем правила (после ввода ника, если его еще нет)
function maybeShowHelp() {
  if (!localStorage.getItem('dubline_help_seen') && myName) openHelpModal();
}

const settingsCue = document.getElementById('settingsCue');
settingsCue.addEventListener('change', () => {
  cueEnabled = settingsCue.checked;
  localStorage.setItem('dubline_cue', cueEnabled ? '1' : '0');
});

// ==========================================
// РАЗМЕРЫ ПАНЕЛЕЙ (разделители как в Vegas / Photoshop)
// ==========================================
const LAYOUT_KEY = 'dubline_layout';
const layoutLimits = {
  lobby: [190, 460],
  inspector: [280, 660],
  chat: [220, 540],
  top: [200, () => window.innerHeight - 220]
};
const layoutVars = { lobby: '--lobby-w', inspector: '--inspector-w', chat: '--chat-w', top: '--top-h' };

function layoutDefaults() {
  // На небольших экранах оставляем видео больше места
  const compact = window.innerWidth < 1500;
  return {
    lobby: compact ? 210 : 250,
    inspector: compact ? 320 : 360,
    chat: compact ? 250 : 300,
    top: Math.round(window.innerHeight * 0.5)
  };
}

function loadLayout() {
  try {
    return { ...layoutDefaults(), ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') };
  } catch (err) {
    return layoutDefaults();
  }
}

let layout = loadLayout();

function clampLayout(key, value) {
  const [min, maxRaw] = layoutLimits[key];
  const max = Math.max(min, typeof maxRaw === 'function' ? maxRaw() : maxRaw);
  return Math.round(Math.min(max, Math.max(min, value)));
}

function applyLayout() {
  for (const key of Object.keys(layoutVars)) {
    layout[key] = clampLayout(key, layout[key]);
    document.documentElement.style.setProperty(layoutVars[key], `${layout[key]}px`);
  }
}

function saveLayout() {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

document.querySelectorAll('.splitter[data-resize]').forEach(splitter => {
  const key = splitter.dataset.resize;
  const dir = Number(splitter.dataset.dir) || 1;
  const vertical = splitter.classList.contains('splitter-y');

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startPos = vertical ? e.clientY : e.clientX;
    const startValue = layout[key];
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');

    const onMove = (ev) => {
      layout[key] = clampLayout(key, startValue + dir * ((vertical ? ev.clientY : ev.clientX) - startPos));
      applyLayout();
    };
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.classList.remove('dragging');
      document.body.classList.remove('resizing');
      saveLayout();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });

  splitter.addEventListener('dblclick', () => {
    layout[key] = layoutDefaults()[key];
    applyLayout();
    saveLayout();
  });
});

window.addEventListener('resize', applyLayout);

window.resetLayout = function() {
  layout = layoutDefaults();
  applyLayout();
  saveLayout();
};

// Запуск
applyLayout();
maybeShowHelp();
syncSettingsUi();
