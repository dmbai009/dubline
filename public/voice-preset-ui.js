(() => {
  const model = DublineVoicePresets, editor = DublineVoiceEditor, $ = id => document.getElementById(id);
  let operation = null, sending = false, audioScene = session?.activeSessionId, audioCatalog = structuredClone(session?.voicePresets || {}), audioRoles = structuredClone(session?.roleEffects || {});
  function synchronizeAudio() { if (audioScene === session?.activeSessionId) { const ids = audio.invalidatePresets(audioCatalog, audioRoles); if (ids.length) window.dispatchEvent(new CustomEvent('dubline-presets-changed', { detail: { ids } })); } audioScene = session?.activeSessionId; audioCatalog = structuredClone(session?.voicePresets || {}); audioRoles = structuredClone(session?.roleEffects || {}); }
  function status(key = '') { const node = $('fxPresetStatus'); if (key) node.dataset.i18n = key; else delete node.dataset.i18n; node.textContent = key ? t(key) : ''; }
  const area = document.createElement('section'); area.className = 'fx-presets'; area.id = 'fxPresets';
  area.innerHTML = `<h3 data-i18n="preset.title"></h3><label class="fx-icon-row"><span data-i18n="preset.icon"></span><select id="fxPresetIcon"></select></label><div class="fx-preset-controls"><select id="fxPresetSelect" aria-label="${esc(t('preset.title'))}"></select><button type="button" id="fxPresetApply" class="btn-outline" data-i18n="preset.apply"></button></div>
    <p class="setting-sub" data-i18n="chain.libraryHelp"></p><p id="fxPresetDescription" class="setting-sub"></p>
    <div class="insp-actions"><button type="button" id="fxPresetSave" class="btn-outline" data-i18n="preset.saveAs"></button><div class="fx-preset-menu"><p class="setting-sub" data-i18n="fx.layout.library"></p><div class="insp-actions"><button type="button" id="fxPresetRename" class="btn-outline" data-i18n="preset.rename"></button><button type="button" id="fxPresetUpdate" class="btn-outline" data-i18n="preset.update"></button><button type="button" id="fxPresetDelete" class="btn-outline" data-i18n="preset.delete"></button></div></div></div>
    <p id="fxPresetStatus" role="status" aria-live="polite"></p><button type="button" id="fxPresetRetry" class="btn-outline" data-i18n="preset.retry" hidden></button>`;
  $('fxDialog').querySelector('.fx-sidebar').append(area);
  $('fxPresetIcon').replaceChildren(...Object.entries(model.ICONS).map(([key, glyph]) => new Option(glyph + ' ' + t(DublineVoiceChain.TYPES.includes(key) ? 'fx.name.' + key : 'preset.icon.' + key), key)));
  $('fxPresetIcon').onchange = () => editor.setIcon($('fxPresetIcon').value);
  const selected = () => Object.hasOwn(session?.voicePresets || {}, $('fxPresetSelect').value) ? session.voicePresets[$('fxPresetSelect').value] : null;
  function refresh() {
    $('fxPresetSelect').setAttribute('aria-label', t('preset.title'));
    const draft = editor.draft(), shared = draft?.scope === 'preset';
    area.querySelector('.fx-icon-row > span').dataset.i18n = shared ? 'preset.icon' : 'preset.icon.new'; area.querySelector('.fx-icon-row > span').textContent = t(shared ? 'preset.icon' : 'preset.icon.new');
    $('fxPresetIcon').value = draft?.icon || 'voice'; $('fxPresetIcon').disabled = sending || !!operation;
    for (const option of $('fxPresetIcon').options) option.textContent = model.ICONS[option.value] + ' ' + t(DublineVoiceChain.TYPES.includes(option.value) ? 'fx.name.' + option.value : 'preset.icon.' + option.value);
    area.querySelector('.fx-preset-controls').hidden = shared; area.querySelector('[data-i18n="chain.libraryHelp"]').hidden = shared;
    area.querySelector('h3').dataset.i18n = shared ? 'live.actions' : 'preset.title'; area.querySelector('h3').textContent = t(area.querySelector('h3').dataset.i18n); $('fxPresetSave').dataset.i18n = shared ? 'live.saveAsNew' : 'preset.saveAs'; $('fxPresetSave').textContent = t($('fxPresetSave').dataset.i18n);
    const previous = shared ? draft.presetId : $('fxPresetSelect').value || draft?.presetId, presets = Object.values(session?.voicePresets || {});
    $('fxPresetSelect').replaceChildren(new Option(t('preset.choose'), ''), ...presets.map(preset => new Option(model.icon(preset) + ' ' + preset.name, preset.id)));
    if (presets.some(preset => preset.id === previous)) $('fxPresetSelect').value = previous;
    const preset = selected(), own = !!preset && (canModerate() || preset.createdBy === myName), locked = sending || !!operation;
    for (const id of ['fxPresetSelect', 'fxPresetSave']) $(id).disabled = locked;
    $('fxPresetUpdate').hidden = shared || !!draft?.presetId && draft.presetId === preset?.id; $('fxPresetUpdate').textContent = t('chain.editLibrary'); delete $('fxPresetUpdate').dataset.i18n;
    $('fxPresetApply').disabled = !preset || locked; for (const id of ['fxPresetRename', 'fxPresetUpdate', 'fxPresetDelete']) $(id).disabled = !own || locked;
    $('fxPresetDescription').textContent = preset ? `${preset.createdBy} · ${preset.effects.map(effect => `${t('effect.' + effect.type)} ${Math.round(effect.amount * 100)}%${effect.enabled ? '' : ' (' + t('fx.disabled') + ')'}`).join(' → ') || t('effect.none')}${preset.pitch === undefined ? '' : ' · ' + t('pitch') + ' ' + preset.pitch}` : t('preset.empty');
    $('fxPresetRetry').hidden = !operation; $('fxPresetRetry').disabled = sending;
  }
  function receive(data) {
    if (data.sessionId !== session.activeSessionId || !model.validLibrary(data.voicePresets) || !acceptSessionProtocol(data.editorProtocol)) return;
    session.voicePresets = data.voicePresets; if (data.roleEffects) session.roleEffects = data.roleEffects; synchronizeAudio(); if (data.lines?.length) applyTakeUpdates(data.sessionId, data.lines, data.editorProtocol, { prewarm: false }); else if (selectedLine) showInspector(selectedLine); refresh(); window.DublineVoiceEditor.catalogChanged?.();
  }
  const call = (event, request) => new Promise(resolve => socket.timeout(5000).emit(event, request, (error, answer) => resolve(error ? null : answer)));
  async function send() {
    if (!operation || sending || !socket.connected) return;
    sending = true; $('fxDialog').querySelector('.fx-body').inert = true; refresh(); const captured = operation;
    try {
      let answer;
      if (captured.sent) { const known = await call('editor_operation_status', { event: 'voice_preset_update', request: captured.request });
        if (known?.ok && known.state === 'known') answer = known.result;
        else if (!known?.ok || known.state !== 'unseen' || !known.retryable) { status('preset.syncError'); return; }
      }
      if (!answer) { captured.sent = true; for (let attempt = 0; attempt < 2 && !answer; attempt++) answer = await call('voice_preset_update', captured.request); }
      if (!answer) { const known = await call('editor_operation_status', { event: 'voice_preset_update', request: captured.request }); if (known?.ok && known.state === 'known') answer = known.result; }
      if (captured !== operation) return;
      if (answer?.ok && captured.request.action === 'delete' && !await resyncEditor()) { status('preset.syncError'); return; }
      if (answer) operation = null;
      if (answer?.ok) { receive({ sessionId: captured.request.sessionId, voicePresets: answer.voicePresets, editorProtocol: answer.editorProtocol }); status('preset.saved'); editor.catalogSaved(captured.request.id, captured.request.revision); if (captured.linkDraft && editor.draft()?.sessionId === captured.request.sessionId && editor.draft()?.draftId === captured.draftId) { try { editor.usePreset(session.voicePresets[captured.request.id], false, true, true); } catch (error) { status(error.message); } } if (session.activeSessionId === captured.request.sessionId && Object.hasOwn(session.voicePresets || {}, captured.request.id)) { $('fxPresetSelect').value = captured.request.id; refresh(); } }
      else status(answer?.reason?.startsWith('preset.') ? answer.reason : 'preset.syncError');
    } catch { status('preset.syncError'); }
    finally { sending = false; $('fxDialog').querySelector('.fx-body').inert = !!operation; refresh(); }
  }
  function mutate(data, draft, linkDraft = false) {
    if (operation || sending || !draft || draft.sessionId !== session.activeSessionId || editor.draft()?.draftId !== draft.draftId) return;
    operation = { linkDraft, draftId: draft.draftId, request: { ...data, sessionId: draft.sessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() }, sent: false };
    void send();
  }
  $('fxPresetSave').onclick = async () => { const draft = editor.draft(); if (!draft || operation) return;
    const settings = { effects: structuredClone(draft.effects), pitch: draft.pitch }, name = await askText(t('preset.name'), draft.character.slice(0, model.MAX_NAME), model.MAX_NAME);
    if (name && editor.draft()?.sessionId === draft.sessionId) mutate({ action: 'create', id: newUploadId(), revision: 0, name, icon: draft.icon, settings }, draft, draft.scope !== 'preset');
  };
  $('fxPresetApply').onclick = async () => {
    const draft = editor.draft(), preset = structuredClone(selected()); if (!draft || !preset) return;
    if ((editor.dirty() || draft.effects.length || draft.replaceHasContent) && !await askConfirm(t('chain.replaceConfirm'))) return;
    if (editor.draft()?.sessionId !== draft.sessionId || editor.draft()?.draftId !== draft.draftId) return;
    try { editor.usePreset(preset); status('preset.draftApplied'); }
    catch (error) { status(error.message); }
  };
  for (const action of ['rename', 'update', 'delete']) $('fxPreset' + action[0].toUpperCase() + action.slice(1)).onclick = async () => {
    const draft = editor.draft(), preset = structuredClone(selected()); if (!draft || !preset || operation) return;
    const data = { action, id: preset.id, revision: preset.revision };
    if (action === 'update') { if (draft.presetId === preset.id) await updateSource(); else if (await editor.close()) editor.open(preset.id, 'preset'); return; }
    if (action === 'rename') { data.name = await askText(t('preset.name'), preset.name, model.MAX_NAME); if (!data.name) return; }
    else { data.settings = { effects: structuredClone(draft.effects), pitch: draft.pitch }; if (!await askConfirm(t(action === 'delete' && (model.usage(session, preset.id).lines.length || model.usage(session, preset.id).roles.length) ? 'live.deleteUsed' : action === 'delete' ? 'preset.deleteConfirm' : 'preset.updateConfirm', { name: preset.name, n: model.usage(session, preset.id).lines.length, r: model.usage(session, preset.id).roles.length }), { danger: action === 'delete' })) return; if (action === 'delete') { delete data.settings; data.detach = true; } }
    mutate(data, draft);
  };
  $('fxPresetSelect').onchange = refresh; $('fxPresetRetry').onclick = () => send();
  socket.on('voice_presets_updated', receive); socket.on('session_updated', () => { synchronizeAudio(); refresh(); window.DublineVoiceEditor.catalogChanged?.(); });
  window.addEventListener('dubline-language-changed', () => { DublineI18n.apply(area); refresh(); });
  async function updateSource() {
    const draft = editor.draft(), preset = session.voicePresets?.[draft?.presetId];
    if (!draft || !preset || operation || sending || !canModerate() && preset.createdBy !== myName) return;
    const usage = model.usage(session, preset.id), revision = draft.sourceRevision;
    if (!await askConfirm(t('chain.updateConfirm', { name: preset.name, n: usage.lines.length, r: usage.roles.length }))) return;
    if (editor.draft()?.sessionId !== draft.sessionId || editor.draft()?.draftId !== draft.draftId) return;
    mutate({ action: 'update', id: preset.id, revision, icon: draft.icon, settings: { effects: structuredClone(draft.effects), ...(draft.pitch === undefined ? {} : { pitch: draft.pitch }) } }, draft, draft.scope !== 'preset');
  }
  window.DublinePresetUI = { updateSource, refresh, begin: () => { $('fxPresetSelect').value = editor.draft()?.presetId || ''; status(); refresh(); }, pending: () => !!operation || sending, receive };
  DublineI18n.apply(area); refresh();
})();
