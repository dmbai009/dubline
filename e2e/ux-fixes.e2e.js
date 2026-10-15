const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('./helpers');
describe('compact studio UX regressions', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, page;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); page = await openPlayer(browser, server.url('ux-regression'), 'Host'); await loadFixture(page); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('remaining checkbox fields use themed toggles with spacing and preserve native keyboard/change behavior', async () => {
    await page.evaluate(() => { openFilesModal(); switchFilesTab('export'); }); await waitFor(page, () => videoExportPanel.dataset.ready === 'true');
    // The native-only completion setting shares this production DOM/CSS; expose it for browser geometry.
    await page.evaluate(() => { videoExportSoundLabel.hidden = false; videoExportSound.checked = true; });
    const geometry = await page.$eval('#videoExportSoundLabel', label => { const input = label.querySelector('input'), text = label.querySelector('span'); return { appearance: getComputedStyle(input).appearance, width: input.getBoundingClientRect().width, gap: text.getBoundingClientRect().left - input.getBoundingClientRect().right }; });
    assert.equal(geometry.appearance, 'none'); assert.equal(geometry.width, 40); assert.ok(geometry.gap >= 8);
    await page.focus('#videoExportSound'); await page.keyboard.press('Space'); assert.equal(await page.evaluate(() => localStorage.getItem('dubline_export_sound')), '0');
    await page.evaluate(() => { videoExportSoundLabel.hidden = false; }); await page.focus('#videoExportSound'); await page.keyboard.press('Space'); assert.equal(await page.evaluate(() => localStorage.getItem('dubline_export_sound')), '1');
    await page.evaluate(() => closeFilesModal()); await page.select('#timelineScopeFilter', 'choose'); await page.click('#timelineChooseFilter');
    const input = '[data-filter-role="Hero"]'; await page.click(input); assert.equal(await page.$eval(input, n => n.checked), true); assert.ok((await page.evaluate(() => DublineTimelineFilters.ids())).includes(1));
    assert.equal(await page.$eval(input, n => getComputedStyle(n).appearance), 'none'); await page.keyboard.press('Escape'); await page.select('#timelineScopeFilter', 'all');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox]:not(.switch-ui input)')].filter(n => getComputedStyle(n).appearance !== 'none').map(n => n.id)), []);
  });
  test('export dropdown text is stationary at fractional UI zoom and stays inside the viewport', async () => {
    await page.evaluate(() => { openFilesModal(); switchFilesTab('export'); }); await waitFor(page, () => videoExportPanel.dataset.ready === 'true');
    await page.click('[name=videoExportMode][value=custom]');
    for (const zoom of [1.25, 1.5]) {
      await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom);
      for (const id of ['videoExportSource', 'videoExportFormat', 'videoExportResolution', 'videoExportFps']) {
        await page.evaluate(id => DublineDropdown.button(document.getElementById(id)).click(), id);
        const geometry = await page.evaluate(async () => {
          const points = [];
          for (let i = 0; i < 25; i++) {
            await new Promise(requestAnimationFrame); if (i < 5) continue;
            const range = document.createRange(); range.selectNodeContents(document.querySelector('#dubSelectOptions [role=option]')); const b = range.getBoundingClientRect(); points.push([b.x, b.y, b.width]);
          }
          const b = dubSelectPopup.getBoundingClientRect();
          return { spread: [0, 1, 2].map(i => Math.max(...points.map(p => p[i])) - Math.min(...points.map(p => p[i]))), fits: b.left >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1 };
        });
        assert.ok(geometry.fits && geometry.spread.every(n => n < .1), JSON.stringify({ id, zoom, geometry })); await page.keyboard.press('Escape');
      }
    }
    await page.evaluate(() => { document.body.style.zoom = ''; closeFilesModal(); });
  });
  test('next-line button wraps within a role, moves to the next owned role, reveals filters and never records', async () => {
    for (const character of ['Hero', 'Friend']) { await page.evaluate(character => socket.emit('claim_character', { sessionId: session.activeSessionId, character }), character); await waitFor(page, character => session.characterClaims[character] === myName, 10000, character); }
    const record = async id => {
      await page.evaluate(async id => { const line = session.lines.find(l => l.id === id); selectLine(line); const b = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }); b.getChannelData(0).fill(.03); await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: id, nick: myName, audioStart: 0, trimStart: 0, trimEnd: 1, duration: 1, blob: new Blob([audioBufferToWav(b)], { type: 'audio/wav' }), createdAt: Date.now() }); }, id);
      await waitFor(page, id => !!session.lines.find(l => l.id === id).audioUrl && !pendingTakeLines.size, 10000, id);
    };
    await record(3); await page.select('#timelineStatusFilter', 'recorded'); await waitFor(page, () => !nextUnrecordedLine.disabled);
    await page.click('#nextUnrecordedLine'); assert.equal(await page.evaluate(() => selectedLine.id), 1); assert.equal(await page.evaluate(() => recordState), 'idle');
    assert.equal(await page.$eval('#timelineStatusFilter', n => n.value), 'recorded'); assert.equal(await page.$eval('#line-block-1', n => n.hidden), false);
    await record(1); await waitFor(page, () => !nextUnrecordedLine.disabled); await page.click('#nextUnrecordedLine'); assert.equal(await page.evaluate(() => selectedLine.id), 2);
    await record(2); await waitFor(page, () => !nextUnrecordedLine.disabled); await page.click('#nextUnrecordedLine'); assert.equal(await page.evaluate(() => selectedLine.id), 4);
    await record(4); await waitFor(page, () => nextUnrecordedLine.disabled); assert.equal(await page.evaluate(() => recordState), 'idle');
    await page.select('#timelineStatusFilter', 'all');
  });
  test('the themed silence-trim switch saves through existing permissions and preserves take data', async () => {
    await page.evaluate(() => selectLine(session.lines[0]));
    const original = await page.evaluate(() => { const l = session.lines[0]; return { url: l.audioUrl, id: l.takeId, start: l.trimStart, end: l.trimEnd, volume: l.volume, pan: l.pan }; });
    const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines[0].audioUrl)).arrayBuffer())));
    assert.equal(await page.$eval('[data-trim-toggle]', n => n.getAttribute('role')), 'switch');
    await page.click('.insp-trim .switch-slider'); await waitFor(page, () => session.lines[0].trimEnabled === false);
    await page.click('.insp-trim .switch-slider'); await waitFor(page, () => session.lines[0].trimEnabled === true);
    const current = await page.evaluate(() => { const l = session.lines[0]; return { url: l.audioUrl, id: l.takeId, start: l.trimStart, end: l.trimEnd, volume: l.volume, pan: l.pan }; });
    assert.deepEqual(current, original);
    assert.deepEqual(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines[0].audioUrl)).arrayBuffer()))), bytes);
  });
  test('single-player navigation includes unclaimed available roles', async () => {
    const solo = await startServer({ DUBLINE_DESKTOP_ROOM: 'main', DUBLINE_DESKTOP_HOST_TOKEN: 'ux-solo', DUBLINE_ROOM_PIN: 'ABCD', DUBLINE_SINGLE_PLAYER: '1' });
    let client;
    try {
      client = await openPlayer(browser, solo.url('main') + '&desktopHost=ux-solo&workspace=single', 'Solo'); await loadFixture(client);
      await client.evaluate(() => selectLine(session.lines[0])); await waitFor(client, () => session.singlePlayer && !nextUnrecordedLine.disabled);
      await client.click('#nextUnrecordedLine'); assert.equal(await client.evaluate(() => selectedLine.id), 3);
      await client.evaluate(() => selectLine(session.lines[1])); await waitFor(client, () => !nextUnrecordedLine.disabled);
      await client.click('#nextUnrecordedLine'); assert.equal(await client.evaluate(() => selectedLine.id), 4);
      assert.deepEqual(await client.evaluate(() => session.characterClaims), {}); assert.equal(await client.evaluate(() => recordState), 'idle'); assert.deepEqual(client.errors, []);
    } finally { await client?.close(); await solo.cleanup(); }
  });
  test('fullscreen subtitles clear the measured transport, return when idle, and respect reduced motion', async () => {
    for (const [width, height, font] of [[1280, 850, 20], [640, 850, 40]]) {
      await page.setViewport({ width, height });
      await page.evaluate(font => { prompterEnabled = true; prompterSize = font; session.lines[0].caption = 'Long captions wrap over several lines. '.repeat(4); video.currentTime = 3.2; invalidatePrompterIndex(); updatePrompter(); }, font);
      await page.click('[data-studio-action=fullscreen]'); await waitFor(page, () => !!document.fullscreenElement);
      await waitFor(page, () => videoPrompter.getBoundingClientRect().bottom <= document.querySelector('.studio-transport').getBoundingClientRect().top - 10);
      await page.evaluate(() => document.querySelector('.video-wrapper').classList.add('fullscreen-idle'));
      await waitFor(page, () => videoPrompter.getBoundingClientRect().bottom >= innerHeight - 25);
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await page.evaluate(() => document.querySelector('.video-wrapper').classList.remove('fullscreen-idle'));
      assert.equal(await page.$eval('#videoPrompter', n => getComputedStyle(n).transitionDuration), '0s'); await page.evaluate(() => document.exitFullscreen());
    }
  });
  test('no unhandled renderer errors', () => assert.deepEqual(page.errors, []));
});
