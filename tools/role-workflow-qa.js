// Playwright checks against an isolated studio; no personal scenes are changed.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('../e2e/helpers');
const { chromium } = process.env.DUBLINE_PLAYWRIGHT_ROOT
  ? require(path.join(process.env.DUBLINE_PLAYWRIGHT_ROOT, 'node_modules', 'playwright-core'))
  : require(require.resolve('playwright-core', { paths: [process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, pw, shots = 0;
  const out = path.resolve('audit/role-workflow'); fs.mkdirSync(out, { recursive: true });
  try {
    server = await startServer(); browser = await launchBrowser(server.port);
    const host = await openPlayer(browser, server.url('role-qa'), 'Host', { autoConfirm: false }); await loadFixture(host);
    const actor = await openPlayer(browser, server.url('role-qa'), 'Actor', { autoConfirm: false }); await waitFor(actor, () => session.loaded);
    await actor.evaluate(() => claimCharacter('Hero')); await waitFor(host, () => session.characterClaims.Hero === 'Actor');
    await host.evaluate(async () => {
      for (const [id, name] of [['phone', 'Phone'], ['long-name', 'A long preset name to check compact inspector controls and dropdown layout']]) {
        const result = await new Promise(resolve => socket.emit('voice_preset_update', { action: 'create', id, name, revision: 0, settings: { effects: [{ id: id + '-stage', type: 'telephone', enabled: true, amount: .5, parameters: {} }] }, sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() }, resolve));
        if (!result.ok) throw Error(JSON.stringify(result));
      }
    });
    pw = await chromium.connectOverCDP(browser.wsEndpoint());
    let page;
    for (const candidate of pw.contexts().flatMap(context => context.pages())) if (await candidate.evaluate(() => typeof myName !== 'undefined' && myName === 'Actor')) page = candidate;
    assert.ok(page);
    const shot = async (locator, name) => { await locator.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); shots++; };
    const themes = ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset'];
    for (const [index, theme] of themes.entries()) for (const width of [280, 540, 900]) {
      const language = ['en', 'ru', 'uk'][index % 3], mode = index % 2 ? 'edit' : 'dub';
      await host.evaluate(mode => socket.emit('set_session_mode', { mode, sessionId: session.activeSessionId }), mode);
      await page.waitForFunction(mode => session.mode === mode, mode); await page.setViewportSize({ width: 1920, height: 1080 });
      await page.evaluate(async ({ theme, language, width }) => {
        document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); layout.inspector = width; applyLayout();
        toastEl.style.display = 'none';
        multiSelection.clear(); [1, 2, 3].forEach(id => multiSelection.add(id)); refreshMultiSelection();
      }, { theme, language, width });
      await page.locator('#inspectorPreset').selectOption('long-name');
      await page.waitForTimeout(60);
      const geometry = await page.locator('#inspector').evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { overflow: node.scrollWidth - node.clientWidth, width: rect.width, outside: [...node.querySelectorAll('button, input, select')].filter(control => !control.classList.contains('dub-select-source')).some(control => { const box = control.getBoundingClientRect(); return box.width && (box.left < rect.left - 1 || box.right > rect.right + 1); }) };
      });
      assert.ok(geometry.overflow <= 1 && !geometry.outside, JSON.stringify({ theme, width, geometry }));
      assert.equal(await page.locator('[data-preset-lines]').getAttribute('data-preset-lines'), '1,3');
      assert.ok(await page.locator('[data-preset-apply]').isEnabled());
      await shot(page.locator('#inspector'), `bulk-${theme}-${language}-${width}-${mode}`);
    }
    for (const width of [280, 540]) for (const zoom of [1, 1.5]) {
      await page.evaluate(({ width, zoom }) => { layout.inspector = width; document.body.style.zoom = String(zoom); applyLayout(); }, { width, zoom });
      await page.waitForTimeout(60);
      assert.ok(await page.locator('#inspector').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      await shot(page.locator('#inspector'), `bulk-zoom-${width}-${zoom}`);
    }
    await page.evaluate(() => { document.body.style.zoom = ''; clearMultiSelection(); DublineVoiceEditor.open('Hero', 'role'); });
    for (const count of [1, 8]) {
      if (await page.locator('#fxClearChain').isEnabled()) await page.locator('#fxClearChain').click();
      for (const type of ['pitch', 'radio', 'telephone', 'robot', 'echo', 'behindDoor', 'megaphone', 'thoughts'].slice(0, count)) await page.locator(`[data-fx-type=${type}]`).click();
      await page.setViewportSize({ width: 1280, height: 800 });
      assert.ok(await page.locator('#fxApply').isEnabled());
      assert.ok(await page.locator('#fxDialog').evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 && node.scrollWidth <= node.clientWidth + 1; }));
      await shot(page.locator('#fxDialog'), `role-owner-${count}`);
    }
    for (const language of ['en', 'ru', 'uk']) {
      await page.evaluate(language => DublineI18n.setLanguage(language), language); await page.locator('#fxApply').click();
      await page.waitForFunction(() => textPrompt.open && textPrompt.dataset.kind === 'confirm');
      await shot(page.locator('.text-prompt[open]'), 'role-confirm-' + language); await page.locator('#textPromptCancel').click();
    }
    assert.equal(await page.evaluate(() => Object.values(session.voicePresets).some(preset => preset.name === 'Hero')), false);
    assert.deepEqual(actor.errors, []); assert.deepEqual(host.errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: true, screenshots: shots }, null, 2));
    console.log(JSON.stringify({ passed: true, screenshots: shots, output: out }));
  } finally { await pw?.close(); await browser?.close(); await server?.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
