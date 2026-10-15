// Playwright checks against the real studio, using isolated generated media/data.
// npm install --prefix audit/fx-tools --no-save --package-lock=false playwright-core
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('../e2e/helpers');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, playwright;
  const destination = path.resolve('audit/effects-workspace'); fs.mkdirSync(destination, { recursive: true });
  try {
    server = await startServer(); browser = await launchBrowser(server.port);
    const setup = await openPlayer(browser, server.url('effect-workspace'), 'Host', { beforeLoad: async page => page.evaluateOnNewDocument(() => localStorage.setItem('dubline_noise_suppression', '1')) });
    await loadFixture(setup); await claimAndSelect(setup, 1);
    await setup.evaluate(async () => {
      const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 });
      for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = .08 * Math.sin(i * .1);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0, duration: 1, trimStart: 0, trimEnd: 1, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
    });
    await waitFor(setup, () => !!session.lines[0].audioUrl);
    playwright = await chromium.connectOverCDP(browser.wsEndpoint());
    const page = playwright.contexts().flatMap(context => context.pages()).find(tab => tab.url().includes('effect-workspace'));
    assert.ok(page, 'Actual studio page is attached through Playwright');
    assert.equal(await page.locator('#settingsNoiseSuppression').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('dubline_noise_suppression')), null);
    const constraints = await page.evaluate(async () => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), calls = [];
      navigator.mediaDevices.getUserMedia = async value => { calls.push(value.audio); return original(value); };
      try { const stream = await DublineAudioDevices.capture({ noiseSuppression: true, echoCancellation: true, autoGainControl: true }); DublineAudioDevices.release(stream); return calls; }
      finally { navigator.mediaDevices.getUserMedia = original; }
    });
    assert.ok(constraints.length && constraints.every(c => c.noiseSuppression === false && c.echoCancellation === false && c.autoGainControl === false));
    const results = [];
    const types = ['telephone', 'robot', 'radio', 'monster', 'thoughts', 'cave', 'behindDoor', 'echo'];
    for (const scope of ['role', 'takes']) for (const count of [1, 8]) {
      await page.evaluate(scope => DublineVoiceEditor.open(1, scope), scope);
      for (const type of types.slice(0, count)) await page.locator(`[data-fx-type="${type}"]`).click();
      for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.evaluate(async ({ theme, language }) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); }, { theme, language });
        const geometry = await page.evaluate(() => {
          const dialog = fxDialog.getBoundingClientRect(), body = document.querySelector('#fxDialog .fx-body');
          const cards = [...fxRows.children].map(node => { const box = node.getBoundingClientRect(); return { w: box.width, h: box.height, contained: box.left >= dialog.left && box.right <= dialog.right && box.top >= dialog.top && box.bottom <= dialog.bottom }; });
          const missing = [...fxDialog.querySelectorAll('[data-i18n]')].filter(node => node.getBoundingClientRect().height && node.textContent === node.dataset.i18n).map(node => node.dataset.i18n);
          return { fits: dialog.left >= 0 && dialog.right <= innerWidth && dialog.bottom <= innerHeight, width: dialog.width, height: dialog.height, scroll: body.scrollHeight - body.clientHeight, overflow: fxDialog.scrollWidth - fxDialog.clientWidth, cards, missing };
        });
        await page.screenshot({ path: path.join(destination, "latest-layout.png") });
        assert.ok(geometry.fits && geometry.width <= 1061 && geometry.height <= 841 && (count === 8 || geometry.scroll <= 1) && geometry.overflow <= 1 && geometry.cards.every(c => c.w > 130 && (count === 8 || c.contained)) && !geometry.missing.length, JSON.stringify({ scope, count, theme, language, geometry }));
        assert.equal(await page.locator('#fxRows .switch-ui').count(), count);
        const filename = `${scope}-${count}-${theme}-${language}.png`; await page.screenshot({ path: path.join(destination, filename) }); results.push({ filename, geometry });
      }
      // The same draft remains usable at narrow widths and browser zoom.
      await page.setViewportSize({ width: 820, height: 900 });
      await page.evaluate(() => { document.body.style.zoom = '150%'; });
      await page.waitForFunction(() => fxDialog.getBoundingClientRect().right <= innerWidth + 1);
      assert.ok(await page.evaluate(() => { const b = fxApply.getBoundingClientRect(); return fxDialog.scrollWidth <= fxDialog.clientWidth + 1 && b.height > 0 && b.bottom <= innerHeight; }));
      await page.screenshot({ path: path.join(destination, `${scope}-${count}-narrow-150.png`) });
      await page.evaluate(() => { document.body.style.zoom = ''; }); await page.setViewportSize({ width: 1600, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => { document.querySelector('#fxDialog .fx-body').scrollTop = 0; requestAnimationFrame(resolve); })));
      if (count === 8) {
        // Pointer-following ghost, local-only live placeholder, cancellation and final order.
        const before = await page.evaluate(() => ({ shared: JSON.stringify({ lines: session.lines, roles: session.roleEffects }), draft: DublineVoiceEditor.draft().effects.map(item => [item.id, item.amount]) }));
        const grip = await page.locator('#fxRows .fx-grip').first().boundingBox(), last = await page.locator('#fxRows > .fx-item').last().boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
        await page.mouse.move(last.x + last.width * .8, last.y + last.height / 2, { steps: 12 });
        assert.equal(await page.locator('.fx-drag-ghost').count(), 1);
        const ghost = await page.locator('.fx-drag-ghost').boundingBox(); assert.ok(Math.abs(ghost.x - (last.x + last.width * .8)) < 100);
        assert.deepEqual(await page.evaluate(() => DublineVoiceEditor.draft().effects.map(item => [item.id, item.amount])), before.draft);
        await page.waitForFunction(() => !fxRows.getAnimations({ subtree: true }).some(a => a.playState === 'running'));
        await page.screenshot({ path: path.join(destination, `${scope}-drag-ghost.png`) });
        await page.mouse.up(); assert.equal(await page.locator('.fx-drag-ghost').count(), 0);
        const after = await page.evaluate(() => DublineVoiceEditor.draft().effects.map(item => [item.id, item.amount])); assert.deepEqual(after, [...before.draft.slice(1), before.draft[0]]);
        assert.equal(await page.evaluate(() => JSON.stringify({ lines: session.lines, roles: session.roleEffects })), before.shared);
        const first = await page.locator('#fxRows .fx-grip').first().boundingBox(); await page.mouse.move(first.x + 8, first.y + 8); await page.mouse.down(); await page.mouse.move(first.x + 80, first.y + 35, { steps: 4 }); await page.keyboard.press('Escape'); await page.mouse.up();
        assert.equal(await page.locator('.fx-drag-ghost').count(), 0); assert.deepEqual(await page.evaluate(() => DublineVoiceEditor.draft().effects.map(item => [item.id, item.amount])), after);
        await page.locator('#fxRows .switch-slider').first().click(); assert.equal(await page.locator('#fxRows input[data-action=enabled]').first().isChecked(), false);
        await page.locator('#fxRows [data-action=down]').first().click(); assert.equal(await page.locator('#fxRows [data-enabled=false]').count(), 1);
        if (scope === 'role') {
          const preserved = await page.evaluate(() => JSON.stringify(DublineVoiceEditor.draft().effects));
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await page.evaluate(() => { document.body.style.zoom = '150%'; document.querySelector('#fxDialog .fx-body').scrollTop = 0; });
          await page.waitForFunction(() => getComputedStyle(fxDialog).getPropertyValue('--fx-ui-zoom') === '1.5');
          const a = await page.locator('#fxRows .fx-grip').first().boundingBox(), b = await page.locator('#fxRows > .fx-item').nth(1).boundingBox();
          const x = b.x + b.width * .7, y = b.y + b.height / 2;
          await page.mouse.move(a.x + 10, a.y + 10); await page.mouse.down(); await page.mouse.move(x, y, { steps: 8 });
          const scaled = await page.locator('.fx-drag-ghost').boundingBox(); assert.ok(Math.abs(scaled.x - x) < 70 && Math.abs(scaled.y - y) < 70, JSON.stringify({ scaled, x, y }));
          assert.equal(await page.locator('.fx-drag-ghost').evaluate(node => getComputedStyle(node).transform), 'none');
          await page.screenshot({ path: path.join(destination, 'role-drag-150-reduced-motion.png') });
          await page.keyboard.press('Escape'); await page.mouse.up();
          assert.equal(await page.evaluate(() => JSON.stringify(DublineVoiceEditor.draft().effects)), preserved);
          await page.evaluate(() => { document.body.style.zoom = ''; }); await page.emulateMedia({ reducedMotion: 'no-preference' });
        }
      }
      await page.evaluate(() => DublineVoiceEditor.close(true));
    }
    await page.evaluate(async () => { await DublineI18n.setLanguage('ru'); document.documentElement.dataset.theme = 'midnight'; openSettingsModal(); await switchSettingsTab('user'); await openSettingsCategory('user', 'audio'); });
    assert.ok(await page.evaluate(() => noiseCard.previousElementSibling?.querySelector('#settingsMicGain') && getComputedStyle(settingsLocalDuck.closest('.setting-card-row')).marginTop === '0px'));
    await page.screenshot({ path: path.join(destination, 'settings-rnnoise.png') });
    assert.deepEqual(setup.errors, []);
    fs.writeFileSync(path.join(destination, 'results.json'), JSON.stringify({ screenshots: results.length + 8, constraints, results }, null, 2));
    console.log(`PASS: Playwright verified ${results.length} theme/locale/scope/count layouts, narrow views, actual drag ghost/order/cancel/toggles, capture constraints and settings.`);
  } finally { await playwright?.close(); await browser?.close(); await server?.cleanup(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
