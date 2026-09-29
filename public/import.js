// ==========================================
// IMPORT
// Загрузка паков, библиотека модов, импорт своих сцен
// ==========================================
// Загрузка нового пака
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
  const tooBig = tunnelUploadError([videoFile, subtitleFile]);
  if (tooBig) return alert(tooBig);

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
    // Следующий импорт начинается с пустой формы (старые субтитры не подхватятся к новому видео)
    ['customVideoInput', 'customSubInput', 'customSceneTitle'].forEach(id => { document.getElementById(id).value = ''; });
    status.style.color = '#10b981';
    setTimeout(closeFilesModal, 700);
  } catch (err) {
    // fetch падает с TypeError, когда туннель рвет соединение посреди загрузки
    status.textContent = err instanceof TypeError ? t('upload.networkFailed') : t('error.generic', { message: err.message });
    status.style.color = '#ef4444';
  } finally {
    button.disabled = false;
  }
};

// ==========================================

// ==========================================
// ВИДЕО С ДИСКА ИГРОКА (экономит интернет хоста)
// ==========================================
const localMediaInput = document.getElementById('localMediaInput');
const localMediaStatus = document.getElementById('localMediaStatus');
const localMediaResetBtn = document.getElementById('localMediaResetBtn');

function revokeLocalMedia() {
  if (!localMedia) return;
  URL.revokeObjectURL(localMedia.videoUrl);
  if (localMedia.backingUrl) URL.revokeObjectURL(localMedia.backingUrl);
  localMedia = null;
}

// Пак сменился — выбранный с диска файл больше не подходит
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
  // Есть файл целиком — сообщаем серверу, что можем раздавать его другим
  announceHave();
}

// Видео (и интершум) теперь играют из памяти браузера: с диска игрока или полученные по P2P
function setLocalMedia({ video: videoBlob, backing: backingBlob, source }) {
  cancelMediaDownload();
  revokeLocalMedia();
  localMedia = {
    forVideoUrl: session.videoUrl,
    videoBlob,
    videoUrl: URL.createObjectURL(videoBlob),
    backingBlob,
    backingUrl: backingBlob ? URL.createObjectURL(backingBlob) : null,
    size: videoBlob.size,
    source
  };
  swapVideoSource();
  updateLocalMediaStatus();
}

function baseName(url) {
  return decodeURIComponent(String(url || '').split('/').pop() || '').toLowerCase();
}

async function extractMediaFromZip(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  const name = entry => entry.name.split('/').pop().toLowerCase();
  const wantedVideo = baseName(session.videoUrl);
  const videoEntry = entries.find(entry => name(entry) === wantedVideo) || entries.find(entry => name(entry) === 'dub_video.mp4');
  if (!videoEntry) return null;
  const wantedBacking = baseName(session.backingUrl);
  const backingEntry = wantedBacking ? entries.find(entry => name(entry) === wantedBacking) : null;
  return {
    video: new Blob([await videoEntry.async('arraybuffer')], { type: 'video/mp4' }),
    backing: backingEntry ? new Blob([await backingEntry.async('arraybuffer')], { type: 'audio/mpeg' }) : null
  };
}

// Меняем источник видео, не сбивая позицию просмотра
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

  localMediaStatus.textContent = t('localMedia.reading');
  localMediaStatus.style.color = '#a78bfa';
  try {
    const media = /\.zip$/i.test(file.name) ? await extractMediaFromZip(file) : { video: file, backing: null };
    if (!media) throw new Error(t('localMedia.notFound'));

    const expected = session.videoSize;
    if (expected && media.video.size !== expected
        && !confirm(t('localMedia.mismatch', { local: formatSize(media.video.size), remote: formatSize(expected) }))) {
      updateLocalMediaStatus();
      return;
    }

    setLocalMedia({ video: media.video, backing: media.backing, source: 'disk' });
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
// СЕССИИ: несколько сцен в комнате, каждая со своими дублями
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

window.switchSession = function(id) {
  const recording = [...new Set(liveRecordings.values())].filter(nick => nick !== myName);
  if (recording.length && !confirm(t('sessions.recordingConfirm', { names: recording.join(', ') }))) return;
  if (recordState !== 'idle') finishRecording({ discard: true });
  socket.emit('host_switch_session', { id });
  closeSessionsModal();
};

window.renameSession = function(id) {
  const item = sessionItems().find(entry => entry.id === id);
  if (!item) return;
  const next = prompt(t('sessions.renamePrompt'), item.title || '');
  if (next && next.trim() && next.trim() !== item.title) socket.emit('host_rename_session', { id, title: next.trim() });
};

window.deleteSession = function(id) {
  const item = sessionItems().find(entry => entry.id === id);
  if (!item) return;
  if (!confirm(t('sessions.deleteConfirm', { title: item.title || '—', takes: item.recorded }))) return;
  socket.emit('host_delete_session', { id });
};

window.newSessionFromImport = function() {
  closeSessionsModal();
  openFilesModal();
};
