// Track changes share the durable editor queue, revisions, leases and Undo.
(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'text-prompt track-delete-dialog'; dialog.setAttribute('aria-labelledby', 'trackDeleteTitle'); document.body.appendChild(dialog);
  let pending;
  function close(value = null) { if (!pending) return; const entry = pending; pending = null; dialog.close(); entry.focus?.focus(); entry.resolve(value); }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  function choose(character, lines) {
    close(); const others = session.trackOrder.filter(name => name !== character);
    dialog.innerHTML = `<h3 id="trackDeleteTitle">${esc(t('track.deleteTitle', { name: character }))}</h3><p>${esc(t('track.deleteCounts', { n: lines.length, m: lines.filter(line => line.audioUrl).length }))}</p>
      <label>${esc(t('track.destination'))}<select class="text-input">${others.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}<option value="">${esc(t('track.new'))}</option></select></label>
      <input class="text-input" maxlength="40" aria-label="${esc(t('editor.trackPrompt'))}" placeholder="${esc(t('editor.trackPrompt'))}">
      <div class="insp-actions"><button type="button" class="btn-play" data-track-decision="transfer">${esc(t('track.transfer'))}</button><button type="button" class="btn-delete" data-track-decision="trash" ${session.protectTimings && lines.length ? 'disabled' : ''}>${esc(t('track.trash'))}</button><button type="button" class="btn-outline" data-track-decision="cancel">${esc(t('dialog.cancel'))}</button></div>`;
    const select = dialog.querySelector('select'), input = dialog.querySelector('input');
    const update = () => { input.hidden = !!select.value; }; select.onchange = update; update();
    return new Promise(resolve => { pending = { resolve, focus: document.activeElement }; dialog.showModal(); select.focus(); });
  }
  dialog.addEventListener('click', event => {
    const action = event.target.closest('[data-track-decision]')?.dataset.trackDecision; if (!action) return;
    const target = dialog.querySelector('select').value, name = target || dialog.querySelector('input').value.trim();
    if (action === 'transfer' && !name) { dialog.querySelector('input').focus(); return; }
    close(action === 'cancel' ? null : { action, target: name, createTarget: !target });
  });
  const allowed = () => !!session?.loaded && session.mode === 'edit' && socket.connected && !window.snapshotFrozen;
  function reorderResult(result) {
    if (result?.ok) return true;
    const reason = result?.reason || 'timeout';
    const key = ['conflict', 'invalid', 'mode', 'locked', 'session', 'cancelled', 'timeout', 'expired'].includes(reason) ? reason : 'failed';
    showToast(t('track.reorder.' + key)); return false;
  }
  function base(character) { return { character, trackOrder: [...session.trackOrder], lines: session.lines.filter(line => line.character === character).map(line => ({ lineId: line.id, revision: line.revision || 0, audioUrl: line.audioUrl || null, takeMixRevision: line.takeMixRevision || 0, claimedBy: line.claimedBy || null })) }; }
  window.deleteEditorTrack = async character => {
    if (!allowed() || !session.trackOrder.includes(character)) return;
    const id = session.activeSessionId, captured = base(character), claims = { ...session.characterClaims }, lines = session.lines.filter(line => line.character === character);
    const choice = lines.length ? await choose(character, lines) : await askConfirm(t('track.deleteEmpty', { name: character }), { danger: true }) ? { action: 'trash' } : null;
    if (!choice) return;
    if (lines.length && choice.action === 'trash' && !await askConfirm(t('track.trashConfirm', { n: lines.length, m: lines.filter(line => line.audioUrl).length }), { danger: true })) return;
    if (!allowed() || session.activeSessionId !== id || JSON.stringify(captured) !== JSON.stringify(base(character)) || JSON.stringify(claims) !== JSON.stringify(session.characterClaims)) { showToast(t('editor.dialogChanged')); return; }
    editorResult(await queueEditorRequest(() => ['editor_delete_track', { ...captured, ...choice, expectedClaims: { from: claims[character] || null, to: claims[choice.target] || null } }]));
  };
  window.addTrackEditorControls = (label, character) => {
    const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'btn-icon track-drag-handle'; handle.textContent = '⠿'; handle.title = handle.ariaLabel = t('track.reorder');
    handle.onclick = event => event.stopPropagation(); handle.onpointerdown = event => begin(event, character);
    handle.onkeydown = event => {
      if (!allowed() || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const order = [...session.trackOrder], index = order.indexOf(character), destination = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (destination < 0 || destination >= order.length) return;
      order.splice(index, 1); order.splice(destination, 0, character);
      queueEditorRequest(() => ['editor_reorder_track', { character, before: order[destination + 1] || null, trackOrder: session.trackOrder }]).then(reorderResult);
    };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-icon track-delete-button'; remove.textContent = '×'; remove.title = remove.ariaLabel = t('track.delete');
    remove.onclick = event => { event.preventDefault(); event.stopPropagation(); deleteEditorTrack(character); };
    const nameRow = label.querySelector('.char-name-row'); nameRow.prepend(handle); nameRow.append(remove);
  };
  function begin(event, character) {
    if (event.button !== 0 || !allowed()) return;
    event.preventDefault(); event.stopPropagation(); cancelEditorGesture();
    const id = session.activeSessionId, order = [...session.trackOrder], scroller = document.getElementById('timelineContainer');
    const rows = [...document.querySelectorAll('.track-row[data-character]')], dragged = rows.find(row => row.dataset.character === character);
    if (!dragged) return;
    const origin = scroller.getBoundingClientRect(), zoom = origin.width / scroller.offsetWidth, scroll = scroller.scrollTop;
    const boxes = rows.map(row => { const rect = row.getBoundingClientRect(); return { row, top: rect.top, height: rect.height }; });
    const draggedBox = boxes.find(box => box.row === dragged), others = boxes.filter(box => box.row !== dragged);
    let before = order[order.indexOf(character) + 1] || null, last, moved = false;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clear = () => { for (const row of rows) { row.style.removeProperty('transform'); row.style.removeProperty('transition'); row.classList.remove('track-reordering', 'track-reorder-source'); } scroller.classList.remove('track-reorder-active'); };
    const move = next => {
      last = next; if (Math.abs(next.clientY - event.clientY) < 4 && !moved) return;
      moved = true; scroller.classList.add('track-reorder-active');
      const scrollDelta = (scroller.scrollTop - scroll) * zoom;
      const y = Math.max(origin.top, Math.min(next.clientY, scroller.getBoundingClientRect().bottom));
      const destination = others.findIndex(box => y + scrollDelta < box.top + box.height / 2), index = destination < 0 ? others.length : destination;
      before = others[index]?.row.dataset.character || null;
      const virtual = [...others]; virtual.splice(index, 0, draggedBox);
      let top = boxes[0].top;
      for (const box of virtual) {
        box.row.classList.add('track-reordering');
        box.row.style.transition = box.row === dragged || reduced ? 'none' : 'transform 160ms ease-out';
        const delta = box.row === dragged ? Math.max(boxes[0].top - draggedBox.top, Math.min(boxes.at(-1).top + boxes.at(-1).height - draggedBox.height - draggedBox.top, y - event.clientY + scrollDelta)) : top - box.top;
        box.row.style.transform = 'translateY(' + delta / zoom + 'px)'; top += box.height;
      }
      dragged.classList.add('track-reorder-source');
    };
    const timer = setInterval(() => { if (!last || !moved) return; const bounds = scroller.getBoundingClientRect(), delta = last.clientY < bounds.top + 35 ? -12 : last.clientY > bounds.bottom - 35 ? 12 : 0; if (delta) { scroller.scrollTop += delta; move(last); } }, 30);
    const key = next => { if (next.key === 'Escape') { next.preventDefault(); next.stopImmediatePropagation(); cleanup(); } };
    const cleanup = () => { clearInterval(timer); clear(); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', cleanup); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', cleanup); if (window.activeEditorGesture?.cleanup === cleanup) window.activeEditorGesture = null; if (deferredEditorRender) { deferredEditorRender = false; renderTimeline(); } };
    const end = () => {
      cleanup(); if (!moved) return;
      if (!allowed() || session.activeSessionId !== id) { reorderResult({ reason: 'session' }); return; }
      if (JSON.stringify(order) !== JSON.stringify(session.trackOrder)) { reorderResult({ reason: 'conflict' }); return; }
      if (before === (order[order.indexOf(character) + 1] || null)) return;
      queueEditorRequest(() => ['editor_reorder_track', { character, before, trackOrder: order }]).then(reorderResult);
    };
    window.activeEditorGesture = { cleanup, type: 'track', lineIds: new Set() }; window.addEventListener('keydown', key, true); window.addEventListener('blur', cleanup); window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', cleanup);
  }
  socket.on('disconnect', () => close());
  document.addEventListener('dubline-session-updated', () => { if (pending && !allowed()) close(); });
})();
