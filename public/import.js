// ==========================================
// IMPORT
// Pack upload, mod library, custom scene import
// ==========================================
// Upload a new pack
const projectInput = document.getElementById('projectInput');
let projectImportBusy = false;
projectInput.addEventListener('change', async () => {
  const file = projectInput.files[0];
  projectInput.value = '';
  if (!file || projectImportBusy) return;
  if (!amHost()) return showToast(t('onlyHost'));
  if (recordState !== 'idle' || renderInProgress) return showToast(t('studio.mediaBusy'));
  const tooBig = tunnelUploadError([file]);
  if (tooBig) return showToast(tooBig);
  const status = document.getElementById('projectImportStatus');
  projectImportBusy = true;
  projectInput.disabled = true;
  status.style.display = 'block';
  status.style.color = 'var(--accent-2)';
  status.textContent = t('project.opening');
  const form = new FormData();
  form.append('clientId', clientId);
  form.append('sessionId', session?.activeSessionId || '');
  form.append('project', file);
  try {
    const response = await fetch(`/api/import-project?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: form });
    if (!response.ok) throw new Error(await readError(response));
    status.style.color = 'var(--success)';
    status.textContent = t('project.opened');
  } catch (error) {
    status.style.color = 'var(--danger)';
    status.textContent = error instanceof TypeError ? t('upload.networkFailed') : error.message;
  } finally {
    projectImportBusy = false;
    projectInput.disabled = !amHost();
  }
});

zipInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  zipInput.value = '';
  const tooBig = tunnelUploadError([file]);
  if (tooBig) return alert(tooBig);

  const formData = new FormData();
  formData.append('clientId', clientId);
  formData.append('pack', file);

  try {
    const res = await fetch(`/api/upload-pack?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: formData });
    if (!res.ok) alert(await readError(res));
  } catch (err) {
    alert(t('upload.networkFailed'));
  }
});

window.importWorkshopPack = async function() {
  if (!amHost()) return alert(t('onlyHost'));
  const input = document.getElementById('workshopUrlInput');
  const button = document.getElementById('workshopImportBtn');
  const status = document.getElementById('workshopImportStatus');
  const url = input.value.trim();
  if (!url) return input.focus();
  button.disabled = true;
  status.style.cssText = 'display:block;color:var(--accent-2);';
  status.textContent = t('workshopImport.loading');
  try {
    const res = await fetch('/api/import-workshop-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: currentRoom, clientId, url })
    });
    if (!res.ok) throw new Error(await readError(res));
    const result = await res.json();
    status.style.color = 'var(--success)';
    status.textContent = t(result.cached ? 'workshopImport.cached' : 'workshopImport.done');
    setTimeout(closeFilesModal, 900);
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = err instanceof TypeError ? t('upload.networkFailed') : t('error.generic', { message: err.message });
  } finally {
    button.disabled = false;
  }
};

// IMPORT AND MOD LIBRARY
// ==========================================
const libraryList = document.getElementById('filesLibraryList');
const customVideoInput = document.getElementById('customVideoInput');
const mkvCompatibilityWarning = document.getElementById('mkvCompatibilityWarning');

function updateMkvCompatibilityWarning() {
  const file = customVideoInput.files[0];
  mkvCompatibilityWarning.style.display = file && /\.mkv$/i.test(file.name) ? 'block' : 'none';
}

customVideoInput.addEventListener('change', updateMkvCompatibilityWarning);

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
        <div style="font-size:10px; color:#71717a;">${esc(t('mb', { value: item.sizeMb }))}</div>
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

// Themed file pickers: show the chosen file name in the interface language
function refreshFilePickers() {
  document.querySelectorAll('.file-pick').forEach(pick => {
    const input = pick.querySelector('input[type=file]');
    const file = input.files && input.files[0];
    const name = pick.querySelector('.file-pick-name'), filename = file?.name || input.dataset.chosenName || '';
    pick.classList.toggle('has-file', !!filename);
    name.textContent = filename || t('file.none');
    name.title = filename;
  });
}
// Capture the display name before import handlers clear the input to allow reselection.
document.addEventListener('change', event => { if (event.target.matches?.('.file-pick input[type=file]')) event.target.dataset.chosenName = event.target.files?.[0]?.name || ''; }, true);
document.addEventListener('change', event => { if (event.target.closest && event.target.closest('.file-pick')) refreshFilePickers(); });
window.addEventListener('dubline-language-changed', refreshFilePickers);
refreshFilePickers();

let customImportRequest = null;
let customImportStatus = null;
window.renderCustomImportStatus = () => {
  const status = document.getElementById('customUploadStatus');
  const state = customImportStatus;
  status.style.display = state ? 'block' : 'none';
  document.getElementById('customCancelBtn').style.display = state?.active && state.canCancel ? 'block' : 'none';
  document.getElementById('customUploadBtn').disabled = !!state?.active || !amHost();
  if (!state) return;
  const key = { upload: state.optimizing ? 'proxy.uploading' : 'uploading', compress: 'proxy.compressing', audio: 'proxy.audio', done: 'upload.done', cancel: 'proxy.cancelled', network: 'upload.networkFailed', error: 'error.generic' }[state.phase];
  status.textContent = t(key, { percent: state.percent, message: state.error }) +
    (state.completed && state.skipped ? ' ' + t('import.skippedTimings', { n: state.skipped }) : '');
  status.style.color = state.error || state.phase === 'cancel' ? 'var(--danger)' : state.completed ? state.skipped ? 'var(--warning)' : 'var(--success)' : 'var(--accent)';
};
window.addEventListener('dubline-language-changed', renderCustomImportStatus);
window.cancelCustomImport = () => customImportRequest?.abort.abort();
window.addEventListener('DOMContentLoaded',()=>socket.on('video_import_progress',event => {
  if(event.requestId!==customImportRequest?.id)return;
  Object.assign(customImportStatus, { phase: event.stage === 'audio' ? 'audio' : 'compress', percent: event.percent });
  renderCustomImportStatus();
}));
window.uploadCustomScene = async function() {
  if (!amHost()) return alert(t('onlyHost'));
  if (customImportRequest || recordState !== 'idle' || renderInProgress) return showToast(t('studio.mediaBusy'));
  const videoFile = customVideoInput.files[0];
  const subtitleFile = document.getElementById('customSubInput').files[0];
  const originalFile = document.getElementById('customOriginalInput').files[0];
  const intershumFile = document.getElementById('customIntershumInput').files[0];
  if (!videoFile) return alert(t('error.generic', { message: t('videoFile') }));
  const optimize=videoFile.size > 300 * 1024 * 1024;
  const tooBig = tunnelUploadError([videoFile, subtitleFile, originalFile, intershumFile]);
  if (tooBig) return alert(tooBig);

  const form = new FormData();
  form.append('clientId', clientId);
  const abort=new AbortController(),id=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);customImportRequest={abort,id};
  customImportStatus = { requestId: id, active: true, phase: 'upload', percent: 0, error: '', optimizing: optimize, canCancel: true, completed: false };
  form.append('requestId',id);
  form.append('title', document.getElementById('customSceneTitle').value.trim());
  form.append('video', videoFile);
  if (subtitleFile) form.append('subtitles', subtitleFile);
  if (originalFile) form.append('original', originalFile);
  if (intershumFile) form.append('intershum', intershumFile);
  renderCustomImportStatus();
  try {
    const res = await fetch(`/api/upload-custom?room=${encodeURIComponent(currentRoom)}${optimize?'&optimize=1':''}`, { method: 'POST', body: form, signal:abort.signal });
    if (!res.ok) throw new Error(await readError(res));
    const result = await res.json().catch(() => ({}));
    const skipped = Number(result.skippedTimings) || 0;
    Object.assign(customImportStatus, { phase: 'done', percent: 100, completed: true, skipped });
    // The next import starts with an empty form (old subtitles won't be attached to a new video)
    ['customVideoInput', 'customSubInput', 'customOriginalInput', 'customIntershumInput', 'customSceneTitle'].forEach(id => { document.getElementById(id).value = ''; });
    refreshFilePickers();
    updateMkvCompatibilityWarning();
    if (skipped) showToast(t('import.skippedTimings', { n: skipped }));
    // Final status remains reviewable; no timer may close a newly reopened Files UI.
  } catch (err) {
    // fetch throws a TypeError when the tunnel drops the connection mid-upload
    Object.assign(customImportStatus, { phase: err.name === 'AbortError' ? 'cancel' : err instanceof TypeError ? 'network' : 'error', error: err.name === 'AbortError' ? '' : err.message });
  } finally {
    customImportRequest=null;
    Object.assign(customImportStatus, { active: false, canCancel: false });
    renderCustomImportStatus();
  }
};

// ==========================================

// ==========================================
// VIDEO FROM THE PLAYER'S DISK (saves the host's bandwidth)
// ==========================================
const localMediaInput = document.getElementById('localMediaInput');
const localMediaStatus = document.getElementById('localMediaStatus');
const localMediaResetBtn = document.getElementById('localMediaResetBtn');

function revokeLocalMedia() {
  if (!localMedia) return;
  URL.revokeObjectURL(localMedia.videoUrl);
  if (localMedia.backingUrl) URL.revokeObjectURL(localMedia.backingUrl);
  for (const asset of Object.values(localMedia.assets || {})) URL.revokeObjectURL(asset.url);
  localMedia = null;
}

// The pack changed: the file picked from disk no longer matches
function forgetStaleLocalMedia() {
  if (localMedia && (!session || localMedia.forVideoUrl !== session.videoUrl)) revokeLocalMedia();
  updateLocalMediaStatus();
}

function updateLocalMediaStatus() {
  const active = !!(localMedia && session && localMedia.forVideoUrl === session.videoUrl);
  const activeKey = active && localMedia.source === 'p2p' ? 'localMedia.activeP2p' : 'localMedia.active';
  localMediaStatus.textContent = active ? t(activeKey, { size: formatSize(localMedia.size) }) : t('localMedia.inactive');
  localMediaStatus.style.color = active ? '#10b981' : '#71717a';
  localMediaResetBtn.style.display = active ? 'inline-flex' : 'none';
  // We have the whole file: tell the server we can share it with others
  announceHave();
}

// The video (and background) now play from browser memory: from the player's disk or received over P2P
function setLocalMedia({ video: videoBlob, backing: backingBlob, source, assets = {}, videoSourceUrl = session.videoUrl, backingSourceUrl = session.backingUrl }) {
  if (videoSourceUrl !== session.videoUrl) return;
  cancelMediaDownload();
  revokeLocalMedia();
  localMedia = {
    forVideoUrl: videoSourceUrl,
    backingSourceUrl,
    videoBlob,
    videoUrl: URL.createObjectURL(videoBlob),
    backingBlob,
    backingUrl: backingBlob ? URL.createObjectURL(backingBlob) : null,
    size: videoBlob.size,
    source
  };
  localMedia.assets = Object.fromEntries(Object.entries(assets).map(([url, blob]) => [url, { blob, url: URL.createObjectURL(blob) }]));
  swapVideoSource();
  updateLocalMediaStatus();
}

function baseName(url) {
  return decodeURIComponent(String(url || '').split('/').pop() || '').toLowerCase();
}

async function extractMediaFromZip(file) {
  const videoSourceUrl = session.videoUrl, backingSourceUrl = session.backingUrl;
  const zip = await (await DublineLazyScripts.jszip()).loadAsync(file);
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  const name = entry => entry.name.split('/').pop().toLowerCase();
  const wantedVideo = baseName(videoSourceUrl);
  const videoEntry = entries.find(entry => name(entry) === wantedVideo) || entries.find(entry => name(entry) === 'dub_video.mp4');
  if (!videoEntry) return null;
  const wantedBacking = baseName(backingSourceUrl);
  const backingEntry = wantedBacking ? entries.find(entry => name(entry) === wantedBacking) : null;
  return {
    videoSourceUrl, backingSourceUrl,
    video: new Blob([await videoEntry.async('arraybuffer')], { type: 'video/mp4' }),
    backing: backingEntry ? new Blob([await backingEntry.async('arraybuffer')], { type: 'audio/mpeg' }) : null
  };
}

// Switch the video source without losing the playback position
function swapVideoSource() {
  const time = video.currentTime;
  const wasPlaying = !video.paused;
  video.pause();
  video.src = mediaUrl(session.videoUrl);
  if (session.backingUrl) backing.src = mediaUrl(session.backingUrl);
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = time;
    if (wasPlaying) video.play().catch(() => {});
  }, { once: true });
}

localMediaInput.addEventListener('change', async () => {
  const file = localMediaInput.files[0];
  localMediaInput.value = '';
  if (!file || !session || !session.loaded) return;
  const sessionId = session.activeSessionId;

  localMediaStatus.textContent = t('localMedia.reading');
  localMediaStatus.style.color = '#a78bfa';
  try {
    const media = /\.zip$/i.test(file.name) ? await extractMediaFromZip(file) : { video: file, backing: null };
    if (session.activeSessionId !== sessionId) return updateLocalMediaStatus();
    if (!media) throw new Error(t('localMedia.notFound'));

    const expected = session.videoSize;
    if (expected && media.video.size !== expected
        && !await askConfirm(t('localMedia.mismatch', { local: formatSize(media.video.size), remote: formatSize(expected) }))) {
      updateLocalMediaStatus();
      return;
    }

    setLocalMedia({ ...media, source: 'disk' });
  } catch (err) {
    localMediaStatus.textContent = t('error.generic', { message: err.message });
    localMediaStatus.style.color = '#ef4444';
  }
});

window.resetLocalMedia = function() {
  revokeLocalMedia();
  if (session && session.loaded) swapVideoSource();
  updateLocalMediaStatus();
};

// ==========================================
// SESSIONS: several scenes in a room, each with its own takes
// ==========================================
const sessionsModal = document.getElementById('sessionsModal');
const sessionsList = document.getElementById('sessionsList');
const sessionBtnTitle = document.getElementById('sessionBtnTitle');
const sessionsNewBtn = document.getElementById('sessionsNewBtn');

function sessionItems() {
  return (session && session.sessionList) || [];
}

function formatSessionDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(i18n.getLanguage(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderSessions() {
  const items = sessionItems();
  const host = amHost();
  sessionBtnTitle.textContent = session && session.loaded ? session.title : t('sessions.none');
  document.getElementById('sessionBtn').title = sessionBtnTitle.textContent;
  sessionsNewBtn.style.display = host ? '' : 'none';

  if (!items.length) {
    sessionsList.innerHTML = `<div class="setting-sub">${t('sessions.empty')}</div>`;
    return;
  }

  sessionsList.innerHTML = (host ? '' : `<div class="setting-sub">${t('sessions.onlyHost')}</div>`) + items.map(item => {
    const pct = item.total ? Math.round((item.recorded / item.total) * 100) : 0;
    const kind = t(item.kind === 'pack' ? 'sessions.kind.pack' : 'sessions.kind.custom');
    const actions = host ? `
      <div class="session-actions">
        ${item.active ? '' : `<button class="btn-play" onclick="switchSession(${jsArg(item.id)})">${t('sessions.open')}</button>`}
        <button class="btn-icon" title="${esc(t('sessions.rename'))}" onclick="renameSession(${jsArg(item.id)})">✎</button>
        <button class="btn-icon" title="${esc(t('sessions.delete'))}" onclick="deleteSession(${jsArg(item.id)})">🗑</button>
      </div>` : '';
    return `
      <div class="session-item ${item.active ? 'active' : ''}">
        <div class="session-main">
          <div class="session-title">${esc(item.title || '—')}${item.active ? ` <span class="tag you">${t('sessions.active')}</span>` : ''}</div>
          <div class="session-meta">${kind} · ${t('sessions.progress', { recorded: item.recorded, total: item.total })} · ${t('sessions.updated', { date: formatSessionDate(item.updatedAt) })}</div>
          <div class="progress"><div style="width:${pct}%"></div></div>
        </div>
        ${actions}
      </div>`;
  }).join('');
}

window.openSessionsModal = function() {
  renderSessions();
  sessionsModal.style.display = 'flex';
};

window.closeSessionsModal = function() {
  sessionsModal.style.display = 'none';
};

window.switchSession = async function(id) {
  const recording = [...new Set(liveRecordings.values())].filter(nick => nick !== myName);
  if (recording.length && !await askConfirm(t('sessions.recordingConfirm', { names: recording.join(', ') }))) return;
  if (recordState !== 'idle') finishRecording({ discard: true });
  socket.emit('host_switch_session', { id });
  closeSessionsModal();
};

window.renameSession = async function(id) {
  const item = sessionItems().find(entry => entry.id === id);
  if (!item || !amHost()) return;
  const sessionId = session.activeSessionId;
  const next = await askText(t('sessions.renamePrompt'), item.title || '', 80);
  if (session.activeSessionId !== sessionId || !amHost() || !sessionItems().some(entry => entry.id === id)) return;
  if (next && next.trim() && next.trim() !== item.title) socket.emit('host_rename_session', { id, title: next.trim() });
};

window.deleteSession = async function(id) {
  const item = sessionItems().find(entry => entry.id === id);
  if (!item) return;
  if (!amHost()) return;
  const message = t('sessions.deleteConfirm', { title: item.title || '—', takes: item.recorded, retained: t(item.kind === 'pack' ? 'sessions.deleteRetained.pack' : 'sessions.deleteRetained.custom') });
  if (!await askConfirm(message, { danger: true, confirmKey: 'sessions.delete' })) return;
  if (!amHost() || !sessionItems().some(entry => entry.id === id)) return;
  socket.emit('host_delete_session', { id });
};

window.newSessionFromImport = function() {
  closeSessionsModal();
  openFilesModal();
};
