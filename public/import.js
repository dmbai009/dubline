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
