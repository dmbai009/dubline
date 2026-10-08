// Explain the existing control state; authorization continues to live in the
// existing handlers/server. Only editor fields add local availability gates.
(() => {
  let frame = 0;
  const scope = '#inspector, #settingsModal, #filesModal, #modeSwitch, .timeline-toolbar, .studio-transport, .studio-audio-row';
  const base = () => !session?.loaded ? 'help.scene' : !socket.connected ? 'help.connection' : window.snapshotFrozen ? 'snapshot.frozen' : '';
  function availability(control, property, value) { if (control[property] !== value) control[property] = value; }
  function explain(control, key) { window.setControlHelp(control, key ? t(key) : ''); }
  function refresh() {
    frame = 0;
    const common = base(), form = document.getElementById('editorLineForm');
    if (form) {
      const id = Number(form.dataset.draftKey?.split(':').pop()), line = session?.lines.find(item => item.id === id);
      for (const input of form.querySelectorAll('[data-editor-field]')) {
        const field = input.dataset.editorField, timing = ['start', 'end'].includes(field);
        const group = timing ? 'timing' : field === 'character' ? 'assignment' : 'caption';
        const lease = window.foreignEditLease?.(id, group);
        const reason = common || (session.mode !== 'edit' ? 'help.mode' : !line ? 'editor.failure.missing' : timing && session.protectTimings ? 'help.protected' : lease ? 'help.locked' : '');
        if (input.tagName === 'SELECT' || timing) availability(input, 'disabled', !!reason);
        else availability(input, 'readOnly', !!reason);
        explain(input, reason);
      }
      for (const button of form.querySelectorAll('button')) {
        const deleting = button.classList.contains('btn-delete');
        const reason = common || (session.mode !== 'edit' ? 'help.mode' : deleting && session.protectTimings ? 'help.protected' : deleting && window.foreignEditLease?.(id, 'structural') ? 'help.locked' : '');
        if (deleting) availability(button, 'disabled', !!reason);
        else {
          const draft = editorDrafts.get(form.dataset.draftKey);
          const conflict = button.type === 'submit' && draft && Number(draft.base.revision || 0) !== Number(line?.revision || 0);
          availability(button, 'disabled', !!reason || !!draft?.pending || !!conflict);
        }
        explain(button, reason || (button.disabled ? editorDrafts.get(form.dataset.draftKey)?.pending ? 'help.busy' : 'help.draft' : ''));
      }
    }
    const line = selectedLine && session?.lines.find(item => item.id === selectedLine.id);
    for (const control of document.querySelectorAll(`${scope.split(', ').map(root => root + ' button, ' + root + ' input, ' + root + ' select, ' + root + ' textarea').join(', ')}`)) {
      if (control.closest('#editorLineForm') || control.id === 'editorSyncState' || control.closest('#editorConflictPanel') || control.tagName === 'OPTION') continue;
      let reason = '';
      if (control.matches('#modeSwitch button, #protectTimingsBtn')) reason = common || (!canModerate() ? 'help.moderator' : '');
      else if (control.id === 'addEditorLineBtn') reason = common || (session.mode !== 'edit' ? 'help.mode' : session.protectTimings ? 'help.protected' : '');
      else if (control.id === 'recBtn') reason = ['recording', 'preparing'].includes(recordState) ? '' : common || (renderInProgress ? 'help.busy' : session.mode !== 'dub' ? 'help.dub' : watchMode ? 'watch.noRecord' : line && getLineOwner(line) !== myName ? 'help.owner' : '');
      else if (control.id === 'projectInput' || control.id === 'customUploadBtn') reason = !socket.connected ? 'help.connection' : projectImportBusy || customImportStatus?.active || renderInProgress ? 'help.busy' : recordState !== 'idle' ? 'help.recording' : !amHost() ? 'help.host' : '';
      else if (control.id === 'packExportBtn' || control.id === 'projectExportBtn') reason = common || (projectImportBusy || projectExportBusy || customImportStatus?.active ? 'help.busy' : !amHost() ? 'help.host' : '');
      else if (control.id === 'startRenderBtn') reason = common || (renderInProgress ? 'help.busy' : recordState !== 'idle' ? 'help.recording' : session.hasOriginalVideo && !amHost() ? 'help.host' : '');
      else if (control.matches('#transportSeek, #previewRate, [data-studio-action=play], [data-studio-action=back], [data-studio-action=forward]')) reason = common || (renderInProgress ? 'help.busy' : recordState !== 'idle' ? 'help.recording' : watchMode && !amHost() ? 'watch.hostControls' : '');
      else if (control.closest('#passwordHostControls')) reason = !socket.connected ? 'help.connection' : !amHost() ? 'help.host' : '';
      else if (control.id === 'settingsBlindMode') reason = common || (!canModerate() ? 'help.moderator' : '');
      else if (control.hasAttribute('data-project-field') || control.dataset.audioField === 'offset' || ['settingsAutoDuck', 'settingsAutoDuckAmount'].includes(control.id)) reason = common || (control.disabled ? 'studio.mixLocked' : '');
      else if (control.hasAttribute('data-clip-field') || control.closest('[data-take-mix]')) reason = common || (control.closest('[data-take-mix]')?.dataset.pending ? 'help.busy' : control.disabled ? 'clip.readOnly' : '');
      else if (control.matches('[data-studio-setting=latency]')) reason = !socket.connected ? 'help.connection' : recordState !== 'idle' ? 'help.recording' : !myName ? 'help.selection' : '';
      else if (control.disabled || control.readOnly) reason = control.title ? '' : common || (control.closest('#filesModal') ? renderInProgress || projectImportBusy || projectExportBusy ? 'help.busy' : 'help.selection' : 'help.selection');
      // Existing code determines whether most controls are disabled. Explanations
      // cannot grant permissions or hide previously visible actions.
      if (control.matches('#modeSwitch button, #protectTimingsBtn, #addEditorLineBtn, #recBtn')) availability(control, 'disabled', !!reason);
      if (control.disabled || control.readOnly) window.setControlHelp(control, reason ? t(reason) : control.title || t('help.selection'));
      else window.setControlHelp(control, '');
    }
    for (const button of document.querySelectorAll('#editorConflictPanel button:disabled')) explain(button, common || (editorReviewBusy ? 'help.busy' : 'editor.failure.session'));
    for (const input of document.querySelectorAll('[data-editor-field]')) if (!input.disabled && !input.readOnly) input.title = '';
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(refresh); }
  const observer = new MutationObserver(schedule);
  for (const root of document.querySelectorAll(scope)) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'readonly'] });
  // Audio rows are rebuilt with the existing timeline. Observe only their controls,
  // never cue positions or the hundreds of per-line DOM mutations.
  const audioObserver = new MutationObserver(schedule);
  const timelineObserver = new MutationObserver(() => {
    audioObserver.disconnect();
    document.querySelectorAll('.studio-audio-row').forEach(row => audioObserver.observe(row, { subtree: true, attributes: true, attributeFilter: ['disabled'] }));
    schedule();
  });
  timelineObserver.observe(timeline, { childList: true });
  for (const event of ['connect', 'disconnect', 'session_updated', 'room_users_updated', 'edit_leases', 'editor_lines_updated', 'recording_state', 'snapshot_probe', 'snapshot_release', 'video_import_progress']) socket.on(event, schedule);
  for (const event of ['loadeddata', 'emptied']) video.addEventListener(event, schedule);
  window.addEventListener('dubline-language-changed', schedule);
  window.addEventListener('pagehide', () => { observer.disconnect(); audioObserver.disconnect(); timelineObserver.disconnect(); cancelAnimationFrame(frame); });
  window.refreshActionHelp = schedule;
  schedule();
})();
