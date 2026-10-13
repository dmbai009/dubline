(function() {
  'use strict';
  const model = window.DublineVoiceChain, $ = id => document.getElementById(id);
  let state = null, context = null, source = null, gain = null, buffer = null, position = 0, started = 0;
  let playing = false, generation = 0, timer = null, abort = null, rendering = false, drag = null, begin = 0, end = 0;
  let expandedKey = null;
  let lastRoleScene = session?.activeSessionId, lastRoles = structuredClone(session?.roleEffects || {});
  const label = items => items.length ? items.map(item => `${t('effect.' + item.type)} ${Math.round(item.amount * 100)}%${item.enabled ? '' : ' (' + t('fx.disabled') + ')'}`).join(' → ') : t('effect.none');
  const button = (text, action, disabled = false) => `<button type="button" class="btn-outline" ${disabled ? 'disabled' : ''} onclick="${action}">${esc(text)}</button>`;
  function html(line) {
    const role = model.role(session, line.character), own = model.take(line);
    const key = `${currentRoom}:${session.activeSessionId}:${line.id}`;
    return `<details class="fx-details" ${expandedKey === key ? 'open' : ''} ontoggle="DublineVoiceEditor.expand(this.open, ${line.id})"><summary>${esc(t('voice'))} · ${esc(label(model.resolve(line, session).effects))}</summary><section class="take-panel fx-summary"><b>${esc(t('fx.role'))}: ${esc(line.character)}</b><p>${esc(label(role.effects))}${role.pitch ? ' · ' + esc(t('pitch')) + ' ' + role.pitch : ''}</p>
      ${button(t('fx.configureRole'), `DublineVoiceEditor.open(${line.id}, 'role')`, !canModerate())}
      <b>${esc(t('fx.take'))}</b><p>${esc(label(own.effects))} · ${esc(t(own.inheritRoleEffects ? 'fx.inheriting' : 'fx.individual'))}</p>
      ${button(t('fx.configureTake'), `DublineVoiceEditor.open(${line.id}, 'takes')`, !canEditTake(line))}</section></details>`;
  }
  function bulkHtml(lines) {
    const eligible = lines.filter(line => line.audioUrl && canEditTake(line));
    const configs = lines.map(line => JSON.stringify(model.take(line)));
    return `<section class="take-panel fx-summary"><b>${esc(t('fx.take'))}</b><p>${esc(configs.every(value => value === configs[0]) ? label(model.take(lines[0]).effects) : t('clip.mixed'))}</p>${button(t('fx.configureBulk', { n: eligible.length }), 'DublineVoiceEditor.bulk()', !eligible.length)}</section>`;
  }
  function canPreview(line) { return line?.audioUrl && canHearLine(line); }
  function open(id, scope, ids) {
    if (recordState !== 'idle' || window.DublineNoise?.busy?.() || document.querySelector('dialog[open]')) return showToast(t('fx.busy'));
    const line = scope === 'role' && typeof id === 'string' && session.trackOrder.includes(id) ? session.lines.find(item => item.character === id) || { id: null, character: id, pitch: 0 } : session.lines.find(item => item.id === id); if (!line) return;
    if (scope === 'role' ? !canModerate() : !canEditTake(line)) return showToast(t('fx.owner'));
    const lines = ids ? session.lines.filter(item => ids.includes(item.id) && item.audioUrl && canEditTake(item)) : [line];
    const own = model.take(line), role = model.role(session, line.character);
    own.excludedRoleEffectIds = own.excludedRoleEffectIds.filter(id => role.effects.some(item => item.id === id));
    state = { scope, sessionId: session.activeSessionId, character: line.character, revision: role.revision || 0,
      settings: scope === 'role' ? structuredClone(role) : own, pitch: scope === 'role' ? role.pitch : line.pitch || 0, editPitch: false,
      takes: lines.map(item => ({ lineId: item.id, character: item.character, audioUrl: item.audioUrl, takeId: item.takeId || null, takeMixRevision: item.takeMixRevision || 0 })),
      samples: (scope === 'role' ? session.lines.filter(item => item.character === line.character) : lines).filter(canPreview).map(item => structuredClone(item)),
      sampleId: null, focus: document.activeElement };
    $('fxTitle').textContent = t(scope === 'role' ? 'fx.role' : 'fx.take') + (scope === 'role' ? ': ' + line.character : ' · ' + lines.length);
    $('fxScope').textContent = t(scope === 'role' ? 'fx.roleScope' : 'fx.takeScope', { n: scope === 'role' ? session.lines.filter(item => item.character === line.character).length : lines.length });
    $('fxInheritRow').hidden = scope === 'role'; $('fxInherit').checked = own.inheritRoleEffects; $('fxInherit').disabled = false;
    $('fxPitchMode').hidden = scope === 'role'; $('fxPitchMode').value = own.pitchMode; $('fxPitchMode').disabled = false;
    $('fxPitch').value = state.pitch; $('fxPitch').disabled = scope !== 'role' && own.pitchMode === 'inherit'; $('fxPitchValue').textContent = state.pitch;
    $('fxActionRow').hidden = lines.length < 2 || scope === 'role'; $('fxAction').value = 'replace';
    $('fxSample').replaceChildren(new Option(t('fx.noSample'), ''), ...state.samples.map(item => new Option(`#${lineNumber(item)} · ${item.caption || ''}`, String(item.id))));
    const candidate = state.samples.find(item => item.id === id) || state.samples[0];
    if (candidate) { state.sampleId = candidate.id; $('fxSample').value = candidate.id; }
    $('fxAB').value = 'wet'; $('fxLoop').checked = true; $('fxStatus').textContent = ''; $('fxRefresh').hidden = true; $('fxApply').disabled = false;
    audio.stopPreview(); window.DublineTakeHistory?.stop(); rows(); exclusions(); $('fxDialog').showModal(); schedule();
  }
  function close() {
    clearTimeout(timer); abort?.abort(); ++generation; stop(false);
    if (context) { DublineAudioDevices.unregisterContext(context); void context.close(); } context = null; buffer = null;
    const focus = state?.focus; state = null; $('fxDialog').close(); if (focus?.isConnected) focus.focus();
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
    const scope = state; await context.resume(); if (scope !== state || !buffer) return;
    const node = context.createBufferSource(), level = context.createGain(); node.buffer = buffer; node.loop = $('fxLoop').checked; node.loopStart = begin; node.loopEnd = end;
    node.connect(level).connect(context.destination); level.gain.setValueAtTime(0, context.currentTime); level.gain.linearRampToValueAtTime(1, context.currentTime + .03);
    if (source) { const old = source, oldGain = gain; old.onended = null; oldGain.gain.cancelScheduledValues(context.currentTime); oldGain.gain.setValueAtTime(oldGain.gain.value, context.currentTime); oldGain.gain.linearRampToValueAtTime(0, context.currentTime + .03); old.stop(context.currentTime + .035); old.onended = () => { old.disconnect(); oldGain.disconnect(); }; }
    source = node; gain = level; started = context.currentTime; playing = true;
    const offset = Math.max(begin, Math.min(position, Math.max(begin, end - .001)));
    if (node.loop) node.start(0, offset); else node.start(0, offset, Math.max(.001, end - offset));
    node.onended = () => { if (source === node) stop(false); };
    $('fxPlay').textContent = t('fx.pause');
  }
  function schedule() { clearTimeout(timer); abort?.abort(); ++generation; timer = setTimeout(render, 100); }
  async function render() {
    if (!state || rendering) return;
    const token = generation, scope = state, sample = scope.samples.find(item => item.id === scope.sampleId);
    if (!sample) { $('fxStatus').textContent = t('fx.noSample'); return; }
    if (!session.lines.some(item => item.id === sample.id && item.audioUrl === sample.audioUrl && canHearLine(item))) return close();
    rendering = true; abort = new AbortController(); $('fxStatus').textContent = t('fx.processing');
    try {
      const test = { ...sample }, scene = { ...session, roleEffects: Object.assign(Object.create(null), session.roleEffects) };
      if (scope.scope === 'role') scene.roleEffects[scope.character] = { ...scope.settings, pitch: scope.pitch };
      else Object.assign(test, structuredClone(scope.settings), { pitch: scope.pitch });
      test._exportVoice = $('fxAB').value === 'dry' ? { pitch: 0, effects: [], tail: 0 } : model.resolve(test, scene);
      const processed = await audio.getProcessedTake(test, { scene, uncached: true, signal: abort.signal });
      if (scope !== state || token !== generation) return;
      if (!processed) throw Error('fx.processingError');
      const at = playing ? currentPosition() : position;
      const bounds = audio.takeBounds(test, processed.duration); begin = bounds.from; end = bounds.to; buffer = processed; position = Math.max(begin, Math.min(at, end));
      if (playing) await play(); $('fxStatus').textContent = t('fx.ready');
    } catch (error) { if (token === generation && state) $('fxStatus').textContent = t(error.message.startsWith('fx.') ? error.message : 'fx.processingError'); }
    finally { rendering = false; if (state && token !== generation) schedule(); }
  }
  function rows(focusId) {
    const items = state.settings.effects;
    $('fxRows').innerHTML = items.map((item, index) => `<div class="fx-item" data-fx-id="${esc(item.id)}" data-index="${index}">
      <div class="fx-item-head"><button type="button" class="btn-icon fx-grip" aria-label="${esc(t('fx.drag'))}">≡</button><b>${esc(t('effect.' + item.type))}</b>
      <input type="checkbox" data-action="enabled" aria-label="${esc(t('fx.enabled'))}" ${item.enabled ? 'checked' : ''}>
      <button type="button" class="btn-icon" data-action="up" aria-label="${esc(t('fx.up'))}" ${index ? '' : 'disabled'}>↑</button><button type="button" class="btn-icon" data-action="down" aria-label="${esc(t('fx.down'))}" ${index < items.length - 1 ? '' : 'disabled'}>↓</button>
      <button type="button" class="btn-icon" data-action="delete" aria-label="${esc(t('fx.remove'))}">×</button></div>
      <label class="fx-slider"><span>${esc(t('fx.amount'))}</span><input type="range" data-action="amount" data-reset-value="100" data-reset-event="input" min="0" max="100" value="${Math.round(item.amount * 100)}"><output>${Math.round(item.amount * 100)}%</output></label>
      ${item.type === 'echo' ? `<details><summary>${esc(t('fx.advanced'))}</summary><label>${esc(t('fx.delay'))}<input type="number" data-action="delay" min="0.03" max="0.8" step="0.01" value="${model.echo(item.parameters).delay}"></label><label>${esc(t('fx.feedback'))}<input type="number" data-action="feedback" min="0" max="0.7" step="0.05" value="${model.echo(item.parameters).feedback}"></label></details>` : ''}</div>`).join('');
    $('fxAdd').disabled = items.length >= model.MAX_EFFECTS;
    if (focusId) [...$('fxRows').children].find(item => item.dataset.fxId === focusId)?.querySelector('.fx-grip').focus();
  }
  function exclusions() {
    const inherited = state.scope === 'role' ? [] : model.role(session, state.character).effects;
    $('fxExceptions').replaceChildren();
    for (const item of inherited) {
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = !state.settings.excludedRoleEffectIds.includes(item.id); input.disabled = !state.settings.inheritRoleEffects;
      input.onchange = () => { const ids = new Set(state.settings.excludedRoleEffectIds); input.checked ? ids.delete(item.id) : ids.add(item.id); state.settings.excludedRoleEffectIds = [...ids]; schedule(); };
      label.append(input, document.createTextNode(t('effect.' + item.type))); $('fxExceptions').append(label);
    }
    $('fxExceptions').hidden = !inherited.length;
  }
  async function apply() {
    if (!state || state.pending) return;
    const captured = state, request = { sessionId: state.sessionId, scope: state.scope, character: state.character, revision: state.revision, settings: structuredClone(state.settings), pitch: state.pitch,
      takes: state.takes, action: $('fxAction').value, editPitch: state.editPitch, value: state.settings.inheritRoleEffects, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() };
    if (state.scope === 'role') request.settings.pitch = state.pitch;
    if (!model.validEffects(request.settings.effects) || state.scope !== 'role' && !model.validTake(request.settings)) return showToast(t('fx.invalid'));
    if (state.scope === 'role' || state.takes.length > 1) { if (!await askConfirm(t('fx.confirm', { n: state.scope === 'role' ? session.lines.filter(line => line.character === state.character).length : state.takes.length }))) return; }
    if (captured !== state || state.sessionId !== session.activeSessionId) return;
    state.pending = true; $('fxApply').disabled = true;
    try {
      let result;
      for (let i = 0; i < 2 && !result; i++) result = await new Promise(resolve => socket.volatile.timeout(5000).emit('voice_update', request, (error, data) => resolve(error ? null : data)));
      if (captured !== state) return;
      if (result?.ok) { close(); return; }
      $('fxStatus').textContent = t(result?.reason?.startsWith('fx.') ? result.reason : 'fx.syncError'); $('fxRefresh').hidden = false;
    } finally { if (captured === state) { state.pending = false; $('fxApply').disabled = false; } }
  }
  const dialog = document.createElement('dialog'); dialog.id = 'fxDialog'; dialog.className = 'modal-card fx-dialog';
  dialog.innerHTML = `<div class="modal-header-row"><h2 id="fxTitle"></h2><button type="button" id="fxClose" class="btn-icon" aria-label="${esc(t('close'))}">×</button></div><p id="fxScope"></p>
    <label id="fxInheritRow"><input type="checkbox" id="fxInherit">${esc(t('fx.inherit'))}</label><div class="fx-pitch"><label>${esc(t('pitch'))}<select id="fxPitchMode"><option value="inherit">${esc(t('fx.pitchInherit'))}</option><option value="override">${esc(t('fx.pitchOverride'))}</option></select></label><input id="fxPitch" type="range" data-reset-value="0" data-reset-event="input" min="-12" max="12" value="0"><output id="fxPitchValue">0</output></div><div id="fxExceptions"></div>
    <div id="fxActionRow"><label>${esc(t('fx.bulkAction'))}<select id="fxAction"><option value="replace">${esc(t('fx.replace'))}</option><option value="append">${esc(t('fx.append'))}</option><option value="clear">${esc(t('fx.clear'))}</option><option value="inherit">${esc(t('fx.inheritOnly'))}</option></select></label></div>
    <div id="fxRows"></div><div class="insp-actions"><select id="fxType">${model.TYPES.map(type => `<option value="${type}">${esc(t('effect.' + type))}</option>`).join('')}</select><button type="button" id="fxAdd" class="btn-outline">${esc(t('fx.add'))}</button><button type="button" id="fxClear" class="btn-outline">${esc(t('fx.clear'))}</button></div>
    <section class="fx-preview"><label>${esc(t('fx.sample'))}<select id="fxSample"></select></label><div class="insp-actions"><button type="button" id="fxPlay" class="btn-play">${esc(t('fx.play'))}</button><select id="fxAB"><option value="dry">${esc(t('fx.dry'))}</option><option value="wet" selected>${esc(t('fx.wet'))}</option></select><label><input type="checkbox" id="fxLoop">${esc(t('fx.loop'))}</label></div></section>
    <p id="fxStatus" role="status" aria-live="polite"></p><div class="insp-actions"><button id="fxApply" type="button" class="btn-play">${esc(t('char.apply'))}</button><button id="fxCancel" type="button" class="btn-outline">${esc(t('dialog.cancel'))}</button><button id="fxRefresh" type="button" class="btn-outline" hidden>${esc(t('fx.refresh'))}</button></div>`;
  document.body.append(dialog);
  const adjustZoom = () => { const zoom = String((Number(getComputedStyle(document.body).zoom) || 1) * (Number(getComputedStyle(document.documentElement).zoom) || 1)); if (dialog.style.getPropertyValue('--fx-ui-zoom') !== zoom) dialog.style.setProperty('--fx-ui-zoom', zoom); };
  const sizeObserver = new ResizeObserver(adjustZoom); sizeObserver.observe(dialog);
  $('fxClose').onclick = $('fxCancel').onclick = close; dialog.oncancel = event => { event.preventDefault(); close(); };
  $('fxApply').onclick = apply; $('fxRefresh').onclick = () => { const old = state; close(); open(old.scope === 'role' ? old.character : old.takes[0].lineId, old.scope, old.takes.map(item => item.lineId)); };
  $('fxAdd').onclick = () => { if (state.settings.effects.length >= model.MAX_EFFECTS) return showToast(t('fx.limit')); state.settings.effects.push({ id: newUploadId(), type: $('fxType').value, enabled: true, amount: 1, parameters: {} }); rows(); schedule(); };
  $('fxClear').onclick = () => { state.settings.effects = []; rows(); schedule(); };
  $('fxInherit').onchange = () => { state.settings.inheritRoleEffects = $('fxInherit').checked; exclusions(); schedule(); };
  $('fxPitchMode').onchange = () => { state.editPitch = true; state.settings.pitchMode = $('fxPitchMode').value; $('fxPitch').disabled = state.settings.pitchMode === 'inherit'; schedule(); };
  $('fxPitch').oninput = () => { state.editPitch = true; state.pitch = Number($('fxPitch').value); $('fxPitchValue').textContent = state.pitch; schedule(); };
  $('fxAction').onchange = () => { const replace = $('fxAction').value === 'replace'; $('fxPitchMode').disabled = !replace; $('fxPitch').disabled = !replace || state.settings.pitchMode === 'inherit'; $('fxInherit').disabled = !replace && $('fxAction').value !== 'inherit'; };
  $('fxSample').onchange = () => { stop(false); state.sampleId = Number($('fxSample').value) || null; schedule(); };
  $('fxAB').onchange = schedule; $('fxLoop').onchange = () => { if (source) source.loop = $('fxLoop').checked; }; $('fxPlay').onclick = () => { if (playing) stop(true); else void play().catch(() => { if (state) $('fxStatus').textContent = t('fx.processingError'); }); };
  $('fxRows').addEventListener('input', event => {
    const row = event.target.closest('[data-fx-id]'); if (!row) return; const item = state.settings.effects[Number(row.dataset.index)], action = event.target.dataset.action;
    if (action === 'amount') { item.amount = Number(event.target.value) / 100; event.target.nextElementSibling.textContent = event.target.value + '%'; }
    if (action === 'enabled') item.enabled = event.target.checked;
    if (['delay', 'feedback'].includes(action)) item.parameters[action] = Number(event.target.value);
    schedule();
  });
  $('fxRows').addEventListener('click', event => {
    const row = event.target.closest('[data-fx-id]'), action = event.target.dataset.action; if (!row || !['up', 'down', 'delete'].includes(action)) return;
    const index = Number(row.dataset.index), [item] = state.settings.effects.splice(index, 1);
    if (action !== 'delete') state.settings.effects.splice(index + (action === 'up' ? -1 : 1), 0, item); rows(item.id); schedule();
  });
  $('fxRows').addEventListener('pointerdown', event => {
    const grip = event.target.closest('.fx-grip'); if (!grip || event.button !== 0) return; const row = grip.closest('[data-fx-id]'); drag = { index: Number(row.dataset.index), target: null, grip };
    grip.setPointerCapture(event.pointerId); event.preventDefault();
  });
  $('fxRows').addEventListener('pointermove', event => {
    if (!drag) return; const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('#fxRows [data-fx-id]');
    for (const item of $('fxRows').children) item.classList.remove('fx-drop');
    if (row) { drag.target = Number(row.dataset.index); row.classList.add('fx-drop'); }
  });
  const finishDrag = event => { if (!drag) return; const old = drag; drag = null; if (event.type === 'pointerup' && old.target !== null && old.target !== old.index) { const [item] = state.settings.effects.splice(old.index, 1); state.settings.effects.splice(old.target, 0, item); rows(item.id); schedule(); } else rows(); };
  $('fxRows').addEventListener('pointerup', finishDrag); $('fxRows').addEventListener('pointercancel', finishDrag);
  socket.on('voice_updated', data => {
    if (data.sessionId !== session.activeSessionId || !acceptSessionProtocol(data.editorProtocol)) return;
    const previousRoles = session.roleEffects || {}; session.roleEffects = data.roleEffects;
    lastRoleScene = data.sessionId; lastRoles = structuredClone(data.roleEffects);
    if (data.character) audio.invalidateRole(data.character, previousRoles);
    if (data.lines?.length) applyTakeUpdates(data.sessionId, data.lines, data.editorProtocol, { prewarm: false });
    else if (selectedLine) showInspector(selectedLine);
    if (state && data.character === state.character && !state.pending) {
      if (state.scope === 'role') { $('fxStatus').textContent = t('fx.conflict'); $('fxRefresh').hidden = false; }
      else schedule();
    }
  });
  socket.on('session_updated', () => {
    const roles = session.roleEffects || {};
    if (lastRoleScene === session.activeSessionId) for (const name of new Set([...Object.keys(lastRoles), ...Object.keys(roles)])) if (JSON.stringify(lastRoles[name]) !== JSON.stringify(roles[name])) audio.invalidateRole(name, lastRoles);
    lastRoleScene = session.activeSessionId; lastRoles = structuredClone(roles);
    if (state && (state.sessionId !== session.activeSessionId || !session.trackOrder.includes(state.character) || state.scope === 'role' && !canModerate() || state.scope === 'takes' && state.takes.some(target => { const line = session.lines.find(item => item.id === target.lineId); return !line || line.character !== target.character || !canEditTake(line); }) || state.samples.some(sample => !session.lines.some(line => line.id === sample.id && line.character === sample.character && line.audioUrl === sample.audioUrl && canHearLine(line))))) close();
  });
  socket.on('disconnect', () => { if (state) close(); });
  for (const event of ['line_updated', 'takes_updated']) socket.on(event, () => { if (state && state.samples.some(sample => !session.lines.some(line => line.id === sample.id && line.audioUrl === sample.audioUrl))) close(); });
  window.addEventListener('pagehide', () => { sizeObserver.disconnect(); if (state) close(); });
  // Existing locale machinery updates stable controls without rebuilding drafts.
  const keys = ['pitch', 'close', 'dialog.cancel', 'char.apply', ...Object.keys(DublineI18n.messages.en).filter(key => key.startsWith('fx.') || key.startsWith('effect.'))];
  const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT), texts = []; while (walker.nextNode()) texts.push(walker.currentNode);
  for (const node of texts) {
    const key = keys.find(key => t(key) === node.textContent.trim()); if (!key) continue;
    if (node.parentElement.childNodes.length === 1) node.parentElement.dataset.i18n = key;
    else { const span = document.createElement('span'); span.dataset.i18n = key; span.textContent = node.textContent; node.replaceWith(span); }
  }
  window.addEventListener('dubline-language-changed', () => { DublineI18n.apply(dialog); if (state) { rows(); exclusions(); } });
  window.DublineVoiceEditor = { html, bulkHtml, open, close, expand: (value, id) => { expandedKey = value ? `${currentRoom}:${session.activeSessionId}:${id}` : null; }, bulk: () => { const lines = session.lines.filter(line => multiSelection.has(line.id) && line.audioUrl && canEditTake(line)); if (lines.length) open(lines[0].id, 'takes', lines.map(line => line.id)); } };
})();
