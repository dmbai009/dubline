(() => {
  let remote = [];
  const own = new Map();
  window.DublineEditLeases = { stats: () => ({ own: own.size, remote: remote.length }) };
  window.editorLeaseTargets = (event, data) => {
    const line = (key, group) => ({ type: 'line', key, group });
    let targets = [];
    if (event === 'editor_update_line' || event === 'editor_update_lines') {
      targets = (event === 'editor_update_line' ? [data] : data.updates).flatMap(patch => [
        ...(patch.caption !== undefined ? [line(patch.lineId, 'caption')] : []),
        ...(patch.start !== undefined || patch.end !== undefined ? [line(patch.lineId, 'timing')] : []),
        ...(patch.character !== undefined ? [line(patch.lineId, 'assignment')] : [])]);
    } else if (event === 'set_line_character') targets = [line(data.lineId, 'assignment')];
    else if (event === 'set_lines_character') targets = (data.lines || data.lineIds?.map(lineId => ({ lineId })) || []).map(item => line(item.lineId, 'assignment'));
    else if (event === 'editor_delete_lines') targets = (data.lines || data.lineIds?.map(lineId => ({ lineId })) || []).map(item => line(item.lineId, 'structural'));
    else if (event === 'editor_create_line') targets = session.trackOrder.includes(data.character)
      ? [{ type: 'track', key: data.character, group: 'structural' }]
      : [{ type: 'session', key: '*', group: 'structural' }];
    else if (event === 'rename_character') targets = [{ type: 'track', key: data.from, group: 'structural' },
      ...(session.trackOrder.includes(data.to) ? [{ type: 'track', key: data.to, group: 'structural' }] : [])];
    else if (['editor_add_track', 'editor_undo', 'editor_reorder_track', 'editor_delete_track'].includes(event)) targets = [{ type: 'session', key: '*', group: 'structural' }];
    return targets.length > 128 ? [{ type: 'session', key: '*', group: 'structural' }] : targets;
  };
  window.acquireEditLease = async (targets, options = {}) => {
    const response = value => options.result ? value : value.ok ? value.token : null;
    const sessionId = session?.activeSessionId;
    if (!socket.connected || session?.mode !== 'edit') return response({ ok: false, reason: !socket.connected ? 'unavailable' : 'mode' });
    if (options.signal?.aborted) return response({ ok: false, reason: 'cancelled' });
    const acquisitionId = crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(18))].map(value => value.toString(16).padStart(2, '0')).join('');
    const cancel = () => { if (socket.connected) socket.emit('edit_lease_cancel', { acquisitionId }); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const result = await new Promise(resolve => socket.timeout(3000).emit('edit_lease_acquire', { sessionId, targets, acquisitionId }, (error, value) => resolve(error ? { ok: false, reason: socket.connected ? 'timeout' : 'unavailable' } : value)));
    options.signal?.removeEventListener('abort', cancel);
    if (options.signal?.aborted || result?.reason === 'timeout') cancel();
    if (options.signal?.aborted) { if (result?.token) socket.emit('edit_lease_release', { token: result.token }); return response({ ok: false, reason: 'cancelled' }); }
    if (!result?.ok) {
      if (!options.result) showToast(editorFailureMessage(result?.reason || 'unavailable'));
      return response(result || { ok: false, reason: 'unavailable' });
    }
    if (result.expires <= serverNow()) {
      socket.emit('edit_lease_release', { token: result.token }); return response({ ok: false, reason: 'timeout' });
    }
    if (session?.activeSessionId !== sessionId || session.mode !== 'edit') {
      socket.emit('edit_lease_release', { token: result.token }); return response({ ok: false, reason: 'session' });
    }
    own.set(result.token, { sessionId });
    return response(result);
  };
  window.releaseEditLease = token => {
    if (!token) return;
    own.delete(token);
    if (socket.connected) socket.emit('edit_lease_release', { token });
  };
  function releaseAll() { [...own.keys()].forEach(releaseEditLease); }
  new MutationObserver(() => {
    for (const [token, entry] of own) if (entry.element && !entry.element.isConnected) releaseEditLease(token);
  }).observe(inspector, { childList: true, subtree: true });
  setInterval(() => {
    for (const [token, entry] of own) {
      const { sessionId, element } = entry;
      if (!socket.connected || session?.activeSessionId !== sessionId || session?.mode !== 'edit' || element && !element.isConnected) { releaseEditLease(token); continue; }
      socket.volatile.emit('edit_lease_heartbeat', { token, sessionId });
    }
  }, 2000);
  function foreign(lineId, group) {
    const line = session?.lines.find(item => item.id === lineId);
    return remote.find(lease => lease.expires > serverNow() && lease.actorId !== socket.id && lease.targets.some(target =>
      (target.type === 'session' || target.type === 'track' && target.key === line?.character || target.type === 'line' && target.key === lineId) &&
      (target.group === group || target.group === 'structural' || group === 'structural')));
  }
  window.foreignEditLease = foreign;
  window.renderEditLease = block => {
    block.querySelector('.remote-edit-lease')?.remove();
    const id = Number(block.id.replace('line-block-', ''));
    const actors = remote.filter(lease => lease.actorId !== socket.id && lease.targets.some(target =>
      target.type === 'session' || target.type === 'line' && target.key === id || target.type === 'track' && target.key === block.closest('.track-row')?.dataset.character));
    if (!actors.length) return;
    const mark = document.createElement('span'); mark.className = 'remote-edit-lease';
    mark.textContent = '✎ ' + [...new Set(actors.map(actor => actor.nick))].join(', ');
    mark.title = actors.map(actor => `${actor.nick}: ${[...new Set(actor.targets.map(target => target.group))].join(', ')}`).join('\n');
    block.appendChild(mark);
  };
  function refresh() {
    document.querySelectorAll('.line-block').forEach(renderEditLease);
    const form = document.getElementById('editorLineForm');
    if (!form) return;
    const lineId = Number(form.dataset.draftKey.split(':').pop());
    for (const input of form.querySelectorAll('[data-editor-field]')) {
      const group = input.dataset.editorField === 'caption' ? 'caption' : input.dataset.editorField === 'character' ? 'assignment' : 'timing';
      const locked = foreign(lineId, group);
      input.dataset.leaseForeign = locked ? 'true' : '';
      if (input.tagName === 'SELECT') input.disabled = !!locked;
      else input.readOnly = !!locked;
      input.title = locked ? t('editor.locked', { name: locked.nick }) : '';
    }
  }
  window.bindEditorLeases = form => {
    let focusedToken = null, generation = 0;
    form.addEventListener('focusin', async event => {
      const input = event.target.closest('[data-editor-field]');
      if (!input || input.dataset.leaseForeign) return;
      const attempt = ++generation;
      releaseEditLease(focusedToken); focusedToken = null;
      const lineId = Number(form.dataset.draftKey.split(':').pop());
      const group = input.dataset.editorField === 'caption' ? 'caption' : input.dataset.editorField === 'character' ? 'assignment' : 'timing';
      // Local draft keystrokes remain available while the request is in flight.
      // Committing the draft waits for an authoritative lease in the editor pump.
      const token = await acquireEditLease([{ type: 'line', key: lineId, group }]);
      if (attempt !== generation || !form.isConnected || document.activeElement !== input) { releaseEditLease(token); return; }
      focusedToken = token;
      if (token) own.get(token).element = form;
      if (input.tagName !== 'SELECT') input.readOnly = !token;
    });
    form.addEventListener('focusout', () => { ++generation; releaseEditLease(focusedToken); focusedToken = null; });
    refresh();
  };
  socket.on('edit_leases', data => { remote = data?.sessionId === session?.activeSessionId && Array.isArray(data.leases) ? data.leases : []; refresh(); });
  socket.on('disconnect', () => { own.clear(); remote = []; refresh(); });
  socket.on('session_updated', () => {
    for (const [token, entry] of own) if (entry.sessionId !== session?.activeSessionId || session?.mode !== 'edit') releaseEditLease(token);
    remote = remote.filter(lease => lease.expires > serverNow()); refresh();
  });
  window.addEventListener('blur', releaseAll);
})();
