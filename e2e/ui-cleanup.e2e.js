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

  async function mapView() {
    return page.evaluate(() => {
      const box = document.getElementById('timelineMinimap').getBoundingClientRect(), total = timelineSeconds() + TIMELINE_TAIL;
      const left = timelineContainer.scrollLeft / pxPerSec, right = left + (timelineContainer.clientWidth - labelWidth) / pxPerSec;
      return { left, right, scale: pxPerSec, x: box.left, y: box.top + box.height / 2, width: box.width, leftX: box.left + left / total * box.width, rightX: box.left + Math.min(total, right) / total * box.width };
    });
  }
  async function dragMap(x, y, targetX) {
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(targetX, y, { steps: 8 }); await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }

  test('long-export warnings contrast with their actual backgrounds in every theme and language', async () => {
    await page.evaluate(() => {
      // Only metadata is substituted: exercise the real duration warning and CSS.
      Object.defineProperty(video, 'duration', { configurable: true, get: () => 1440 });
      openFilesModal(); switchFilesTab('export');
    });
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) {
      for (const language of ['ru', 'en', 'uk']) {
        const result = await page.evaluate((theme, language) => {
          document.documentElement.dataset.theme = theme; i18n.setLanguage(language);
          updateExportDurationWarning();
          const warning = document.getElementById('longExportWarning');
          const rgba = color => color.match(/[\d.]+/g).map(Number);
          // Composite translucent warning/card surfaces over their opaque parents.
          const chain = []; for (let node = warning; node; node = node.parentElement) chain.unshift(node);
          let background = [255, 255, 255];
          for (const node of chain) {
            const [r, g, b, a = 1] = rgba(getComputedStyle(node).backgroundColor);
            background = [r, g, b].map((channel, index) => channel * a + background[index] * (1 - a));
          }
          const luminance = rgb => rgb.slice(0, 3).map(channel => {
            const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
          }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
          const foreground = luminance(rgba(getComputedStyle(warning).color)), surface = luminance(background);
          return { ratio: (Math.max(foreground, surface) + .05) / (Math.min(foreground, surface) + .05), visible: warning.getBoundingClientRect().height > 0, text: warning.textContent, expected: t('warning.longExport', { minutes: 24 }) };
        }, theme, language);
        assert.equal(result.visible, true);
        assert.equal(result.text, result.expected);
        assert.ok(result.ratio >= 4.5, `${theme}/${language}: contrast ${result.ratio.toFixed(2)}`);
      }
    }
    await page.evaluate(() => { delete video.duration; updateExportDurationWarning(); });
    assert.equal(await page.$eval('#longExportWarning', node => getComputedStyle(node).display), 'none', 'short scenes still hide the warning');
  });

  test('all zoom controls and both minimap edges stop at ten percent', async () => {
    await page.evaluate(() => { Object.defineProperty(video, 'duration', { configurable: true, get: () => 1440 }); video.pause(); video.currentTime = 2; });
    const checkFloor = async () => {
      assert.equal(await page.evaluate(() => pxPerSec / ZOOM_DEFAULT), .1);
      assert.equal(await page.$eval('#zoomLabel', label => label.textContent), '10%');
      assert.equal(await page.evaluate(() => video.currentTime), 2, 'zoom never seeks');
    };
    await page.evaluate(() => { setTimelineZoom(6.1); });
    await page.click('#zoomOutBtn'); await checkFloor();
    await page.evaluate(() => {
      setTimelineZoom(6.1);
      timelineContainer.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 100, cancelable: true }));
    });
    await checkFloor();
    await page.evaluate(() => fitTimeline()); await checkFloor();
    for (const edge of ['right', 'left']) {
      await page.evaluate(() => setTimelineZoom(7));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => { timelineContainer.scrollLeft = 400; });
      const before = await mapView();
      await dragMap(edge === 'left' ? before.leftX : before.rightX, before.y, edge === 'left' ? before.x - 100 : before.x + before.width + 100);
      await checkFloor();
    }
    await page.evaluate(() => localStorage.setItem('dubline_zoom', '2'));
    await page.reload(); await waitFor(page, () => session?.loaded && document.getElementById('timelineMinimap'));
    assert.equal(await page.evaluate(() => pxPerSec / ZOOM_DEFAULT), .1, 'old saved zoom below the floor is clamped on startup');
    assert.equal(await page.$eval('#zoomLabel', label => label.textContent), '10%');
  });

  test('minimap repaints immediately with a distinct background for each theme', async () => {
    const pixels = [];
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await waitFor(page, () => {
        const map = document.getElementById('timelineMinimap'), ctx = map.getContext('2d'), expected = document.createElement('canvas').getContext('2d');
        expected.fillStyle = getComputedStyle(map).getPropertyValue('--panel-2'); expected.fillRect(0, 0, 1, 1);
        return JSON.stringify([...ctx.getImageData(Math.floor(map.width / 2), 0, 1, 1).data]) === JSON.stringify([...expected.getImageData(0, 0, 1, 1).data]);
      });
      pixels.push(await page.$eval('#timelineMinimap', map => [...map.getContext('2d').getImageData(Math.floor(map.width / 2), 0, 1, 1).data]));
    }
    assert.equal(new Set(pixels.map(pixel => pixel.join(','))).size, 6);
    assert.ok(pixels[2].slice(0, 3).every(channel => channel > 230), 'light theme must actually paint a light canvas');
    for (const language of ['ru', 'en', 'uk']) {
      await page.evaluate(language => i18n.setLanguage(language), language);
      assert.equal(await page.$eval('#timelineMinimap', map => map.title), await page.evaluate(() => t('find.minimap')));
    }
  });

  test('both minimap edges zoom around the opposite edge while center drag only scrolls', async () => {
    await page.evaluate(() => { setTimelineZoom(180); video.currentTime = 2; });
    await waitFor(page, () => timeline.scrollWidth > timelineContainer.clientWidth);
    await page.evaluate(() => { timelineContainer.scrollLeft = 2 * pxPerSec; });
    const project = await page.evaluate(() => JSON.stringify([session.lines, session.projectAudio]));
    const clickOnly = await mapView();
    await page.mouse.click(clickOnly.rightX - 4, clickOnly.y);
    assert.ok(Math.abs((await mapView()).scale - clickOnly.scale) < .01, 'an edge click without a drag must not jump');
    for (const edge of ['right', 'left']) {
      for (const outward of [false, true]) {
        const before = await mapView(), x = edge === 'right' ? before.rightX : before.leftX;
        await page.mouse.move(x, before.y);
        assert.equal(await page.$eval('#timelineMinimap', map => getComputedStyle(map).cursor), 'ew-resize');
        const delta = (edge === 'right' ? 1 : -1) * (outward ? 60 : -40);
        await dragMap(x, before.y, x + delta);
        const after = await mapView();
        assert.ok(outward ? after.scale < before.scale : after.scale > before.scale, `${edge} outward=${outward}`);
        assert.ok(Math.abs((edge === 'right' ? after.left - before.left : after.right - before.right)) < .02, 'opposite edge stays anchored');
      }
    }
    const before = await mapView();
    await dragMap((before.leftX + before.rightX) / 2, before.y, (before.leftX + before.rightX) / 2 + 25);
    const after = await mapView();
    assert.equal(after.scale, before.scale); assert.ok(after.left > before.left);
    assert.equal(await page.evaluate(() => video.currentTime), 2);
    assert.equal(await page.evaluate(() => JSON.stringify([session.lines, session.projectAudio])), project);
    assert.equal(await page.$eval('#timelineMinimap', map => map.clientHeight), 36, 'overview keeps its visual height');
    assert.equal(Number(await page.evaluate(() => localStorage.getItem('dubline_zoom'))), Math.round(after.scale * 100) / 100);
  });

  test('minimap zoom respects limits and stops on cancellation and scene switch', async () => {
    await page.evaluate(() => setTimelineZoom(180));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    let before = await mapView();
    await dragMap(before.rightX, before.y, before.x - 100);
    assert.equal((await mapView()).scale, await page.evaluate(() => ZOOM_MAX));
    before = await mapView();
    await dragMap(before.rightX, before.y, before.x + before.width + 100);
    assert.ok((await mapView()).scale >= await page.evaluate(() => ZOOM_MIN));
    await page.evaluate(() => setTimelineZoom(180));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const cancel of ['pointercancel', 'blur', 'scene']) {
      before = await mapView();
      await page.mouse.move(before.rightX, before.y); await page.mouse.down();
      if (cancel === 'scene') {
        const id = await page.evaluate(() => session.activeSessionId); await loadFixture(page);
        await waitFor(page, id => session.activeSessionId !== id, 5000, id);
      } else await page.evaluate(cancel => cancel === 'blur' ? window.dispatchEvent(new Event('blur')) : document.getElementById('timelineMinimap').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })), cancel);
      const stopped = await mapView();
      await page.mouse.move(before.rightX - 80, before.y); await page.mouse.up();
      assert.equal((await mapView()).scale, stopped.scale, `no stale resize after ${cancel}`);
    }
    assert.equal(await page.$eval('#timelineMinimap', map => map.hasPointerCapture(1)), false);
  });

  test('Edit warning keeps its background without panel frames, and the host badge has balanced padding', async () => {
    await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit');
    await page.click('#line-block-1');
    const styles = await page.evaluate(() => {
      const banner = getComputedStyle(document.querySelector('.edit-banner')), host = getComputedStyle(hostPanel);
      return { shadow: getComputedStyle(document.querySelector('.timeline-panel')).boxShadow, outline: getComputedStyle(timelineContainer).outlineStyle, banner: banner.display !== 'none' && banner.backgroundImage !== 'none', paddingLeft: host.paddingLeft, paddingRight: host.paddingRight };
    });
    assert.deepEqual(styles, { shadow: 'none', outline: 'none', banner: true, paddingLeft: '12px', paddingRight: '12px' });
    await page.keyboard.press('Space'); await waitFor(page, () => !video.paused); await page.keyboard.press('Space'); await waitFor(page, () => video.paused);
  });

  test('host and moderator actions follow accepted mode changes without reloading', async () => {
    const moderator = await openPlayer(browser, server.url(`ui-cleanup-${serial}`), 'Moderator');
    try {
      await waitFor(moderator, () => session?.loaded);
      await page.evaluate(() => { changeModerator('Moderator', null); });
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await page.click('#textPromptSave');
      await waitFor(moderator, () => amModerator());
      for (const mode of ['edit', 'dub', 'edit', 'dub']) {
        await page.evaluate(mode => setStudioMode(mode), mode);
        for (const client of [page, moderator]) {
          await waitFor(client, mode => session?.mode === mode, 5000, mode);
          const actions = await client.evaluate(() => ({ cast: !!hostPanel.querySelector('.cast'), reset: !!hostPanel.querySelector('.reset'), watch: !!hostPanel.querySelector('[onclick="hostWatchStart()"]') }));
          assert.equal(actions.cast, mode === 'dub'); assert.equal(actions.reset, mode === 'dub');
          assert.equal(actions.watch, client === page && mode === 'dub');
        }
      }
      assert.deepEqual(moderator.errors, []);
    } finally { await moderator.browserContext().close(); }
  });

  test('caption resize stays vertical and within a narrow inspector', async () => {
    await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit');
    await page.click('#line-block-1');
    for (const width of [1024, 1280, 1920]) {
      await page.setViewport({ width, height: 768 });
      const bounds = await page.$eval('#editorCaption', node => {
        const box = node.getBoundingClientRect(), form = node.closest('form').getBoundingClientRect();
        return { resize: getComputedStyle(node).resize, contained: box.left >= form.left && box.right <= form.right };
      });
      assert.deepEqual(bounds, { resize: 'vertical', contained: true });
    }
  });

  test('CC off glows, describes its state and stays in sync with settings and reload', async () => {
    await page.click('#transportCC');
    const state = () => page.$eval('#transportCC', node => ({ off: node.classList.contains('subtitles-off'), pressed: node.getAttribute('aria-pressed'), shadow: getComputedStyle(node).boxShadow, title: node.title }));
    assert.equal((await state()).off, true); assert.equal((await state()).pressed, 'false'); assert.notEqual((await state()).shadow, 'none');
    await page.reload(); await waitFor(page, () => session?.loaded);
    assert.equal((await state()).off, true);
    for (const language of ['ru', 'en', 'uk']) {
      await page.evaluate(language => i18n.setLanguage(language), language);
      assert.equal((await state()).title, await page.evaluate(() => t('playback.ccOff')));
    }
    await page.evaluate(() => { openSettingsModal(); openSettingsCategory('user', 'interface'); });
    assert.equal(await page.$eval('#settingsPrompter', input => input.checked), false);
    await page.click('#settingsPrompter + .switch-slider');
    assert.equal((await state()).off, false); assert.equal((await state()).pressed, 'true'); assert.equal((await state()).shadow, 'none');
    await page.evaluate(() => closeSettingsModal()); await page.click('#transportCC');
    assert.equal(await page.$eval('#settingsPrompter', input => input.checked), false);
  });

  test('settings cards pack without row-height gaps across locales, sizes and Solo visibility', async () => {
    await page.evaluate(() => openSettingsModal());
    for (const language of ['ru', 'en', 'uk']) {
      await page.evaluate(language => i18n.setLanguage(language), language);
      for (const [width, height] of [[650, 768], [1024, 768], [1280, 720], [1920, 1080]]) {
        await page.setViewport({ width, height });
        for (const solo of [false, true]) {
          await page.evaluate(solo => document.body.classList.toggle('single-player', solo), solo);
          for (const category of ['audio', 'interface', 'storage']) {
            await page.evaluate(category => openSettingsCategory('user', category), category);
            const failures = await page.evaluate(category => {
              const panel = document.getElementById(`settings-user-${category}`), columns = new Map(), failures = [];
              const bounds = panel.getBoundingClientRect();
              for (const card of panel.children) {
                const r = card.getBoundingClientRect(); if (!r.width || card.classList.contains('settings-wide')) continue;
                if (card.getClientRects().length !== 1 || r.left < bounds.left - 1 || r.right > bounds.right + 1) failures.push('split or overflow');
                const key = Math.round(r.left); if (!columns.has(key)) columns.set(key, []); columns.get(key).push(r);
              }
              for (const stack of columns.values()) {
                stack.sort((a, b) => a.top - b.top);
                for (let index = 1; index < stack.length; index++) {
                  const gap = stack[index].top - stack[index - 1].bottom;
                  if (gap < 11 || gap > 13) failures.push(`gap ${gap}`);
                }
              }
              return failures;
            }, category);
            assert.deepEqual(failures, [], `${language} ${width} ${category} solo=${solo}`);
          }
        }
      }
    }
    await page.evaluate(() => document.body.classList.remove('single-player'));
  });

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
      const actions = await page.evaluate(() => {
        const speed = document.getElementById('previewRate'), expand = document.getElementById('transportExpandBtn'), fullscreen = document.querySelector('[data-studio-action=fullscreen]');
        const a = expand.getBoundingClientRect(), b = fullscreen.getBoundingClientRect(), bar = document.querySelector('.studio-transport').getBoundingClientRect();
        const options = speed.closest('.transport-options'), master = document.querySelector('.transport-master'), cc = document.getElementById('transportCC');
        const grouped = options.contains(master) && options.contains(cc) && options.contains(fullscreen) && Math.abs(options.getBoundingClientRect().right - b.right) < 2;
        return { order: !!(speed.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_FOLLOWING), aligned: a.right <= b.left && b.right <= bar.right && b.right >= bar.right - 16, grouped };
      });
      assert.deepEqual(actions, { order: true, aligned: true, grouped: true });
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
