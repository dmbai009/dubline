(() => {
  const panel = document.querySelector('.timeline-panel');
  const filters = document.createElement('div'); filters.className = 'timeline-filters';
  const role = document.createElement('select'); role.id = 'timelineRoleFilter'; role.className = 'text-input';
  const status = document.createElement('select'); status.id = 'timelineStatusFilter'; status.className = 'text-input';
  for (const key of ['all', 'recorded', 'unrecorded', 'retake']) { const option = document.createElement('option'); option.value = key; option.textContent = t('find.' + key); status.append(option); }
  const findButton = document.createElement('button'); findButton.className = 'btn-outline'; findButton.textContent = t('find.open'); findButton.onclick = () => openTimelineSearch();
  filters.append(role, status, findButton); panel.querySelector('.timeline-toolbar').after(filters);
  const search = document.createElement('div'); search.id = 'timelineSearch'; search.className = 'timeline-search'; search.hidden = true;
  const input = document.createElement('input'); input.id = 'timelineSearchInput'; input.className = 'text-input'; input.type = 'search'; input.placeholder = t('find.placeholder'); input.setAttribute('aria-label', t('find.open'));
  const count = document.createElement('output'); count.id = 'timelineSearchCount';
  const prev = document.createElement('button'); prev.className = 'btn-icon'; prev.textContent = '↑'; prev.setAttribute('aria-label', t('find.previous'));
  const next = document.createElement('button'); next.className = 'btn-icon'; next.textContent = '↓'; next.setAttribute('aria-label', t('find.next'));
  const close = document.createElement('button'); close.className = 'btn-icon'; close.textContent = '×'; close.setAttribute('aria-label', t('find.close'));
  search.append(input, count, prev, next, close); filters.after(search);
  let results = [], selectedResult = -1, searchTimer = null;
  function visible(line) {
    return (!role.value || line.character === role.value) && (status.value === 'all' || status.value === 'recorded' && !!line.audioUrl || status.value === 'unrecorded' && !line.audioUrl || status.value === 'retake' && !!line.audioUrl && line.needsRetake === true);
  }
  function queryMatches(line, query) {
    if (/^#\d+$/.test(query)) return lineNumber(line) === Number(query.slice(1));
    return `${line.caption || ''}\n${line.character}`.toLowerCase().includes(query);
  }
  function updateSearch() {
    const query = input.value.trim().toLowerCase();
    results = [...(session?.lines || [])].filter(line => visible(line) && (!query || queryMatches(line, query))).sort((a, b) => a.start - b.start || a.id - b.id);
    selectedResult = Math.min(selectedResult, results.length - 1); count.textContent = t('find.matches', { n: results.length });
    prev.disabled = next.disabled = !results.length;
  }
  function refreshRoles() {
    const value = role.value;
    role.replaceChildren();
    const all = document.createElement('option'); all.value = ''; all.textContent = t('find.roles'); role.append(all);
    for (const name of sessionCharacters()) { const option = document.createElement('option'); option.value = name; option.textContent = name; role.append(option); }
    if (sessionCharacters().includes(value)) role.value = value;
  }
  function applyFilters() {
    for (const row of timeline.querySelectorAll('.track-row')) row.hidden = !!role.value && row.dataset.character !== role.value;
    for (const block of timeline.querySelectorAll('.line-block')) {
      const line = session?.lines.find(item => item.id === Number(block.id.replace('line-block-', '')));
      block.hidden = !line || !visible(line);
    }
    if (selectedLine && !visible(selectedLine)) { selectedLine = null; multiSelection.clear(); inspector.innerHTML = `<h3>${t('inspector.title')}</h3><p>${t('inspector.empty')}</p>`; publishSelection?.(); }
    updateSearch(); invalidateMinimap();
  }
  window.refreshTimelineNavigation = () => { refreshRoles(); applyFilters(); };
  window.openTimelineSearch = () => { search.hidden = false; updateSearch(); input.focus(); input.select(); };
  window.closeTimelineSearch = () => { if (search.hidden) return false; search.hidden = true; input.blur(); return true; };
  function revealMatch(direction) {
    updateSearch(); if (!results.length) return;
    selectedResult = (selectedResult + direction + results.length) % results.length;
    const line = results[selectedResult], block = document.getElementById(`line-block-${line.id}`);
    if (!block) return;
    clearMultiSelection(); selectLine(line); block.scrollIntoView({ block: 'nearest', inline: 'center' });
    block.classList.remove('search-flash'); requestAnimationFrame(() => { if (block.isConnected) block.classList.add('search-flash'); });
    setTimeout(() => block.classList.remove('search-flash'), 1200);
    count.textContent = `${selectedResult + 1} / ${results.length}`;
  }
  input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { selectedResult = -1; updateSearch(); }, 120); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); revealMatch(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeTimelineSearch(); } });
  prev.onclick = () => revealMatch(-1); next.onclick = () => revealMatch(1); close.onclick = closeTimelineSearch;
  role.addEventListener('change', applyFilters); status.addEventListener('change', applyFilters);
  window.addEventListener('dubline-language-changed', () => {
    for (const option of status.options) option.textContent = t('find.' + option.value);
    findButton.textContent = t('find.open'); input.placeholder = t('find.placeholder'); input.setAttribute('aria-label', t('find.open'));
    for (const [button, key] of [[prev, 'previous'], [next, 'next'], [close, 'close']]) button.setAttribute('aria-label', t('find.' + key));
    updateSearch();
  });
  const footer = document.createElement('div'); footer.className = 'timeline-footer';
  const nav = document.createElement('div'); nav.className = 'timeline-footer-controls';
  nav.append(panel.querySelector('.toolbar-hint'), panel.querySelector('.zoom-controls'));
  const map = document.createElement('canvas'); map.id = 'timelineMinimap'; map.height = 36; map.setAttribute('aria-label', t('find.minimap')); map.title = t('find.minimap');
  footer.append(map, nav); panel.append(footer);
  const density = document.createElement('canvas');
  let dirty = true, frame = null, signature = '', dragging = false;
  function invalidateMinimap() { dirty = true; scheduleMap(); }
  function scheduleMap() { if (frame === null) frame = requestAnimationFrame(drawMap); }
  function drawMap() {
    frame = null;
    const width = Math.max(1, Math.round(map.clientWidth)), height = 36, dpr = window.devicePixelRatio || 1;
    const seconds = timelineSeconds() + TIMELINE_TAIL;
    const nextSignature = JSON.stringify([width, dpr, seconds]);
    if (dirty || signature !== nextSignature) {
      const lines = (session?.lines || []).filter(visible);
      density.width = Math.round(width * dpr); density.height = Math.round(height * dpr);
      const ctx = density.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#272733'; ctx.fillRect(0, 0, width, height);
      for (const line of lines) {
        const x = line.start / seconds * width, w = Math.max(1, (line.end - line.start) / seconds * width);
        ctx.fillStyle = line.needsRetake ? '#f59e0b' : line.audioUrl ? '#22c55e' : '#8b5cf6'; ctx.globalAlpha = .65;
        ctx.fillRect(x, 5, w, height - 10);
      }
      ctx.globalAlpha = 1; signature = nextSignature; dirty = false;
    }
    map.width = density.width; map.height = density.height;
    const ctx = map.getContext('2d'); ctx.drawImage(density, 0, 0); ctx.scale(dpr, dpr);
    const left = timelineContainer.scrollLeft / pxPerSec / seconds * width;
    const viewport = Math.max(0, timelineContainer.clientWidth - labelWidth) / pxPerSec / seconds * width;
    ctx.fillStyle = '#ffffff18'; ctx.fillRect(left, 1, viewport, height - 2);
    ctx.strokeStyle = '#e4e4e7'; ctx.lineWidth = 1; ctx.strokeRect(left + .5, 1.5, Math.max(1, viewport - 1), height - 3);
    ctx.fillStyle = '#ef4444'; ctx.fillRect(video.currentTime / seconds * width, 0, 2, height);
  }
  map.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); map.setPointerCapture(event.pointerId); dragging = true;
    const box = map.getBoundingClientRect(), total = timelineSeconds() + TIMELINE_TAIL;
    const left = timelineContainer.scrollLeft / pxPerSec, span = Math.max(0, timelineContainer.clientWidth - labelWidth) / pxPerSec;
    const time = (event.clientX - box.left) / box.width * total;
    const within = time >= left && time <= left + span;
    const originScroll = timelineContainer.scrollLeft, originX = event.clientX;
    let pending = within ? originScroll : (time - span / 2) * pxPerSec, scrollFrame = null;
    const paint = () => { scrollFrame = null; timelineContainer.scrollLeft = pending; };
    paint();
    const move = nextEvent => { pending = within ? originScroll + (nextEvent.clientX - originX) / box.width * total * pxPerSec : ((nextEvent.clientX - box.left) / box.width * total - span / 2) * pxPerSec; if (scrollFrame === null) scrollFrame = requestAnimationFrame(paint); };
    const finish = () => { if (!dragging) return; dragging = false; if (scrollFrame !== null) cancelAnimationFrame(scrollFrame); paint(); map.removeEventListener('pointermove', move); map.removeEventListener('pointerup', finish); map.removeEventListener('pointercancel', finish); map.removeEventListener('lostpointercapture', finish); window.removeEventListener('blur', finish); };
    map.addEventListener('pointermove', move); map.addEventListener('pointerup', finish); map.addEventListener('pointercancel', finish); map.addEventListener('lostpointercapture', finish); window.addEventListener('blur', finish);
  });
  timelineContainer.addEventListener('scroll', scheduleMap, { passive: true }); video.addEventListener('timeupdate', scheduleMap);
  new ResizeObserver(invalidateMinimap).observe(footer);
  for (const event of ['session_updated', 'line_updated', 'takes_updated', 'editor_lines_updated']) socket.on(event, () => { refreshRoles(); applyFilters(); });
  window.addEventListener('dubline-language-changed', refreshTimelineNavigation);
  refreshTimelineNavigation();
})();
