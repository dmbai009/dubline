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
  }
});

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
  } else {
    recordBtnHtml = `<button class="btn-record" disabled>${t('claimFirst')}</button>`;
  }

  // Готовый дубль можно послушать всегда — даже если реплика освобождена или роли сброшены
  if (!isOwnedByMe && line.audioUrl) {
    const author = line.recordedBy || owner;
    recordBtnHtml += author
      ? `<button class="btn-play" onclick="previewTake(${line.id})">${t('listenTake', { owner: esc(author) })}</button>`
      : `<button class="btn-play" onclick="previewTake(${line.id})">${t('listenTakeAnon')}</button>`;
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
  const shift = line.recordedStart != null ? rawTakeStart(line) - line.recordedStart : 0;
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
syncSettingsUi();
