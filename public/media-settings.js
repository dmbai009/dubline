(() => {
  const card = document.createElement('div'); card.className = 'setting-card'; card.id = 'mediaCacheSettings';
  card.innerHTML = `<div class="setting-label">${esc(t('cache.title'))}</div>
    <label class="clip-mix-row"><span>${esc(t('cache.limit'))}</span><input id="mediaCacheLimit" type="number" min="0.25" max="20" step="0.25" class="text-input"><span>GB</span></label>
    <p id="mediaCacheUsage" class="setting-sub"></p><button id="clearMediaCache" class="btn-outline">${esc(t('cache.clear'))}</button>
    <label class="clip-mix-row"><span>${esc(t('cache.uploadLimit'))}</span><select id="mediaUploadLimit" class="text-input"></select></label>`;
  document.getElementById('tabContentPlayer').append(card);
  const limit = card.querySelector('#mediaCacheLimit'), upload = card.querySelector('#mediaUploadLimit'), clear = card.querySelector('#clearMediaCache');
  limit.value = localStorage.getItem('dubline_cache_gb') || '2';
  for (const n of [0, 2, 5, 10, 20]) { const option = document.createElement('option'); option.value = String(n); option.textContent = n ? `${n} MB/s` : t('cache.unlimited'); upload.append(option); }
  upload.value = localStorage.getItem('dubline_upload_limit') || '0';
  window.mediaUploadLimiter = new DublineTransferUtils.UploadLimiter();
  if (![0, 2, 5, 10, 20].includes(Number(upload.value))) upload.value = '0';
  mediaUploadLimiter.setLimit(Number(upload.value));
  upload.addEventListener('change', () => { mediaUploadLimiter.setLimit(Number(upload.value)); localStorage.setItem('dubline_upload_limit', upload.value); });
  limit.addEventListener('change', () => { const value = Math.max(.25, Math.min(20, Number(limit.value) || 2)); limit.value = String(value); localStorage.setItem('dubline_cache_gb', limit.value); DublineMediaCache.prune().then(refresh); });
  async function refresh() { card.querySelector('#mediaCacheUsage').textContent = t('cache.usage', { size: formatSize(await DublineMediaCache.usage()) || '0' }); }
  clear.addEventListener('click', async () => { clear.disabled = true; try { await DublineMediaCache.clear(); await refresh(); } finally { clear.disabled = false; } });
  setInterval(() => { if (settingsModal.style.display === 'flex') refresh(); }, 5000); refresh();
})();
