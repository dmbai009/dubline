// Local device preferences. Only listening destinations are registered here;
// microphone capture and offline/export graphs retain their own destinations.
(() => {
  const media = navigator.mediaDevices;
  const contexts = new Set(), elements = new Set(), streams = new Set();
  const read = key => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private profile */ } };
  let inputId = read('dubline_input_device'), outputId = read('dubline_output_device');
  let devices = [], enumeration = 0, outputQueue = Promise.resolve(), notice = '', captureRequests = 0;
  let inputSelect, outputSelect, status, permissionButton;
  const Context = window.AudioContext || window.webkitAudioContext;
  const policy = document.permissionsPolicy || document.featurePolicy;
  const policyBlocksOutput = policy?.features?.().includes('speaker-selection') && !policy.allowsFeature('speaker-selection');
  const outputSupported = !!(window.isSecureContext && Context?.prototype.setSinkId && HTMLMediaElement.prototype.setSinkId && !policyBlocksOutput);
  function say(key) { notice = key; paint(); }
  function recordingBusy() { return captureRequests > 0 || streams.size > 0; }
  function paintSelect(select, kind, selected) {
    if (!select) return;
    const options = [new Option(DublineI18n.t('audio.device.default'), '')];
    let index = 0;
    for (const device of devices.filter(item => item.kind === kind && item.deviceId && !['default', 'communications'].includes(item.deviceId))) {
      options.push(new Option(device.label || DublineI18n.t(kind === 'audioinput' ? 'audio.device.microphoneNumber' : 'audio.device.outputNumber', { n: ++index }), device.deviceId));
    }
    if (selected && !options.some(option => option.value === selected)) options.push(new Option(DublineI18n.t('audio.device.saved'), selected));
    select.replaceChildren(...options); select.value = selected;
  }
  function paint() {
    if (!inputSelect) return;
    paintSelect(inputSelect, 'audioinput', inputId); paintSelect(outputSelect, 'audiooutput', outputId);
    inputSelect.disabled = !media?.getUserMedia;
    outputSelect.hidden = !outputSupported; outputSelect.disabled = !outputSupported;
    document.getElementById('audioOutputUnsupported').hidden = outputSupported;
    status.textContent = DublineI18n.t(notice || (devices.some(device => device.label) ? 'audio.device.help' : 'audio.device.permissionHelp'));
    inputSelect.setAttribute('aria-label', DublineI18n.t('audio.device.input'));
    outputSelect.setAttribute('aria-label', DublineI18n.t('audio.device.output'));
  }
  async function route(target, id) {
    if (target.state === 'closed') { contexts.delete(target); return; }
    if (typeof target.setSinkId === 'function') await target.setSinkId(id);
  }
  async function routeAll(id) {
    const results = await Promise.allSettled([...contexts, ...elements].map(target => route(target, id)));
    const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  }
  function enqueue(action) { outputQueue = outputQueue.then(action, action); return outputQueue; }
  async function restoreOutput(previous) {
    for (const candidate of [...new Set([previous, ''])]) {
      try {
        await routeAll(candidate);
        outputId = candidate; write('dubline_output_device', candidate); return;
      } catch { /* Roll back every destination again on the system default. */ }
    }
    outputId = ''; write('dubline_output_device', '');
  }
  function changeOutput(id) {
    if (!outputSupported) return Promise.resolve(false);
    return enqueue(async () => {
      const previous = outputId;
      try {
        // Probe even before the first playback context exists.
        const probe = new Audio(); await route(probe, id); await routeAll(id);
        outputId = id; write('dubline_output_device', id); notice = ''; paint(); return true;
      } catch {
        await restoreOutput(previous); say('audio.device.outputFailed'); return false;
      }
    });
  }
  function register(target, collection) {
    collection.add(target);
    if (outputSupported) enqueue(async () => {
      try { await route(target, outputId); }
      catch {
        await restoreOutput(outputId); say('audio.device.outputFailed');
      }
    });
    return target;
  }
  async function refresh({ changed = false } = {}) {
    if (!media?.enumerateDevices) { say('audio.device.unavailable'); return; }
    const token = ++enumeration;
    try {
      const next = await media.enumerateDevices(); if (token !== enumeration) return;
      devices = next;
      // Without permission, labels and IDs can be withheld. Do not discard a
      // saved microphone preference merely because the permission is pending.
      if (next.some(device => device.kind === 'audioinput' && device.label) && inputId && !next.some(device => device.kind === 'audioinput' && device.deviceId === inputId)) {
        inputId = ''; write('dubline_input_device', ''); notice = 'audio.device.inputMissing';
      }
      if ((changed || next.some(device => device.kind === 'audiooutput' && device.label)) && outputId && !next.some(device => device.kind === 'audiooutput' && device.deviceId === outputId)) {
        await changeOutput(''); notice = 'audio.device.outputMissing';
      }
      paint();
    } catch { say('audio.device.listFailed'); }
  }
  async function capture(constraints) {
    if (!media?.getUserMedia) throw new Error('Microphone capture unavailable');
    const selected = inputId;
    captureRequests++;
    let stream;
    try {
      try { stream = await media.getUserMedia({ audio: { ...constraints, ...(selected ? { deviceId: { exact: selected } } : {}) } }); }
      catch (error) {
        if (!selected || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
        if (inputId === selected) { inputId = ''; write('dubline_input_device', ''); }
        say('audio.device.inputMissing'); stream = await media.getUserMedia({ audio: constraints });
      }
      if (!stream.active || !stream.getAudioTracks().some(track => track.readyState === 'live')) {
        stream.getTracks().forEach(track => track.stop()); say('audio.device.recordingInterrupted');
        throw new Error('Microphone disconnected before capture started');
      }
      streams.add(stream);
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
        streams.delete(stream);
        // Preserve the captured chunks when the hardware disappears.
        if (window.DublineState?.data.micStream === stream) window.finishRecording?.();
        say('audio.device.recordingInterrupted'); refresh({ changed: true });
      }, { once: true });
      refresh(); return stream;
    } finally { captureRequests--; }
  }
  function release(stream) { streams.delete(stream); if (!recordingBusy() && notice === 'audio.device.deferred') { notice = ''; paint(); } }
  window.DublineAudioDevices = {
    capture, release, refresh,
    live: stream => !!stream?.active && stream.getAudioTracks().some(track => track.readyState === 'live'),
    registerContext: context => register(context, contexts),
    registerElement: element => register(element, elements),
    unregisterElement: element => elements.delete(element),
    ready: () => outputQueue,
    resume: context => outputQueue.then(() => context.state === 'suspended' ? context.resume() : undefined),
    changeOutput,
    getSelection: () => ({ inputId, outputId, outputSupported })
  };
  function init() {
    const card = document.createElement('div'); card.className = 'setting-card settings-wide'; card.id = 'audioDeviceSettings';
    card.innerHTML = '<div class="setting-label" data-i18n="audio.device.title"></div><div class="audio-device-fields"><label><span data-i18n="audio.device.input"></span><select id="audioInputDevice" class="text-input audio-device-select"></select></label><label><span data-i18n="audio.device.output"></span><select id="audioOutputDevice" class="text-input audio-device-select"></select><span id="audioOutputUnsupported" class="setting-sub" data-i18n="audio.device.unsupported"></span></label></div><div id="audioDeviceStatus" class="setting-sub" role="status" aria-live="polite"></div><button id="audioDeviceRefresh" class="btn-outline" data-i18n="audio.device.refresh"></button>';
    window.addSettingsCard('user', 'audio', card); card.parentElement.prepend(card);
    inputSelect = card.querySelector('#audioInputDevice'); outputSelect = card.querySelector('#audioOutputDevice'); status = card.querySelector('#audioDeviceStatus'); permissionButton = card.querySelector('#audioDeviceRefresh');
    inputSelect.onchange = () => { inputId = inputSelect.value; write('dubline_input_device', inputId); say(recordingBusy() ? 'audio.device.deferred' : 'audio.device.help'); };
    outputSelect.onchange = () => { outputSelect.disabled = true; changeOutput(outputSelect.value).finally(() => { outputSelect.disabled = false; }); };
    permissionButton.onclick = async () => {
      permissionButton.disabled = true;
      try {
        if (!recordingBusy()) { const stream = await media.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); }
        notice = ''; await refresh();
      } catch { say('audio.device.permissionDenied'); }
      finally { permissionButton.disabled = false; }
    };
    permissionButton.disabled = !media?.getUserMedia;
    document.querySelectorAll('video, audio').forEach(element => register(element, elements));
    media?.addEventListener('devicechange', () => refresh({ changed: true }));
    window.addEventListener('dubline-language-changed', paint);
    paint(); refresh();
  }
  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
