// ==========================================
// UI
// Settings and files modals, line inspector, hotkeys, app startup
// ==========================================
function refreshViews() {
  if (!session || !session.loaded) return;
  renderTimeline();
  if (selectedLine) showInspector(selectedLine);
}

let desktopInviteState = null;
let desktopCopyTimer = null;
let desktopInviteCollapsed = localStorage.getItem('dubline_invite_collapsed') !== '0';
let desktopFailureNotice = '';
let appUpdateState = null;
let appUpdateDismissed = false;

const DESKTOP_MODES = ['cloudflare', 'porthole', 'vpn'];

function desktopMode() {
  return desktopInviteState?.mode || 'cloudflare';
}

function desktopModeName(mode = desktopMode()) {
  if (mode === 'vpn' && ['radmin', 'hamachi'].includes(desktopInviteState?.provider)) {
    return t(`desktop.mode.${desktopInviteState.provider}`);
  }
  return t(`desktop.mode.${mode}`);
}

function desktopStatusText() {
  const state = desktopInviteState?.state || 'connecting';
  return t(`desktop.status.${state}`);
}

function desktopPublicInviteUrl() {
  if (!desktopInviteState || !desktopInviteState.publicUrl) return '';
  return `${desktopInviteState.publicUrl.replace(/\/$/, '')}/?room=${encodeURIComponent(desktopInviteState.room || currentRoom)}`;
}

function renderDesktopInvite() {
  if (!desktopInviteState) return;
  const panel = document.getElementById('desktopInvitePanel');
  const status = document.getElementById('desktopTunnelStatus');
  const input = document.getElementById('desktopInviteUrl');
  const copy = document.getElementById('desktopCopyBtn');
  const copyAll = document.getElementById('desktopCopyAllBtn');
  const showPin = document.getElementById('desktopPinVisible').checked;
  panel.style.display = 'flex';
  panel.classList.toggle('collapsed', desktopInviteCollapsed);
  status.className = `desktop-invite-status ${desktopInviteState.state || ''}`;
  status.textContent = desktopStatusText();
  document.getElementById('desktopModePort').textContent = `${desktopModeName()} · ${desktopInviteState.port || '—'}`;
  const inviteUrl = desktopPublicInviteUrl();
  input.value = inviteUrl;
  input.placeholder = t('desktop.linkPending');
  copy.disabled = !inviteUrl;
  copyAll.disabled = !inviteUrl;
  document.getElementById('desktopPinCode').textContent = showPin ? desktopInviteState.pin : '••••';
  renderDesktopHostingModal();
}

function renderDesktopHostingModal() {
  if (!desktopInviteState) return;
  const mode = desktopMode();
  document.querySelectorAll('[data-hosting-mode]').forEach(button => button.classList.toggle('active', button.dataset.hostingMode === mode));
  document.getElementById('desktopHostingModeTitle').textContent = desktopModeName(mode);
  const status = document.getElementById('desktopHostingStatus');
  status.className = `hosting-mode-status ${['ready'].includes(desktopInviteState.state) ? 'ready' : ['error', 'missing', 'stopped'].includes(desktopInviteState.state) ? 'error' : ''}`;
  status.textContent = desktopStatusText();
  document.getElementById('desktopHostingPort').textContent = desktopInviteState.port || '—';
  document.getElementById('desktopHostingDescription').textContent = t(`desktop.description.${mode}`);
  const instructions = document.getElementById('desktopHostingInstructions');
  instructions.replaceChildren(...t(`desktop.instructions.${mode}`).split('|').map(value => {
    const item = document.createElement('li'); item.textContent = value; return item;
  }));
  const openTool = document.getElementById('desktopOpenToolBtn');
  openTool.style.display = mode === 'cloudflare' ? 'none' : '';
  openTool.textContent = mode === 'vpn' ? t('desktop.openRadmin') : t('desktop.openTool');
  document.getElementById('desktopOpenHamachiBtn').style.display = mode === 'vpn' ? '' : 'none';
  document.getElementById('desktopRetryHostingBtn').style.display = mode === 'cloudflare' ? '' : 'none';
}

function handleDesktopStatus(nextStatus) {
  if (!desktopInviteState) desktopInviteState = {};
  Object.assign(desktopInviteState, nextStatus);
  const failed = ['error', 'missing', 'stopped'].includes(desktopInviteState.state);
  const noticeKey = `${desktopMode()}:${desktopInviteState.state}:${desktopInviteState.error || ''}`;
  if (failed && desktopFailureNotice !== noticeKey) {
    desktopFailureNotice = noticeKey;
    desktopInviteCollapsed = false;
    localStorage.setItem('dubline_invite_collapsed', '0');
    showToast(t('desktop.hostingFailed', { mode: desktopModeName() }));
    openHostingModal();
  }
  if (!failed) desktopFailureNotice = '';
  renderDesktopInvite();
}

async function initDesktopInvite() {
  if (!window.dublineDesktop) return;
  document.body.classList.add('desktop-mode');
  document.getElementById('roomSecuritySettings').style.display = 'none';
  handleDesktopStatus(await window.dublineDesktop.getStatus());
  window.dublineDesktop.onTunnelStatus(handleDesktopStatus);
  setInterval(async () => {
    try { handleDesktopStatus(await window.dublineDesktop.getStatus()); } catch (err) { /* app may be closing */ }
  }, 4000);
}

window.toggleDesktopPin = renderDesktopInvite;

window.toggleDesktopInvitePanel = function() {
  desktopInviteCollapsed = !desktopInviteCollapsed;
  localStorage.setItem('dubline_invite_collapsed', desktopInviteCollapsed ? '1' : '0');
  renderDesktopInvite();
};

window.copyDesktopInvite = async function() {
  const url = desktopPublicInviteUrl();
  if (!url) return;
  await window.dublineDesktop.copyText(url);
  const label = document.getElementById('desktopCopyLabel');
  label.textContent = t('desktop.copied');
  clearTimeout(desktopCopyTimer);
  desktopCopyTimer = setTimeout(() => { label.textContent = t('desktop.copy'); }, 2000);
};

window.copyDesktopInviteWithPin = async function() {
  const url = desktopPublicInviteUrl();
  if (!url || !desktopInviteState?.pin) return;
  const mode = desktopMode();
  const key = mode === 'porthole' ? 'desktop.shareText.porthole'
    : mode === 'vpn' ? 'desktop.shareText.vpn' : 'desktop.shareText';
  await window.dublineDesktop.copyText(t(key, {
    url,
    pin: desktopInviteState.pin,
    port: desktopInviteState.port,
    mode: desktopModeName(mode)
  }));
  showToast(t('desktop.copiedAll'));
};

window.openHostingModal = function() {
  if (!window.dublineDesktop) return;
  renderDesktopHostingModal();
  document.getElementById('hostingModal').style.display = 'flex';
};

window.closeHostingModal = function() {
  document.getElementById('hostingModal').style.display = 'none';
};

window.selectDesktopHostingMode = async function(mode) {
  if (!DESKTOP_MODES.includes(mode) || mode === desktopMode()) return;
  document.querySelectorAll('[data-hosting-mode]').forEach(button => { button.disabled = true; });
  try { handleDesktopStatus(await window.dublineDesktop.setHostingMode(mode)); }
  catch (err) { showToast(t('desktop.hostingChangeError', { message: err.message })); }
  finally { document.querySelectorAll('[data-hosting-mode]').forEach(button => { button.disabled = false; }); }
};

window.retryDesktopHosting = async function() {
  try { handleDesktopStatus(await window.dublineDesktop.retryHosting()); }
  catch (err) { showToast(t('desktop.hostingChangeError', { message: err.message })); }
};

window.openDesktopNetworkTool = function(tool = '') {
  const target = tool || (desktopMode() === 'vpn' ? 'radmin' : desktopMode());
  return window.dublineDesktop.openNetworkTool(target);
};

function renderAppUpdate() {
  const banner = document.getElementById('appUpdateBanner');
  if (appUpdateState?.currentVersion) document.getElementById('desktopAboutVersion').textContent = `Dubline v${appUpdateState.currentVersion}`;
  const available = !appUpdateDismissed && !appUpdateState?.dismissed && appUpdateState?.state === 'available';
  banner.classList.toggle('show', available);
  if (available) document.getElementById('appUpdateVersion').textContent = t('desktop.update.version', { version: appUpdateState.version });
}

async function initAppUpdate() {
  if (!window.dublineDesktop || typeof window.dublineDesktop.getUpdateStatus !== 'function') return;
  try { appUpdateState = await window.dublineDesktop.getUpdateStatus(); renderAppUpdate(); } catch (err) { /* update checks are optional */ }
  window.dublineDesktop.onUpdateStatus?.(status => { appUpdateState = status; renderAppUpdate(); });
}

window.openAppUpdate = function() {
  return window.dublineDesktop?.openUpdate?.();
};

window.openProjectPage = function() {
  return window.dublineDesktop?.openProject?.();
};

window.dismissAppUpdate = function() {
  appUpdateDismissed = true;
  renderAppUpdate();
  window.dublineDesktop?.dismissUpdate?.();
};

window.clearDesktopData = async function() {
  if (!window.dublineDesktop) return;
  if (!confirm(t('desktop.clearData.confirm'))) return;
  const button = document.getElementById('desktopClearDataBtn');
  button.disabled = true;
  button.textContent = t('desktop.clearData.progress');
  try {
    await window.dublineDesktop.clearAllData();
  } catch (err) {
    button.disabled = false;
    button.textContent = t('desktop.clearData.button');
    alert(t('desktop.clearData.error', { message: err.message }));
  }
};

window.copyInviteLink = async function() {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('desktopHost');
  const value = desktopPublicInviteUrl() || cleanUrl.href;
  if (window.dublineDesktop) await window.dublineDesktop.copyText(value);
  else await navigator.clipboard.writeText(value);
  showToast(t('invite.copied'));
};

// ==========================================

// SETTINGS AND FILES
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

window.openFilesModal = function() {
  document.getElementById('customUploadStatus').style.display = 'none'; filesModal.style.display = 'flex'; switchFilesTab('import'); };
window.closeFilesModal = function() { filesModal.style.display = 'none'; };
window.switchFilesTab = function(tab) {
  const names = ['import', 'library', 'export'];
  names.forEach(name => {
    const suffix = name[0].toUpperCase() + name.slice(1);
    document.getElementById(`tabBtn${suffix}`).classList.toggle('active', name === tab);
    document.getElementById(`tabContent${suffix}`).classList.toggle('active', name === tab);
  });
  if (tab === 'library') loadServerPacks();
  if (tab === 'export') updateExportDurationWarning();
};

window.addEventListener('dubline-language-changed', () => {
  updateHostUi();
  if (trashModal.style.display === 'flex') renderTrash();
  renderTrackPicker();
  renderLobby();
  updateP2pStatus();
  updateDownloadButtons();
  updateLocalMediaStatus();
  if (watchMode) showWatchOverlay();
  if (connectionState === 'offline') setConnectionState('offline');
  if (session && session.loaded) renderTimeline();
  if (selectedLine) showInspector(selectedLine);
  renderChatHistory();
  updateExportDurationWarning();
  renderDesktopInvite();
  renderAppUpdate();
});

// ==========================================
// HOTKEYS
// ==========================================
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

  // Space: play/pause
  if (e.code === 'Space') {
    e.preventDefault();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  // R (same physical key on any layout): record the selected line
  if (e.code === 'KeyR') {
    e.preventDefault();
    if (selectedLine) handleStudioRecord(selectedLine.id);
    else showToast(t('toast.selectLine'));
  }

  // Arrows: seek 3 seconds
  if (e.code === 'ArrowLeft') {
    e.preventDefault();
    video.currentTime = Math.max(0, video.currentTime - 3);
  }
  if (e.code === 'ArrowRight') {
    e.preventDefault();
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 3);
  }

  // Ctrl+Z: the host undoes the last line deletion
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    if (!amHost()) return;
    e.preventDefault();
    if (session && session.undoCount) undoDelete();
    else showToast(t('undo.nothing'));
    return;
  }

  // Esc: close modals
  if (e.code === 'Escape') {
    closeHostingModal();
    closeSettingsModal();
    closeFilesModal();
    closeSessionsModal();
    closeHelpModal();
    closeTrashModal();
    clearMultiSelection();
  }
});

function showInspector(line) {
  if (multiSelection.size >= 2) return showMultiInspector();
  const duration = Number((line.end - line.start).toFixed(2));
  const characters = [...new Set(session.lines.map(l => l.character))];
  const allowCharacterClaims = characters.length > 1;

  const charOwner = session.characterClaims ? session.characterClaims[line.character] : null;
  const owner = getLineOwner(line);
  const isOwnedByMe = owner === myName;
  const isOwnedByOther = !!owner && owner !== myName;
  const isFree = !owner;
  const author = line.recordedBy || owner;

  // Status as a compact badge in the header
  const chip = isOwnedByMe
    ? `<span class="insp-chip me">${t(charOwner ? 'chip.role' : 'chip.you')}</span>`
    : isOwnedByOther
      ? `<span class="insp-chip other">${t('chip.other', { owner: esc(owner) })}</span>`
      : `<span class="insp-chip free">${t('chip.free')}</span>`;

  const originalBtn = line.originalAudioUrl
    ? `<button class="btn-outline" onclick="playAudio(${jsArg(line.originalAudioUrl)})" title="${esc(t('listenOriginal'))}">${t('insp.original')}</button>`
    : '';

  // Main actions in one row right under the line text
  let primary = '';
  if (isOwnedByMe) {
    primary = line.audioUrl
      ? `<button class="btn-play" onclick="previewTake(${line.id})">${t('playTake')}</button>
         <button class="btn-record grow" id="recBtn" onclick="handleStudioRecord(${line.id})">${t('rerecord')}</button>
         ${originalBtn}
         <button class="btn-delete" onclick="deleteLineAudio(${line.id})" title="${esc(t('confirm.delete'))}">🗑</button>`
      : `<button class="btn-record grow" id="recBtn" onclick="handleStudioRecord(${line.id})">${t('record')}</button>${originalBtn}`;
  } else {
    // A finished take can always be played, even if the line was released or roles were reset
    const listen = line.audioUrl
      ? `<button class="btn-play grow" onclick="previewTake(${line.id})">${author ? t('listenTake', { owner: esc(author) }) : t('listenTakeAnon')}</button>`
      : '';
    const claim = isFree ? `<button class="btn-claim grow" onclick="claimSingleLine(${line.id})">${t('claim.line')}</button>` : '';
    primary = claim + listen + originalBtn;
  }

  // Secondary actions as small buttons
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

  // The take is recorded but hasn't reached the server yet
  const pendingNotice = isOwnedByMe && pendingTakeLines.has(line.id)
    ? `<div class="insp-pending"><span>${t('take.pendingNotice')}</span><button class="btn-outline" onclick="retryPendingTakes()">${t('take.sendNow')}</button></div>`
    : '';

  // Hint for newcomers: recording starts after the countdown, not right away (until they have a take)
  const hint = isOwnedByMe && !line.audioUrl && recordState === 'idle' ? `<p class="take-hint">${t('record.hint')}</p>` : '';

  const micRow = isOwnedByMe ? `
    <div class="insp-row" title="${esc(t('micLevel'))}">
      <span class="insp-label">🎙</span>
      <input type="range" min="30" max="300" step="10" value="${Math.round(userMicGain * 100)}" oninput="updateUserMicGain(this.value)">
      <span id="gainDisplay" class="take-val">${Math.round(userMicGain * 100)}%</span>
    </div>` : '';

  // The character can be changed by the host, the line's owner, or anyone if the line is free
  const canRename = amHost() || !owner || owner === myName;
  const characterNames = [...new Set(session.lines.map(l => l.character))].sort((a, b) => a.localeCompare(b));
  const characterRow = canRename ? `
    <form class="insp-row insp-char-form" onsubmit="saveLineCharacter(event, ${line.id})" title="${esc(t('char.rename'))}">
      <span class="insp-label">🎭</span>
      <input id="charInput" class="text-input" list="charList" maxlength="40" value="${esc(line.character)}" placeholder="${esc(t('char.placeholder'))}">
      <datalist id="charList">${characterNames.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>
      <button type="submit" class="btn-outline">${t('char.apply')}</button>
    </form>` : '';
  const deleteLineBtn = amHost() ? `<button class="btn-outline" onclick="deleteLines([${line.id}])">${t('line.delete')}</button>` : '';

  inspector.innerHTML = `
    <div class="insp-head">
      <div class="insp-title"><b>${esc(line.character)}</b><span>#${line.id}</span></div>
      ${chip}
    </div>
    <div class="insp-meta">${line.start}–${line.end} s · ${duration} s${line.audioUrl && author ? ` · ${t('recordedBy', { owner: esc(author) })}` : ''}</div>
    <div class="insp-caption">${esc(line.caption || '…')}</div>
    ${characterRow}
    ${pendingNotice}
    <div class="insp-actions">${primary}</div>
    ${secondary.length || deleteLineBtn ? `<div class="insp-actions secondary">${secondary.join('')}${deleteLineBtn}</div>` : ''}
    ${hint}
    <canvas id="visualizerCanvas" width="320" height="28"></canvas>
    ${micRow}
    ${takePanelHtml(line, isOwnedByMe)}
  `;
}

// Inspector for several selected lines: assign a character in bulk
function showMultiInspector() {
  const lines = session.lines.filter(l => multiSelection.has(l.id)).sort((a, b) => a.start - b.start);
  const characters = [...new Set(session.lines.map(l => l.character))].sort((a, b) => a.localeCompare(b));
  const preview = lines.slice(0, 6).map(l => `<div class="multi-item"><b>#${l.id}</b> <span class="multi-char">${esc(l.character)}</span> ${esc(l.caption || '')}</div>`).join('');
  inspector.innerHTML = `
    <div class="insp-head"><div class="insp-title"><b>${t('multi.title', { n: lines.length })}</b></div></div>
    <div class="multi-list">${preview}${lines.length > 6 ? `<div class="insp-meta">${t('multi.more', { n: lines.length - 6 })}</div>` : ''}</div>
    <form class="insp-char-form" onsubmit="assignSelectedCharacter(event)">
      <input id="multiCharInput" class="text-input" list="multiCharList" maxlength="40" placeholder="${esc(t('char.placeholder'))}">
      <datalist id="multiCharList">${characters.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>
      <button type="submit" class="btn-play">${t('multi.assign')}</button>
    </form>
    <div class="insp-actions secondary">
      ${amHost() ? `<button class="btn-host" onclick="releaseSelectedLines()">${t('multi.release')}</button>` : ''}
      ${amHost() ? `<button class="btn-outline" onclick="deleteLines([...multiSelection])">${t('multi.delete')}</button>` : ''}
      <button class="btn-outline" onclick="clearMultiSelection()">${t('multi.clear')}</button>
    </div>
    <p class="take-hint">${t('multi.hint')}</p>
  `;
}

window.assignSelectedCharacter = function(e) {
  e.preventDefault();
  const name = document.getElementById('multiCharInput').value.trim();
  if (!name) return;
  revealLineId = [...multiSelection][0];
  socket.emit('set_lines_character', { lineIds: [...multiSelection], character: name }, result => {
    if (!result) return;
    showToast(t('multi.done', { moved: result.moved, name }) + (result.skipped ? ' ' + t('multi.skipped', { n: result.skipped }) : ''));
  });
};

window.releaseSelectedLines = function() {
  socket.emit('host_release_lines', { lineIds: [...multiSelection] });
};

// Changing a line's character moves it to that character's track
window.startCharacterEdit = function(lineId) {
  const line = session.lines.find(l => l.id === lineId);
  if (!line) return;
  if (!selectedLine || selectedLine.id !== lineId) selectLine(line);
  const input = document.getElementById('charInput');
  if (input) {
    input.focus();
    input.select();
  }
};

window.saveLineCharacter = function(e, lineId) {
  e.preventDefault();
  const line = session.lines.find(l => l.id === lineId);
  const name = document.getElementById('charInput').value.trim();
  if (!line || !name || name === line.character) return showInspector(selectedLine);
  const roleOwner = session.characterClaims && session.characterClaims[name];
  if (roleOwner && roleOwner !== myName && !amHost()) {
    showToast(t('char.roleTaken', { name, owner: roleOwner }));
    return;
  }
  revealLineId = lineId; // after the redraw, scroll to the line on its new track
  socket.emit('set_line_character', { lineId, character: name });
};

// The host deletes lines (e.g. on-screen signs that shouldn't be dubbed)
window.deleteLines = function(lineIds) {
  if (!lineIds.length || !confirm(t('line.deleteConfirm', { n: lineIds.length }))) return;
  socket.emit('host_delete_lines', { lineIds });
  if (lineIds.length > 1) clearMultiSelection();
};

// Recorded take settings in a compact grid: voice, pitch, silence trimming, shift
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
// TOASTS AND "HOW TO PLAY"
// ==========================================
const toastEl = document.getElementById('toast');
const helpModal = document.getElementById('helpModal');
let toastTimer = null;

// Toast at the bottom of the screen; action is an optional button (e.g. "Undo")
function showToast(text, action = null) {
  toastEl.textContent = text;
  if (action) {
    const button = document.createElement('button');
    button.className = 'btn-record';
    button.textContent = action.label;
    button.onclick = () => {
      toastEl.style.display = 'none';
      action.onClick();
    };
    toastEl.appendChild(button);
  }
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, action ? 7000 : 3000);
}

window.openHelpModal = function() {
  helpModal.style.display = 'flex';
};

window.closeHelpModal = function() {
  helpModal.style.display = 'none';
  localStorage.setItem('dubline_help_seen', '1');
};

// Show the rules on the first visit (after entering a nick, if there isn't one yet)
function maybeShowHelp() {
  if (!localStorage.getItem('dubline_help_seen') && myName) openHelpModal();
}

const settingsCue = document.getElementById('settingsCue');
settingsCue.addEventListener('change', () => {
  cueEnabled = settingsCue.checked;
  localStorage.setItem('dubline_cue', cueEnabled ? '1' : '0');
});

// ==========================================
// PANEL SIZES (dividers like in Vegas / Photoshop)
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
  // On small screens give the video more room
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

// Startup
applyLayout();
maybeShowHelp();
syncSettingsUi();
initDesktopInvite();
initAppUpdate();

// ==========================================
// HINT TO PLAY IN CHROME / EDGE
// Recording, export and P2P are tested only in Chromium-based browsers
// ==========================================
const browserBanner = document.getElementById('browserBanner');

function isChromiumBrowser() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  return brands.some(item => /Chromium|Google Chrome|Microsoft Edge/.test(item.brand));
}

window.dismissBrowserBanner = function() {
  browserBanner.style.display = 'none';
  try { localStorage.setItem('dubline_browser_hint', '1'); } catch (err) { /* private mode */ }
};

if (!isChromiumBrowser()) {
  let dismissed = false;
  try { dismissed = localStorage.getItem('dubline_browser_hint') === '1'; } catch (err) { /* private mode */ }
  if (!dismissed) browserBanner.style.display = 'flex';
}
