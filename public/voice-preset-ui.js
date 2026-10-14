(() => {
  const model = DublineVoicePresets, editor = DublineVoiceEditor, $ = id => document.getElementById(id);
  let operation = null, sending = false;
  function status(key = '') { const node = $('fxPresetStatus'); if (key) node.dataset.i18n = key; else delete node.dataset.i18n; node.textContent = key ? t(key) : ''; }
  const area = document.createElement('details'); area.className = 'fx-presets'; area.id = 'fxPresets';
  area.innerHTML = `<summary data-i18n="preset.title"></summary><div class="fx-preset-controls"><select id="fxPresetSelect" aria-label="${esc(t('preset.title'))}"></select><button type="button" id="fxPresetApply" class="btn-outline" data-i18n="preset.apply"></button><select id="fxPresetMode" aria-label="${esc(t('preset.mode'))}"><option value="replace" data-i18n="preset.replace"></option><option value="append" data-i18n="preset.append"></option></select></div>
    <label class="fx-preset-pitch"><span data-i18n="preset.pitch"></span><span class="switch-ui"><input type="checkbox" id="fxPresetPitch" aria-label="${esc(t('preset.pitch'))}"><span class="switch-slider"></span></span></label><p class="setting-sub" data-i18n="preset.inheritanceHelp"></p><p id="fxPresetDescription" class="setting-sub"></p>
    <div class="insp-actions"><button type="button" id="fxPresetSave" class="btn-outline" data-i18n="preset.saveAs"></button><details class="fx-preset-menu"><summary data-i18n="preset.manage"></summary><div class="insp-actions"><button type="button" id="fxPresetRename" class="btn-outline" data-i18n="preset.rename"></button><button type="button" id="fxPresetUpdate" class="btn-outline" data-i18n="preset.update"></button><button type="button" id="fxPresetDelete" class="btn-outline" data-i18n="preset.delete"></button></div></details></div>
    <p id="fxPresetStatus" role="status" aria-live="polite"></p><button type="button" id="fxPresetRetry" class="btn-outline" data-i18n="preset.retry" hidden></button>`;
  $('fxDialog').querySelector('.fx-body').append(area);
  const selected = () => Object.hasOwn(session?.voicePresets || {}, $('fxPresetSelect').value) ? session.voicePresets[$('fxPresetSelect').value] : null;
  function refresh() {
    $('fxPresetSelect').setAttribute('aria-label', t('preset.title')); $('fxPresetMode').setAttribute('aria-label', t('preset.mode')); $('fxPresetPitch').setAttribute('aria-label', t('preset.pitch'));
    const previous = $('fxPresetSelect').value, presets = Object.values(session?.voicePresets || {});
    $('fxPresetSelect').replaceChildren(new Option(t('preset.choose'), ''), ...presets.map(preset => new Option(preset.name, preset.id)));
    if (presets.some(preset => preset.id === previous)) $('fxPresetSelect').value = previous;
    const preset = selected(), own = !!preset && (canModerate() || preset.createdBy === myName), locked = sending || !!operation;
    for (const id of ['fxPresetSelect', 'fxPresetMode', 'fxPresetPitch', 'fxPresetSave']) $(id).disabled = locked;
    $('fxPresetApply').disabled = !preset || locked; for (const id of ['fxPresetRename', 'fxPresetUpdate', 'fxPresetDelete']) $(id).disabled = !own || locked;
    $('fxPresetPitch').disabled = locked || !preset || preset.pitch === undefined;
    $('fxPresetDescription').textContent = preset ? `${preset.createdBy} · ${preset.effects.map(effect => `${t('effect.' + effect.type)} ${Math.round(effect.amount * 100)}%${effect.enabled ? '' : ' (' + t('fx.disabled') + ')'}`).join(' → ') || t('effect.none')}${preset.pitch === undefined ? '' : ' · ' + t('pitch') + ' ' + preset.pitch}` : t('preset.empty');
    $('fxPresetRetry').hidden = !operation; $('fxPresetRetry').disabled = sending;
  }
  function receive(data) {
    if (data.sessionId !== session.activeSessionId || !model.validLibrary(data.voicePresets) || !acceptSessionProtocol(data.editorProtocol)) return;
    session.voicePresets = data.voicePresets; refresh();
  }
  const call = (event, request) => new Promise(resolve => socket.timeout(5000).emit(event, request, (error, answer) => resolve(error ? null : answer)));
  async function send() {
    if (!operation || sending || !socket.connected) return;
    sending = true; refresh(); const captured = operation;
    try {
      let answer;
      if (captured.sent) { const known = await call('editor_operation_status', { event: 'voice_preset_update', request: captured.request });
        if (known?.ok && known.state === 'known') answer = known.result;
        else if (!known?.ok || known.state !== 'unseen' || !known.retryable) { status('preset.syncError'); return; }
      }
      if (!answer) { captured.sent = true; for (let attempt = 0; attempt < 2 && !answer; attempt++) answer = await call('voice_preset_update', captured.request); }
      if (!answer) { const known = await call('editor_operation_status', { event: 'voice_preset_update', request: captured.request }); if (known?.ok && known.state === 'known') answer = known.result; }
      if (captured !== operation) return;
      if (answer) operation = null;
      if (answer?.ok) { receive({ sessionId: captured.request.sessionId, voicePresets: answer.voicePresets, editorProtocol: answer.editorProtocol }); status('preset.saved'); if (session.activeSessionId === captured.request.sessionId && Object.hasOwn(session.voicePresets || {}, captured.request.id)) { $('fxPresetSelect').value = captured.request.id; refresh(); } }
      else status(answer?.reason?.startsWith('preset.') ? answer.reason : 'preset.syncError');
    } catch { status('preset.syncError'); }
    finally { sending = false; refresh(); }
  }
  function mutate(data, draft) {
    if (operation || sending || !draft || draft.sessionId !== session.activeSessionId) return;
    operation = { request: { ...data, sessionId: draft.sessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() }, sent: false };
    void send();
  }
  $('fxPresetSave').onclick = async () => { const draft = editor.draft(); if (!draft || operation) return;
    const settings = { effects: structuredClone(draft.effects), pitch: draft.pitch }, name = await askText(t('preset.name'), draft.character.slice(0, model.MAX_NAME), model.MAX_NAME);
    if (name && editor.draft()?.sessionId === draft.sessionId) mutate({ action: 'create', id: newUploadId(), revision: 0, name, settings }, draft);
  };
  $('fxPresetApply').onclick = async () => {
    const draft = editor.draft(), preset = structuredClone(selected()), append = $('fxPresetMode').value === 'append', pitch = $('fxPresetPitch').checked; if (!draft || !preset) return;
    if (!append && editor.dirty()) { const decision = await askDraftDecision(); if (!decision) return; if (decision === 'save' && !await editor.apply(true)) return; }
    else if (!append && draft.effects.length && !await askConfirm(t('preset.replaceConfirm'))) return;
    if (editor.draft()?.sessionId !== draft.sessionId || editor.draft()?.character !== draft.character) return;
    try { editor.usePreset(preset, append, pitch); status('preset.draftApplied'); }
    catch (error) { status(error.message); }
  };
  for (const action of ['rename', 'update', 'delete']) $('fxPreset' + action[0].toUpperCase() + action.slice(1)).onclick = async () => {
    const draft = editor.draft(), preset = structuredClone(selected()); if (!draft || !preset || operation) return;
    const data = { action, id: preset.id, revision: preset.revision };
    if (action === 'rename') { data.name = await askText(t('preset.name'), preset.name, model.MAX_NAME); if (!data.name) return; }
    else { data.settings = { effects: structuredClone(draft.effects), pitch: draft.pitch }; if (!await askConfirm(t(action === 'delete' ? 'preset.deleteConfirm' : 'preset.updateConfirm', { name: preset.name }), { danger: action === 'delete' })) return; if (action === 'delete') delete data.settings; }
    mutate(data, draft);
  };
  $('fxPresetSelect').onchange = refresh; $('fxPresetRetry').onclick = () => send();
  socket.on('voice_presets_updated', receive); socket.on('session_updated', refresh);
  window.addEventListener('dubline-language-changed', () => { DublineI18n.apply(area); refresh(); });
  window.DublinePresetUI = { refresh, begin: () => { $('fxPresetPitch').checked = false; $('fxPresetMode').value = 'replace'; status(); refresh(); }, pending: () => !!operation || sending };
  DublineI18n.apply(area); refresh();
})();
