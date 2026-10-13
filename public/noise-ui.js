// Microphone profile settings and an isolated scratch player. Preview never edits a take.
(() => {
  const model = DublineNoiseModel, $ = id => document.getElementById(id);
  const read = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  let stored = read('dubline_noise_profile'), draft = null, profile = null, signature = null;
  let captureAbort = null, stopTest = null, previewAbort = null, sample = null, cleaned = null, sampleIdentity = null;
  let ctx = null, source = null, sourceGain = null, position = 0, startedAt = 0, playing = false;
  let playbackGeneration = 0;
  let sceneId = null, operation = null, processingGeneration = 0, sliderTimer = null, progressTimer = null;
  let audioScene = null;
  const fading = new Map();
  let selectionCatalog = new Map(), selectedTakes = new Set();
  const automaticScopes = new Set();
  let offerPending = false, offerTimer = null, focus = null;
  let statusKey = null, statusValues = null;
  const signatureNow = () => JSON.stringify({ input: DublineAudioDevices.getSelection().inputId, gain: userMicGain, browser: noiseSuppression });
  const deviceKey = stream => {
    const settings = stream?.getAudioTracks()[0]?.getSettings();
    return settings?.deviceId ? JSON.stringify([settings.deviceId, settings.groupId || '']) : null;
  };
  const actor = () => session?.noiseReduction?.actors?.[myName];
  const ownTakes = () => (session?.lines || []).flatMap(line => [line.audioUrl && { line, take: { ...line, id: line.takeId }, historical: false }, ...(line.takeHistory || []).map(take => ({ line, take, historical: true }))].filter(Boolean)).filter(item => item.take.recordedBy === myName);
  const busy = () => !!captureAbort;
  const freeMicrophone = () => recordState === 'idle' && !recordStartPending && !renderInProgress && !projectImportBusy && !customImportRequest && !window.snapshotFrozen && !watchMode && !DublineAudioDevices.busy();
  function status(key, values) { statusKey = key; statusValues = values; $('noiseStatus').textContent = t(key, values); }
  function controls() {
    for (const id of ['noiseCalibrate', 'noiseTestRecord', 'noiseConfirm', 'noiseSelect', 'noiseApplyAll']) $(id).disabled = !!operation || busy();
    $('noiseCaptureCancel').hidden = !busy();
    $('noiseEnable').disabled = !profile; $('noiseConfirm').disabled ||= !profile || !socket.connected;
    $('noiseStrengthValue').textContent = `${Math.round(draft?.strength * 100 || 0)}%`;
    $('noisePreviewPlay').disabled = !sample || busy(); $('noiseAB').disabled = !sample || busy();
    $('noiseSample').disabled = busy(); $('noiseSampleSearch').disabled = busy();
    $('noiseTestRecord').disabled = !!operation || busy() && !stopTest;
    $('noiseApplyAll').disabled ||= !profile; $('noiseSelect').disabled ||= !profile;
  }
  function loadDraft() {
    const a = actor(), p = session?.noiseReduction?.profiles?.[a?.profileId];
    profile = p || (model.validProfile(stored?.profile) ? stored.profile : null);
    signature = stored?.profile?.id === profile?.id ? stored?.signature || null : null;
    draft = a ? { ...a } : { enabled: !!profile && stored?.enabled !== false, strength: stored?.strength ?? .2, profileId: profile?.id || null };
    $('noiseEnable').checked = draft.enabled; $('noiseStrength').value = Math.round(draft.strength * 100);
    status(profile ? ((signature?.settings || signature) === signatureNow() ? 'noise.calibrated' : 'noise.recalibrateRecommended') : 'noise.notCalibrated');
    controls(); populateSamples();
  }
  function open() {
    if (!session?.loaded || !socket.connected) return showToast(t('record.connectionRequired'));
    if (!freeMicrophone()) return showToast(t('noise.busy'));
    if ($('noiseDialog').open) return;
    focus = document.activeElement; sceneId = session.activeSessionId; loadDraft();
    $('noiseDialog').style.setProperty('--noise-ui-zoom', Number(getComputedStyle(document.body).zoom) || 1);
    $('noiseDialog').showModal(); $('noiseCalibrate').focus();
  }
  function currentPosition() { return playing && ctx && sample ? (position + ctx.currentTime - startedAt) % sample.duration : position; }
  function stopPlayback(keep = true) {
    ++playbackGeneration;
    if (keep) position = currentPosition(); else position = 0;
    playing = false; if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); sourceGain?.disconnect(); source = null; }
    for (const [old, item] of fading) { clearTimeout(item.timer); try { old.stop(); } catch {} old.disconnect(); item.gain.disconnect(); } fading.clear();
    $('noisePreviewPlay').textContent = t('noise.play');
  }
  async function play(buffer = $('noiseAB').value === 'raw' ? sample : cleaned || sample, replace = false) {
    if (!buffer) return;
    const generation = ++playbackGeneration;
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    DublineAudioDevices.registerContext(ctx); await DublineAudioDevices.resume(ctx);
    if (generation !== playbackGeneration || !sample || !$('noiseDialog').open) return;
    const offset = currentPosition(), old = source, oldGain = sourceGain;
    const next = ctx.createBufferSource(), gain = ctx.createGain(); next.buffer = buffer; next.loop = $('noiseLoop').checked;
    gain.gain.setValueAtTime(0, ctx.currentTime); gain.gain.linearRampToValueAtTime(1, ctx.currentTime + .03);
    next.connect(gain).connect(ctx.destination); next.start(0, Math.min(offset, buffer.duration - 1 / buffer.sampleRate));
    position = offset; startedAt = ctx.currentTime; source = next; sourceGain = gain; playing = true;
    next.onended = () => { if (source === next) stopPlayback(false); };
    if (old) {
      old.onended = null; oldGain.gain.cancelScheduledValues(ctx.currentTime); oldGain.gain.setValueAtTime(oldGain.gain.value, ctx.currentTime); oldGain.gain.linearRampToValueAtTime(0, ctx.currentTime + .03);
      const timer = setTimeout(() => { try { old.stop(); } catch {} old.disconnect(); oldGain.disconnect(); fading.delete(old); }, 40);
      fading.set(old, { timer, gain: oldGain });
    }
    $('noisePreviewPlay').textContent = t('noise.pause');
  }
  async function updatePreview() {
    clearTimeout(sliderTimer); const generation = ++processingGeneration;
    previewAbort?.abort(); previewAbort = new AbortController();
    if (!sample || !profile) return;
    status('noise.processing');
    try {
      const result = await DublineNoiseAudio.clean(sample, { profile, strength: draft.strength }, previewAbort.signal, true);
      if (generation !== processingGeneration || !$('noiseDialog').open) return;
      cleaned = result; if (playing && $('noiseAB').value === 'clean') await play(cleaned, true); status('noise.previewOnly');
    } catch (error) { if (error.name !== 'AbortError') status('noise.fallback'); }
  }
  function close() {
    clearTimeout(sliderTimer); captureAbort?.abort(); previewAbort?.abort(); ++processingGeneration; stopPlayback(false);
    if (ctx) { DublineAudioDevices.unregisterContext(ctx); ctx.close(); }
    ctx = null; sample = null; cleaned = null; sampleIdentity = null; sceneId = null; operation = null;
    $('noiseDialog').close(); $('noiseSelection').hidden = true; if (focus?.isConnected) focus.focus();
  }
  async function capture(seconds, test = false) {
    if (!freeMicrophone()) throw Error('noise.busy');
    const abort = new AbortController(); captureAbort = abort; controls();
    const captureSignature = signatureNow(); let stream, context, input, gain, processor, mute, timer;
    stopPlayback(false); video.pause(); audio.stopPreview(); window.DublineTakeHistory?.stop();
    const parts = []; let length = 0, ended;
    try {
      stream = await DublineAudioDevices.capture({ echoCancellation: noiseSuppression, noiseSuppression, autoGainControl: false, channelCount: 1 });
      if (abort.signal.aborted || captureSignature !== signatureNow() || sceneId !== session?.activeSessionId || !DublineAudioDevices.live(stream)) throw new DOMException('Cancelled', 'AbortError');
      context = new (window.AudioContext || window.webkitAudioContext)(); await context.resume();
      input = context.createMediaStreamSource(stream); gain = context.createGain(); gain.gain.value = userMicGain;
      processor = context.createScriptProcessor(2048, 1, 1); mute = context.createGain(); mute.gain.value = 0;
      input.connect(gain).connect(processor).connect(mute).connect(context.destination);
      const target = Math.round(seconds * context.sampleRate);
      await new Promise((resolve, reject) => {
        const finish = () => resolve(); stopTest = test ? finish : null;
        if (test) { $('noiseTestRecord').disabled = false; $('noiseTestRecord').textContent = t('noise.stopTest'); }
        ended = () => reject(Error('noise.deviceLost'));
        for (const track of stream.getAudioTracks()) track.addEventListener('ended', ended);
        abort.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        processor.onaudioprocess = event => {
          if (captureSignature !== signatureNow()) return reject(Error('noise.deviceChanged'));
          const data = event.inputBuffer.getChannelData(0), count = Math.min(data.length, target - length);
          if (count > 0) { parts.push(data.slice(0, count)); length += count; }
          if (length >= target) resolve();
        };
        progressTimer = setInterval(() => { $('noiseProgress').value = length / target; status(test ? 'noise.testRecording' : 'noise.collecting', { seconds: Math.max(0, Math.ceil(seconds - length / context.sampleRate)) }); }, 100);
        timer = setTimeout(() => reject(Error('noise.incomplete')), seconds * 1000 + 8000);
      });
      if (!length || abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const pcm = new Float32Array(length); let at = 0; for (const part of parts) { pcm.set(part, at); at += part.length; }
      return { pcm, sampleRate: context.sampleRate, signature: { settings: captureSignature, deviceId: deviceKey(stream) } };
    } finally {
      clearTimeout(timer); clearInterval(progressTimer); progressTimer = null; stopTest = null;
      if (processor) processor.onaudioprocess = null;
      for (const node of [input, gain, processor, mute]) node?.disconnect();
      if (stream) { for (const track of stream.getTracks()) { track.removeEventListener('ended', ended); track.stop(); } DublineAudioDevices.release(stream); }
      await context?.close(); captureAbort = null; $('noiseProgress').value = 0; controls();
    }
  }
  async function calibrate() {
    const scope = sceneId;
    try {
      const data = await capture(6); status('noise.processing');
      previewAbort?.abort(); previewAbort = new AbortController();
      const result = await DublineNoiseAudio.run({ kind: 'calibrate', pcm: data.pcm, sampleRate: data.sampleRate }, previewAbort.signal);
      if (scope !== sceneId || !$('noiseDialog').open) return;
      profile = { ...result, id: crypto.randomUUID ? crypto.randomUUID() : newUploadId() };
      signature = data.signature; draft.profileId = profile.id; draft.enabled = true;
      $('noiseEnable').checked = true; status('noise.calibratedDraft'); controls(); if (sample) updatePreview();
    } catch (error) { if ($('noiseDialog').open) status(error.name === 'AbortError' ? 'noise.cancelled' : error.message.startsWith('noise.') ? error.message : 'error.mic'); }
  }
  function populateSamples() {
    const query = $('noiseSampleSearch').value.toLocaleLowerCase(), select = $('noiseSample');
    const options = [new Option(t('noise.chooseSample'), '')];
    for (const item of ownTakes()) {
      const label = `#${item.line.id} · ${item.line.character} · ${item.line.caption || ''}${item.historical ? ' · ' + t('noise.history') : ''}`;
      if (!label.toLocaleLowerCase().includes(query)) continue;
      options.push(new Option(label, `${item.line.id}:${item.take.id}`));
    }
    const current = select.value; select.replaceChildren(...options); if (options.some(o => o.value === current)) select.value = current;
  }
  async function selectSample() {
    stopPlayback(false); previewAbort?.abort(); const generation = ++processingGeneration;
    sample = null; cleaned = null; sampleIdentity = $('noiseSample').value; controls();
    const item = ownTakes().find(item => `${item.line.id}:${item.take.id}` === sampleIdentity); if (!item) return;
    const abort = new AbortController(); previewAbort = abort; status('noise.loading');
    try {
      const raw = await audio.getRawTake(item.take.audioUrl, { signal: abort.signal });
      if (generation !== processingGeneration || !$('noiseDialog').open) return;
      if (!raw) throw Error('noise.sampleUnavailable');
      sample = raw; controls(); await updatePreview();
    } catch (error) { if (error.name !== 'AbortError') status('noise.sampleUnavailable'); }
  }
  async function mutation(payload) {
    const request = { ...payload, sessionId: sceneId, revision: session.noiseReduction?.revision || 0,
      operationId: newUploadId(), operationEpoch: session.editorProtocol?.epoch, operationTime: Date.now() };
    operation = request; controls();
    // Retry the same operation ID after a lost ACK. No fresh blind mutation.
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!socket.connected || sceneId !== session?.activeSessionId) break;
      result = await new Promise(resolve => socket.timeout(5000).emit('noise_update', request, (error, answer) => resolve(error ? null : answer)));
      if (result) break;
    }
    operation = null; controls();
    if (!result?.ok) { status(result?.reason?.startsWith('noise.') ? result.reason : 'noise.syncError'); return false; }
    status('noise.saved'); return true;
  }
  async function confirm() {
    if (!profile || busy()) return;
    if (await mutation({ profile, actor: { ...draft, profileId: profile.id } })) {
      stored = { profile, signature, enabled: draft.enabled, strength: draft.strength }; write('dubline_noise_profile', stored); write('dubline_noise_offer_seen', true);
    }
  }
  function selection(reset = true) {
    if (reset) {
      selectionCatalog = new Map(ownTakes().map(item => [`${item.line.id}:${item.take.id}`, structuredClone(item)]));
      selectedTakes.clear();
    }
    $('noiseSelection').hidden = false; const list = $('noiseTakeList'); list.replaceChildren();
    const filter = $('noiseTakeSearch').value.toLocaleLowerCase();
    for (const [key, item] of selectionCatalog) {
      const label = `#${item.line.id} · ${item.line.character} · ${item.line.caption || ''} · ${item.historical ? t('noise.history') : t('noise.current')} · ${item.take.duration || item.take.takeDuration ? (item.take.duration || item.take.takeDuration).toFixed(1) + 's' : ''}`;
      if (!label.toLocaleLowerCase().includes(filter)) continue;
      const row = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
      input.type = 'checkbox'; input.dataset.id = key; input.checked = selectedTakes.has(key);
      input.onchange = () => input.checked ? selectedTakes.add(key) : selectedTakes.delete(key);
      text.textContent = label + (item.take.noiseProfileId ? ' · ' + t('noise.on') : ''); row.append(input, text); list.append(row);
    }
    $('noiseTargetProfile').textContent = t('noise.targetProfile', { profile: profile?.id.slice(0, 8) || '—' });
  }
  async function applyTakes(items, apply) {
    if (!items.length || !profile || busy()) return;
    const takes = items.map(({ line, take }) => ({ lineId: line.id, takeId: take.id, historyRevision: line.takeHistoryRevision || 0 }));
    if (!await askConfirm(t('noise.confirmBatch', { n: items.length }))) return;
    if (!$('noiseDialog').open || sceneId !== session?.activeSessionId) return;
    // Local checkbox/sample selection is not consulted when applying global settings.
    if (await mutation({ profile, actor: { ...draft, profileId: profile.id }, takes, profileId: profile.id, apply })) {
      stored = { profile, signature, enabled: draft.enabled, strength: draft.strength }; write('dubline_noise_profile', stored); selection();
    }
  }
  function selectedItems() { return [...selectedTakes].map(key => selectionCatalog.get(key)); }
  function receive(data) {
    if (data.sessionId !== session?.activeSessionId || data.noiseReduction.revision < (session.noiseReduction?.revision || 0)) return;
    if (!acceptSessionProtocol(data.editorProtocol)) return;
    session.noiseReduction = data.noiseReduction;
    if (stored && data.author === myName && actor()) { stored.enabled = actor().enabled; stored.strength = actor().strength; write('dubline_noise_profile', stored); }
    audio.invalidateNoise(data.author); if (data.lines?.length) applyTakeUpdates(data.sessionId, data.lines, data.editorProtocol, { prewarm: false });
    paintCard();
  }
  function paintCard() { $('noiseCardStatus').textContent = t(actor()?.enabled ? 'noise.enabledStatus' : 'noise.offStatus'); }
  async function initializeFutureTakes() {
    if (!socket.connected || !session?.loaded || !window.hasSceneMediaAccess?.() || !model.validProfile(stored?.profile) || actor() ||
        (stored.signature?.settings || stored.signature) !== signatureNow() || ownTakes().some(item => item.take.noiseProfileId)) return;
    const scope = session.activeSessionId, name = myName, key = `${currentRoom}:${scope}:${name}`;
    if (automaticScopes.has(key)) return; automaticScopes.add(key);
    if (automaticScopes.size > 32) automaticScopes.delete(automaticScopes.values().next().value);
    const p = { ...stored.profile }, localId = p.id;
    if (session.noiseReduction?.profiles[p.id] && session.noiseReduction.profiles[p.id].author !== name) p.id = newUploadId();
    const request = { sessionId: scope, revision: session.noiseReduction?.revision || 0, initialize: true, profile: p,
      actor: { enabled: stored.enabled !== false, strength: stored.strength ?? .2, profileId: p.id }, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!socket.connected || scope !== session?.activeSessionId || name !== myName) return;
      const result = await new Promise(resolve => socket.volatile.timeout(5000).emit('noise_update', request, (error, value) => resolve(error ? null : value)));
      if (result) {
        if (result.ok && scope === session?.activeSessionId && actor()?.profileId === p.id && stored?.profile.id === localId) { stored.profile = p; write('dubline_noise_profile', stored); }
        return;
      }
    }
  }
  function scheduleOffer() {
    if (!offerPending || read('dubline_noise_offer_seen') || model.validProfile(stored?.profile)) return;
    clearTimeout(offerTimer); offerTimer = setTimeout(() => {
      if (!offerPending || !freeMicrophone() || !session?.loaded || !socket.connected) return;
      if ([...document.querySelectorAll('.modal-overlay, dialog[open]')].some(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')) return;
      $('noiseOffer').showModal();
    }, 300);
  }
  function dismissOffer(configure) { write('dubline_noise_offer_seen', true); offerPending = false; $('noiseOffer').close(); if (configure) open(); }
  function captureBinding(gain = userMicGain, browser = noiseSuppression, stream = null) {
    const a = actor(); if (!a) { if (stored?.enabled && model.validProfile(stored.profile)) showToast(t('noise.profileMissing')); return null; } if (!a.enabled) return null;
    const captured = JSON.stringify({ input: DublineAudioDevices.getSelection().inputId, gain, browser });
    const actual = deviceKey(stream);
    if (stored?.profile?.id !== a.profileId || (stored.signature?.settings || stored.signature) !== captured || stored.signature?.deviceId && stored.signature.deviceId !== actual) { showToast(t('noise.recalibrateRecommended')); return null; }
    return a.profileId;
  }
  function init() {
    const card = document.createElement('div'); card.className = 'setting-card settings-wide';
    card.innerHTML = '<div class="setting-label" data-i18n="noise.title"></div><p id="noiseCardStatus" class="setting-sub"></p><button class="btn-outline" id="noiseOpen" data-i18n="noise.configure"></button>';
    addSettingsCard('user', 'audio', card);
    const dialog = document.createElement('dialog'); dialog.id = 'noiseDialog'; dialog.className = 'noise-dialog'; dialog.setAttribute('aria-labelledby', 'noiseTitle');
    dialog.innerHTML = `<div class="noise-heading"><h2 id="noiseTitle" data-i18n="noise.title"></h2><button id="noiseClose" class="btn-outline" data-i18n="dialog.cancel"></button></div>
      <p class="setting-sub" data-i18n="noise.instruction"></p><div class="noise-actions"><button id="noiseCalibrate" class="btn-play" data-i18n="noise.calibrate"></button><button id="noiseCaptureCancel" class="btn-outline" data-i18n="dialog.cancel" hidden></button></div>
      <progress id="noiseProgress" max="1" value="0"></progress><p id="noiseStatus" role="status" aria-live="polite"></p>
      <label class="noise-row"><input id="noiseEnable" type="checkbox"><span data-i18n="noise.useNew"></span></label>
      <label for="noiseStrength" data-i18n="noise.strength"></label> <output id="noiseStrengthValue">20%</output><input id="noiseStrength" type="range" min="0" max="100" value="20" data-reset-value="20" data-reset-event="input"><div class="noise-scale"><span data-i18n="noise.weak"></span><span data-i18n="noise.medium"></span><span data-i18n="noise.strong"></span></div>
      <details><summary data-i18n="noise.checkSound"></summary><p class="setting-sub" data-i18n="noise.previewOnly"></p><button id="noiseTestRecord" class="btn-outline" data-i18n="noise.testRecord"></button>
      <input id="noiseSampleSearch" class="text-input" data-i18n-placeholder="noise.search" aria-label="Search"><select id="noiseSample" class="text-input"></select>
      <div class="noise-actions"><button id="noisePreviewPlay" class="btn-play" data-i18n="noise.play" disabled></button><select id="noiseAB" class="text-input"><option value="raw" data-i18n="noise.raw"></option><option value="clean" data-i18n="noise.cleaned"></option></select><label><input id="noiseLoop" type="checkbox" checked><span data-i18n="noise.loop"></span></label></div></details>
      <details><summary data-i18n="noise.existing"></summary><p class="setting-sub" data-i18n="noise.oldWarning"></p><div class="noise-actions"><button id="noiseApplyAll" class="btn-outline" data-i18n="noise.applyAll"></button><button id="noiseSelect" class="btn-outline" data-i18n="noise.select"></button></div>
      <div id="noiseSelection" hidden><p id="noiseTargetProfile" class="setting-sub"></p><input id="noiseTakeSearch" class="text-input" data-i18n-placeholder="noise.search" aria-label="Search"><div class="noise-actions"><button id="noiseSelectAll" class="btn-outline" data-i18n="noise.selectAll"></button><button id="noiseSelectNone" class="btn-outline" data-i18n="noise.selectNone"></button></div><div id="noiseTakeList"></div><div class="noise-actions"><button id="noiseApplySelected" class="btn-play" data-i18n="noise.applySelected"></button><button id="noiseRemoveSelected" class="btn-outline" data-i18n="noise.removeSelected"></button><button id="noiseRemoveAll" class="btn-outline" data-i18n="noise.removeAll"></button><button id="noiseSelectionCancel" class="btn-outline" data-i18n="dialog.cancel"></button></div></div></details>
      <p class="setting-sub" data-i18n="noise.browserWarning"></p><button id="noiseConfirm" class="btn-play" data-i18n="noise.confirm"></button>`;
    document.body.append(dialog); i18n.apply(dialog);
    const offer = document.createElement('dialog'); offer.id = 'noiseOffer'; offer.className = 'noise-dialog';
    offer.innerHTML = '<h2 data-i18n="noise.offerTitle"></h2><p data-i18n="noise.offerText"></p><div class="noise-actions"><button id="noiseOfferSetup" class="btn-play" data-i18n="noise.configure"></button><button id="noiseOfferSkip" class="btn-outline" data-i18n="noise.skip"></button><button id="noiseOfferClose" class="btn-outline" aria-label="Close">×</button></div>'; document.body.append(offer); i18n.apply(offer);
    $('noiseOpen').onclick = open; $('noiseClose').onclick = close; dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    $('noiseOfferSetup').onclick = () => dismissOffer(true); $('noiseOfferSkip').onclick = $('noiseOfferClose').onclick = () => dismissOffer(false);
    offer.addEventListener('cancel', event => { event.preventDefault(); dismissOffer(false); });
    $('noiseCalibrate').onclick = calibrate; $('noiseCaptureCancel').onclick = () => captureAbort?.abort();
    $('noiseEnable').onchange = () => { draft.enabled = $('noiseEnable').checked; };
    $('noiseStrength').oninput = () => { draft.strength = Number($('noiseStrength').value) / 100; controls(); clearTimeout(sliderTimer); previewAbort?.abort(); sliderTimer = setTimeout(updatePreview, 80); };
    $('noiseTestRecord').onclick = async () => {
      if (stopTest) return stopTest();
      const scope = sceneId;
      try { const data = await capture(30, true); if (!dialog.open || sceneId !== scope) return; sample = new AudioBuffer({ length: data.pcm.length, numberOfChannels: 1, sampleRate: data.sampleRate }); sample.copyToChannel(data.pcm, 0); sampleIdentity = null; cleaned = null; controls(); updatePreview(); }
      catch (error) { if (dialog.open) status(error.name === 'AbortError' ? 'noise.cancelled' : 'error.mic'); }
      finally { $('noiseTestRecord').textContent = t('noise.testRecord'); }
    };
    // Keep Stop available while only a scratch recording is active.
    $('noiseTestRecord').addEventListener('click', () => { if (captureAbort && stopTest) { $('noiseTestRecord').disabled = false; $('noiseTestRecord').textContent = t('noise.stopTest'); } });
    $('noiseSampleSearch').oninput = populateSamples; $('noiseSample').onchange = selectSample;
    $('noisePreviewPlay').onclick = () => playing ? stopPlayback() : play().catch(() => status('noise.sampleUnavailable')); $('noiseAB').onchange = () => { if (playing) play().catch(() => status('noise.sampleUnavailable')); };
    $('noiseLoop').onchange = () => { if (source) source.loop = $('noiseLoop').checked; };
    $('noiseConfirm').onclick = confirm; $('noiseApplyAll').onclick = () => applyTakes(ownTakes(), true); $('noiseSelect').onclick = selection;
    $('noiseTakeSearch').oninput = () => selection(false); $('noiseSelectAll').onclick = () => { for (const key of selectionCatalog.keys()) selectedTakes.add(key); selection(false); };
    $('noiseSelectNone').onclick = () => { selectedTakes.clear(); selection(false); };
    $('noiseApplySelected').onclick = () => applyTakes(selectedItems(), true); $('noiseRemoveSelected').onclick = () => applyTakes(selectedItems(), false); $('noiseRemoveAll').onclick = () => applyTakes(ownTakes().filter(item => item.take.noiseProfileId), false); $('noiseSelectionCancel').onclick = () => $('noiseSelection').hidden = true;
    socket.on('noise_updated', receive);
    socket.on('session_updated', () => { if (audioScene !== session?.activeSessionId) { audioScene = session?.activeSessionId; DublineNoiseAudio.cancelAll(); } if (dialog.open && sceneId !== session?.activeSessionId) close(); paintCard(); scheduleOffer(); void initializeFutureTakes(); });
    socket.on('nick_state', () => { void initializeFutureTakes(); });
    for (const event of ['line_updated', 'takes_updated']) socket.on(event, () => { if (sampleIdentity && !ownTakes().some(item => `${item.line.id}:${item.take.id}` === sampleIdentity)) { stopPlayback(false); sample = null; cleaned = null; previewAbort?.abort(); ++processingGeneration; controls(); status('noise.sampleUnavailable'); } });
    socket.on('disconnect', () => { if (dialog.open) close(); offer.close(); });
    window.addEventListener('dubline-microphone-granted', () => { offerPending = true; });
    window.addEventListener('storage', event => { if (event.key === 'dubline_noise_profile') stored = read('dubline_noise_profile'); });
    window.addEventListener('dubline-microphone-released', scheduleOffer);
    document.addEventListener('close', scheduleOffer, true);
    // Legacy settings/PIN/help overlays close by changing style rather than by
    // dispatching dialog.close. Observe only dialog visibility, not timeline DOM.
    const visibility = new MutationObserver(scheduleOffer);
    for (const modal of document.querySelectorAll('.modal-overlay, dialog')) visibility.observe(modal, { attributes: true, attributeFilter: ['style', 'open'] });
    window.addEventListener('dubline-language-changed', () => {
      i18n.apply(dialog); i18n.apply(offer); paintCard();
      if (statusKey) status(statusKey, statusValues); populateSamples();
      $('noisePreviewPlay').textContent = t(playing ? 'noise.pause' : 'noise.play');
      if (!$('noiseSelection').hidden) selection(false);
    });
    window.addEventListener('pagehide', () => { visibility.disconnect(); clearTimeout(offerTimer); close(); }); paintCard();
  }
  window.DublineNoise = { open, close, busy, captureBinding, ownTakes, previewPosition: currentPosition };
  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
