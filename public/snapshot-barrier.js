(() => {
  let frozenToken = null, frozenScene = null, freezeTimer = null;
  const mutating = new Set(['claim_character', 'unclaim_character', 'claim_line', 'unclaim_line', 'host_release_lines', 'host_reset_claims', 'set_take_props', 'set_takes_props', 'set_line_character', 'set_lines_character', 'rename_character', 'set_session_mode', 'editor_create_line', 'editor_update_line', 'editor_update_lines', 'editor_delete_lines', 'editor_add_track', 'editor_undo', 'host_delete_lines', 'host_undo_delete', 'host_trash_restore', 'host_trash_purge', 'host_set_audio_tracks', 'random_cast', 'host_reveal_takes', 'set_blind_mode', 'set_blind_preference', 'set_needs_retake', 'project_audio_update', 'host_switch_session', 'host_delete_session']);
  function thaw(token) {
    if (token && frozenToken !== token) return;
    clearTimeout(freezeTimer); frozenToken = null; frozenScene = null; window.snapshotFrozen = false; document.body.classList.remove('snapshot-frozen');
  }
  const originalEmit = socket.emit;
  socket.emit = function(event, ...args) {
    if (frozenToken && mutating.has(event)) {
      const ack = args.at(-1); if (typeof ack === 'function') queueMicrotask(() => ack({ ok: false, reason: 'snapshot' }));
      showToast(t('snapshot.frozen')); return this;
    }
    return originalEmit.call(this, event, ...args);
  };
  function call(event, data) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(t('snapshot.expired'))), 4000);
      socket.emit(event, data, result => { clearTimeout(timer); resolve(result); });
    });
  }
  function reason() {
    if (!socket.connected) return 'disconnected';
    if (recordState !== 'idle') return 'recording';
    if (renderInProgress || projectImportBusy) return 'upload';
    if (window.activeEditorGesture || document.querySelector('.dragging,.latency-drag,.editor-dragging')) return 'gesture';
    if (editorNeedsResync) return 'resync';
    if (editorQueue.some(entry => entry.sessionId === session.activeSessionId)) return 'pending';
    if (editorConflicts.some(entry => entry.sessionId === session.activeSessionId)) return 'conflict';
    const form = inspector.querySelector('form[data-draft-key]'); if (form) rememberEditorDraft(form);
    if ([...editorDrafts.keys()].some(key => key.startsWith(`${session.activeSessionId}:`))) return 'draft';
    if ([...pendingTakes.values()].some(entry => entry.sessionId === session.activeSessionId)) return 'upload';
    return 'ready';
  }
  socket.on('snapshot_probe', async data => {
    if (data.sessionId !== session?.activeSessionId) return;
    thaw();
    if (session.mode === 'dub') window.retryPendingTakes?.();
    while (['pending', 'upload', 'resync'].includes(reason()) && Date.now() < data.deadline - 250 && socket.connected && data.sessionId === session?.activeSessionId) await new Promise(resolve => setTimeout(resolve, 50));
    if (data.sessionId !== session?.activeSessionId || !socket.connected) return;
    const status = reason();
    if (status === 'ready') {
      frozenToken = data.token; frozenScene = data.sessionId; window.snapshotFrozen = true; document.body.classList.add('snapshot-frozen');
      freezeTimer = setTimeout(() => thaw(data.token), 15000);
    }
    try { const ack = await call('snapshot_ready', { token: data.token, sessionId: data.sessionId, reason: status }); if (!ack?.ok) thaw(data.token); }
    catch { thaw(data.token); }
  });
  socket.on('snapshot_release', data => thaw(data.token)); socket.on('disconnect', () => thaw());
  socket.on('session_updated', () => { if (frozenScene !== session?.activeSessionId) thaw(); });
  document.addEventListener('beforeinput', event => { if (frozenToken && event.target.closest('#inspector')) event.preventDefault(); }, true);
  function choose(status) {
    const dialog = document.createElement('dialog'); dialog.className = 'text-prompt';
    const text = document.createElement('p'); text.textContent = t('snapshot.notReady') + '\n' + status.participants.filter(player => player.reason !== 'ready').map(player => `${player.nick}: ${t(`snapshot.reason.${player.reason}`)}`).join('\n'); text.style.whiteSpace = 'pre-line'; dialog.append(text);
    const actions = document.createElement('div'); actions.className = 'insp-actions'; dialog.append(actions);
    document.body.append(dialog);
    return new Promise(resolve => {
      const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
      for (const action of ['retry', 'force', 'cancel']) { const button = document.createElement('button'); button.className = action === 'force' ? 'btn-play' : 'btn-outline'; button.textContent = t(`snapshot.${action}`); button.onclick = () => finish(action); actions.append(button); }
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel'); }); dialog.showModal();
    });
  }
  window.prepareSafeSnapshot = async purpose => {
    const sceneId = session.activeSessionId;
    while (sceneId === session?.activeSessionId && socket.connected) {
      const started = await call('snapshot_request', { sessionId: sceneId, purpose });
      if (!started?.ok) throw new Error(t('snapshot.expired'));
      let status = started;
      try {
        while (!status.finished) {
          await new Promise(resolve => setTimeout(resolve, 100));
          status = await call('snapshot_status_request', { token: started.token });
          if (!status?.ok) throw new Error(t('snapshot.expired'));
        }
        if (status.participants.every(player => player.reason === 'ready')) return { barrierToken: started.token, forceSnapshot: false, sessionId: sceneId };
        const action = await choose(status);
        if (sceneId !== session?.activeSessionId) throw new Error(t('snapshot.expired'));
        if (action === 'force') return { barrierToken: started.token, forceSnapshot: true, sessionId: sceneId };
        socket.emit('snapshot_cancel', { token: started.token });
        if (action === 'cancel') return null;
      } catch (error) { socket.emit('snapshot_cancel', { token: started.token }); throw error; }
    }
    throw new Error(t('snapshot.expired'));
  };
})();
