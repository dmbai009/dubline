// Real studio functional checks and screenshots through Playwright, using isolated generated media.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('../e2e/helpers');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, pw;
  const out = path.resolve('audit/single-chain-workspace'); fs.mkdirSync(out, { recursive: true }); const shots = [];
  try {
    server = await startServer(); browser = await launchBrowser(server.port);
    const setup = await openPlayer(browser, server.url('single-chain'), 'Host', { autoConfirm: false }); await loadFixture(setup);
    const actorSetup = await openPlayer(browser, server.url('single-chain'), 'Author', { autoConfirm: false }); await waitFor(actorSetup, () => session.loaded);
    for (const [client, id, count] of [[setup, 1, 1], [actorSetup, 2, 2]]) {
      await claimAndSelect(client, id);
      await client.evaluate(async ({ id, count }) => {
        window.qaMutation = (event, data) => new Promise(resolve => socket.emit(event, { ...data, sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() }, resolve));
        for (let j = 0; j < count; j++) { const b = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < b.length; i++) b.getChannelData(0)[i] = .08 * Math.sin(i * .1); await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: id, nick: myName, audioStart: 0, duration: 1, trimStart: .1, trimEnd: .8, blob: new Blob([audioBufferToWav(b)], { type: 'audio/wav' }), createdAt: Date.now() }); }
      }, { id, count });
    }
    await actorSetup.evaluate(async () => { for (const [id, type] of [['radio', 'radio'], ['robot', 'robot']]) { const r = await qaMutation('voice_preset_update', { action: 'create', id, name: id === 'radio' ? 'Radio voice' : 'Robot voice', revision: 0, settings: { effects: [{ id: id + '-stage', type, amount: .7, enabled: true, parameters: {} }, ...(id === 'robot' ? [{ id: 'role-echo', type: 'echo', amount: .3, enabled: true, parameters: { delay: .1, feedback: .2 } }] : [])], pitch: 2 } }); if (!r.ok) throw Error(JSON.stringify(r)); } });
    await waitFor(setup, () => !!session.voicePresets.robot);
    const original = await actorSetup.evaluate(async () => ({ bytes: Array.from(new Uint8Array(await (await fetch(session.lines[1].audioUrl)).arrayBuffer())), trim: session.lines[1].trimStart, history: session.lines[1].takeHistory.length }));
    pw = await chromium.connectOverCDP(browser.wsEndpoint()); const pages = pw.contexts().flatMap(c => c.pages()).filter(p => p.url().includes('single-chain'));
    const page = pages.find(p => p.url() === setup.url()) || pages[0], actor = pages.find(p => p !== page);
    // Both URLs match: identify the authenticated pages explicitly.
    const host = (await Promise.all(pages.map(async p => ({ p, nick: await p.evaluate(() => myName) })))).find(x => x.nick === 'Host').p;
    const author = pages.find(p => p !== host);
    const shot = async (p, name) => { await p.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); shots.push(name); };
    for (const [p, id] of [[host, 1], [author, 2]]) { await p.evaluate(id => selectLine(session.lines.find(l => l.id === id)), id); await p.locator('#inspectorPreset').selectOption('radio'); await p.locator('[data-preset-apply]').click(); await p.waitForFunction(id => session.lines.find(l => l.id === id).voicePresetId === 'radio' && !editorQueue.length, id); }
    await host.evaluate(async () => { const r = await qaMutation('voice_update', { scope: 'role', character: 'Hero', revision: 0, presetRevision: 1, settings: { effects: [], pitch: 0, voicePresetId: 'robot', usePresetPitch: true, presetModified: false } }); if (!r.ok) throw Error(JSON.stringify(r)); window.beforeSharedPCM = await audio.getProcessedTake(session.lines[0], { strict: true }); });
    assert.deepEqual(await host.evaluate(() => DublineVoiceChain.resolve(session.lines[0], session).effects.map(e => e.type)), ['robot', 'echo', 'radio']);
    await host.evaluate(() => DublineVoiceEditor.open(1, 'takes'));
    assert.equal(await host.locator('#fxFlow .fx-flow-role').count(), 1); assert.equal(await host.locator('#fxFlow .fx-flow-role').getAttribute('data-active'), 'true');
    assert.match(await host.locator('#fxFlow .fx-flow-role').textContent(), /Robot voice/);
    assert.equal(await host.locator('#fxFlow .fx-flow-step:not(.fx-flow-role)').allTextContents().then(labels => labels.includes('Robot') || labels.includes('Echo / Delay')), false);
    const badgeColor = await host.locator('#fxFlow .fx-flow-role').evaluate(n => getComputedStyle(n).backgroundColor), ownColor = await host.locator('#fxFlow .fx-flow-step').nth(3).evaluate(n => getComputedStyle(n).backgroundColor); assert.notEqual(badgeColor, ownColor);
    await shot(host, 'take-with-role-badge'); await host.locator('#fxInheritRow .switch-slider').click(); assert.equal(await host.locator('#fxFlow .fx-flow-role').getAttribute('data-active'), 'false'); await shot(host, 'take-with-bypassed-role'); await host.evaluate(() => DublineVoiceEditor.close(true));
    await author.evaluate(() => DublineVoiceEditor.open(2, 'takes')); assert.equal(await author.locator('#fxAdd').isEnabled(), true);
    await author.locator('#fxRows [data-action=amount]').evaluate(n => { n.value = '27'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.match(await author.locator('#fxLinkedLabel').textContent(), /modified/); assert.equal(await host.evaluate(() => session.voicePresets.radio.effects[0].amount), .7);
    await shot(author, 'private-draft'); await author.locator('#fxApply').click(); await author.waitForFunction(() => !fxDialog.open && session.lines[1].presetModified === true);
    assert.equal(await host.evaluate(() => session.lines[0].presetModified), false);
    assert.equal(await host.evaluate(async () => beforeSharedPCM === await audio.getProcessedTake(session.lines[0], { strict: true })), true);
    await author.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await author.locator('#fxLinkedEdit').click(); await author.waitForFunction(() => textPrompt.open); await author.locator('#textPromptCancel').click();
    assert.equal(await host.evaluate(() => session.voicePresets.radio.revision), 1);
    await author.locator('#fxLinkedEdit').click(); await author.waitForFunction(() => textPrompt.open); await shot(author, 'shared-update-confirmation'); await author.locator('#textPromptSave').click();
    await host.waitForFunction(() => session.voicePresets.radio.revision === 2); await author.waitForFunction(() => DublineVoiceEditor.draft()?.modified === false && !DublinePresetUI.pending());
    assert.equal(await host.evaluate(() => session.lines[1].presetModified), true, 'Publishing never silently replaces an already-saved private chain');
    const pcmChange = await host.evaluate(async () => { const next = await audio.getProcessedTake(session.lines[0], { strict: true }); let delta = 0; for (let i = 0; i < Math.min(next.length, beforeSharedPCM.length); i++) delta += Math.abs(next.getChannelData(0)[i] - beforeSharedPCM.getChannelData(0)[i]); return delta; }); assert.ok(pcmChange > .1);
    await author.locator('#fxApply').click(); await author.waitForFunction(() => !fxDialog.open && session.lines[1].presetModified === false);
    // Creating a new library entry captures exactly the private chain and its icon.
    await author.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await author.locator('[data-fx-type=echo]').click(); await author.locator('#fxPresetIcon').selectOption('music'); await author.locator('#fxPresetSave').click(); await author.waitForFunction(() => textPrompt.open); await author.locator('#textPromptInput').fill('My radio echo'); await author.locator('#textPromptSave').click(); await author.waitForFunction(() => Object.values(session.voicePresets).some(p => p.name === 'My radio echo') && !DublinePresetUI.pending());
    assert.deepEqual(await author.evaluate(() => Object.values(session.voicePresets).find(p => p.name === 'My radio echo').effects.map(e => e.type)), ['radio', 'echo']);
    await author.locator('#fxApply').click(); await author.waitForFunction(() => !fxDialog.open);
    await author.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await author.locator('#fxInheritRow .switch-slider').click(); await author.locator('#fxApply').click(); await author.waitForFunction(() => !fxDialog.open && session.lines[1].inheritRoleEffects === false);
    assert.equal(await author.evaluate(() => session.lines[1].takeHistory.length), original.history); assert.equal(await author.evaluate(() => session.lines[1].trimStart), original.trim);
    assert.deepEqual(await author.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines[1].audioUrl)).arrayBuffer()))), original.bytes);
    // Role editing uses the same chain and requires a library preset for a newly-created role chain.
    await host.evaluate(() => DublineVoiceEditor.open('Hero', 'role')); await shot(host, 'role-preset'); await host.evaluate(() => DublineVoiceEditor.close(true));
    // Responsive inspector and editor matrix; no production state is replaced by screenshot fixtures.
    for (const theme of ['midnight', 'light']) for (const lang of ['en', 'ru', 'uk']) {
      await author.setViewportSize({ width: 1920, height: 1080 }); await author.evaluate(async ({ theme, lang }) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(lang); }, { theme, lang });
      for (const width of [280, 540, 900]) { await author.evaluate(width => { layout.inspector = width; applyLayout(); selectLine(session.lines[1]); }, width); await author.waitForFunction(() => !document.querySelector('#inspector .insp-columns') || getComputedStyle(document.querySelector('#inspector .insp-columns')).display === 'grid'); await shot(author, `inspector-${theme}-${lang}-${width}`); }
      for (const count of [1, 8]) {
        await author.evaluate(() => DublineVoiceEditor.open(2, 'takes')); await author.locator('#fxClearChain').click(); for (let i = 0; i < count; i++) await author.locator('[data-fx-type=radio]').click();
        await author.setViewportSize({ width: 1280, height: 720 }); await shot(author, `editor-${theme}-${lang}-${count}`);
        const geometry = await author.evaluate(() => { const d = fxDialog, b = d.getBoundingClientRect(), a = fxApply.getBoundingClientRect(), rows = document.getElementById('fxRows'); return { columns: getComputedStyle(rows).gridTemplateColumns.split(' ').length, cards: [...rows.children].map(n => ({ top: n.getBoundingClientRect().top, overflow: [...n.querySelectorAll('button,input,label,b')].some(child => { const b = child.getBoundingClientRect(), r = n.getBoundingClientRect(); return b.left < r.left - 1 || b.right > r.right + 1; }) })), overflow: d.scrollWidth > d.clientWidth + 1, fits: b.left >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1, footer: a.top >= b.top && a.bottom <= b.bottom }; }); assert.ok(!geometry.overflow && geometry.fits && geometry.footer && geometry.cards.every(c => !c.overflow), JSON.stringify(geometry)); assert.equal(geometry.columns, 4); if (count === 8) { assert.equal(geometry.cards[0].top, geometry.cards[3].top); assert.ok(geometry.cards[4].top > geometry.cards[0].top); }
        if (count === 8 && theme === 'midnight' && lang === 'en') {
          const grip = await author.locator('#fxRows .fx-grip').first().boundingBox(), last = await author.locator('#fxRows .fx-item').last().boundingBox(); await author.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await author.mouse.down(); await author.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 12 }); assert.equal(await author.locator('.fx-drag-ghost').count(), 1); await shot(author, 'drag-eight'); await author.keyboard.press('Escape'); await author.mouse.up(); assert.equal(await author.locator('.fx-drag-ghost').count(), 0); assert.equal(await author.locator('#fxDialog').evaluate(n => n.open), true); const order = await author.evaluate(() => DublineVoiceEditor.draft().effects.map(e => e.id));
          await author.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await author.mouse.down(); await author.mouse.move(last.x + last.width * .8, last.y + last.height / 2, { steps: 12 }); assert.deepEqual(await author.evaluate(() => DublineVoiceEditor.draft().effects.map(e => e.id)), order); await author.mouse.up(); assert.equal(await author.evaluate(() => DublineVoiceEditor.draft().effects.at(-1).id), order[0]);

        }
        await author.evaluate(() => DublineVoiceEditor.close(true)); await author.setViewportSize({ width: 1920, height: 1080 });
      }
    }
    await host.setViewportSize({ width: 1280, height: 900 }); await host.evaluate(() => DublineVoiceEditor.open(1, 'takes'));
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const lang of ['en', 'ru', 'uk']) {
      await host.evaluate(async ({ theme, lang }) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(lang); }, { theme, lang });
      const badge = host.locator('#fxFlow .fx-flow-role'); assert.equal(await badge.count(), 1); assert.match(await badge.textContent(), /Robot voice/); assert.equal(await badge.getAttribute('data-active'), 'true');
      await shot(host, 'badge-' + theme + '-' + lang);
    }
    for (const width of [1024, 820, 640]) { await host.setViewportSize({ width, height: 900 }); for (const zoom of [1, 1.5]) {
      await host.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom); await host.waitForFunction(() => fxDialog.getBoundingClientRect().right <= innerWidth + 1);
      const safe = await host.evaluate(() => { const b = fxDialog.getBoundingClientRect(), a = fxApply.getBoundingClientRect(); return fxDialog.scrollWidth <= fxDialog.clientWidth + 1 && a.bottom <= b.bottom && b.left >= 0; }); assert.ok(safe); await shot(host, 'compact-' + width + '-' + zoom);
    }}
    await host.evaluate(() => { document.body.style.zoom = ''; DublineVoiceEditor.close(true); });
    assert.deepEqual(setup.errors, []); assert.deepEqual(actorSetup.errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ screenshots: shots, pcmDifference: pcmChange, originalBytesPreserved: true, assertions: 'PASS' }, null, 2));
    console.log(`Playwright PASS: ${shots.length} screenshots; private edits, explicit shared update, actual PCM, new preset/icon, collapsed role badge, four-column cards, role order, inheritance, history, original bytes and responsive layout.`);
  } finally { await pw?.close(); await browser?.close(); await server?.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
