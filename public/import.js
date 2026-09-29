// ==========================================
// IMPORT
// Загрузка паков, библиотека модов, импорт своих сцен
// ==========================================
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
  localMediaStatus.textContent = active ? t('localMedia.active', { size: formatSize(localMedia.size) }) : t('localMedia.inactive');
  localMediaStatus.style.color = active ? '#10b981' : '#71717a';
  localMediaResetBtn.style.display = active ? 'inline-flex' : 'none';
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

    revokeLocalMedia();
    localMedia = {
      forVideoUrl: session.videoUrl,
      videoBlob: media.video,
      videoUrl: URL.createObjectURL(media.video),
      backingBlob: media.backing,
      backingUrl: media.backing ? URL.createObjectURL(media.backing) : null,
      size: media.video.size
    };
    swapVideoSource();
    updateLocalMediaStatus();
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
