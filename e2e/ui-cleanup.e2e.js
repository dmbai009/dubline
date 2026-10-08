const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, claimAndSelect } = require('./helpers');

// Virtual device identities wrap real Chromium capture/playback. They simulate
// unplugging hardware without replacing MediaRecorder or the listening graphs.
async function virtualDevices(page) {
  await page.evaluateOnNewDocument(() => {
    window.deviceFixture = [
      { kind: 'audioinput', deviceId: 'mic-a', label: 'Studio microphone' },
      { kind: 'audioinput', deviceId: 'mic-b', label: 'Headset microphone' },
      { kind: 'audiooutput', deviceId: 'out-a', label: 'Studio headphones' },
      { kind: 'audiooutput', deviceId: 'out-b', label: 'Speakers' }
    ];
    window.captureDevices = []; window.routedAudio = [];
    navigator.mediaDevices.enumerateDevices = async () => deviceFixture;
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => {
      const id = constraints.audio?.deviceId?.exact || '';
      captureDevices.push(id);
      if (id && !deviceFixture.some(device => device.deviceId === id)) return Promise.reject(new DOMException('Device gone', 'OverconstrainedError'));
      const { deviceId, ...audio } = constraints.audio === true ? {} : constraints.audio;
      return capture({ audio: Object.keys(audio).length ? audio : true });
    };
    for (const prototype of [AudioContext.prototype, HTMLMediaElement.prototype]) {
      const original = prototype.setSinkId;
      prototype.setSinkId = async function(id) {
        routedAudio.push({ kind: this instanceof AudioContext ? 'context' : 'element', name: this.id || '', id });
        if (id && (window.failOutput === id || !deviceFixture.some(device => device.deviceId === id))) throw new DOMException('Output unavailable', 'NotFoundError');
        if (original) await original.call(this, '');
        this.testSink = id;
      };
    }
  });
}

describe('UI cleanup and local audio devices', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, page, serial = 0;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => {
    page = await openPlayer(browser, server.url(`ui-cleanup-${++serial}`), 'Alice', { autoConfirm: false, beforeLoad: virtualDevices });
    await loadFixture(page); await waitFor(page, () => !!window.DublineAudioDevices && !!document.getElementById('audioInputDevice'));
  });
  afterEach(async () => { assert.deepEqual(page.errors, []); await page.browserContext().close(); });

  test('header has accessible, nonoverlapping actions at three sizes, three locales and 150% UI scale', async () => {
    await page.evaluate(() => { session.title = 'A very long session — Длинное название проекта '.repeat(8); renderSessions(); });
    for (const language of ['ru', 'en', 'uk']) {
      await page.evaluate(language => i18n.setLanguage(language), language);
      for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080]]) {
        await page.setViewport({ width, height });
        for (const scale of [1, 1.5]) {
          await page.evaluate(scale => { document.documentElement.style.zoom = String(scale); }, scale);
          const collisions = await page.evaluate(() => {
            const controls = [...document.querySelectorAll('header button, header input')].map(element => ({ element, r: element.getBoundingClientRect() })).filter(({ r }) => r.width && r.height);
            const failures = [];
            for (const { element, r } of controls) {
              if (r.left < -1 || r.right > innerWidth + 1) failures.push('outside: ' + element.outerHTML.slice(0, 100));
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              if (!element.contains(hit) && hit !== element) failures.push('covered: ' + element.outerHTML.slice(0, 100));
            }
            return failures;
          });
          assert.deepEqual(collisions, [], `${language} ${width} ${scale}`);
        }
      }
    }
  });

  test('settings retain handlers, personal/shared scopes, one project mixer and accessible cursor switch', async () => {
    const result = await page.evaluate(() => {
      openSettingsModal();
      const parent = id => document.getElementById(id).closest('.tab-content').id;
      return { mix: !!document.getElementById('projectMixSettings'), cards: ['settingsMicGain', 'settingsP2P', 'mediaCacheLimit', 'settingsCollaboratorCursors', 'audioInputDevice'].map(parent), shared: parent('settingsAutoDuck'), switch: !!document.getElementById('settingsCollaboratorCursors').closest('.switch-ui') };
    });
    assert.equal(result.mix, false); assert.equal(result.switch, true); assert.ok(result.cards.every(id => id === 'tabContentUser')); assert.equal(result.shared, 'tabContentPlayer');
    await page.click('#settings-user-interface-tab'); await page.click('#settingsCollaboratorCursors + .switch-slider');
    assert.equal(await page.evaluate(() => localStorage.getItem('dubline_cursors')), '0');
    await page.click('#settings-user-storage-tab');
    const inline = await page.$eval('.setting-unit-field', node => { const input = node.firstElementChild.getBoundingClientRect(), unit = node.lastElementChild.getBoundingClientRect(); return Math.abs(input.top + input.height / 2 - unit.top - unit.height / 2) < 2; });
    assert.equal(inline, true);
    for (const language of ['ru', 'en', 'uk']) {
      await page.evaluate(language => i18n.setLanguage(language), language);
      assert.equal(await page.$eval('#clearMediaCache', node => node.textContent), await page.evaluate(() => t('cache.clear')));
    }
  });

  test('microphone selection persists and changing it during a real take preserves the current stream', async () => {
    await page.evaluate(() => openSettingsModal()); await page.select('#audioInputDevice', 'mic-a'); await page.evaluate(() => closeSettingsModal());
    await page.reload(); await waitFor(page, () => session?.loaded && document.getElementById('audioInputDevice'));
    assert.equal(await page.$eval('#audioInputDevice', node => node.value), 'mic-a');
    await claimAndSelect(page, 1); await page.evaluate(() => handleStudioRecord(1));
    await waitFor(page, () => recordState !== 'idle' && !!micStream);
    await page.evaluate(() => { window.recordedStream = micStream; openSettingsModal(); }); await page.select('#audioInputDevice', 'mic-b');
    assert.equal(await page.evaluate(() => micStream === recordedStream && micStream.getAudioTracks()[0].readyState === 'live'), true);
    assert.match(await page.$eval('#audioDeviceStatus', node => node.textContent), /next take/);
    await waitFor(page, () => recordState === 'recording' && mediaRecorder.state === 'recording');
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.evaluate(() => { closeSettingsModal(); finishRecording(); });
    await waitFor(page, () => session.lines[0].audioUrl && !pendingTakeLines.size);
    assert.deepEqual(await page.evaluate(() => captureDevices), ['mic-a']);
    await page.evaluate(() => handleStudioRecord(1)); await waitFor(page, () => recordState !== 'idle');
    assert.deepEqual(await page.evaluate(() => captureDevices), ['mic-a', 'mic-b']);
    await waitFor(page, () => recordState === 'recording'); await new Promise(resolve => setTimeout(resolve, 400));
    await page.evaluate(() => finishRecording()); await waitFor(page, () => !pendingTakeLines.size);
  });

  test('disconnected input falls back to default, and a hardware-ended take is saved', async () => {
    await page.evaluate(() => { openSettingsModal(); }); await page.select('#audioInputDevice', 'mic-a'); await page.evaluate(() => closeSettingsModal());
    await claimAndSelect(page, 1);
    await page.evaluate(() => { deviceFixture = deviceFixture.filter(device => device.deviceId !== 'mic-a'); });
    await page.evaluate(() => handleStudioRecord(1)); await waitFor(page, () => recordState !== 'idle');
    assert.deepEqual(await page.evaluate(() => captureDevices), ['mic-a', '']);
    await waitFor(page, () => recordState === 'recording'); await new Promise(resolve => setTimeout(resolve, 400));
    await page.evaluate(() => { micStream.getAudioTracks()[0].dispatchEvent(new Event('ended')); });
    await waitFor(page, () => recordState === 'idle' && !!session.lines[0].audioUrl && !pendingTakeLines.size);
    assert.equal(await page.evaluate(() => DublineAudioDevices.getSelection().inputId), '');
  });

  test('selected output routes video/original/background, take context, HTML preview and ADR, and survives reload', async () => {
    await page.evaluate(() => openSettingsModal()); await page.select('#audioOutputDevice', 'out-a'); await page.evaluate(() => DublineAudioDevices.ready());
    await page.evaluate(() => { closeSettingsModal(); ensurePlayCtx(); }); await page.evaluate(() => DublineAudioDevices.ready());
    await page.evaluate(() => { adrCues.arm(); }); await page.evaluate(() => DublineAudioDevices.ready());
    await page.evaluate(() => audio.playAudio(video.currentSrc));
    const result = await page.evaluate(() => ({ contexts: routedAudio.filter(route => route.kind === 'context' && route.id === 'out-a').length, names: routedAudio.filter(route => route.id === 'out-a').map(route => route.name), output: DublineAudioDevices.getSelection().outputId }));
    assert.equal(result.contexts, 2); assert.equal(result.output, 'out-a');
    for (const id of ['mainVideo', 'backingAudio', 'originalTrackAudio']) assert.ok(result.names.includes(id), id);
    await page.evaluate(() => { audio.stopPreview(); adrCues.stop(); });
    await page.reload(); await waitFor(page, () => session?.loaded && document.getElementById('audioOutputDevice'));
    assert.equal(await page.$eval('#audioOutputDevice', node => node.value), 'out-a');
    await page.evaluate(() => { ensurePlayCtx(); }); await page.evaluate(() => DublineAudioDevices.ready());
    assert.ok(await page.evaluate(() => routedAudio.some(route => route.kind === 'context' && route.id === 'out-a')));
  });

  test('output disconnect and rejected switching restore every destination to the system default', async () => {
    await page.evaluate(() => { ensurePlayCtx(); adrCues.arm(); }); await page.evaluate(() => DublineAudioDevices.ready());
    assert.equal(await page.evaluate(() => DublineAudioDevices.changeOutput('out-a')), true);
    await page.evaluate(() => { deviceFixture = deviceFixture.filter(device => device.deviceId !== 'out-a'); navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });
    await waitFor(page, () => DublineAudioDevices.getSelection().outputId === '');
    assert.equal(await page.evaluate(() => localStorage.getItem('dubline_output_device')), '');
    await page.evaluate(() => { failOutput = 'out-b'; });
    assert.equal(await page.evaluate(() => DublineAudioDevices.changeOutput('out-b')), false);
    const routes = await page.evaluate(() => routedAudio.slice(-5)); assert.ok(routes.length >= 5 && routes.every(route => route.id === ''), JSON.stringify(routes));
    await page.evaluate(() => adrCues.stop());
  });

  test('partial output switching failure rolls every listening destination back to the last successful output', async () => {
    await page.evaluate(async () => {
      window.outputTestContext = ensurePlayCtx();
      window.outputTestPreview = DublineAudioDevices.registerElement(new Audio());
      adrCues.arm(); await DublineAudioDevices.ready();
    });
    assert.equal(await page.evaluate(() => DublineAudioDevices.changeOutput('out-a')), true);
    await page.evaluate(() => { const route = backing.setSinkId; backing.setSinkId = function(id) { return id === 'out-b' ? Promise.reject(new DOMException('Injected partial failure', 'NotFoundError')) : route.call(this, id); }; });
    assert.equal(await page.evaluate(() => DublineAudioDevices.changeOutput('out-b')), false);
    const result = await page.evaluate(() => ({ selected: DublineAudioDevices.getSelection().outputId, stored: localStorage.getItem('dubline_output_device'), sinks: [video, backing, originalTrackAudio, outputTestContext, outputTestPreview].map(target => target.testSink) }));
    assert.equal(result.selected, 'out-a'); assert.equal(result.stored, 'out-a'); assert.deepEqual(result.sinks, Array(5).fill('out-a'));
    await page.evaluate(() => adrCues.stop());
  });

  test('microphone loss after reservation cleans up without starting a dead recorder or leaving processing UI', async () => {
    await claimAndSelect(page, 1);
    await page.evaluate(async () => {
      const capture = DublineAudioDevices.capture; DublineAudioDevices.capture = async constraints => { const stream = await capture(constraints); window.lostMic = stream; return stream; };
      const reserve = reserveTake; reserveTake = async (...args) => { const sequence = await reserve(...args); lostMic.getTracks().forEach(track => track.stop()); return sequence; };
      await handleStudioRecord(1);
    });
    assert.deepEqual(await page.evaluate(() => ({ state: recordState, mic: !!micStream, pending: processingRecordings.size, active: !!activeRecording, live: lostMic.active })), { state: 'idle', mic: false, pending: 0, active: false, live: false });
    assert.doesNotMatch(await page.$eval('#recBtn', button => button.textContent), /processing|preparing/i);
  });

  test('mute preserves master volume and immediately silences HTML previews and scheduled ADR cues', async () => {
    await page.evaluate(() => { const slider = document.getElementById('masterVolume'); slider.value = '37'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(async () => {
      const RealAudio = window.Audio; window.Audio = function(...args) { const element = new RealAudio(...args); window.lastPreview = element; return element; };
      await audio.playAudio(video.currentSrc);
      const gain = AudioContext.prototype.createGain;
      AudioContext.prototype.createGain = function() { const node = gain.call(this); (window.adrGains ||= []).push(node); return node; };
      adrCues.arm(); await DublineAudioDevices.ready();
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    const result = await page.evaluate(async () => {
      document.getElementById('masterMute').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const muted = { volume: lastPreview.volume, cue: adrGains[0].gain.value, pressed: document.getElementById('masterMute').getAttribute('aria-pressed') };
      document.getElementById('masterMute').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const restored = { volume: localMasterVolume(), cue: adrGains[0].gain.value, slider: document.getElementById('masterVolume').value };
      audio.stopPreview(); adrCues.stop(); return { muted, restored };
    });
    assert.deepEqual(result.muted, { volume: 0, cue: 0, pressed: 'true' }); assert.equal(result.restored.volume, .37); assert.equal(result.restored.slider, '37'); assert.ok(Math.abs(result.restored.cue - .37) < .0001);
  });

  test('seek spans available player width in normal, narrow, expanded and fullscreen modes', async () => {
    async function check() {
      const sizes = await page.evaluate(() => ({ seek: document.getElementById('transportSeek').getBoundingClientRect().width, bar: document.querySelector('.studio-transport').getBoundingClientRect().width }));
      assert.ok(sizes.seek >= sizes.bar - 32, JSON.stringify(sizes));
    }
    for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080]]) { await page.setViewport({ width, height }); await check(); }
    await page.evaluate(() => toggleExpandedVideo()); await check();
    await page.click('[data-studio-action=fullscreen]'); await waitFor(page, () => !!document.fullscreenElement); await check();
    await page.evaluate(() => document.exitFullscreen());
  });

  test('delete confirmation distinguishes custom scenes from packs and uses danger styling; help is a flexible studio workflow', async () => {
    for (const kind of ['custom', 'pack']) {
      await page.evaluate(kind => { session.sessionList[0].kind = kind; deleteSession(session.sessionList[0].id); }, kind);
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      const result = await page.evaluate(() => ({ text: document.getElementById('textPromptTitle').textContent, danger: document.getElementById('textPromptSave').classList.contains('btn-delete'), focus: document.activeElement.id }));
      assert.equal(result.danger, true); assert.equal(result.focus, 'textPromptCancel');
      assert.ok(kind === 'pack' ? result.text.includes('pack archive') : result.text.includes('Original files on your computer') && !result.text.includes('pack archive'));
      await page.keyboard.press('Escape');
    }
    for (const language of ['ru', 'en', 'uk']) {
      await page.evaluate(async language => { await i18n.setLanguage(language); openHelpModal(); }, language);
      assert.equal(await page.$$eval('.help-step', nodes => nodes.length), 6);
      assert.ok(await page.$eval('.help-intro', node => node.textContent.length > 100));
      assert.equal(await page.evaluate(() => i18n.missing.size), 0);
    }
    assert.equal(await page.$('.player-latency'), null);
  });

  test('unsupported output selection shows an explanation and no dead dropdown', async () => {
    const unsupported = await openPlayer(browser, server.url('ui-unsupported'), 'Unsupported', { beforeLoad: async remote => {
      await remote.evaluateOnNewDocument(() => { AudioContext.prototype.setSinkId = undefined; });
    } });
    try {
      await unsupported.evaluate(() => { openSettingsModal(); });
      assert.equal(await unsupported.$eval('#audioOutputDevice', node => node.hidden && node.disabled), true);
      assert.match(await unsupported.$eval('#audioOutputUnsupported', node => node.textContent), /system default/);
      assert.deepEqual(unsupported.errors, []);
    } finally { await unsupported.browserContext().close(); }
  });
});
