(() => {
  const drafts = new Map(), busy = new Set(); let viewKey = null, seen = new Map(), storageWarned = false;
  const counter = document.createElement('button'); counter.id = 'myRetakeCount'; counter.className = 'btn-outline'; counter.hidden = true;
  document.querySelector('.timeline-filters').append(counter);
  const key = () => `${encodeURIComponent(currentRoom)}:${session?.activeSessionId || ''}:${clientId}`;
  const draftKey = id => `dubline_retake_draft_v1:${key()}:${id}`;
  function remember(id, draft, storeKey = draftKey(id)) {
    drafts.set(storeKey, draft);
    try { draft ? localStorage.setItem(storeKey, JSON.stringify(draft)) : localStorage.removeItem(storeKey); }
    catch { if (!storageWarned) { storageWarned = true; showToast(t('editor.failure.storage')); } }
  }
  function draftFor(line) {
    const id = draftKey(line.id);
    if (!drafts.has(id)) {
      try { const saved = JSON.parse(localStorage.getItem(id)); drafts.set(id, saved && typeof saved.comment === 'string' && saved.comment.length <= 1000 && typeof saved.audioUrl === 'string' && Number.isSafeInteger(saved.revision) ? saved : null); }
      catch { drafts.set(id, null); }
    }
    return drafts.get(id);
  }
  const allowed = () => canModerate();
  function controlHtml(line) {
    const draft = allowed(line) ? draftFor(line) : null;
    if (!line.audioUrl) return draft ? `<div class="retake-controls"><p class="take-hint">${esc(t('retake.audioChanged'))}</p><label>${esc(t('retake.comment'))}<textarea data-retake-comment="${line.id}" readonly rows="2" class="text-input">${esc(draft.comment)}</textarea></label><button type="button" class="btn-outline" data-retake-discard="${line.id}">${esc(t('retake.discardDraft'))}</button></div>` : '';
    const stale = draft && draft.audioUrl !== line.audioUrl, disabled = !allowed(line) || !!stale;
    const waiting = busy.has(draftKey(line.id)) || [...editorQueue, ...editorConflicts].some(operation => operation.event === 'set_needs_retake' && operation.sessionId === session.activeSessionId && operation.payload.lineId === line.id && !operation.outcome?.confirmed);
    const binding = `data-retake-line="${line.id}" data-retake-session="${esc(session.activeSessionId)}" data-retake-url="${esc(draft?.audioUrl || line.audioUrl)}" data-retake-revision="${draft?.revision ?? line.retakeRevision ?? 0}"`;
    return `<form class="retake-controls" data-retake-form="${line.id}">
      <div class="retake-switch-row"><label class="switch-ui"><input type="checkbox" aria-label="${esc(t('retake.label'))}" ${binding} ${line.needsRetake ? 'checked' : ''} ${disabled || waiting ? 'disabled' : ''}><span class="switch-slider"></span></label><span>${esc(t('retake.label'))}</span></div>
      <label>${esc(t('retake.comment'))}<textarea data-retake-comment="${line.id}" maxlength="1000" rows="2" class="text-input" ${disabled ? 'readonly' : ''}>${esc(draft?.comment ?? line.retakeComment ?? '')}</textarea></label>
      ${stale ? `<p class="take-hint">${esc(t('retake.audioChanged'))}</p><button type="button" class="btn-outline" data-retake-discard="${line.id}">${esc(t('retake.discardDraft'))}</button>` : `<button type="submit" class="btn-outline" ${disabled || waiting ? 'disabled' : ''}>${esc(t('retake.save'))}</button>`}
    </form>`;
  }
  async function change(input, value = input.checked) {
    const id = Number(input.dataset.retakeLine), line = session?.lines.find(line => line.id === id);
    if (busy.has(draftKey(id))) return;
    if (!line || !allowed(line) || input.dataset.retakeSession !== session.activeSessionId) return;
    const form = input.closest('form'), comment = value ? form.querySelector('textarea').value : '';
    const audioUrl = input.dataset.retakeUrl;
    let revision = Number(input.dataset.retakeRevision);
    if (audioUrl !== line.audioUrl) return showToast(t('retake.audioChanged'));
    if (revision !== (line.retakeRevision || 0)) {
      if (!await askConfirm(t('retake.changed'))) return;
      if (session.activeSessionId !== input.dataset.retakeSession || line.audioUrl !== audioUrl) return;
      revision = line.retakeRevision || 0;
    }
    remember(id, { audioUrl, revision, comment }); input.disabled = true;
    const operationKey = draftKey(id); busy.add(operationKey);
    let result;
    try { result = await queueEditorRequest(() => ['set_needs_retake', { lineId: id, audioUrl, retakeRevision: revision, value, comment }]); }
    finally { busy.delete(operationKey); }
    if (result?.ok) {
      const draft = drafts.get(operationKey);
      if (draft?.comment === comment) remember(id, null, operationKey);
      else if (draft?.audioUrl === audioUrl) remember(id, { ...draft, revision: result.line.retakeRevision }, operationKey);
    } else editorResult(result);
    if (selectedLine?.id === id && session.activeSessionId === input.dataset.retakeSession) showInspector(selectedLine);
  }
  document.addEventListener('input', event => {
    const area = event.target.closest('[data-retake-comment]'); if (!area || area.readOnly) return;
    const input = area.closest('form').querySelector('[data-retake-line]');
    remember(Number(area.dataset.retakeComment), { audioUrl: input.dataset.retakeUrl, revision: Number(input.dataset.retakeRevision), comment: area.value });
  });
  document.addEventListener('submit', event => {
    const form = event.target.closest('[data-retake-form]'); if (!form) return;
    event.preventDefault(); const input = form.querySelector('[data-retake-line]');
    change(input, input.checked || !!form.querySelector('textarea').value);
  });
  document.addEventListener('click', event => {
    const discard = event.target.closest('[data-retake-discard]'); if (!discard) return;
    remember(Number(discard.dataset.retakeDiscard), null); if (selectedLine) showInspector(selectedLine);
  });
  const owned = () => (session?.lines || []).filter(line => line.audioUrl && line.needsRetake && getLineOwner(line) === myName);
  function focusLine(id) {
    const line = session?.lines.find(line => line.id === id); if (!line || getLineOwner(line) !== myName) return;
    showMyRetakes(); clearMultiSelection(); selectLine(line); document.getElementById(`line-block-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  counter.onclick = () => { const first = owned()[0]; if (first) focusLine(first.id); };
  function persistSeen() { try { localStorage.setItem(`dubline_retakes_seen_v1:${key()}`, JSON.stringify([...seen])); } catch { /* The persistent counter is authoritative even if a toast repeats after reload. */ } }
  function refresh() {
    if (!window.hasSceneMediaAccess?.()) { counter.hidden = true; return; }
    const active = owned(); counter.hidden = !active.length; counter.textContent = t('retake.counter', { n: active.length }); counter.title = t('retake.summary', { n: active.length });
    if (viewKey === key()) return;
    viewKey = key();
    try { const saved = JSON.parse(localStorage.getItem(`dubline_retakes_seen_v1:${key()}`)); seen = new Map((Array.isArray(saved) ? saved : []).filter(entry => Array.isArray(entry) && Number.isSafeInteger(entry[0]) && Number.isSafeInteger(entry[1]))); } catch { seen = new Map(); }
    const unread = active.filter(line => seen.get(line.id) !== (line.retakeRevision || 0));
    const sceneId = session.activeSessionId;
    if (unread.length) showToast(t('retake.summary', { n: unread.length }), { label: t('retake.open'), onClick: () => { if (session.activeSessionId === sceneId) focusLine(unread[0].id); } });
    for (const line of active) seen.set(line.id, line.retakeRevision || 0); persistSeen();
  }
  socket.on('retake_notice', notice => {
    if (notice.sessionId !== session?.activeSessionId || !window.hasSceneMediaAccess?.()) return;
    const line = owned().find(line => line.id === notice.lineId && line.retakeRevision === notice.revision);
    if (!line || seen.get(line.id) === notice.revision) return;
    seen.set(line.id, notice.revision); persistSeen(); refresh();
    showToast(t('retake.notice', { by: notice.by, id: lineNumber(line), role: line.character, comment: (line.retakeComment || '').slice(0, 120) }), { label: t('retake.open'), onClick: () => { if (session.activeSessionId === notice.sessionId) focusLine(line.id); } });
  });
  for (const event of ['session_updated', 'line_updated', 'takes_updated', 'editor_lines_updated', 'nick_state', 'room_users_updated', 'disconnect']) socket.on(event, refresh);
  window.addEventListener('dubline-language-changed', refresh);
  const dirty = () => {
    const ids = new Set((session?.lines || []).map(line => line.id));
    // Keep orphaned drafts locally for Undo, without freezing unrelated saves.
    return [...drafts].some(([storeKey, draft]) => storeKey.startsWith(`dubline_retake_draft_v1:${key()}:`) && !!draft && ids.has(Number(storeKey.slice(storeKey.lastIndexOf(':') + 1))));
  };
  window.hasRetakeDrafts = dirty;
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  window.DublineRetakes = { controlHtml, change, captureFocus: line => {
    const area = document.activeElement;
    return area?.dataset.retakeComment === String(line.id) ? { id: line.id, start: area.selectionStart, end: area.selectionEnd, scroll: area.scrollTop } : null;
  }, restoreFocus: state => {
    if (!state) return; const area = inspector.querySelector(`[data-retake-comment="${state.id}"]`);
    if (area) { area.focus({ preventScroll: true }); area.setSelectionRange(state.start, state.end); area.scrollTop = state.scroll; }
  } };
  refresh();
})();
