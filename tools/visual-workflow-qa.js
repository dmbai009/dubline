const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, waitFor, recordTake } = require('../e2e/helpers');

// Produces reviewable screenshots and a generated playback sample, using temporary server data.
(async () => {
  let server, browser;
  const output = path.join(__dirname, '../docs/qa');
  const screenshot = (page, name) => page.screenshot({ path: path.join(output, name) });
  try {
    server = await startServer({ DUBLINE_DESKTOP_ROOM: 'main', DUBLINE_DESKTOP_HOST_TOKEN: 'visual-secret', DUBLINE_SINGLE_PLAYER: '1', DUBLINE_ROOM_PIN: 'ABCD' });
    browser = await launchBrowser(server.port);
    const page = await openPlayer(browser, server.url('main') + '&desktopHost=visual-secret&workspace=single', 'Solo', { autoConfirm: false, audioExpanded: false });
    await loadFixture(page);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; setStudioMode('edit'); });
    await waitFor(page, () => session.mode === 'edit');
    fs.mkdirSync(output, { recursive: true });
    await screenshot(page, '1.4-light-timeline.png');
    await page.evaluate(() => { askText(t('editor.addTrack'), ''); });
    await waitFor(page, () => document.querySelector('dialog[open]'));
    await screenshot(page, '1.4-light-dialog.png');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { openSettingsModal(); switchSettingsTab('player'); });
    await screenshot(page, '1.4-project-settings.png');
    await page.evaluate(() => { closeSettingsModal(); document.documentElement.dataset.theme = 'midnight'; });
    await screenshot(page, '1.4-dark-timeline.png');
    await page.evaluate(() => setStudioMode('dub'));
    await waitFor(page, () => session.mode === 'dub');
    await recordTake(page, 1);
    await page.evaluate(() => { document.querySelector('[data-studio-action=audio]').click(); });
    await screenshot(page, '1.4-dub-coverage.png');
    const sample = await page.evaluate(async () => {
      const blob = await renderWithWebCodecs(() => {});
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      const playback = document.createElement('video');
      playback.muted = true;
      playback.src = URL.createObjectURL(blob);
      await new Promise((resolve, reject) => { playback.onloadeddata = resolve; playback.onerror = reject; });
      await playback.play();
      await new Promise(resolve => setTimeout(resolve, 400));
      playback.pause();
      const result = { bytes: btoa(binary), time: playback.currentTime, duration: playback.duration, width: playback.videoWidth, height: playback.videoHeight };
      URL.revokeObjectURL(playback.src);
      return result;
    });
    assert.ok(sample.time > 0 && sample.duration > 0 && sample.width > 0 && sample.height > 0);
    fs.writeFileSync(path.join(output, '1.4-export-playback.mp4'), Buffer.from(sample.bytes, 'base64'));
    console.log('Visual QA artifacts saved in docs/qa; exported MP4 plays with decoded frames and advancing time. Physical listening is a human check.');
  } finally {
    await browser?.close();
    await server?.cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
