// Responsive grouping of existing controls; preset assignment uses the editor journal.
(() => {
  const choices = new Map(), pending = new Set(), notices = new Map();
  const contextKey = line => `${currentRoom}:${session.activeSessionId}:${line.id}:${line.takeId || line.audioUrl || ''}`;
  const operations = line => [...editorQueue, ...editorConflicts].filter(op => op.event === 'voice_update' && op.sessionId === session.activeSessionId && op.payload.takes?.some(take => take.lineId === line.id));
  const eligible = lines => lines.filter(line => canEditTake(line));
  const panelLines = panel => panel.dataset.presetLines.split(',').map(Number).map(id => session.lines.find(line => line.id === id)).filter(Boolean);
  const groupKey = lines => lines.map(contextKey).sort().join('|');
  function presetHtml(line, bulk = null) {
    const targets = bulk ? eligible(bulk) : [line], ids = targets.map(line => line.id), key = groupKey(targets), model = DublineVoicePresets;
    const values = new Set(targets.map(line => line.voicePresetId || '')), current = values.size > 1 ? '__mixed' : [...values][0] || '';
    let choice = choices.get(key); if (!choice || choice.current !== current) choice = { current, selected: current };
    if (choice.selected && choice.selected !== '__mixed' && !Object.hasOwn(session.voicePresets || {}, choice.selected)) choice.selected = current;
    choices.set(key, choice); if (choices.size > 200) choices.delete(choices.keys().next().value);
    const waiting = pending.has(key) || targets.some(line => operations(line).length);
    const disabled = !targets.length || !bulk && !line.audioUrl || targets.some(line => !canEditTake(line)) || !socket.connected || recordState !== 'idle' || renderInProgress || window.snapshotFrozen || waiting;
    const options = Object.values(session.voicePresets || {}).filter(preset => !preset.role).sort((a, b) => a.name.localeCompare(b.name));
    const modified = targets.some(line => line.presetModified && line.voicePresetId);
    const title = bulk ? t('preset.bulk.title', { n: targets.length, total: bulk.length }) : t('preset.quick.title');
    const help = bulk ? t('preset.bulk.help') : modified && current ? t('chain.modified') + ' · ' + t('chain.localHelp') : t('chain.quickHelp');
    return '<div class="insp-preset" data-preset-line="' + (ids[0] || '') + '" data-preset-lines="' + ids.join(',') + '" data-preset-bulk="' + !!bulk + '" data-preset-scene="' + esc(session.activeSessionId) + '"><label class="setting-sub" for="inspectorPreset">' + esc(title) + '</label><div class="insp-preset-controls"><select id="inspectorPreset" data-inspector-preset aria-label="' + esc(title) + '" ' + (disabled ? 'disabled' : '') + '>' + (current === '__mixed' ? '<option value="__mixed" disabled' + (choice.selected === '__mixed' ? ' selected' : '') + '>' + esc(t('clip.mixed')) + '</option>' : '') + '<option value=""' + (choice.selected === '' ? ' selected' : '') + '>' + esc(t('preset.quick.detach')) + '</option>' + options.map(preset => '<option value="' + esc(preset.id) + '"' + (preset.id === choice.selected ? ' selected' : '') + '>' + esc(model.icon(preset) + ' ' + preset.name + (preset.id === current && modified ? ' ' + t('chain.modified') : '')) + '</option>').join('') + '</select><button type="button" class="btn-outline" data-preset-apply ' + (disabled || choice.selected === current && !modified ? 'disabled' : '') + '>' + esc(t('char.apply')) + '</button></div><p class="setting-sub insp-preset-help">' + esc(help) + '</p>' + (waiting || notices.has(key) ? '<p class="setting-sub" role="status">' + esc(t(waiting ? 'sync.pending' : notices.get(key))) + '</p>' : '') + (targets.some(line => operations(line).some(op => editorConflicts.includes(op))) ? '<button type="button" class="btn-outline" data-preset-review>' + esc(t('preset.quick.review')) + '</button>' : '') + '</div>';
  }
  function arrange(line) {
    if (inspector.querySelector(':scope > .insp-columns')) return;
    const grid = document.createElement('div'); grid.className = 'insp-columns';
    const groups = new Map();
    function group(name, key) {
      if (!groups.has(name)) { const node = document.createElement('section'); node.className = `insp-section insp-${name}`; if (key) { const title = document.createElement('h4'); title.textContent = t(key); node.append(title); } groups.set(name, node); }
      return groups.get(name);
    }
    for (const node of [...inspector.children]) {
      if (node.matches('.insp-head, .insp-meta, .insp-caption, .multi-list')) continue;
      if (node.matches('[data-editor-take]')) { node.classList.add('insp-editor-take'); groups.set('editor-take', node); continue; }
      if (node.matches('#editorLineForm')) { group('editing').append(node); continue; }
      if (node.matches('.fx-inspector, .fx-details, .fx-summary')) { group('voice').append(node); continue; }
      if (node.matches('.take-history')) { group('recording', 'inspector.recording').append(node); continue; }
      if (node.matches('.retake-controls, .quality-hint')) { group('history').append(node); continue; }
      if (node.matches('[data-take-mix], .clip-mix-panel')) { group('mix').append(node); continue; }
      if (session.mode === 'edit' && line) group('editing').append(node);
      else group('recording', 'inspector.recording').append(node);
    }
    const recording = groups.get('recording');
    if (recording) { const history = recording.querySelector('.take-history'); if (history) recording.append(history); }
    const order = session.mode === 'edit' && line ? ['editing', 'editor-take', 'voice', 'mix', 'history', 'recording'] : ['recording', 'voice', 'mix', 'history'];
    for (const name of order) if (groups.has(name)) grid.append(groups.get(name));
    inspector.append(grid);
  }
  const takeHtml = line => `<section class="insp-section insp-voice">${DublineVoiceEditor.html(line)}</section><section class="insp-section insp-mix">${takePanelHtml(line, canEditTake(line))}</section>`;
  function refresh(lineId) { if (multiSelection.size >= 2) showMultiInspector(); else if (selectedLine?.id === lineId) showInspector(selectedLine); }
  inspector.addEventListener('change', event => {
    if (!event.target.matches('[data-inspector-preset]')) return;
    const panel = event.target.closest('[data-preset-lines]'), targets = panelLines(panel); if (!targets.length) return;
    const key = groupKey(targets), values = new Set(targets.map(line => line.voicePresetId || '')), current = values.size === 1 ? [...values][0] : '__mixed';
    choices.set(key, { current, selected: event.target.value }); notices.delete(key);
    panel.querySelector('[data-preset-apply]').disabled = event.target.value === '__mixed' || event.target.value === current && !targets.some(line => line.voicePresetId && line.presetModified);
  });
  inspector.addEventListener('click', async event => {
    if (event.target.closest('[data-preset-review]')) { document.getElementById('editorConflictPanel')?.scrollIntoView({ block: 'center' }); return; }
    const button = event.target.closest('[data-preset-apply]'); if (!button || button.disabled) return;
    const panel = button.closest('[data-preset-lines]'), targets = panelLines(panel), bulk = panel.dataset.presetBulk === 'true';
    if (!targets.length || panel.dataset.presetScene !== session.activeSessionId || !bulk && !targets[0].audioUrl || targets.some(line => !canEditTake(line)) || recordState !== 'idle' || !socket.connected || renderInProgress || window.snapshotFrozen) return;
    const key = groupKey(targets), sceneId = session.activeSessionId, room = currentRoom, snapshots = structuredClone(targets), chosen = panel.querySelector('select').value, presetRevision = session.voicePresets?.[chosen]?.revision;
    if (chosen === '__mixed' || pending.has(key) || targets.some(line => operations(line).length)) return;
    pending.add(key); refresh(targets[0].id);
    try {
      if (chosen && (bulk || targets.some(line => line.voicePresetId || line.pitch || DublineVoiceChain.ownEffects(DublineVoiceChain.take(line), session).length)) && !await askConfirm(t(bulk ? 'preset.bulk.confirm' : 'chain.replaceConfirm', { n: targets.length }))) return;
      if (currentRoom !== room || session.activeSessionId !== sceneId || session.voicePresets?.[chosen]?.revision !== presetRevision || bulk && groupKey(eligible(session.lines.filter(line => multiSelection.has(line.id)))) !== key) throw Error('fx.conflict');
      for (const snapshot of snapshots) {
        const current = session.lines.find(line => line.id === snapshot.id);
        if (!current || !canEditTake(current) || current.character !== snapshot.character || current.audioUrl !== snapshot.audioUrl || current.takeId !== snapshot.takeId || current.takeMixRevision !== snapshot.takeMixRevision) throw Error('fx.conflict');
        if (chosen) DublineVoicePresets.link(snapshot, session, chosen, true);
      }
      const request = { scope: 'takes', action: chosen ? 'replace' : 'detach', editPreset: true, ...(chosen ? { settings: DublineVoiceChain.take(DublineVoicePresets.link(snapshots[0], session, chosen, true)), pitch: 0, editPitch: true } : {}), presetRevision,
        takes: snapshots.map(snapshot => ({ lineId: snapshot.id, character: snapshot.character, audioUrl: snapshot.audioUrl, takeId: snapshot.takeId || null, takeMixRevision: snapshot.takeMixRevision || 0, presetRevision: DublineVoiceChain.preset(session, snapshot)?.revision })) };
      const result = await queueEditorRequest(() => ['voice_update', request]);
      if (!result?.ok) throw Error(result?.reason?.startsWith('fx.') || result?.reason?.startsWith('preset.') ? result.reason : 'fx.syncError');
      if (currentRoom === room && session.activeSessionId === sceneId && !await resyncEditor()) throw Error('fx.syncError');
      choices.delete(key); notices.delete(key); if (currentRoom === room && session.activeSessionId === sceneId) showToast(t('preset.saved'));
    } catch (error) { notices.set(key, error.message.startsWith('fx.') || error.message.startsWith('preset.') ? error.message : 'fx.syncError'); if (notices.size > 200) notices.delete(notices.keys().next().value); }
    finally { pending.delete(key); if (currentRoom === room && session.activeSessionId === sceneId) refresh(targets[0].id); }
  });
  window.DublineInspector = { arrange, takeHtml, presetHtml, bulkPresetHtml: lines => presetHtml(lines[0], lines) };
})();
