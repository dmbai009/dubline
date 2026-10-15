// Private settings drafts; one acknowledged author update on normal exit.
(() => {
  const model = DublineNoiseModel, $ = id => document.getElementById(id);
  let context = null, sampleGeneration = 0, playbackGeneration = 0, sliderTimer = null, audioScene = null;
  const retained = new Map();
  const scopeKey = () => `${currentRoom}:${session?.activeSessionId}:${myName}`;
  const visible = () => $('settingsModal').style.display === 'flex' && $('tabContentUser').classList.contains('active') && !$('settings-user-audio').hidden;
  const current = state => state === context && state.key === scopeKey();
  const ownTakes = () => (session?.lines || []).flatMap(line => [line.audioUrl && { line, take: { ...line, id: line.takeId }, historical: false },
    ...(line.takeHistory || []).map(take => ({ line, take, historical: true }))].filter(Boolean)).filter(item => item.take.recordedBy === myName && item.take.audioUrl && item.take.id);
  function status(key) { if (context) context.status = key; $('noiseStatus').textContent = t(key); }
  function controls() {
    const a = context?.draft || model.actor(session?.noiseReduction, myName);
    $('noiseEnable').checked = a.enabled; $('noiseEnable').disabled = !session?.loaded || !socket.connected || !!context?.saving || !!context?.operation;
    $('noiseStrength').value = Math.round(a.strength * 100); $('noiseStrength').disabled = !a.enabled || $('noiseEnable').disabled;
    $('noiseStrengthValue').textContent = `${Math.round(a.strength * 100)}%`;
    $('noiseStrengthRow').classList.toggle('noise-disabled', !a.enabled);
    $('noiseStrongWarning').hidden = !a.enabled || a.strength < .85;
    $('noisePreviewPlay').disabled = !ownTakes().length || !!context?.saving || !!context?.preparing;
    $('noisePreviewPlay').textContent = t(context?.playing ? 'noise.pause' : 'noise.play');
    $('noiseNext').disabled = !ownTakes().length || !!context?.saving || !!context?.preparing;
    $('noiseRetry').hidden = !context?.saveError;
    $('noiseRetry').disabled = !!context?.saving || !socket.connected;
    $('noiseEffectsHelp').dataset.tooltip = t('noise.effectsHelp');
    $('noiseEffects').setAttribute('aria-label', t('noise.effects'));
    $('noiseEffects').setAttribute('aria-description', t('noise.effectsHelp'));
    if (!context) $('noiseStatus').textContent = t(ownTakes().length ? 'noise.description' : 'noise.noSample');
  }
  function begin() {
    if (!visible() || !session?.loaded || !myName) return controls();
    if (context?.key === scopeKey()) return controls();
    suspend();
    const key = scopeKey(), saved = retained.get(key); retained.delete(key);
    context = saved || { key, room: currentRoom, sceneId: session.activeSessionId, name: myName,
      committed: model.actor(session.noiseReduction, myName), draft: model.actor(session.noiseReduction, myName), failedSamples: new Set() };
    context.status ||= ownTakes().length ? 'noise.description' : 'noise.noSample';
    status(context.status); controls();
  }
  function currentPosition(state = context) {
    if (!state) return 0;
    const at = (state.position || state.begin || 0) + (state.playing ? state.output.currentTime - state.started : 0);
    return state.playing ? Math.min(state.end, at) : at;
  }
  function release(item) {
    if (item.released) return; item.released = true; item.node.onended = null;
    try { item.node.stop(); } catch {} item.node.disconnect(); item.fade.disconnect(); item.graph.gain.disconnect(); item.graph.panner.disconnect();
  }
  function stop(keep = true, state = context) {
    clearTimeout(sliderTimer); ++sampleGeneration; ++playbackGeneration;
    if (!state) return;
    state.abort?.abort(); state.preparing = false;
    state.position = keep ? currentPosition(state) : state.begin || 0; state.playing = false;
    for (const item of state.nodes || []) release(item);
    state.nodes?.clear(); state.source = null;
    if (state === context) controls();
  }
  function suspend() {
    clearTimeout(sliderTimer); ++sampleGeneration; stop(false); context?.abort?.abort();
    if (context) {
      context.buffer = null; context.sample = null; context.output = null; context.preparing = false;
      if (context.operation || JSON.stringify(context.draft) !== JSON.stringify(context.committed)) {
        retained.set(context.key, context); if (retained.size > 16) retained.delete(retained.keys().next().value);
      }
    }
    context = null;
  }
  async function chooseSample(state) {
    if (state.sample) {
      const currentTake = ownTakes().find(item => item.take.id === state.sample.takeId && item.take.audioUrl === state.sample.audioUrl);
      if (!currentTake) throw Error('noise.sampleUnavailable');
      state.sample = { ...structuredClone(currentTake.line), ...structuredClone(currentTake.take), id: currentTake.line.id, takeId: currentTake.take.id };
      return state.sample;
    }
    let candidates = ownTakes().filter(item => !state.failedSamples.has(item.take.audioUrl));
    if (candidates.length > 1 && state.previousSampleUrl) candidates = candidates.filter(item => item.take.audioUrl !== state.previousSampleUrl);
    const preferred = candidates.filter(item => (item.take.duration || item.take.takeDuration || 0) >= .4);
    const pool = preferred.length ? preferred : candidates;
    for (let attempt = 0; pool.length && attempt < 8; attempt++) {
      const item = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const raw = await audio.getRawTake(item.take.audioUrl, { signal: state.abort.signal });
      if (!current(state) || state.abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!raw || !raw.length || raw.duration <= 0) { state.failedSamples.add(item.take.audioUrl); continue; }
      state.sample = { ...structuredClone(item.line), ...structuredClone(item.take), id: item.line.id, takeId: item.take.id };
      $('noiseSampleLabel').textContent = `#${lineNumber(item.line)} · ${item.line.character} · ${item.line.caption || ''}`;
      state.position = 0; return state.sample;
    }
    throw Error(ownTakes().length ? 'noise.previewError' : 'noise.noSample');
  }
  async function prepare() {
    begin(); const state = context; if (!state) return false;
    const generation = ++sampleGeneration;
    state.abort?.abort(); state.abort = new AbortController(); state.preparing = true; status('noise.processing'); controls();
    try {
      const sample = await chooseSample(state);
      const scene = structuredClone(session), draft = { ...model.protocol(), ...state.draft };
      const line = { ...sample, _exportNoise: draft.enabled && draft.strength > 0 ? draft : null,
        _exportVoice: $('noiseEffects').checked ? DublineVoiceChain.resolve(sample, scene) : { pitch: 0, effects: [], tail: 0 } };
      const { buffer, gain } = await audio.prepareTake(line, { uncached: true, strict: true, scene, priority: 'preview', signal: state.abort.signal }); line._levelGain = gain;
      if (!current(state) || generation !== sampleGeneration || state.abort.signal.aborted) return false;
      if (!buffer) throw Error('noise.previewError');
      state.buffer = buffer; const bounds = audio.takeBounds(line, buffer.duration); state.begin = bounds.from; state.end = bounds.to;
      state.playLine = line; state.position = Math.max(state.begin, Math.min(state.position, Math.max(state.begin, state.end - .001)));
      status('noise.previewOnly'); return true;
    } catch (error) {
      if (current(state) && generation === sampleGeneration && error.name !== 'AbortError') { stop(false); status(error.message === 'noise.noSample' ? 'noise.noSample' : 'noise.previewError'); }
      return false;
    } finally { if (current(state) && generation === sampleGeneration) { state.preparing = false; controls(); } }
  }
  async function play() {
    const state = context; if (!state?.buffer) return;
    const generation = ++playbackGeneration;
    state.output ||= audio.ensurePlayCtx(); const output = state.output;
    await DublineAudioDevices.ready(); await DublineAudioDevices.resume(output);
    if (!current(state) || generation !== playbackGeneration || !visible()) return;
    const offset = currentPosition(state), next = output.createBufferSource(), fade = output.createGain();
    next.buffer = state.buffer;
    const graph = audio.connectAudition(next, fade, state.playLine), item = { node: next, fade, graph };
    state.nodes ||= new Set(); state.nodes.add(item);
    fade.gain.setValueAtTime(0, output.currentTime); fade.gain.linearRampToValueAtTime(1, output.currentTime + .03);
    const from = Math.max(state.begin, Math.min(offset, Math.max(state.begin, state.end - .001)));
    next.start(output.currentTime, from, Math.max(.001, state.end - from));
    const previous = state.source;
    if (previous) {
      previous.node.onended = () => { release(previous); state.nodes.delete(previous); };
      previous.fade.gain.cancelScheduledValues(output.currentTime); previous.fade.gain.setValueAtTime(previous.fade.gain.value, output.currentTime);
      previous.fade.gain.linearRampToValueAtTime(0, output.currentTime + .03); previous.node.stop(output.currentTime + .035);
    }
    state.source = item; state.position = offset; state.started = output.currentTime; state.playing = true;
    next.onended = () => { if (current(state) && state.source === item) stop(false); else release(item); };
    controls();
  }
  function receive(data) {
    if (data.sessionId !== session?.activeSessionId || !model.validState(data.noiseReduction) || data.noiseReduction.revision <= (session.noiseReduction?.revision || 0)) return;
    if (data.editorProtocol && !acceptSessionProtocol(data.editorProtocol)) return;
    session.noiseReduction = data.noiseReduction; audio.invalidateNoise(data.author); controls();
  }
  function call(event, data) { return new Promise(resolve => { try { socket.timeout(5000).emit(event, data, (error, answer) => resolve(error ? null : answer)); } catch { resolve(null); } }); }
  async function resolveOperation(state) {
    const request = state.operation;
    if (!request || !socket.connected) return null;
    if (state.attempted) {
      const known = await call('editor_operation_status', { event: 'noise_update', request });
      if (known?.ok && known.state === 'known') return known.result;
      if (!known?.ok || known.state !== 'unseen' || !known.retryable) return null;
    }
    state.attempted = true;
    let answer;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current(state)) break;
      answer = await call('noise_update', request); if (answer) return answer;
    }
    const found = await call('editor_operation_status', { event: 'noise_update', request });
    return found?.ok && found.state === 'known' ? found.result : null;
  }
  async function commit(state) {
    if (!current(state)) return false;
    if (!state.operation && JSON.stringify(state.draft) === JSON.stringify(model.actor(session.noiseReduction, myName))) return true;
    if (!socket.connected) { state.saveError = true; status('noise.syncError'); controls(); return false; }
    if (!state.operation) {
      if (JSON.stringify(state.committed) !== JSON.stringify(model.actor(session.noiseReduction, myName))) { state.saveError = true; status('noise.conflict'); controls(); return false; }
      state.operation = { ...model.protocol(), actor: { ...state.draft }, sessionId: state.sceneId,
        revision: session.noiseReduction?.revision || 0, operationId: newUploadId(), operationEpoch: session.editorProtocol?.epoch, operationTime: Date.now() };
      state.attempted = false;
    }
    status('noise.saving'); controls();
    const applied = { ...state.operation.actor }, answer = await resolveOperation(state);
    if (!current(state)) return false;
    if (!answer?.ok) {
      if (answer) state.operation = null; // A confirmed refusal permits a fresh explicit retry.
      state.saveError = true; status(answer?.reason?.startsWith('noise.') ? answer.reason : 'noise.syncError'); controls(); return false;
    }
    receive({ sessionId: state.sceneId, noiseReduction: answer.noiseReduction, author: state.name, editorProtocol: answer.editorProtocol });
    state.committed = applied; state.operation = null; state.saveError = false; status('noise.saved');
    return JSON.stringify(state.draft) === JSON.stringify(applied);
  }
  async function beforeExit() {
    const state = context; if (!state) return true;
    if (!state.saving) { state.saving = commit(state); controls(); }
    const success = await state.saving; state.saving = null;
    if (success && current(state)) { retained.delete(state.key); stop(false); state.abort?.abort(); context = null; ++sampleGeneration; controls(); }
    else controls();
    return success;
  }
  function edited() {
    const changed = { enabled: $('noiseEnable').checked, strength: Number($('noiseStrength').value) / 100 };
    begin(); if (!context) return;
    if (context.operation || context.saving) return controls();
    context.draft = changed;
    status(ownTakes().length ? 'noise.previewOnly' : 'noise.noSample'); controls(); refreshAudition();
  }
  function refreshAudition() {
    clearTimeout(sliderTimer);
    if (!context?.playing && !context?.preparing) return;
    ++sampleGeneration; context.abort?.abort();
    sliderTimer = setTimeout(async () => { if (await prepare()) await play().catch(() => status('noise.previewError')); }, 80);
  }
  function init() {
    for (const key of ['dubline_noise_profile', 'dubline_noise_offer_seen']) { try { localStorage.removeItem(key); } catch {} }
    const card = document.createElement('div'); card.id = 'noiseCard'; card.className = 'setting-card';
    card.innerHTML = `<div class="setting-card-row"><div><div class="setting-label" data-i18n="noise.title"></div><div class="setting-sub" data-i18n="noise.description"></div></div><label class="switch-ui"><input id="noiseEnable" type="checkbox"><span class="switch-slider"></span></label></div>
      <div id="noiseStrengthRow"><label for="noiseStrength" data-i18n="noise.strength"></label><output id="noiseStrengthValue">60%</output><input id="noiseStrength" type="range" min="0" max="100" value="60" data-reset-value="60" data-reset-event="input"></div>
      <p id="noiseStrongWarning" class="setting-sub" data-i18n="noise.strongWarning" hidden></p>
      <div class="noise-preview-actions"><button id="noisePreviewPlay" type="button" class="btn-outline" data-i18n="noise.play"></button><button id="noiseNext" type="button" class="btn-outline" data-i18n="noise.next"></button><label class="switch-ui"><input id="noiseEffects" type="checkbox" checked><span class="switch-slider"></span></label><span id="noiseEffectsHelp" tabindex="0" data-i18n="noise.effects"></span></div>
      <p id="noiseSampleLabel" class="setting-sub"></p><p id="noiseStatus" class="setting-sub" role="status" aria-live="polite"></p><button id="noiseRetry" type="button" class="btn-outline" data-i18n="noise.retry" hidden></button>`;
    addSettingsCard('user', 'audio', card);
    $('noiseEnable').onchange = edited; $('noiseStrength').oninput = edited;
    $('noiseEffects').onchange = refreshAudition;
    $('noisePreviewPlay').onclick = async () => { begin(); if (context?.playing) return stop(false); if (context) context.position = context.begin || 0; audio.stopPreview(); window.DublineTakeHistory?.stop(); if (await prepare()) await play().catch(() => status('noise.previewError')); };
    $('noiseNext').onclick = () => { begin(); if (context) { stop(false); context.previousSampleUrl = context.sample?.audioUrl; context.sample = null; context.buffer = null; context.failedSamples.clear(); $('noiseSampleLabel').textContent = ''; status('noise.description'); } };
    $('noiseRetry').onclick = async () => { if (context && !context.operation) context.committed = model.actor(session.noiseReduction, myName); if (await beforeExit()) begin(); };
    const open = window.openSettingsModal, close = window.closeSettingsModal, tab = window.switchSettingsTab;
    window.openSettingsModal = () => { open(); begin(); };
    window.closeSettingsModal = async () => { if (await beforeExit()) close(); };
    window.switchSettingsTab = async name => { if (name !== 'user' && !await beforeExit()) return; tab(name); begin(); };
    const switchScene = window.switchSession;
    window.switchSession = async (...args) => { if (await beforeExit()) return switchScene(...args); };
    socket.on('noise_updated', receive);
    socket.on('project_audio_updated', () => { if (visible() && context?.sample) refreshAudition(); });
    window.addEventListener('dubline-presets-changed', event => { if ($('noiseEffects').checked && context?.sample && event.detail.ids.includes(context.sample.id)) refreshAudition(); });
    socket.on('session_updated', () => {
      if (audioScene !== session?.activeSessionId) { audioScene = session?.activeSessionId; DublineNoiseAudio.cancelAll(); suspend(); }
      else if (context?.key !== scopeKey()) suspend();
      if (visible()) begin(); controls();
    });
    socket.on('nick_state', () => { if (context?.key !== scopeKey()) suspend(); if (visible()) begin(); controls(); });
    socket.on('disconnect', () => { stop(false); context?.abort?.abort(); if (context) status('noise.syncError'); controls(); });
    const checkSample = () => {
      if (context?.sample && !ownTakes().some(item => item.take.id === context.sample.takeId && item.take.audioUrl === context.sample.audioUrl)) {
        stop(false); context.abort?.abort(); ++sampleGeneration; context.sample = null; context.buffer = null; status('noise.sampleUnavailable'); controls();
      }
      if (context) {
        if (context.status === 'noise.noSample' && ownTakes().length) status('noise.description');
        controls();
      }
    };
    for (const event of ['line_updated', 'takes_updated', 'editor_lines_updated']) socket.on(event, checkSample);
    window.addEventListener('dubline-language-changed', () => { i18n.apply(card); $('noiseEnable').setAttribute('aria-label', t('noise.title')); if (context?.status) status(context.status); controls(); });
    window.addEventListener('pagehide', () => { suspend(); retained.clear(); });
    $('noiseEnable').setAttribute('aria-label', t('noise.title')); controls();
  }
  window.DublineNoise = Object.freeze({ begin, beforeExit, open: () => { openSettingsModal(); switchSettingsTab('user'); openSettingsCategory('user', 'audio'); },
    close: () => closeSettingsModal(), busy: () => !!context?.saving, ownTakes, previewPosition: currentPosition,
    snapshot: () => context && ({ sceneId: context.sceneId, draft: { ...context.draft }, sampleId: context.sample?.takeId, sampleUrl: context.sample?.audioUrl,
      playing: !!context.playing, preparing: !!context.preparing, operationId: context.operation?.operationId, saveError: !!context.saveError }) });
  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
