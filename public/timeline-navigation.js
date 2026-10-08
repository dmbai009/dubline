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
  let results = [], selectedResult = -1, searchTimer = null, resultSignature = '';
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
    const signature = JSON.stringify([session?.activeSessionId, query, role.value, status.value, results.map(line => line.id)]);
    if (signature !== resultSignature) selectedResult = -1;
    resultSignature = signature;
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
    const byId = new Map((session?.lines || []).map(line => [line.id, line]));
    for (const row of timeline.querySelectorAll('.track-row')) row.hidden = !!role.value && row.dataset.character !== role.value;
    for (const block of timeline.querySelectorAll('.line-block')) {
      const line = byId.get(Number(block.id.replace('line-block-', '')));
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
    selectedResult = selectedResult < 0 ? (direction < 0 ? results.length - 1 : 0) : (selectedResult + direction + results.length) % results.length;
    const line = results[selectedResult], block = document.getElementById(`line-block-${line.id}`);
    if (!block) return;
    clearMultiSelection(); selectLine(line); block.scrollIntoView({ block: 'nearest', inline: 'center' });
    block.classList.remove('search-flash'); requestAnimationFrame(() => { if (block.isConnected) block.classList.add('search-flash'); });
    setTimeout(() => block.classList.remove('search-flash'), 1200);
    count.textContent = `${selectedResult + 1} / ${results.length}`;
  }
  input.addEventListener('input', () => { selectedResult = -1; clearTimeout(searchTimer); searchTimer = setTimeout(updateSearch, 120); });
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
  let dirty = true, frame = null, signature = '', gesture = null, palette = null;
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
      const style = getComputedStyle(map);
      const color = name => style.getPropertyValue('--' + name).trim();
      palette = { background: color('panel-2'), line: color('accent'), recorded: color('success'), retake: color('warning'), viewport: color('accent-soft'), border: color('text'), playhead: color('danger') };
      const ctx = density.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = palette.background; ctx.fillRect(0, 0, width, height);
      for (const line of lines) {
        const x = line.start / seconds * width, w = Math.max(1, (line.end - line.start) / seconds * width);
        ctx.fillStyle = line.needsRetake ? palette.retake : line.audioUrl ? palette.recorded : palette.line; ctx.globalAlpha = .65;
        ctx.fillRect(x, 5, w, height - 10);
      }
      ctx.globalAlpha = 1; signature = nextSignature; dirty = false;
    }
    map.width = density.width; map.height = density.height;
    const ctx = map.getContext('2d'); ctx.drawImage(density, 0, 0); ctx.scale(dpr, dpr);
    const viewport = viewportBounds();
    const left = viewport.left / seconds * width, span = (viewport.right - viewport.left) / seconds * width;
    ctx.fillStyle = palette.viewport; ctx.fillRect(left, 1, span, height - 2);
    ctx.strokeStyle = palette.border; ctx.lineWidth = 1; ctx.strokeRect(left + .5, 1.5, Math.max(1, span - 1), height - 3);
    ctx.fillStyle = palette.playhead; ctx.fillRect(video.currentTime / seconds * width, 0, 2, height);
  }
  function viewportBounds() {
    const total = timelineSeconds() + TIMELINE_TAIL;
    const left = Math.min(total, timelineContainer.scrollLeft / pxPerSec);
    const available = Math.max(0, timelineContainer.clientWidth - labelWidth);
    return { total, left, right: Math.min(total, left + available / pxPerSec), available };
  }
  function edgeAt(event, bounds, box) {
    const x = event.clientX - box.left;
    const left = bounds.left / bounds.total * box.width, right = bounds.right / bounds.total * box.width;
    const a = Math.abs(x - left), b = Math.abs(x - right);
    return Math.min(a, b) <= 7 ? (a <= b ? 'left' : 'right') : null;
  }
  map.addEventListener('pointermove', event => {
    if (!gesture) map.style.cursor = edgeAt(event, viewportBounds(), map.getBoundingClientRect()) ? 'ew-resize' : 'grab';
  });
  map.addEventListener('pointerleave', () => { if (!gesture) map.style.cursor = ''; });
  map.addEventListener('pointerdown', event => {
    if (event.button !== 0 || gesture || !session?.loaded) return;
    const bounds = viewportBounds(), box = map.getBoundingClientRect();
    if (!bounds.available || !box.width) return;
    event.preventDefault(); map.setPointerCapture(event.pointerId);
    const { total, left, right, available } = bounds, span = right - left;
    const edge = edgeAt(event, bounds, box), sessionId = session.activeSessionId;
    const time = (event.clientX - box.left) / box.width * total;
    const within = time >= left && time <= left + span;
    const originScroll = timelineContainer.scrollLeft, originX = event.clientX, originScale = pxPerSec;
    let pending = event.clientX, scrollFrame = null, lastZoomFrame = null;
    const paint = () => {
      scrollFrame = null;
      if (session?.activeSessionId !== sessionId) return;
      if (edge) {
        const nextTime = Math.max(0, Math.min(total, (edge === 'left' ? left : right) + (pending - originX) / box.width * total));
        const nextSpan = edge === 'left' ? right - nextTime : nextTime - left;
        // The opposite edge is an explicit time anchor, including rapid events
        // arriving before the previous zoom render has run.
        setTimelineZoom(available / Math.max(available / ZOOM_MAX, nextSpan), edge === 'left' ? timelineContainer.clientWidth : labelWidth, edge === 'left' ? right : left);
        lastZoomFrame = zoomFrame;
      } else {
        timelineContainer.scrollLeft = within ? originScroll + (pending - originX) / box.width * total * originScale : ((pending - box.left) / box.width * total - span / 2) * originScale;
      }
      scheduleMap();
    };
    const move = nextEvent => {
      if (nextEvent.pointerId !== event.pointerId) return;
      pending = nextEvent.clientX; if (scrollFrame === null) scrollFrame = requestAnimationFrame(paint);
    };
    const finish = endEvent => {
      if (gesture?.finish !== finish) return;
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
      if (endEvent.type === 'pointerup') { pending = endEvent.clientX; paint(); }
      if (endEvent.type === 'scene' && lastZoomFrame !== null && zoomFrame === lastZoomFrame) cancelAnimationFrame(zoomFrame);
      map.removeEventListener('pointermove', move); map.removeEventListener('pointerup', finish); map.removeEventListener('pointercancel', finish); map.removeEventListener('lostpointercapture', finish); window.removeEventListener('blur', finish);
      gesture = null;
      if (map.hasPointerCapture(event.pointerId)) map.releasePointerCapture(event.pointerId);
      map.style.cursor = ''; scheduleMap();
    };
    gesture = { finish, sessionId }; map.style.cursor = edge ? 'ew-resize' : 'grabbing';
    if (!edge) paint();
    map.addEventListener('pointermove', move); map.addEventListener('pointerup', finish); map.addEventListener('pointercancel', finish); map.addEventListener('lostpointercapture', finish); window.addEventListener('blur', finish);
  });
  timelineContainer.addEventListener('scroll', scheduleMap, { passive: true }); video.addEventListener('timeupdate', scheduleMap);
  new ResizeObserver(invalidateMinimap).observe(footer);
  for (const event of ['session_updated', 'line_updated', 'takes_updated', 'editor_lines_updated']) socket.on(event, () => {
    if (gesture && gesture.sessionId !== session?.activeSessionId) gesture.finish({ type: 'scene' });
    refreshRoles(); applyFilters();
  });
  new MutationObserver(invalidateMinimap).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  window.addEventListener('dubline-language-changed', () => { map.title = t('find.minimap'); map.setAttribute('aria-label', map.title); });
  window.addEventListener('dubline-language-changed', refreshTimelineNavigation);
  refreshTimelineNavigation();
})();
