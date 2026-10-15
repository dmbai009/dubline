(() => {
  const model = window.DublineTakeHistoryModel, busy = new Set();
  let view = null, expanded = false, playing = null, generation = 0;
  const key = line => `${currentRoom}:${session?.activeSessionId}:${line.id}`;
  const allowed = (line, take) => canModerate() || !!myName && (getLineOwner(line) === myName || !getLineOwner(line) && take?.recordedBy === myName);
  const pending = line => busy.has(key(line)) || [...editorQueue, ...editorConflicts].some(op => op.event === 'take_history_update' && op.sessionId === session?.activeSessionId && op.payload.lineId === line.id);
  const blocked = () => recordState !== 'idle' || renderInProgress || window.snapshotFrozen;
  const icons = { pin: '<path d="m8 3 8 0-1 5 3 4H6l3-4-1-5ZM12 12v9"/>', restore: '<path d="M5 10a7 7 0 1 1 0 6M5 4v6h6"/>', delete: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>', play: '<path d="m7 4 13 8-13 8Z"/>', stop: '<path d="M6 6h12v12H6Z"/>' };
  function button(action, take, enabled, label, active = false) {
    const title = t(label) + (action === 'pin' && take.pinned ? ' · ' + t('takeHistory.pinned') : '');
    return `<button type="button" class="btn-outline take-history-icon${active ? ' active' : ''}" data-history-action="${action}" data-history-take="${esc(take.id)}" title="${esc(title)}" aria-label="${esc(t(label))}"${action === 'pin' ? ` aria-pressed="${take.pinned}"` : ''}${enabled ? '' : ' disabled'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${icons[action === 'play' && active ? 'stop' : action]}</svg></button>`;
  }
  function mainHtml(line) {
    const take = model.extract(line); if (!take) return '';
    const edit = allowed(line, take) && !blocked() && !pending(line);
    return button('pin', take, edit, take.pinned ? 'takeHistory.unpin' : 'takeHistory.pin', take.pinned) +
      (getLineOwner(line) !== myName && allowed(line, take) ? button('delete', take, edit, 'takeHistory.delete') : '');
  }
  function html(line) {
    if (line.takeHistory != null && !Array.isArray(line.takeHistory)) return `<p class="take-hint">${esc(t('takeHistory.invalid'))}</p>`;
    const history = line.takeHistory || [], issues = window.takeHistoryPending?.(line.id) || [];
    if (!history.length && !issues.length) return '';
    const rows = history.map((take, index) => {
      const edit = allowed(line, take) && !blocked() && !pending(line), active = playing?.id === take.id;
      const duration = Number.isFinite(take.duration) ? ` · ${take.duration.toFixed(1)} ${t('takeHistory.seconds')}` : '';
      const label = t('takeHistory.variant', { n: history.length - index }) + duration;
      return `<div class="take-history-row" data-history-row="${esc(take.id)}">${button('play', take, !blocked() && video.paused && !watchMode && canHearLine({ ...line, ...take }), active ? 'takeHistory.stop' : 'takeHistory.listen', active)}<span class="take-history-label" title="${esc(label + (take.recordedBy ? ' · ' + take.recordedBy : ''))}">${esc(label)}${take.recordedBy ? `<small>${esc(take.recordedBy)}</small>` : ''}</span>${button('pin', take, edit, take.pinned ? 'takeHistory.unpin' : 'takeHistory.pin', take.pinned)}${button('restore', take, edit, 'takeHistory.restore')}${button('delete', take, edit, 'takeHistory.delete')}</div>`;
    }).join('');
    const conflicts = issues.map(entry => `<div class="take-history-conflict"><span>${esc(t(entry.historyIssue))}</span><button type="button" class="btn-outline" data-history-retry="${esc(entry.uploadId)}" ${blocked() || !socket.connected ? 'disabled' : ''}>${esc(t('takeHistory.retry'))}</button><button type="button" class="btn-outline" data-history-discard="${esc(entry.uploadId)}">${esc(t('takeHistory.discardLocal'))}</button></div>`).join('');
    return `<details class="take-history" ${expanded ? 'open' : ''}><summary>${esc(t('takeHistory.title'))}<span>${history.length}/3${history.some(take => take.pinned) ? ' · 📌' : ''}</span></summary>${[model.extract(line), ...history].filter(take => take && canHearLine({ ...line, ...take })).length >= 2 ? `<button type="button" class="btn-outline" data-history-compare="true">${esc(t('compare.title'))}</button>` : ''}${rows}${conflicts}</details>`;
  }
  function stop() { generation++; if (playing) { playing = null; audio.stopPreview(); refresh(); } }
  function refresh() { if (selectedLine && recordState === 'idle' && multiSelection.size < 2) showInspector(selectedLine); }
  function capture(line) {
    const next = key(line);
    if (view !== next) { view = next; expanded = false; stop(); }
    else expanded = inspector.querySelector('.take-history')?.open ?? expanded;
    if (playing && !(Array.isArray(line.takeHistory) ? line.takeHistory : []).some(take => take.id === playing.id && take.audioUrl === playing.audioUrl)) stop();
    const focus = document.activeElement;
    return focus?.matches('[data-history-action]') ? { action: focus.dataset.historyAction, id: focus.dataset.historyTake } : null;
  }
  function restoreFocus(saved) { if (saved) [...inspector.querySelectorAll('[data-history-action]')].find(btn => btn.dataset.historyAction === saved.action && btn.dataset.historyTake === saved.id)?.focus({ preventScroll: true }); }
  async function play(line, take) {
    if (blocked() || !video.paused || watchMode || !canHearLine({ ...line, ...take })) return;
    if (playing?.id === take.id) return stop();
    stop(); const token = ++generation;
    playing = { id: take.id, audioUrl: take.audioUrl }; refresh();
    let started = false;
    try { started = await audio.previewTake({ ...line, ...take, id: line.id }, { historical: true, onEnded: () => { if (generation === token) { playing = null; refresh(); } } }); }
    catch { if (generation === token) audio.stopPreview(); }
    if (!started && generation === token) { playing = null; refresh(); showToast(t('takeHistory.missing')); }
  }
  async function change(line, take, action) {
    if (!allowed(line, take) || blocked() || pending(line)) return;
    const focused = document.activeElement?.dataset.historyTake === take.id;
    const scene = session.activeSessionId, room = currentRoom, target = { room, lineId: line.id, takeId: take.id, historyRevision: line.takeHistoryRevision || 0, expectedOwner: getLineOwner(line), action };
    if (action === 'pin') target.value = !take.pinned;
    if (action === 'delete') {
      if (!await askConfirm(t(take.pinned ? 'takeHistory.confirmPinned' : 'takeHistory.confirmDelete'), { danger: true })) return;
      target.confirmPinned = take.pinned === true;
    }
    if (scene !== session?.activeSessionId || room !== currentRoom || blocked()) return;
    busy.add(key(line)); refresh();
    try {
      const result = await queueEditorRequest(() => ['take_history_update', target]);
      if (!editorResult(result)) return;
      if (result.cleanupError) showToast(t('takeHistory.cleanupError'));
      if (action === 'restore') showToast(t('takeHistory.restored'));
    } finally {
      busy.delete(`${room}:${scene}:${line.id}`); refresh();
      if (focused && view === `${room}:${scene}:${line.id}` && document.activeElement === document.body) {
        const button = [...inspector.querySelectorAll('[data-history-action]')].find(btn => btn.dataset.historyTake === take.id && btn.dataset.historyAction === action && !btn.disabled);
        (button || inspector.querySelector('.take-history summary'))?.focus({ preventScroll: true });
      }
    }
  }
  function beforeRecord(line) {
    if (line.takeHistory != null && !Array.isArray(line.takeHistory)) { showToast(t('takeHistory.invalid')); return null; }
    const scene = session.activeSessionId, room = currentRoom, owner = getLineOwner(line), plan = model.replacement(line);
    if (plan.kind === 'blocked') { showToast(t('takeHistory.full')); return null; }
    if (plan.kind !== 'confirm') return {};
    const binding = { discardCurrentId: line.takeId, historyRevision: line.takeHistoryRevision || 0 };
    return (async () => {
      if (!await askConfirm(t('takeHistory.confirmOverwrite'), { danger: true })) return null;
      const actual = session?.lines.find(item => item.id === line.id);
      if (room !== currentRoom || scene !== session?.activeSessionId || !actual || getLineOwner(actual) !== owner || actual.takeId !== binding.discardCurrentId || (actual.takeHistoryRevision || 0) !== binding.historyRevision) { showToast(t('takeHistory.changed')); return null; }
      return binding;
    })();
  }
  inspector.addEventListener('click', event => {
    const btn = event.target.closest('button'); if (!btn || btn.disabled || !selectedLine) return;
    if (btn.dataset.historyRetry) return void window.retryHistoryTake?.(btn.dataset.historyRetry);
    if (btn.dataset.historyDiscard) return void window.discardHistoryTake?.(btn.dataset.historyDiscard);
    if (btn.dataset.historyCompare) return window.DublineTakeCompare?.open(selectedLine.id);
    if (!btn.dataset.historyAction) return;
    const line = selectedLine, take = [model.extract(line), ...(Array.isArray(line.takeHistory) ? line.takeHistory : [])].find(take => take?.id === btn.dataset.historyTake);
    if (!take) return;
    if (btn.dataset.historyAction === 'play') void play(line, take);
    else void change(line, take, btn.dataset.historyAction);
  });
  video.addEventListener('play', stop);
  socket.on('session_updated', () => { if (view && (!selectedLine || view !== key(selectedLine))) stop(); });
  socket.on('disconnect', stop);
  socket.on('take_history_warning', message => { if (message.sessionId === session?.activeSessionId) showToast(t('takeHistory.cleanupError')); });
  window.DublineTakeHistory = Object.freeze({ capture, restoreFocus, mainHtml, html, stop, beforeRecord, choose: (line, take) => change(line, take, 'restore') });
})();
