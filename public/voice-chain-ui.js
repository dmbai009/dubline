(function() {
  'use strict';
  const model = window.DublineVoiceChain, $ = id => document.getElementById(id);
  let state = null, context = null, source = null, gain = null, buffer = null, position = 0, started = 0;
  function status(key = '') { if (state?.applyError && ['fx.processing', 'fx.ready', 'fx.processingError'].includes(key)) key = state.applyError; const node = $('fxStatus'); if (key) node.dataset.i18n = key; else delete node.dataset.i18n; node.textContent = key ? t(key) : ''; }
  let playing = false, generation = 0, timer = null, abort = null, rendering = false, drag = null, begin = 0, end = 0;
  let expandedKey = null;
  let lastRoleScene = session?.activeSessionId, lastRoles = structuredClone(session?.roleEffects || {});
  const icons = { robot: '<rect x="5" y="7" width="14" height="13" rx="3"/><path d="M12 3v4M8 12h1m6 0h1M9 16h6"/>', radio: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="m5 7 13-4M7 12h10M7 16h3m4 0h3"/>', telephone: '<path d="M7 3 3 6c0 8 7 15 15 15l3-4-5-3-2 3c-3-1-6-4-7-7l3-2z"/>', monster: '<path d="m5 8-2-5 6 3h6l6-3-2 5v10l-7 4-7-4zM8 12h1m6 0h1M8 17l2-2 2 2 2-2 2 2"/>', thoughts: '<path d="M6 17c-7-7 3-16 8-10 7-3 11 9 3 10H6z"/><circle cx="6" cy="21" r="1"/>', cave: '<path d="M2 21 7 5l5-3 5 4 5 15H2zM8 21v-7l4-5 4 5v7"/>', behindDoor: '<path d="M5 21V4l13-2v19M3 21h18M14 12h1"/>', megaphone: '<path d="m4 9 15-5v16L4 15V9zM7 16l2 5h3l-2-4M2 10v4"/>', echo: '<path d="M4 9v6m4-9v12m4-15v18m4-15v12m4-9v6"/>' };
  const icon = type => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[type] + '</svg>';
  const label = items => items.length ? items.map(item => `${t('effect.' + item.type)} ${Math.round(item.amount * 100)}%${item.enabled ? '' : ' (' + t('fx.disabled') + ')'}`).join(' → ') : t('effect.none');
  const button = (text, action, disabled = false) => `<button type="button" class="btn-outline" ${disabled ? 'disabled' : ''} onclick="${action}">${esc(text)}</button>`;
  const fingerprint = () => state && JSON.stringify({ settings: { ...state.settings, revision: undefined }, pitch: state.pitch, presetHasPitch: state.presetHasPitch, presetIcon: state.scope === 'preset' ? state.presetIcon : undefined, action: state.action,
    edits: state.takes.length > 1 ? [state.editPitch, state.editInheritance, state.editExceptions] : [] });
  const dirty = () => !!state && fingerprint() !== state.baseline;
  function summary(line) { const effects = model.active(model.resolve(line, session).effects); return label(effects.slice(0, 3)) + (effects.length > 3 ? ` (+${effects.length - 3})` : ''); }
  function paintScope() {
    if (!state) return;
    if (state.scope === 'preset') { const preset = session.voicePresets[state.presetId]; $('fxTitle').textContent = t('live.edit') + ': ' + (preset?.name || t('preset.missing')); $('fxScope').textContent = t('live.impact', { n: DublineVoicePresets.usage(session, state.presetId).lines.length }); $('fxApply').textContent = t('live.save'); }
    else { $('fxApply').textContent = t(state.scope === 'role' ? 'chain.applyRole' : 'chain.applyTake'); $('fxTitle').textContent = t(state.scope === 'role' ? 'fx.role' : 'fx.take') + (state.scope === 'role' ? ': ' + state.character : ' · ' + state.takes.length);
    $('fxScope').textContent = t(state.scope === 'role' ? 'fx.roleScope' : 'fx.takeScope', { n: state.scope === 'role' ? session.lines.filter(line => line.character === state.character).length : state.takes.length }); }
    dialog.dataset.scope = state.scope; window.DublinePresetUI?.refresh(); $('fxDirty').hidden = !dirty(); paintLinked(); paintFlow();
  }
  function html(line) {
    const role = model.roleVoice(session, line.character), own = model.take(line);
    const key = `${currentRoom}:${session.activeSessionId}:${line.id}`;
    return `<section class="fx-inspector"><div class="insp-section-title"><b>${esc(t('voice'))}</b>${button(t('preset.quick.editor'), `DublineVoiceEditor.open(${line.id}, 'takes')`, !canEditTake(line))}</div>
      ${window.DublineInspector?.presetHtml(line) || ''}<p class="insp-chain-text" title="${esc(label(model.resolve(line, session).effects))}">${esc(summary(line))}</p>
      <div class="insp-role-voice"><span>${esc(t(!role.effects.length ? 'chain.roleNone' : own.inheritRoleEffects ? 'chain.roleOn' : 'chain.roleOff'))} · ${esc(line.character)} · ${esc(label(role.effects))}</span>${button(t('fx.configureRole'), `DublineVoiceEditor.open(${line.id}, 'role')`, !canModerate())}</div></section>`;
  }
  function bulkHtml(lines) {
    const eligible = lines.filter(line => line.audioUrl && canEditTake(line));
    const configs = lines.map(line => JSON.stringify(model.take(line)));
    return `<section class="take-panel fx-summary"><b>${esc(t('fx.take'))}</b><p>${esc(configs.every(value => value === configs[0]) ? label(model.take(lines[0]).effects) : t('clip.mixed'))}</p>${button(t('fx.configureBulk', { n: eligible.length }), 'DublineVoiceEditor.bulk()', !eligible.length)}</section>`;
  }
  function canPreview(line) { return line?.audioUrl && canHearLine(line); }
  function open(id, scope, ids) {
    if (recordState !== 'idle' || window.DublineNoise?.busy?.() || document.querySelector('dialog[open]')) return showToast(t('fx.busy'));
    const sharedPreset = scope === 'preset' ? session.voicePresets?.[id] : null;
    if (scope === 'preset' && (!sharedPreset || !canModerate() && sharedPreset.createdBy !== myName)) return showToast(t('preset.owner'));
    const line = scope === 'preset' ? session.lines.find(canPreview) || { id: null, character: '', pitch: 0 } : scope === 'role' && typeof id === 'string' && session.trackOrder.includes(id) ? session.lines.find(item => item.character === id) || { id: null, character: id, pitch: 0 } : session.lines.find(item => item.id === id); if (!line) return;
    if (scope !== 'preset' && (scope === 'role' ? !canModerate() : !canEditTake(line))) return showToast(t('fx.owner'));
    const lines = scope === 'preset' ? session.lines.filter(canPreview) : ids ? session.lines.filter(item => ids.includes(item.id) && item.audioUrl && canEditTake(item)) : [line];
    const ownEntry = model.editable(line, session), own = model.take(ownEntry), role = model.editable(model.role(session, line.character), session);
    const presetLines = scope === 'preset' ? new Set(DublineVoicePresets.usage(session, sharedPreset.id).lines) : null, presetSamples = presetLines ? lines.filter(item => presetLines.has(item.id)) : [];
    own.excludedRoleEffectIds = own.excludedRoleEffectIds.filter(id => model.roleVoice(session, line.character).effects.some(item => item.id === id));
    state = { draftId: newUploadId(), scope, sessionId: session.activeSessionId, character: line.character, revision: role.revision || 0,
      sourceRevision: model.preset(session, scope === 'role' ? role : own)?.revision, presetId: sharedPreset?.id, presetIcon: sharedPreset?.icon || model.preset(session, scope === 'role' ? role : own)?.icon || 'voice', presetHasPitch: sharedPreset?.pitch !== undefined, presetRevision: sharedPreset?.revision, presetOriginal: sharedPreset && JSON.stringify([sharedPreset.effects, sharedPreset.pitch, sharedPreset.icon]), previousPresetRevision: role.voicePresetId ? model.preset(session, role)?.revision : undefined, editPreset: false,
      settings: scope === 'preset' ? { effects: structuredClone(sharedPreset.effects), pitch: sharedPreset.pitch ?? 0 } : scope === 'role' ? structuredClone(role) : own, pitch: scope === 'preset' ? sharedPreset.pitch ?? 0 : scope === 'role' ? role.pitch : ownEntry.pitch || 0, editPitch: false, editInheritance: false, editExceptions: false, action: 'replace', effectDrafts: { replace: structuredClone(own.effects), append: [] },
      pitchSnapshot: lines.map(item => ({ character: item.character, pitch: item.pitch || 0, mode: model.take(item).pitchMode })),
      takes: lines.map(item => ({ lineId: item.id, character: item.character, audioUrl: item.audioUrl, takeId: item.takeId || null, takeMixRevision: item.takeMixRevision || 0, presetRevision: model.preset(session, item)?.revision })),
      samples: (scope === 'preset' ? presetSamples.length ? presetSamples : lines : scope === 'role' ? session.lines.filter(item => item.character === line.character) : lines).filter(canPreview).map(item => structuredClone(item)),
      sampleId: null, focus: document.activeElement };
    $('fxTitle').textContent = t(scope === 'role' ? 'fx.role' : 'fx.take') + (scope === 'role' ? ': ' + line.character : ' · ' + lines.length);
    $('fxScope').textContent = t(scope === 'role' ? 'fx.roleScope' : 'fx.takeScope', { n: scope === 'role' ? session.lines.filter(item => item.character === line.character).length : lines.length });
    $('fxPresetIncludePitchRow').hidden = scope !== 'preset'; $('fxPresetIncludePitch').checked = state.presetHasPitch; $('fxInheritRow').hidden = scope !== 'takes'; $('fxInherit').checked = own.inheritRoleEffects; $('fxInherit').disabled = false; $('fxInherit').indeterminate = lines.some(item => model.take(item).inheritRoleEffects !== own.inheritRoleEffects);
    $('fxPitchMode').querySelector('[value="mixed"]')?.remove(); $('fxPitchMode').hidden = scope !== 'takes'; $('fxPitchMode').value = own.pitchMode; $('fxPitchMode').disabled = false;
    paintPitch();
    $('fxActionRow').hidden = lines.length < 2 || scope !== 'takes'; $('fxAction').value = 'replace';
    $('fxSample').replaceChildren(new Option(t('fx.noSample'), ''), ...state.samples.map(item => new Option(`#${lineNumber(item)} · ${item.caption || ''}`, String(item.id))));
    const candidate = state.samples.find(item => item.id === id) || state.samples[0];
    if (candidate) { state.sampleId = candidate.id; $('fxSample').value = candidate.id; }
    $('fxAB').value = 'wet'; $('fxLoop').checked = false; status(); $('fxRefresh').hidden = true; $('fxApply').disabled = false; $('fxPlay').disabled = !buffer;
    $('fxAction').querySelector('[value=detach]')?.remove(); state.baseline = fingerprint(); state.initialEffects = JSON.stringify(state.settings.effects); window.DublinePresetUI?.begin();
    audio.stopPreview(); window.DublineTakeHistory?.stop(); rows(); exclusions(); paintScope(); $('fxDialog').showModal(); (scope !== 'takes' ? $('fxPitch') : $('fxInherit')).focus(); schedule();
  }
  async function close(force = false) {
    if (!force && (state?.pending || window.DublinePresetUI?.pending())) return false;
    if (!force && state?.pendingRequest) { status('fx.syncError'); return false; }
    if (!force && dirty()) { const captured = state, decision = await askDraftDecision(); if (captured !== state || !decision) return false; if (decision === 'save') return apply(); }
    cleanupDrag();
    clearTimeout(timer); abort?.abort(); ++generation; stop(false);
    if (context) { DublineAudioDevices.unregisterContext(context); void context.close(); } context = null; buffer = null;
    const focus = state?.focus; state = null; $('fxDialog').close(); if (focus?.isConnected) focus.focus();
    dialog.querySelector('.fx-body').inert = false;
    return true;
  }
  function stop(keep = true) {
    if (keep && playing && context) position = currentPosition(); else if (!keep) position = 0;
    playing = false; if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); } gain?.disconnect(); source = null; gain = null;
    $('fxPlay').textContent = t('fx.play');
  }
  function currentPosition() { const at = position + (context.currentTime - started); return $('fxLoop').checked ? begin + Math.max(0, at - begin) % Math.max(.001, end - begin) : Math.min(end, at); }
  async function play() {
    if (!state || !buffer) return;
    if (!context) { context = new (window.AudioContext || window.webkitAudioContext)(); DublineAudioDevices.registerContext(context); }
    const scope = state, output = context; await DublineAudioDevices.ready(); await output.resume(); if (scope !== state || context !== output || !buffer) return;
    const node = context.createBufferSource(), level = context.createGain(); node.buffer = buffer; node.loop = $('fxLoop').checked; node.loopStart = begin; node.loopEnd = end;
    node.connect(level).connect(context.destination); level.gain.setValueAtTime(0, context.currentTime); level.gain.linearRampToValueAtTime(scope.auditionGain || 1, context.currentTime + .03);
    if (source) { const old = source, oldGain = gain; old.onended = null; oldGain.gain.cancelScheduledValues(context.currentTime); oldGain.gain.setValueAtTime(oldGain.gain.value, context.currentTime); oldGain.gain.linearRampToValueAtTime(0, context.currentTime + .03); old.stop(context.currentTime + .035); old.onended = () => { old.disconnect(); oldGain.disconnect(); }; }
    source = node; gain = level; started = context.currentTime; playing = true;
    const offset = Math.max(begin, Math.min(position, Math.max(begin, end - .001)));
    if (node.loop) node.start(0, offset); else node.start(0, offset, Math.max(.001, end - offset));
    node.onended = () => { if (source === node) stop(false); };
    $('fxPlay').textContent = t('fx.pause');
  }
  function schedule() { paintScope(); clearTimeout(timer); abort?.abort(); ++generation; timer = setTimeout(render, 100); }
  function previewDraft(sample, scope = state) {
      const test = { ...sample }, scene = { ...session, roleEffects: Object.assign(Object.create(null), session.roleEffects), voicePresets: Object.assign(Object.create(null), session.voicePresets) };
      if (scope.scope === 'preset') { scene.voicePresets[scope.presetId] = { ...scene.voicePresets[scope.presetId], effects: structuredClone(scope.settings.effects) }; if (scope.presetHasPitch) scene.voicePresets[scope.presetId].pitch = scope.pitch; else delete scene.voicePresets[scope.presetId].pitch; if (!DublineVoicePresets.usage(scene, scope.presetId).lines.includes(test.id)) Object.assign(test, DublineVoicePresets.link(test, scene, scope.presetId, true)); }
      else if (scope.scope === 'role') scene.roleEffects[scope.character] = { ...scope.settings, pitch: scope.pitch };
      else {
        const original = model.take(sample), settings = structuredClone(original); let pitch = sample.pitch || 0;
        if (scope.action === 'replace') {
          Object.assign(settings, structuredClone(scope.settings));
          if (scope.takes.length > 1) { if (!scope.editInheritance) settings.inheritRoleEffects = original.inheritRoleEffects; if (!scope.editExceptions) settings.excludedRoleEffectIds = original.excludedRoleEffectIds; if (!scope.editPreset) { settings.voicePresetId = original.voicePresetId; settings.usePresetPitch = original.usePresetPitch; if (original.presetModified === undefined) delete settings.presetModified; else settings.presetModified = original.presetModified; } }
          if (scope.takes.length > 1 && !scope.editPitch) settings.pitchMode = original.pitchMode; else pitch = scope.pitch;
        }
        if (scope.action === 'append') settings.effects.push(...structuredClone(scope.settings.effects));
        if (scope.action === 'append' && scope.editPitch) { pitch = scope.pitch; settings.pitchMode = 'override'; }
        if (scope.action === 'clear') settings.effects = [];
        if (scope.action === 'inherit') settings.inheritRoleEffects = scope.settings.inheritRoleEffects;
        Object.assign(test, scope.action === 'detach' ? DublineVoicePresets.detach(test, scene, newUploadId) : settings, scope.action === 'detach' ? {} : { pitch });
      }
      return { test, scene };
  }
  function paintFlow() {
    if (!state) return;
    const sample = state.samples.find(item => item.id === state.sampleId) || { character: state.character, pitch: 0 };
    const { test, scene } = previewDraft(sample), voice = model.resolve(test, scene), own = model.take(test);
    const role = model.role(scene, test.character), inherited = model.roleVoice(scene, test.character).effects;
    const collapseRole = inherited.length > 0 && state.scope !== 'role' && !(state.scope === 'preset' && role.voicePresetId === state.presetId);
    const steps = [{ label: t('fx.layout.input') }];
    if (window.DublineNoiseModel?.resolve(test, scene)) steps.push({ label: 'RNNoise' });
    if (voice.pitch) steps.push({ label: t('pitch') + ' ' + (voice.pitch > 0 ? '+' : '') + voice.pitch });
    if (collapseRole) {
      const preset = model.preset(scene, role), active = own.inheritRoleEffects && model.active(inherited.filter(item => !own.excludedRoleEffectIds.includes(item.id))).length > 0;
      const name = (preset?.name || test.character) + (role.presetModified && preset ? ' ' + t('chain.modified') : '');
      steps.push({ role: true, active, label: t('chain.roleBadge', { name }) + (active ? '' : ' · ' + t('fx.disabled')) });
    }
    steps.push(...model.active(collapseRole ? model.ownEffects(own, scene) : voice.effects).map(item => ({ label: t('fx.name.' + item.type) })), { label: t('fx.layout.output') });
    $('fxFlow').innerHTML = steps.map((step, i) => '<span class="fx-flow-step' + (step.role ? ' fx-flow-role' : '') + '"' + (step.role ? ' data-active="' + step.active + '" title="' + esc(t(step.active ? 'chain.roleBadgeHelp' : 'chain.roleBadgeOff')) + '"' : '') + '>' + esc(step.label) + '</span>' + (i < steps.length - 1 ? '<span class="fx-flow-arrow" aria-hidden="true">→</span>' : '')).join('');
  }
  async function render() {
    if (!state || rendering) return;
    paintPitch(); const token = generation, scope = state, sample = scope.samples.find(item => item.id === scope.sampleId);
    if (!sample) { $('fxPlay').disabled = true; window.setControlHelp?.($('fxPlay'), t('fx.noSampleHelp')); status('fx.noSample'); return; }
    if (!session.lines.some(item => item.id === sample.id && item.audioUrl === sample.audioUrl && canHearLine(item))) return close(true);
    rendering = true; abort = new AbortController(); status('fx.processing');
    try {
      const { test, scene } = previewDraft(sample, scope);
      if ($('fxAB').value !== 'dry' && !model.safe(model.resolve(test, scene))) throw Error('fx.limit');
      test._exportVoice = $('fxAB').value === 'dry' ? { pitch: 0, effects: [], tail: 0 } : model.resolve(test, scene);
      const { buffer: processed, gain: levelGain } = await audio.prepareTake(test, { scene, uncached: true, signal: abort.signal });
      if (scope !== state || token !== generation) return;
      if (!processed) throw Error('fx.processingError'); scope.auditionGain = levelGain;
      const at = playing ? currentPosition() : position;
      const bounds = audio.takeBounds(test, processed.duration); begin = bounds.from; end = bounds.to; buffer = processed; position = Math.max(begin, Math.min(at, end));
      $('fxPlay').disabled = false;
      window.setControlHelp?.($('fxPlay'), '');
      if (playing) await play(); status('fx.ready');
    } catch (error) { if (token === generation && state && error.name !== 'AbortError') { stop(false); buffer = null; $('fxPlay').disabled = true; window.setControlHelp?.($('fxPlay'), t('fx.processingError')); status(error.message.startsWith('fx.') ? error.message : 'fx.processingError'); } }
    finally { rendering = false; if (state && token !== generation) schedule(); }
  }
  function rows(focusId) {
    cleanupDrag();
    const linked = linkedDraft(), preset = model.preset(session, state.settings);
    const items = state.scope === 'preset' ? state.settings.effects : model.ownEffects(state.settings, session);
    $('fxRows').innerHTML = items.map((item, index) => `<div class="fx-item" role="listitem" data-fx-id="${esc(item.id)}" data-index="${index}" data-enabled="${item.enabled}">
      <div class="fx-item-head"><button type="button" class="btn-icon fx-grip" aria-label="${esc(t('fx.drag'))}" ${''}>⠿</button><span class="fx-step" title="${esc(t('fx.layout.step', { n: index + 1 }))}">${index + 1}</span><span class="fx-effect-icon">${icon(item.type)}</span><b>${esc(t('fx.name.' + item.type))}</b>
      <label class="switch-ui"><input type="checkbox" data-action="enabled" aria-label="${esc(t('fx.enabled'))} · ${esc(t('fx.name.' + item.type))}" ${item.enabled ? 'checked' : ''}><span class="switch-slider"></span></label></div>
      <label class="fx-slider"><span>${esc(t('fx.amount'))}</span><output>${Math.round(item.amount * 100)}%</output><input type="range" data-action="amount" data-reset-value="100" data-reset-event="input" min="0" max="100" value="${Math.round(item.amount * 100)}" aria-label="${esc(t('fx.amount'))} · ${esc(t('fx.name.' + item.type))}"></label>
      ${item.type === 'echo' ? `<div class="fx-echo" role="group" aria-label="${esc(t('fx.layout.echo'))}"><label>${esc(t('fx.layout.delay'))}<input type="number" data-action="delay" min="0.03" max="0.8" step="0.01" value="${model.echo(item.parameters).delay}"></label><label>${esc(t('fx.layout.feedback'))}<input type="number" data-action="feedback" min="0" max="0.7" step="0.05" value="${model.echo(item.parameters).feedback}"></label></div>` : ''}
      <div class="fx-item-actions"><button type="button" class="btn-icon" data-action="up" aria-label="${esc(t('fx.up'))}" ${index ? '' : 'disabled'}>←</button><button type="button" class="btn-icon" data-action="down" aria-label="${esc(t('fx.down'))}" ${index < items.length - 1 ? '' : 'disabled'}>→</button><button type="button" class="btn-icon fx-remove" data-action="delete" aria-label="${esc(t('fx.remove'))}">×</button></div></div>`).join('');
    const inactive = ['clear', 'inherit', 'detach'].includes(state.action);
    $('fxRows').inert = false; $('fxRows').hidden = inactive; $('fxClearChain').disabled = inactive || !items.length;
    $('fxEmpty').hidden = !!items.length || inactive;
    $('fxType').disabled = inactive; $('fxClear').disabled = inactive || !items.length; $('fxAdd').disabled = inactive || items.length >= model.MAX_EFFECTS;
    for (const button of $('fxPalette').children) button.disabled = $('fxAdd').disabled;
    $('fxCount').textContent = items.length + ' / ' + model.MAX_EFFECTS;
    if (focusId) [...$('fxRows').children].find(item => item.dataset.fxId === focusId)?.querySelector('.fx-grip').focus();
  }
  function exclusions() {
    const inherited = state.scope !== 'takes' || new Set(state.takes.map(item => item.character)).size > 1 ? [] : model.roleVoice(session, state.character).effects;
    $('fxExceptions').replaceChildren();
    for (const item of inherited) {
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = !state.settings.excludedRoleEffectIds.includes(item.id); input.disabled = !state.settings.inheritRoleEffects || state.action !== 'replace';
      input.onchange = () => { state.editExceptions = true; const ids = new Set(state.settings.excludedRoleEffectIds); input.checked ? ids.delete(item.id) : ids.add(item.id); state.settings.excludedRoleEffectIds = [...ids]; schedule(); };
      label.append(input, document.createTextNode(t('effect.' + item.type))); $('fxExceptions').append(label);
    }
    $('fxExceptions').hidden = !inherited.length || !state.settings.excludedRoleEffectIds.length;
  }
  function paintPitch() {
    if (!state) return;
    if (state.scope === 'takes' && state.takes.length > 1 && !state.editPitch) {
      const pitches = state.pitchSnapshot.map(item => JSON.stringify([item.mode, item.mode === 'inherit' ? model.roleVoice(session, item.character).pitch : item.pitch]));
      if (pitches.some(value => value !== pitches[0])) {
        if (!$('fxPitchMode').querySelector('[value="mixed"]')) { const option = new Option(t('clip.mixed'), 'mixed'); option.disabled = true; option.dataset.i18n = 'clip.mixed'; $('fxPitchMode').append(option); }
        $('fxPitchMode').value = 'mixed'; $('fxPitch').disabled = true; $('fxPitchValue').textContent = t('clip.mixed'); return;
      }
    }
    const sample = state.samples?.find(item => item.id === state.sampleId), inherited = state.scope !== 'role' && state.settings.pitchMode === 'inherit';
    const linked = model.preset(session, state.settings);
    const shown = state.settings.presetModified !== true && state.settings.usePresetPitch && linked?.pitch !== undefined ? linked.pitch : inherited ? model.roleVoice(session, sample?.character || state.character).pitch : state.pitch;
    $('fxPitch').value = shown; $('fxPitchValue').textContent = shown; $('fxPitch').disabled = state.scope === 'preset' && !state.presetHasPitch || inherited || state.scope !== 'role' && state.action !== 'replace';
  }
  async function apply(keepOpen = false) {
    if (!state || state.pending || window.DublinePresetUI?.pending()) return false;
    if (state.scope === 'role' && !state.settings.voicePresetId && state.settings.effects.length) { status('fx.rolePreset'); return false; }
    const presetEdit = state.scope === 'preset', event = presetEdit ? 'voice_preset_update' : 'voice_update';
    const captured = state, request = state.pendingRequest || (presetEdit ? { sessionId: state.sessionId, action: 'update', id: state.presetId, revision: state.presetRevision, icon: state.presetIcon, settings: { effects: structuredClone(state.settings.effects), ...(state.presetHasPitch ? { pitch: state.pitch } : {}) }, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() } : { sessionId: state.sessionId, scope: state.scope, character: state.character, revision: state.revision, settings: structuredClone(state.settings), pitch: state.pitch,
      takes: state.takes, action: $('fxAction').value, editPitch: state.editPitch, editInheritance: state.editInheritance, editExceptions: state.editExceptions, value: state.settings.inheritRoleEffects, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), editPreset: state.editPreset, presetRevision: model.preset(session, state.settings)?.revision, previousPresetRevision: state.previousPresetRevision });
    if (state.scope === 'role' && !state.pendingRequest) request.settings.pitch = state.pitch;
    if (!model.validEffects(request.settings.effects, presetEdit || request.settings.presetModified === true ? 16 : model.MAX_EFFECTS) || state.scope === 'takes' && !model.validTake(request.settings)) return showToast(t('fx.invalid'));
    if (!state.pendingRequest && presetEdit && !await askConfirm(t('live.updateUsed', { name: session.voicePresets[state.presetId]?.name, n: DublineVoicePresets.usage(session, state.presetId).lines.length }))) return false;
    if (!state.pendingRequest && !presetEdit && (state.scope === 'role' || state.takes.length > 1)) { if (!await askConfirm(t('fx.confirm', { n: state.scope === 'role' ? session.lines.filter(line => line.character === state.character).length : state.takes.length }))) return false; }
    if (captured !== state || state.sessionId !== session.activeSessionId) return;
    state.applyError = null; state.pending = true; $('fxApply').disabled = true;
    state.pendingRequest = request; dialog.querySelector('.fx-body').inert = true;
    try {
      let result, recovered = false, retryable = true;
      const call = (event, data) => new Promise(resolve => socket.timeout(5000).emit(event, data, (error, answer) => resolve(error ? null : answer)));
      if (state.sentRequest) { const status = await call('editor_operation_status', { event, request }); if (status?.ok && status.state === 'known') { result = status.result; recovered = true; } else retryable = !!status?.ok && status.state === 'unseen' && status.retryable; }
      state.sentRequest = true;
      if (retryable) for (let i = 0; i < 2 && !result; i++) result = await call(event, request);
      if (!result) { const status = await call('editor_operation_status', { event, request }); if (status?.ok && status.state === 'known') { result = status.result; recovered = true; } }
      if (captured !== state) return;
      if (result?.ok && recovered && !await resyncEditor()) { status('fx.syncError'); $('fxRefresh').hidden = false; return false; }
      if (captured !== state) return false;
      if (result) { state.pendingRequest = null; state.sentRequest = false; }
      if (result?.ok) {
        if (presetEdit) { window.DublinePresetUI.receive({ sessionId: request.sessionId, voicePresets: result.voicePresets, editorProtocol: result.editorProtocol }); state.presetRevision = session.voicePresets[state.presetId]?.revision; }
        if (keepOpen) { state.revision = model.role(session, state.character).revision || 0; state.takes = state.takes.map(target => ({ ...target, takeMixRevision: session.lines.find(line => line.id === target.lineId)?.takeMixRevision || target.takeMixRevision })); state.baseline = fingerprint(); }
        else await close(true);
        return true;
      }
      state.applyError = result?.reason?.startsWith('fx.') || result?.reason?.startsWith('preset.') ? result.reason : 'fx.syncError'; status(state.applyError); $('fxRefresh').hidden = false;
    } finally { if (captured === state) { state.pending = false; $('fxApply').disabled = false; dialog.querySelector('.fx-body').inert = !!state.pendingRequest; } }
    return false;
  }
  const dialog = document.createElement('dialog'); dialog.id = 'fxDialog'; dialog.className = 'modal-card fx-dialog';
  dialog.setAttribute('aria-labelledby', 'fxTitle');
  dialog.innerHTML = `<div class="modal-header-row"><h2 id="fxTitle"></h2><button type="button" id="fxClose" class="btn-icon" aria-label="${esc(t('close'))}">×</button></div><p id="fxScope"></p>
    <label id="fxInheritRow"><span>${esc(t('fx.inherit'))}</span><span class="switch-ui"><input type="checkbox" id="fxInherit"><span class="switch-slider"></span></span></label><div class="fx-pitch"><label>${esc(t('pitch'))}<select id="fxPitchMode"><option value="inherit">${esc(t('fx.pitchInherit'))}</option><option value="override">${esc(t('fx.pitchOverride'))}</option></select></label><input id="fxPitch" type="range" data-reset-value="0" data-reset-event="input" min="-12" max="12" value="0"><output id="fxPitchValue">0</output></div><div id="fxExceptions"></div>
    <div id="fxActionRow"><label>${esc(t('fx.bulkAction'))}<select id="fxAction"><option value="replace">${esc(t('fx.replace'))}</option><option value="clear">${esc(t('fx.clear'))}</option><option value="inherit">${esc(t('fx.inheritOnly'))}</option></select></label></div>
    <div id="fxRows" role="list" tabindex="-1"></div><div class="insp-actions"><select id="fxType">${model.TYPES.map(type => `<option value="${type}">${esc(t('effect.' + type))}</option>`).join('')}</select><button type="button" id="fxAdd" class="btn-outline">${esc(t('fx.add'))}</button><button type="button" id="fxClear" class="btn-outline">${esc(t('fx.clear'))}</button></div>
    <section class="fx-preview"><label>${esc(t('fx.sample'))}<select id="fxSample"></select></label><div class="insp-actions"><button type="button" id="fxPlay" class="btn-play">${esc(t('fx.play'))}</button><select id="fxAB"><option value="dry">${esc(t('fx.dry'))}</option><option value="wet" selected>${esc(t('fx.wet'))}</option></select><label><span>${esc(t('fx.loop'))}</span><span class="switch-ui"><input type="checkbox" id="fxLoop"><span class="switch-slider"></span></span></label></div></section>
    <p id="fxStatus" role="status" aria-live="polite"></p><div class="insp-actions"><button id="fxApply" type="button" class="btn-play">${esc(t('char.apply'))}</button><button id="fxCancel" type="button" class="btn-outline">${esc(t('dialog.cancel'))}</button><button id="fxRefresh" type="button" class="btn-outline" hidden>${esc(t('fx.refresh'))}</button></div>`;
  document.body.append(dialog);
  const header = document.createElement('header'), body = document.createElement('div'), footer = document.createElement('footer');
  header.className = 'fx-header'; body.className = 'fx-body'; footer.className = 'fx-footer';
  header.append(dialog.firstElementChild, $('fxScope'));
  while (dialog.firstElementChild && !dialog.firstElementChild.classList.contains('fx-preview')) body.append(dialog.firstElementChild);
  while (dialog.firstElementChild) footer.append(dialog.firstElementChild);
  dialog.append(header, body, footer);
  const main = document.createElement('section'), sidebar = document.createElement('aside');
  main.className = 'fx-main'; sidebar.className = 'fx-sidebar';
  while (body.firstChild) main.append(body.firstChild); body.append(main, sidebar);
  const soundTitle = document.createElement('h3'); soundTitle.dataset.i18n = 'fx.layout.sound'; soundTitle.textContent = t('fx.layout.sound'); main.prepend(soundTitle);
  const chain = document.createElement('section'); chain.className = 'fx-chain-section';
  chain.innerHTML = '<div class="fx-section-title"><h3 data-i18n="fx.layout.chain"></h3><span id="fxCount" class="fx-count"></span><button id="fxClearChain" type="button" class="btn-outline" data-i18n="fx.clear"></button></div><p class="fx-order-help" data-i18n="fx.layout.order"></p><div id="fxFlow" class="fx-flow" aria-label="' + esc(t('fx.layout.chain')) + '"></div>';
  const legacy = $('fxType').parentElement; legacy.hidden = true; legacy.classList.add('fx-legacy-add');
  main.append(chain); chain.append($('fxRows')); chain.insertAdjacentHTML('beforeend', '<p id="fxEmpty" class="fx-empty" data-i18n="fx.layout.empty"></p><p class="fx-reorder-help" data-i18n="fx.layout.reorder"></p>');
  const palette = document.createElement('section'); palette.className = 'fx-palette-section';
  palette.innerHTML = '<h3 data-i18n="fx.layout.add"></h3><div id="fxPalette" class="fx-palette">' + model.TYPES.map(type => '<button type="button" class="btn-outline" data-fx-type="' + type + '">' + icon(type) + '<span data-i18n="fx.name.' + type + '"></span></button>').join('') + '</div>';
  main.append(palette); $('fxClearChain').onclick = () => { if (!$('fxClear').disabled) $('fxClear').click(); };
  palette.onclick = event => { const button = event.target.closest('[data-fx-type]'); if (!button || button.disabled) return; $('fxType').value = button.dataset.fxType; $('fxAdd').click(); };
  const announcement = document.createElement('span'); announcement.id = 'fxMoveStatus'; announcement.className = 'sr-only'; announcement.setAttribute('role', 'status'); footer.append(announcement);
  const dirtyLabel = document.createElement('span'); dirtyLabel.id = 'fxDirty'; dirtyLabel.className = 'setting-sub'; dirtyLabel.dataset.i18n = 'live.unsaved'; dirtyLabel.hidden = true; dirtyLabel.textContent = t('live.unsaved'); header.querySelector('.modal-header-row').insertBefore(dirtyLabel, $('fxClose'));
  const linkedCard = document.createElement('section'); linkedCard.id = 'fxLinked'; linkedCard.className = 'fx-summary'; linkedCard.hidden = true;
  linkedCard.innerHTML = '<p id="fxLinkedLabel"></p><div class="insp-actions"><button type="button" id="fxLinkedEdit" class="btn-outline" data-i18n="live.edit"></button><button type="button" id="fxDetach" class="btn-outline" data-i18n="live.detach"></button></div>'; sidebar.prepend(linkedCard); DublineI18n.apply(linkedCard);
  const includePitch = document.createElement('label'); includePitch.id = 'fxPresetIncludePitchRow'; includePitch.hidden = true; includePitch.innerHTML = '<span data-i18n="live.includePitch"></span><span class="switch-ui"><input type="checkbox" id="fxPresetIncludePitch"><span class="switch-slider"></span></span>'; main.insertBefore(includePitch, main.children[1]); DublineI18n.apply(includePitch); $('fxPresetIncludePitch').setAttribute('aria-label', t('live.includePitch')); $('fxPresetIncludePitch').onchange = () => { state.presetHasPitch = $('fxPresetIncludePitch').checked; paintPitch(); schedule(); };
  function ensureOwn() {
    if (!state) return; state.applyError = null; if (state.scope === 'preset') return;
    const entry = model.modify({ ...state.settings, pitch: state.pitch }, session);
    state.settings = state.scope === 'role' ? { ...entry, pitch: entry.pitch } : model.take(entry); state.pitch = entry.pitch;
    state.editPreset = true;
    $('fxPitchMode').value = state.settings.pitchMode || 'override';
  }
  function linkedDraft() { return !!state && state.scope !== 'preset' && state.action !== 'detach' && (state.settings.voicePresetId || !state.editPreset && state.scope === 'takes' && state.takes.some(target => session.lines.find(line => line.id === target.lineId)?.voicePresetId)); }
  function paintLinked() {
    if (!state) return; const linked = linkedDraft(); linkedCard.hidden = !linked;
    if (!linked) return;
    const ids = state.editPreset || state.scope === 'role' ? [state.settings.voicePresetId] : state.takes.map(target => session.lines.find(line => line.id === target.lineId)?.voicePresetId), unique = [...new Set(ids)].filter(Boolean), preset = unique.length === 1 ? session.voicePresets[unique[0]] : null;
    $('fxLinkedLabel').textContent = preset ? preset.name + (state.settings.presetModified ? ' ' + t('chain.modified') : '') + ' · ' + t(state.settings.presetModified ? 'chain.localHelp' : 'chain.linkHelp') : t('live.mixed');
    $('fxLinkedEdit').disabled = !preset || !canModerate() && preset.createdBy !== myName || window.DublinePresetUI?.pending();
    $('fxDetach').hidden = state.scope === 'role'; $('fxLinkedEdit').textContent = t('chain.updateSource'); $('fxLinkedEdit').onclick = () => window.DublinePresetUI?.updateSource();
  }
  $('fxDetach').onclick = () => detach();
  function detach() {
    if (!state || state.pending || state.pendingRequest) return;
    if (state.scope === 'role') { const resolved = model.roleVoice(session, state.character); state.settings.effects = structuredClone(resolved.effects); state.pitch = resolved.pitch; state.settings.voicePresetId = null; state.settings.usePresetPitch = false; state.settings.presetModified = true; }
    else if (state.takes.length === 1) { const detached = DublineVoicePresets.detach({ ...session.lines.find(line => line.id === state.takes[0].lineId), ...state.settings, pitch: state.pitch }, session, newUploadId); state.settings = model.take(detached); state.pitch = detached.pitch; }
    else { state.action = 'detach'; const option = new Option(t('live.detach'), 'detach'); $('fxAction').append(option); $('fxAction').value = 'detach'; }
    state.editPreset = true; rows(); exclusions(); paintPitch(); schedule();
  }
  function catalogChanged() { if (!state) return; const preset = session.voicePresets[state.presetId]; if (state.scope === 'preset' && preset && state.presetOriginal === JSON.stringify([preset.effects, preset.pitch, preset.icon])) state.presetRevision = preset.revision; if (state.scope === 'preset' && state.presetRevision !== session.voicePresets[state.presetId]?.revision && !state.pending) { status('preset.conflict'); $('fxRefresh').hidden = false; } paintScope(); rows(); schedule(); }
  window.addEventListener('dubline-presets-changed', () => { if (state && state.scope !== 'preset') schedule(); });
  const sizeObserver = observeDialogZoom(dialog);
  $('fxClose').onclick = $('fxCancel').onclick = () => close(); dialog.oncancel = event => { event.preventDefault(); void close(); };
  $('fxApply').onclick = () => apply(); $('fxRefresh').onclick = async () => { if (state?.pendingRequest) return apply(); const old = state; if (await close()) open(old.scope === 'preset' ? old.presetId : old.scope === 'role' ? old.character : old.takes[0].lineId, old.scope, old.takes.map(item => item.lineId)); };
  $('fxAdd').onclick = () => { ensureOwn(); if (state.settings.effects.length >= model.MAX_EFFECTS) return showToast(t('fx.limit')); state.settings.effects.push({ id: newUploadId(), type: $('fxType').value, enabled: true, amount: 1, parameters: {} }); rows(); schedule(); };
  $('fxClear').onclick = () => { ensureOwn(); state.settings.effects = []; state.settings.voicePresetId = null; state.settings.usePresetPitch = false; rows(); schedule(); };
  $('fxInherit').onchange = () => { state.applyError = null; state.editInheritance = true; $('fxInherit').indeterminate = false; state.settings.inheritRoleEffects = $('fxInherit').checked; exclusions(); schedule(); };
  $('fxPitchMode').onchange = () => { ensureOwn(); state.editPitch = true; state.settings.pitchMode = $('fxPitchMode').value; paintPitch(); schedule(); };
  $('fxPitch').oninput = () => { ensureOwn(); state.editPitch = true; state.pitch = Number($('fxPitch').value); $('fxPitchValue').textContent = state.pitch; schedule(); };
  $('fxAction').onchange = () => {
    if (state.action === 'replace' || state.action === 'append') state.effectDrafts[state.action] = structuredClone(state.settings.effects);
    state.action = $('fxAction').value; state.settings.effects = structuredClone(state.effectDrafts[state.action] || []);
    if (state.action === 'clear') { state.settings.voicePresetId = null; state.settings.usePresetPitch = false; state.settings.presetModified = true; state.editPreset = true; state.action = 'replace'; $('fxAction').value = 'replace'; }
    $('fxPitchMode').disabled = state.action !== 'replace'; $('fxInherit').disabled = !['replace', 'inherit'].includes(state.action); rows(); exclusions(); paintPitch(); schedule();
  };
  $('fxSample').onchange = () => { stop(false); buffer = null; $('fxPlay').disabled = true; state.sampleId = Number($('fxSample').value) || null; paintPitch(); schedule(); };
  $('fxAB').onchange = schedule; $('fxLoop').onchange = () => { if (source) source.loop = $('fxLoop').checked; }; $('fxPlay').onclick = () => { if (playing) stop(false); else void play().catch(() => { if (state) status('fx.processingError'); }); };
  $('fxRows').addEventListener('input', event => {
    const row = event.target.closest('[data-fx-id]'); if (!row) return; ensureOwn(); const item = state.settings.effects[Number(row.dataset.index)], action = event.target.dataset.action;
    if (action === 'amount') { item.amount = Number(event.target.value) / 100; row.querySelector('output').textContent = event.target.value + '%'; }
    if (action === 'enabled') { item.enabled = event.target.checked; row.dataset.enabled = String(item.enabled); }
    if (['delay', 'feedback'].includes(action)) item.parameters[action] = Number(event.target.value);
    schedule();
  });
  $('fxRows').addEventListener('click', event => {
    const row = event.target.closest('[data-fx-id]'), action = event.target.dataset.action; if (!row || !['up', 'down', 'delete'].includes(action)) return;
    ensureOwn(); const index = Number(row.dataset.index), [item] = state.settings.effects.splice(index, 1);
    if (action !== 'delete') state.settings.effects.splice(index + (action === 'up' ? -1 : 1), 0, item); rows(item.id); schedule();
  });
  function cleanupDrag() {
    if (!drag) return null; const old = drag; drag = null; old.ghost?.remove(); old.row.classList.remove('is-dragging'); dialog.classList.remove('fx-dragging');
    if ($('fxRows').hasPointerCapture(old.pointerId)) $('fxRows').releasePointerCapture(old.pointerId);
    return old;
  }
  function finishDrag(event) {
    if (!drag || event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    const old = cleanupDrag();
    const bounds = $('fxRows').getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (event.type === 'pointerup' && inside && old.moved && state === old.scope) {
      ensureOwn(); const ids = [...$('fxRows').children].map(row => row.dataset.fxId), effects = new Map(state.settings.effects.map(item => [item.id, item]));
      state.settings.effects = ids.map(id => effects.get(id)); rows(old.id); schedule();
      $('fxMoveStatus').textContent = t('fx.layout.moved', { n: ids.indexOf(old.id) + 1 });
    } else if (state) rows(old.id);
  }
  $('fxRows').addEventListener('pointerdown', event => {
    const grip = event.target.closest('.fx-grip'); if (!grip || event.button !== 0 || !state || state.pending || state.pendingRequest ) return;
    cleanupDrag(); const row = grip.closest('[data-fx-id]'), box = row.getBoundingClientRect();
    drag = { id: row.dataset.fxId, scope: state, row, grip, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: event.clientX - box.left, dy: event.clientY - box.top, moved: false };
    // Keep keyboard focus on the stable container while its cards are reinserted.
    $('fxRows').focus({ preventScroll: true }); $('fxRows').setPointerCapture(event.pointerId); event.preventDefault();
  });
  $('fxRows').addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    const zoom = dialog.getBoundingClientRect().width / dialog.offsetWidth;
    if (!drag.moved) {
      drag.moved = true; const ghost = drag.row.cloneNode(true), rect = drag.row.getBoundingClientRect();
      ghost.classList.add('fx-drag-ghost'); ghost.removeAttribute('data-fx-id'); ghost.setAttribute('aria-hidden', 'true');
      for (const node of ghost.querySelectorAll('input, button')) { node.tabIndex = -1; node.removeAttribute('id'); }
      ghost.style.width = rect.width / zoom + 'px'; dialog.append(ghost); drag.ghost = ghost; drag.row.classList.add('is-dragging'); dialog.classList.add('fx-dragging');
    }
    drag.ghost.style.left = (event.clientX - drag.dx) / zoom + 'px'; drag.ghost.style.top = (event.clientY - drag.dy) / zoom + 'px';
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('#fxRows [data-fx-id]');
    if (!target || target === drag.row) return;
    const rect = target.getBoundingClientRect(), columns = getComputedStyle($('fxRows')).gridTemplateColumns.split(' ').length;
    const after = columns === 1 ? event.clientY >= rect.y + rect.height / 2 : event.clientY > rect.bottom - 12 || event.clientY >= rect.y + 12 && event.clientX >= rect.x + rect.width / 2;
    const before = new Map([...$('fxRows').children].map(row => [row, row.getBoundingClientRect()]));
    $('fxRows').insertBefore(drag.row, after ? target.nextSibling : target);
    [...$('fxRows').children].forEach((row, index) => { row.querySelector('.fx-step').textContent = index + 1; });
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) for (const [row, box] of before) { if (row === drag.row) continue; const next = row.getBoundingClientRect(); if (next.x !== box.x || next.y !== box.y) row.animate([{ transform: 'translate(' + (box.x - next.x) / zoom + 'px,' + (box.y - next.y) / zoom + 'px)' }, { transform: 'none' }], { duration: 160, easing: 'ease-out' }); }
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('fxRows').addEventListener(name, finishDrag);
  dialog.addEventListener('keydown', event => { if (drag && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finishDrag({ type: 'cancel' }); } }, true);
  window.addEventListener('blur', () => finishDrag({ type: 'cancel' }));
  socket.on('voice_updated', data => {
    if (data.sessionId !== session.activeSessionId || !acceptSessionProtocol(data.editorProtocol)) return;
    const previousRoles = session.roleEffects || {}; session.roleEffects = data.roleEffects;
    lastRoleScene = data.sessionId; lastRoles = structuredClone(data.roleEffects);
    if (data.character) audio.invalidateRole(data.character, previousRoles);
    if (data.lines?.length) applyTakeUpdates(data.sessionId, data.lines, data.editorProtocol, { prewarm: false });
    else if (selectedLine) showInspector(selectedLine);
    if (state && data.character === state.character && !state.pending) {
      if (state.scope === 'role') { status('fx.conflict'); $('fxRefresh').hidden = false; }
      else schedule();
    }
  });
  socket.on('session_updated', () => {
    const roles = session.roleEffects || {};
    if (lastRoleScene === session.activeSessionId) for (const name of new Set([...Object.keys(lastRoles), ...Object.keys(roles)])) if (JSON.stringify(lastRoles[name]) !== JSON.stringify(roles[name])) audio.invalidateRole(name, lastRoles);
    lastRoleScene = session.activeSessionId; lastRoles = structuredClone(roles);
    if (state && (state.sessionId !== session.activeSessionId || state.scope !== 'preset' && !session.trackOrder.includes(state.character) || state.scope === 'role' && !canModerate() || state.scope === 'takes' && state.takes.some(target => { const line = session.lines.find(item => item.id === target.lineId); return !line || line.character !== target.character || !canEditTake(line); }) || state.samples.some(sample => !session.lines.some(line => line.id === sample.id && line.character === sample.character && line.audioUrl === sample.audioUrl && canHearLine(line))))) close(true);
  });
  socket.on('project_audio_updated', () => { if (state) schedule(); });
  socket.on('disconnect', () => { if (state) close(true); });
  for (const event of ['line_updated', 'takes_updated']) socket.on(event, () => { if (state && state.samples.some(sample => !session.lines.some(line => line.id === sample.id && line.audioUrl === sample.audioUrl))) close(true); });
  window.addEventListener('pagehide', () => { sizeObserver.disconnect(); if (state) close(true); });
  window.addEventListener('beforeunload', event => { if (dirty() || window.DublinePresetUI?.pending()) { event.preventDefault(); event.returnValue = ''; } });
  // Existing locale machinery updates stable controls without rebuilding drafts.
  DublineI18n.apply(dialog);
  const keys = ['pitch', 'close', 'dialog.cancel', 'char.apply', ...Object.keys(DublineI18n.messages.en).filter(key => key.startsWith('fx.') || key.startsWith('effect.'))];
  const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT), texts = []; while (walker.nextNode()) texts.push(walker.currentNode);
  for (const node of texts) {
    const key = keys.find(key => t(key) === node.textContent.trim()); if (!key) continue;
    if (node.parentElement.childNodes.length === 1) node.parentElement.dataset.i18n = key;
    else { const span = document.createElement('span'); span.dataset.i18n = key; span.textContent = node.textContent; node.replaceWith(span); }
  }
  window.addEventListener('dubline-language-changed', () => { DublineI18n.apply(dialog); $('fxPresetIncludePitch').setAttribute('aria-label', t('live.includePitch')); if (state) { rows(); exclusions(); paintPitch(); paintScope(); $('fxPlay').textContent = t(playing ? 'fx.pause' : 'fx.play'); $('fxSample').options[0].textContent = t('fx.noSample'); } });
  function usePreset(preset) {
    if (!state || state.scope === 'preset' || state.pending || state.pendingRequest || state.sessionId !== session.activeSessionId) throw Error('preset.conflict');
    const targets = state.scope === 'role' ? [{ character: state.character, pitch: state.pitch, inheritRoleEffects: false }] : state.takes.map(target => {
      const line = session.lines.find(item => item.id === target.lineId); if (!line || !canEditTake(line)) throw Error('fx.owner');
      const settings = { ...state.settings };
      if (state.takes.length > 1) { const own = model.take(line); if (!state.editInheritance) settings.inheritRoleEffects = own.inheritRoleEffects; if (!state.editExceptions) settings.excludedRoleEffectIds = own.excludedRoleEffectIds; }
      return { ...line, ...settings };
    });
    state.applyError = null; for (const target of targets) DublineVoicePresets.link(target, session, preset.id, true);
    state.settings.effects = []; state.settings.voicePresetId = preset.id; state.settings.usePresetPitch = true; state.settings.presetModified = false;
    state.sourceRevision = preset.revision; state.presetIcon = preset.icon || 'voice'; state.editPreset = true; state.action = 'replace'; $('fxAction').value = 'replace';
    rows(); exclusions(); paintPitch(); schedule();
  }
  window.DublineVoiceEditor = { catalogSaved: (id, previousRevision) => { if (!state) return; const revision = session.voicePresets[id]?.revision; for (const target of state.takes) if (session.lines.find(line => line.id === target.lineId)?.voicePresetId === id && target.presetRevision === previousRevision) target.presetRevision = revision; if (model.role(session, state.character).voicePresetId === id && state.previousPresetRevision === previousRevision) state.previousPresetRevision = revision; }, setIcon: value => { if (!state || !DublineVoicePresets.validIcon(value) || state.pending || state.pendingRequest) return; state.presetIcon = value; paintScope(); }, html, bulkHtml, summary, open, close, catalogChanged, detach, dirty, apply, usePreset, draft: () => state && ({ draftId: state.draftId, scope: state.scope, presetId: state.scope === 'preset' ? state.presetId : state.settings.voicePresetId, modified: state.settings.presetModified === true, replaceHasContent: state.scope === 'role' ? model.ownEffects(state.settings, session).length > 0 : state.takes.some(target => model.ownEffects(model.take(session.lines.find(line => line.id === target.lineId) || {}), session).length > 0), sourceRevision: state.scope === 'preset' ? state.presetRevision : state.sourceRevision, icon: state.presetIcon, sessionId: state.sessionId, character: state.character, effects: structuredClone(state.scope === 'preset' ? state.settings.effects : model.ownEffects(state.settings, session)), pitch: state.settings.presetModified !== true && state.settings.usePresetPitch && model.preset(session, state.settings)?.pitch !== undefined ? model.preset(session, state.settings).pitch : state.scope === 'preset' && !state.presetHasPitch ? undefined : state.scope !== 'takes' || state.settings.pitchMode === 'override' ? state.pitch : model.roleVoice(session, state.character).pitch }), expand: (value, id) => { expandedKey = value ? `${currentRoom}:${session.activeSessionId}:${id}` : null; }, bulk: () => { const lines = session.lines.filter(line => multiSelection.has(line.id) && line.audioUrl && canEditTake(line)); if (lines.length) open(lines[0].id, 'takes', lines.map(item => item.id)); } };
})();
