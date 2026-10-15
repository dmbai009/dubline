// Responsive grouping of existing controls; preset assignment uses the editor journal.
(() => {
  const choices = new Map(), pending = new Set(), notices = new Map();
  const contextKey = line => `${currentRoom}:${session.activeSessionId}:${line.id}:${line.takeId || line.audioUrl || ''}`;
  const operations = line => [...editorQueue, ...editorConflicts].filter(op => op.event === 'voice_update' && op.sessionId === session.activeSessionId && op.payload.takes?.some(take => take.lineId === line.id));
  function presetHtml(line) {
    const key = contextKey(line), current = line.voicePresetId || '', model = DublineVoicePresets;
    let choice = choices.get(key); if (!choice || choice.current !== current) choice = { current, selected: current };
    if (choice.selected && !Object.hasOwn(session.voicePresets || {}, choice.selected)) choice.selected = current;
    choices.set(key, choice); if (choices.size > 200) choices.delete(choices.keys().next().value);
    const waiting = pending.has(key) || operations(line).length > 0;
    const disabled = !line.audioUrl || !canEditTake(line) || !socket.connected || recordState !== 'idle' || renderInProgress || window.snapshotFrozen || waiting;
    const options = Object.values(session.voicePresets || {}).sort((a, b) => a.name.localeCompare(b.name));
    return `<div class="insp-preset" data-preset-line="${line.id}" data-preset-scene="${esc(session.activeSessionId)}"><label class="setting-sub" for="inspectorPreset">${esc(t('preset.quick.title'))}</label><div class="insp-preset-controls"><select id="inspectorPreset" data-inspector-preset aria-label="${esc(t('preset.quick.title'))}" ${disabled ? 'disabled' : ''}><option value="">${esc(t('preset.quick.detach'))}</option>${options.map(preset => `<option value="${esc(preset.id)}" ${preset.id === choice.selected ? 'selected' : ''}>${esc(model.icon(preset) + ' ' + preset.name)}</option>`).join('')}</select><button type="button" class="btn-outline" data-preset-apply ${disabled || choice.selected === current ? 'disabled' : ''}>${esc(t('char.apply'))}</button></div><p class="setting-sub insp-preset-help">${esc(t('preset.quick.preserve'))}</p>${waiting || notices.has(key) ? `<p class="setting-sub" role="status">${esc(t(waiting ? 'sync.pending' : notices.get(key)))}</p>` : ''}${operations(line).some(op => editorConflicts.includes(op)) ? `<button type="button" class="btn-outline" data-preset-review>${esc(t('preset.quick.review'))}</button>` : ''}</div>`;
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
      if (node.matches('.take-history, .retake-controls, .quality-hint')) { group('history').append(node); continue; }
      if (node.matches('[data-take-mix], .clip-mix-panel')) { group('mix').append(node); continue; }
      if (session.mode === 'edit' && line) group('editing').append(node);
      else group('recording', 'inspector.recording').append(node);
    }
    const order = session.mode === 'edit' && line ? ['editing', 'editor-take', 'voice', 'mix', 'history', 'recording'] : ['recording', 'voice', 'mix', 'history'];
    for (const name of order) if (groups.has(name)) grid.append(groups.get(name));
    inspector.append(grid);
  }
  const takeHtml = line => `<section class="insp-section insp-voice">${DublineVoiceEditor.html(line)}</section><section class="insp-section insp-mix">${takePanelHtml(line, canEditTake(line))}</section>`;
  function refresh(lineId) { if (selectedLine?.id === lineId && multiSelection.size < 2) showInspector(selectedLine); }
  inspector.addEventListener('change', event => {
    if (!event.target.matches('[data-inspector-preset]')) return;
    const line = session.lines.find(item => item.id === Number(event.target.closest('[data-preset-line]').dataset.presetLine)); if (!line) return;
    const key = contextKey(line); choices.set(key, { current: line.voicePresetId || '', selected: event.target.value }); notices.delete(key);
    event.target.closest('[data-preset-line]').querySelector('[data-preset-apply]').disabled = event.target.value === (line.voicePresetId || '');
  });
  inspector.addEventListener('click', async event => {
    if (event.target.closest('[data-preset-review]')) { document.getElementById('editorConflictPanel')?.scrollIntoView({ block: 'center' }); return; }
    const button = event.target.closest('[data-preset-apply]'); if (!button || button.disabled) return;
    const panel = button.closest('[data-preset-line]'), line = session.lines.find(item => item.id === Number(panel.dataset.presetLine));
    if (!line || panel.dataset.presetScene !== session.activeSessionId || !line.audioUrl || !canEditTake(line) || recordState !== 'idle' || !socket.connected || renderInProgress || window.snapshotFrozen) return;
    const key = contextKey(line), sceneId = session.activeSessionId, room = currentRoom, snapshot = structuredClone(line), chosen = panel.querySelector('select').value;
    const presetRevision = session.voicePresets?.[chosen]?.revision;
    if (pending.has(key) || operations(line).length) return;
    pending.add(key); refresh(line.id);
    try {
      if (line.voicePresetId && chosen && chosen !== line.voicePresetId && !await askConfirm(t('preset.quick.replace'))) return;
      const current = session.lines.find(item => item.id === snapshot.id);
      if (currentRoom !== room || session.activeSessionId !== sceneId || !current || !canEditTake(current) || current.audioUrl !== snapshot.audioUrl || current.takeId !== snapshot.takeId || current.takeMixRevision !== snapshot.takeMixRevision || session.voicePresets?.[chosen]?.revision !== presetRevision) throw Error('fx.conflict');
      let settings = DublineVoiceChain.take(snapshot);
      if (chosen) {
        if (!Object.hasOwn(session.voicePresets || {}, chosen)) throw Error('preset.missing');
        settings.voicePresetId = chosen; settings.usePresetPitch = chosen === snapshot.voicePresetId && settings.usePresetPitch;
        if (!DublineVoiceChain.safe(DublineVoiceChain.resolve({ ...snapshot, ...settings }, session))) throw Error('fx.limit');
      }
      const request = { scope: 'takes', action: chosen ? 'replace' : 'detach', editPreset: true, ...(chosen ? { settings } : {}),
        presetRevision, takes: [{ lineId: snapshot.id, character: snapshot.character, audioUrl: snapshot.audioUrl, takeId: snapshot.takeId || null, takeMixRevision: snapshot.takeMixRevision || 0, presetRevision: DublineVoiceChain.preset(session, snapshot)?.revision }] };
      const result = await queueEditorRequest(() => ['voice_update', request]);
      if (!result?.ok) throw Error(result?.reason?.startsWith('fx.') || result?.reason?.startsWith('preset.') ? result.reason : 'fx.syncError');
      if (currentRoom === room && session.activeSessionId === sceneId && !await resyncEditor()) throw Error('fx.syncError');
      choices.delete(key); notices.delete(key);
      if (currentRoom === room && session.activeSessionId === sceneId) showToast(t('preset.saved'));
    } catch (error) { notices.set(key, error.message.startsWith('fx.') || error.message.startsWith('preset.') ? error.message : 'fx.syncError'); if (notices.size > 200) notices.delete(notices.keys().next().value); }
    finally { pending.delete(key); if (currentRoom === room && session.activeSessionId === sceneId) refresh(line.id); }
  });
  window.DublineInspector = { arrange, takeHtml, presetHtml };
})();
