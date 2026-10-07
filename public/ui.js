// Personal preferences stay on this device; shared values have their own controls.
(() => {
  const personal = document.getElementById('tabContentUser'), shared = document.getElementById('tabContentPlayer');
  for (const id of ['settingsPrompter', 'settingsP2P', 'desktopClearDataBtn']) {
    const card = document.getElementById(id).closest('.setting-card'); personal.appendChild(card);
    if (id === 'settingsP2P') card.dataset.singleHide = '';
  }
  personal.appendChild(shared.querySelector('[data-i18n="layout.reset"]').closest('.setting-card'));
  const own = document.createElement('div'); own.className = 'setting-card';
  own.append(document.getElementById('settingsLocalDuck').closest('.setting-card-row'), document.getElementById('localDuckSubRow'));
  personal.appendChild(own);
  const hide = document.createElement('div'); hide.className = 'setting-card'; hide.dataset.singleHide = '';
  hide.appendChild(document.getElementById('settingsHideMyTakes').closest('.setting-card-row')); personal.appendChild(hide);
  document.getElementById('settingsBlindMode').closest('.setting-card').dataset.singleHide = '';
  const monitoring = document.createElement('div'); monitoring.className = 'setting-card';
  monitoring.innerHTML = '<label data-i18n="studio.mixMode"></label><select data-studio-mix class="text-input"><option value="project" data-i18n="studio.projectMix"></option><option value="monitor" data-i18n="studio.monitor"></option></select><div class="setting-sub" data-i18n="studio.monitorHelp"></div>';
  personal.appendChild(monitoring);
  const card = document.createElement('div'); card.id = 'projectMixSettings'; card.className = 'setting-card';
  card.innerHTML = '<div class="setting-label" data-i18n="studio.projectMix"></div><div class="setting-sub" data-i18n="studio.projectHelp"></div>';
  for (const channel of ['original', 'backing', 'dub']) {
    const row = document.createElement('div'); row.className = 'setting-card-row'; row.dataset.projectChannel = channel;
    row.innerHTML = '<span data-i18n="studio.' + channel + '"></span><label><input type="range" min="0" max="150" step="1" data-project-field="volume" data-reset-resolver="project-volume" data-reset-event="change"><output></output></label><button class="btn-outline" data-project-field="muted" data-i18n="studio.mute"></button><button class="btn-outline" data-project-field="solo" data-i18n="studio.solo"></button>' + (channel === 'dub' ? '' : '<label><span data-i18n="studio.offset"></span><input class="text-input" type="number" min="-43200" max="43200" step="0.01" data-project-field="offset"></label>');
    card.appendChild(row);
  }
  shared.prepend(card);
  DublineI18n.apply(personal);
  DublineI18n.apply(shared);
})();
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
let desktopHostingRequest = 0;
let desktopHostingRequestedMode = null;
let desktopFutureHostingMode = 'cloudflare', desktopMultiplayerStarting = false;
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
  if (desktopInviteState.singlePlayer) { panel.style.display = 'none'; renderDesktopHostingModal(); return; }
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
  const mode = desktopHostingRequestedMode || (desktopMode() === 'single' ? desktopFutureHostingMode : desktopMode());
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
  document.getElementById('desktopRetryHostingBtn').style.display = mode === 'cloudflare' && !session?.singlePlayer ? '' : 'none';
  const start = document.getElementById('desktopStartMultiplayerBtn');
  start.style.display = session?.singlePlayer ? '' : 'none';
  start.disabled = desktopMultiplayerStarting || desktopTransitionBusy();
}

function handleDesktopStatus(nextStatus) {
  if (desktopHostingRequestedMode && nextStatus.mode !== desktopHostingRequestedMode) return;
  if (!desktopInviteState) desktopInviteState = {};
  Object.assign(desktopInviteState, nextStatus, { singlePlayer: nextStatus.mode === 'single' });
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
  if (session?.singlePlayer) { if (DESKTOP_MODES.includes(mode) && !desktopMultiplayerStarting) { desktopFutureHostingMode = mode; renderDesktopHostingModal(); } return; }
  return applyDesktopHostingMode(mode);
};
function desktopTransitionBusy() { return recordState !== 'idle' || pendingTakeLines.size > 0 || renderInProgress || projectImportBusy || projectExportBusy || window.snapshotFrozen; }
window.startDesktopMultiplayer = async function() {
  if (!session?.singlePlayer || desktopMultiplayerStarting || desktopTransitionBusy()) return;
  desktopMultiplayerStarting = true; renderDesktopHostingModal();
  try { await applyDesktopHostingMode(desktopFutureHostingMode); }
  finally { desktopMultiplayerStarting = false; renderDesktopHostingModal(); }
};
async function applyDesktopHostingMode(mode) {
  if (!DESKTOP_MODES.includes(mode) || (mode === desktopMode() && !desktopHostingRequestedMode)) return;
  const request = ++desktopHostingRequest;
  desktopHostingRequestedMode = mode;
  renderDesktopHostingModal();
  try {
    const status = await window.dublineDesktop.setHostingMode(mode);
    if (request === desktopHostingRequest) handleDesktopStatus(status);
  } catch (err) {
    if (request === desktopHostingRequest) showToast(t('desktop.hostingChangeError', { message: err.message }));
  } finally {
    if (request === desktopHostingRequest) { desktopHostingRequestedMode = null; renderDesktopHostingModal(); }
  }
}

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
  const view = window.DublineUpdatePresentation(appUpdateState, window.DublineI18n.getLanguage());
  const available = !appUpdateDismissed && !appUpdateState?.dismissed && view.visible;
  banner.classList.toggle('show', available);
  if (available) {
    banner.querySelector('strong').textContent = view.title;
    document.getElementById('appUpdateVersion').textContent = view.text;
    const action = banner.querySelector('.btn-play'); action.textContent = view.action; action.disabled = view.disabled;
  }
}

async function initAppUpdate() {
  if (!window.dublineDesktop || typeof window.dublineDesktop.getUpdateStatus !== 'function') return;
  try { appUpdateState = await window.dublineDesktop.getUpdateStatus(); renderAppUpdate(); } catch (err) { /* update checks are optional */ }
  window.dublineDesktop.onUpdateStatus?.(status => { appUpdateState = status; renderAppUpdate(); });
}

window.openAppUpdate = async function() {
  const result = await window.dublineDesktop?.openUpdate?.();
  if (result?.code === 'busy') showToast(window.DublineUpdatePresentation(appUpdateState, window.DublineI18n.getLanguage()).busy);
  return result;
};

window.openProjectPage = function() {
  return window.dublineDesktop?.openProject?.();
};

window.dismissAppUpdate = function() {
  appUpdateDismissed = true;
  renderAppUpdate();
  window.dublineDesktop?.dismissUpdate?.();
};

let desktopStorageInfo = null;
function renderDesktopStorage() {
  document.getElementById('desktopStoragePath').textContent = desktopStorageInfo?.root || '';
  document.getElementById('desktopStoragePending').textContent = desktopStorageInfo?.pending ? t('storage.pending', { path: desktopStorageInfo.pending }) : '';
}
async function refreshDesktopStorage() {
  if (!window.dublineDesktop?.getStorage) return;
  desktopStorageInfo = await window.dublineDesktop.getStorage(); renderDesktopStorage();
}
window.changeDesktopStorage = async function() {
  if (!window.dublineDesktop?.chooseStorage) return;
  const button = document.getElementById('desktopStorageChange');
  const status = document.getElementById('desktopStorageStatus');
  button.disabled = true; status.textContent = '';
  try {
    const result = await window.dublineDesktop.chooseStorage();
    if (!result.ok) {
      const key = 'storage.error.' + result.code;
      status.textContent = t(DublineI18n.messages.en[key] ? key : 'storage.error.io', { message: result.message || result.code });
    }
    await refreshDesktopStorage();
  } catch (error) { status.textContent = t('storage.error.io', { message: error.message }); }
  finally { button.disabled = false; }
};
window.addEventListener('dubline-language-changed', renderDesktopStorage);
window.clearDesktopData = async function() {
  if (!window.dublineDesktop) return;
  if (!await askConfirm(t('desktop.clearData.confirm'))) return;
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
const settingsTheme = document.getElementById('settingsTheme');
const settingsPreRoll = document.getElementById('settingsPreRoll');
const settingsPreRollVal = document.getElementById('settingsPreRollVal');

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
  settingsPreRoll.value = preRollSeconds;
  settingsPreRoll.min = localStorage.getItem('dubline_adr') === 'three' ? '3' : '0';
  document.getElementById('settingsAdrVolume').value = Math.round(adrCueVolume * 100);
  document.getElementById('settingsAdrVolumeVal').textContent = `${Math.round(adrCueVolume * 100)}%`;
  settingsPreRollVal.textContent = t('seconds.short', { value: Number(preRollSeconds).toFixed(1) });
  document.getElementById('preRollSubRow').style.opacity = cueEnabled ? '1' : '0.75';
  settingsPrompterSize.value = prompterSize;
  settingsPrompterSizeVal.textContent = `${prompterSize}px`;
  document.getElementById('prompterSubRow').style.opacity = prompterEnabled ? '1' : '0.45';
  settingsLanguage.value = i18n.getLanguage();
  settingsTheme.value = document.documentElement.dataset.theme || 'midnight';
  if (window.syncStudioSettings) window.syncStudioSettings();
  updatePrompter();
}

window.openSettingsModal = function() { syncSettingsUi(); refreshDesktopStorage().catch(() => {}); settingsModal.style.display = 'flex'; };
window.closeSettingsModal = function() { settingsModal.style.display = 'none'; };
window.switchSettingsTab = function(tab) {
  ['user', 'player'].forEach(name => {
    const active = name === tab;
    document.getElementById(`tabBtn${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle('active', active);
    document.getElementById(`tabContent${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle('active', active);
  });
};

let nickSaveGeneration = 0;
let nickSavePending = false;
let nickSaveStatusTimer = null;
window.saveNickFromSettings = function() {
  const next = settingsNickInput.value.trim();
  if (nickSavePending || !next || next === myName || !socket.connected) return;
  const generation = ++nickSaveGeneration;
  const roomId = currentRoom;
  nickSavePending = true;
  const button = document.getElementById('settingsNickSave');
  button.disabled = true;
  settingsNickInput.disabled = true;
  clearTimeout(nickSaveStatusTimer);
  settingsNickStatus.textContent = t('nick.saving');
  settingsNickStatus.style.color = 'var(--text-secondary)';
  settingsNickStatus.style.display = 'block';
  socket.timeout(5000).emit('rename_user', { newName: next }, (error, result) => {
    if (generation !== nickSaveGeneration) return;
    nickSavePending = false;
    button.disabled = false;
    settingsNickInput.disabled = false;
    if (roomId !== currentRoom) return;
    settingsNickInput.value = myName;
    const ok = !error && result?.ok === true && result.nick === myName;
    settingsNickStatus.textContent = ok ? t('nick.saved') : result?.errorKey ? t(result.errorKey, result.errorParams || {}) : t('nick.failed');
    settingsNickStatus.style.color = ok ? 'var(--success)' : 'var(--danger)';
    nickSaveStatusTimer = setTimeout(() => { if (generation === nickSaveGeneration) settingsNickStatus.style.display = 'none'; }, 3000);
  });
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
  window.updateProjectAudio('settings', 'autoDuckEnabled', settingsAutoDuck.checked);
});
settingsAutoDuckAmount.addEventListener('change', () => {
  window.updateProjectAudio('settings', 'autoDuckAmount', settingsAutoDuckAmount.value / 100);
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
settingsTheme.addEventListener('change', () => {
  document.documentElement.dataset.theme = settingsTheme.value;
  localStorage.setItem('dubline_theme', settingsTheme.value);
});

window.openFilesModal = function() {
  filesModal.style.display = 'flex'; switchFilesTab('import'); renderCustomImportStatus(); };
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
  if (tab === 'import') renderCustomImportStatus();
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
  if (e.code === 'KeyF' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.openTimelineSearch?.(); return; }
  if (e.code === 'Escape') {
    if (window.closeTimelineSearch?.()) return;
    if (closeTextPrompt()) return;
    if (document.body.classList.contains('video-expanded')) toggleExpandedVideo();
    closeHostingModal(); closeSettingsModal(); closeFilesModal(); closeSessionsModal();
    closeHelpModal(); closeTrashModal(); clearMultiSelection();
    return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable || e.ctrlKey && e.code !== 'KeyZ' || e.metaKey && e.code !== 'KeyZ') return;

  // Edit Mode has its own keys for the selected lines (move, change role, delete, undo)
  if (window.handleEditorKey && handleEditorKey(e)) return;
  if (e.altKey) return;

  // Space: play/pause
  if (e.code === 'Space') {
    e.preventDefault();
    window.studioTransport('play');
  }
  const transportKeys = { KeyJ: 'back', KeyK: 'pause', KeyL: 'forward', KeyF: 'fullscreen' };
  if (transportKeys[e.code]) { e.preventDefault(); window.studioTransport(transportKeys[e.code]); }

  // R (same physical key on any layout): record the selected line
  if (e.code === 'KeyR') {
    e.preventDefault();
    if (session && session.mode === 'edit') return showToast(t('editor.recordDisabled'));
    recordSelectedLine();
  }

  // Arrows: seek 3 seconds
  if (e.code === 'ArrowLeft') {
    e.preventDefault();
    window.studioTransport('back');
  }
  if (e.code === 'ArrowRight') {
    e.preventDefault();
    window.studioTransport('forward');
  }

  // Ctrl+Z: the host undoes the last line deletion
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    if (!amHost()) return;
    e.preventDefault();
    if (session && session.undoCount) undoDelete();
    else showToast(t('undo.nothing'));
    return;
  }

});

function showInspector(line) {
  if (multiSelection.size >= 2) return showMultiInspector();
  if (session.mode === 'edit') return window.showEditorInspector(line);
  const duration = Number((line.end - line.start).toFixed(2));
  const characters = sessionCharacters();
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
         <button class="btn-record grow" id="recBtn" ${renderInProgress ? 'disabled' : ''} onclick="handleStudioRecord(${line.id})">${t('rerecord')}</button>
         ${originalBtn}
         <button class="btn-delete" onclick="deleteLineAudio(${line.id})" title="${esc(t('confirm.delete'))}">🗑</button>`
      : `<button class="btn-record grow" id="recBtn" ${renderInProgress ? 'disabled' : ''} onclick="handleStudioRecord(${line.id})">${t('record')}</button>${originalBtn}`;
  } else {
    // A finished take can always be played, even if the line was released or roles were reset
    const listen = line.audioUrl && canHearLine(line)
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

  if (session.singlePlayer) secondary.length = 0;

  // The take is recorded but hasn't reached the server yet
  const pendingNotice = isOwnedByMe && pendingTakeLines.has(line.id)
    ? `<div class="insp-pending"><span>${t('take.pendingNotice')}</span><button class="btn-outline" onclick="retryPendingTakes()">${t('take.sendNow')}</button></div>`
    : '';

  // Hint for newcomers: recording starts after the countdown, not right away (until they have a take)
  const hint = isOwnedByMe && !line.audioUrl && recordState === 'idle' ? `<p class="take-hint">${t('record.hint')}</p>` : '';

  const micRow = isOwnedByMe ? `
    <div class="insp-row" title="${esc(t('micLevel'))}">
      <span class="insp-label">🎙</span>
      <input type="range" data-reset-value="100" data-reset-event="input" min="30" max="300" step="10" value="${Math.round(userMicGain * 100)}" oninput="updateUserMicGain(this.value)">
      <span id="gainDisplay" class="take-val">${Math.round(userMicGain * 100)}%</span>
    </div>` : '';

  // The character can be changed by the host, the line's owner, or anyone if the line is free
  const canRename = false;
  const characterNames = sessionCharacters().sort((a, b) => a.localeCompare(b));
  const characterRow = canRename ? `
    <form class="insp-row insp-char-form" onsubmit="saveLineCharacter(event, ${line.id})" title="${esc(t('char.rename'))}">
      <span class="insp-label">🎭</span>
      <input id="charInput" class="text-input" list="charList" maxlength="40" value="${esc(line.character)}" placeholder="${esc(t('char.placeholder'))}">
      <datalist id="charList">${characterNames.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>
      <button type="submit" class="btn-outline">${t('char.apply')}</button>
    </form>` : '';
  const deleteLineBtn = '';

  inspector.innerHTML = `
    <div class="insp-head">
      <div class="insp-title"><b>${esc(line.character)}</b><span>#${lineNumber(line)}</span></div>
      ${chip}
    </div>
    <div class="insp-meta">${line.start}–${line.end} s · ${duration} s${line.audioUrl && author ? ` · ${t('recordedBy', { owner: esc(author) })}` : ''}</div>
    <div class="insp-caption">${esc(line.caption || '…')}</div>
    ${retakeControlHtml(line)}
    ${characterRow}
    ${pendingNotice}
    <div class="insp-actions">${primary}</div>
    ${secondary.length || deleteLineBtn ? `<div class="insp-actions secondary">${secondary.join('')}${deleteLineBtn}</div>` : ''}
    ${hint}
    <canvas id="visualizerCanvas" width="320" height="28"></canvas>
    ${micRow}
    ${takePanelHtml(line, canEditTake(line))}
  `;
}

// Inspector for several selected lines: assign a character in bulk
function showMultiInspector() {
  const lines = session.lines.filter(l => multiSelection.has(l.id)).sort((a, b) => a.start - b.start);
  const characters = sessionCharacters().sort((a, b) => a.localeCompare(b));
  const preview = lines.slice(0, 6).map(l => `<div class="multi-item"><b>#${lineNumber(l)}</b> <span class="multi-char">${esc(l.character)}</span> ${esc(l.caption || '')}</div>`).join('');
  const editorForm = session.mode === 'edit' ? `
    <form class="insp-char-form" onsubmit="assignSelectedCharacter(event)">
      <input id="multiCharInput" class="text-input" list="multiCharList" maxlength="40" placeholder="${esc(t('char.placeholder'))}">
      <datalist id="multiCharList">${characters.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>
      <button type="submit" class="btn-play">${t('multi.assign')}</button>
    </form>` : '';
  inspector.innerHTML = `
    <div class="insp-head"><div class="insp-title"><b>${t('multi.title', { n: lines.length })}</b></div></div>
    <div class="multi-list">${preview}${lines.length > 6 ? `<div class="insp-meta">${t('multi.more', { n: lines.length - 6 })}</div>` : ''}</div>
    ${editorForm}
    ${takeMixPanelHtml(lines, true)}
    <div class="insp-actions secondary">
      ${amHost() && !session.singlePlayer ? `<button class="btn-host" onclick="releaseSelectedLines()">${t('multi.release')}</button>` : ''}
      ${session.mode === 'edit' ? `<button class="btn-outline" onclick="deleteEditorLines([...multiSelection])">${t('multi.delete')}</button>` : ''}
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
  const ids = [...multiSelection].filter(lineId => session.lines.some(line => line.id === lineId));
  queueEditorRequest(() => ['set_lines_character', {
    lines: ids.map(lineId => ({ lineId, revision: lineRevision(lineId) })),
    character: name
  }]).then(result => {
    if (!editorResult(result)) return;
    showToast(t('multi.done', { moved: result.moved, name }) + (result.skipped ? ' ' + t('multi.skipped', { n: result.skipped }) : ''));
  });
};

window.releaseSelectedLines = function() {
  socket.emit('host_release_lines', { lineIds: [...multiSelection], sessionId: session?.activeSessionId });
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
  queueEditorRequest(() => ['set_line_character', { lineId, revision: lineRevision(lineId), character: name }]).then(editorResult);
};

// The host deletes lines (e.g. on-screen signs that shouldn't be dubbed)
window.deleteLines = async function(lineIds) {
  if (session && session.mode === 'edit') return deleteEditorLines(lineIds);
  const sessionId = session?.activeSessionId;
  if (!lineIds.length || !await askConfirm(t('line.deleteConfirm', { n: lineIds.length }))) return;
  if (session?.activeSessionId !== sessionId) return showToast(t('editor.dialogChanged'));
  socket.emit('host_delete_lines', { lineIds, sessionId });
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
    return `${takeMixPanelHtml([line])}<div class="insp-meta">${t('voice')} ${esc(parts.join(', '))}</div>${effect !== 'none' ? clipSliderHtml([line], 'effectAmount', 0, 100, 1, 'disabled') : ''}`;
  }

  const options = Object.entries(VOICE_EFFECTS)
    .map(([key]) => `<option value="${key}" ${key === effect ? 'selected' : ''}>${t(`effect.${key}`)}</option>`)
    .join('');

  return `
    ${takeMixPanelHtml([line])}
    <div class="take-panel" data-take-mix data-session="${esc(session.activeSessionId)}" data-takes="${esc(JSON.stringify([{ lineId: line.id, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0 }]))}" title="${esc(t('dragHint'))}">
      <label class="clip-mix-row"><span>${esc(t('voice'))}</span>
        <select class="text-input" data-clip-field="effect" aria-label="${esc(t('voice'))}" title="${esc(t('voice'))}" onchange="setTakeControlProps(this, { effect: this.value })">${options}</select>
      </label>
      ${effect !== 'none' ? clipSliderHtml([line], 'effectAmount', 0, 100, 1, '') : ''}
      <div class="take-row">
        <span class="insp-label" title="${esc(t('pitch'))}">♯</span>
        <input type="range" data-reset-value="0" data-reset-event="change" min="-12" max="12" step="1" value="${pitch}" class="pitch-range" title="${esc(t('pitch'))}"
          oninput="document.getElementById('pitchVal').innerText = (this.value > 0 ? '+' : '') + this.value"
          onchange="this.oninput(); setTakeControlProps(this, { pitch: Number(this.value) })">
        <span id="pitchVal" class="take-val narrow">${signed(pitch, 0)}</span>
      </div>
      <div class="take-row">
        <label class="insp-check" title="${esc(hasTrim ? t('speech', { from: line.trimStart.toFixed(2), to: line.trimEnd.toFixed(2) }) : t('speechMissing'))}">
          <input type="checkbox" ${line.trimEnabled !== false ? 'checked' : ''} ${hasTrim ? '' : 'disabled'}
            onchange="setTakeControlProps(this, { trimEnabled: this.checked })">
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
  syncSettingsUi();
});

settingsPreRoll.addEventListener('input', () => {
  preRollSeconds = DublineAdr.preparation(settingsPreRoll.value, localStorage.getItem('dubline_adr') === 'three');
  settingsPreRoll.value = preRollSeconds;
  localStorage.setItem('dubline_pre_roll', String(preRollSeconds));
  settingsPreRollVal.textContent = t('seconds.short', { value: preRollSeconds.toFixed(1) });
});

document.getElementById('settingsAdrVolume').addEventListener('input', event => {
  adrCueVolume = Math.max(0, Math.min(1, Number(event.target.value) / 100));
  localStorage.setItem('dubline_adr_volume', String(adrCueVolume));
  document.getElementById('settingsAdrVolumeVal').textContent = `${Math.round(adrCueVolume * 100)}%`;
});

const videoWrapper = document.querySelector('.video-wrapper');
const transportBar = document.querySelector('.studio-transport');
const transportAnchor = document.createComment('transport');
transportBar.before(transportAnchor);
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement === videoWrapper) videoWrapper.appendChild(transportBar);
  else transportAnchor.after(transportBar);
});

window.toggleExpandedVideo = function() {
  const expanded = document.body.classList.toggle('video-expanded');
  const button = document.getElementById('expandVideoBtn');
  button.classList.toggle('active', expanded);
  button.title = t(expanded ? 'video.collapse' : 'video.expand');
};

window.toggleVideoFullscreen = async function() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await videoWrapper.requestFullscreen();
  } catch (err) {
    showToast(t('video.fullscreenFailed'));
  }
};

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


function canEditTake(line) {
  return window.DublineTakeMix.canEdit(line, myName, amHost(), getLineOwner(line));
}
function retakeControlHtml(line) {
  if (!line.audioUrl) return '';
  const allowed = session.mode === 'edit' || canEditTake(line);
  return '<label class="insp-check"><input type="checkbox" ' + (line.needsRetake ? 'checked ' : '') + (allowed ? '' : 'disabled ') +
    'data-retake-line="' + line.id + '" data-retake-session="' + esc(session.activeSessionId) + '" data-retake-url="' + esc(line.audioUrl) +
    '" data-retake-revision="' + (line.takeMixRevision || 0) + '">' + esc(t('retake.label')) + '</label>';
}
document.addEventListener('change', event => {
  const input = event.target.closest('[data-retake-line]');
  if (!input || input.dataset.retakeSession !== session?.activeSessionId) return;
  input.disabled = true;
  socket.timeout(5000).emit('set_needs_retake', { sessionId: input.dataset.retakeSession,
    lineId: Number(input.dataset.retakeLine), audioUrl: input.dataset.retakeUrl,
    takeMixRevision: Number(input.dataset.retakeRevision), value: input.checked }, (error, result) => {
    if (error || !result?.ok) {
      showToast(t('clip.changed'));
      if (input.isConnected && selectedLine) showInspector(selectedLine);
    }
  });
});

function clipSliderHtml(lines, field, min, max, fallback, disabled) {
  const valueOf = line => window.DublineTakeMix.normalize(line)[field];
  const mixed = !lines.every(line => valueOf(line) === valueOf(lines[0]));
  const value = Math.round((mixed ? fallback : valueOf(lines[0])) * 100);
  return '<label class="clip-mix-row"><span>' + esc(t(`clip.${field}`)) + '</span>' +
    '<input data-clip-field="' + field + '" data-reset-value="' + fallback * 100 + '" data-reset-event="change" aria-label="' + esc(t(`clip.${field}`)) + '" type="range" min="' + min + '" max="' + max + '" step="1" value="' + value + '" ' + disabled +
    ' oninput="updateTakeMixLabel(this)" onchange="updateTakeMixLabel(this); setTakeControlProps(this, { ' + field + ': Number(this.value) / 100 })">' +
    '<output>' + esc(mixed ? t('clip.mixed') : takeMixLabel(field, value)) + '</output></label>';
}

function takeMixPanelHtml(selection, bulk = false) {
  const recorded = selection.filter(line => line.audioUrl);
  if (!recorded.length) return '';
  const editable = recorded.filter(canEditTake);
  const lines = editable.length ? editable : recorded;
  const disabled = editable.length ? '' : 'disabled';
  const targets = editable.map(line => ({ lineId: line.id, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0 }));
  const slider = (field, min, max, fallback) => clipSliderHtml(lines, field, min, max, fallback, disabled);
  const effectsMatch = lines.every(line => (line.effect || 'none') === (lines[0].effect || 'none'));
  const effect = effectsMatch ? lines[0].effect || 'none' : '';
  const options = (!effectsMatch ? '<option value="" disabled selected>' + esc(t('clip.mixed')) + '</option>' : '') +
    Object.keys(VOICE_EFFECTS).map(key => '<option value="' + key + '" ' + (key === effect ? 'selected' : '') + '>' + esc(t(`effect.${key}`)) + '</option>').join('');
  return '<section class="take-panel clip-mix-panel" data-take-mix data-session="' + esc(session.activeSessionId) + '" data-takes="' + esc(JSON.stringify(targets)) + '">' +
    '<b class="setting-sub">' + esc(t('clip.title')) + '</b>' +
    (bulk ? '<p class="take-hint">' + esc(t('clip.bulk', { n: editable.length, total: recorded.length })) + '</p>' : '') +
    slider('volume', 0, 300, 1) + slider('pan', -100, 100, 0) +
    (bulk ? '<label class="clip-mix-row"><span>' + esc(t('voice')) + '</span><select class="text-input" data-clip-field="effect" aria-label="' + esc(t('voice')) + '" ' + disabled + ' onchange="setTakeControlProps(this, { effect: this.value })">' + options + '</select></label>' : '') +
    (bulk ? bulkPitchSliderHtml(lines, disabled) : '') +
    (bulk && effect && effect !== 'none' ? slider('effectAmount', 0, 100, 1) + '<p class="take-hint">' + esc(t('clip.effectHelp')) + '</p>' : '') +
    (!editable.length ? '<p class="take-hint">' + esc(t('clip.readOnly')) + '</p>' : '') + '</section>';
}

function takeMixLabel(field, value) {
  return field === 'pan' ? (value === 0 ? t('clip.center') : t(value < 0 ? 'clip.left' : 'clip.right', { n: Math.abs(value) })) : value + '%';
}
function bulkPitchSliderHtml(lines, disabled) {
  const value = lines[0].pitch || 0;
  const mixed = lines.some(line => (line.pitch || 0) !== value);
  return '<label class="clip-mix-row"><span>' + esc(t('pitch')) + '</span>' +
    '<input type="range" data-clip-field="pitch" data-reset-value="0" data-reset-event="change" min="-12" max="12" step="1" value="' + (mixed ? 0 : value) + '" ' + disabled +
    ' oninput="this.parentElement.querySelector(\'output\').textContent = (Number(this.value) > 0 ? \'+\' : \'\') + this.value" onchange="this.oninput(); setTakeControlProps(this, { pitch: Number(this.value) })">' +
    '<output>' + esc(mixed ? t('clip.mixed') : (value > 0 ? '+' : '') + value) + '</output></label>';
}
window.updateTakeMixLabel = function(input) {
  input.parentElement.querySelector('output').textContent = takeMixLabel(input.dataset.clipField, Number(input.value));
};
window.setTakeControlProps = function(input, props) {
  const panel = input.closest('[data-take-mix]');
  if (!panel || panel.dataset.pending) return;
  const sessionId = panel.dataset.session, takes = JSON.parse(panel.dataset.takes);
  if (!takes.length || sessionId !== session.activeSessionId) return;
  panel.dataset.pending = 'true';
  panel.querySelectorAll('input,select').forEach(control => { control.disabled = true; });
  socket.timeout(5000).emit('set_takes_props', { sessionId, takes, props }, (error, result) => {
    if (!session || session.activeSessionId !== sessionId) return;
    if (error || !result?.ok) {
      showToast(t(error ? 'clip.timeout' : result?.reason === 'owner' ? 'clip.readOnly' : result?.reason === 'invalid' ? 'clip.invalid' : 'clip.changed'));
      if (panel.isConnected) {
        if (multiSelection.size >= 2) showMultiInspector();
        else if (selectedLine) showInspector(selectedLine);
      }
    }
  });
};
