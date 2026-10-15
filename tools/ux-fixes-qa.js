// Real studio + Playwright: layout, stationary dropdown text and fullscreen captions.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('../e2e/helpers');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.cwd(), path.resolve('audit/fx-tools')] }));
async function main() {
  let server, browser, pw;
  const out = path.resolve('audit/ux-fixes'); fs.mkdirSync(out, { recursive: true }); const shots = [], measurements = [];
  try {
    server = await startServer(); browser = await launchBrowser(server.port);
    const setup = await openPlayer(browser, server.url('ux-fixes'), 'Host', { autoConfirm: false }); await loadFixture(setup);
    const actor = await openPlayer(browser, server.url('ux-fixes'), 'Moderator_Long16'); await waitFor(actor, () => session.loaded);
    await claimAndSelect(setup, 1);
    await setup.evaluate(async () => {
      window.qaMutation = (event, data) => new Promise(resolve => socket.emit(event, { ...data, sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() }, resolve));
      for (let j = 0; j < 2; j++) {
        const b = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }); for (let i = 0; i < b.length; i++) b.getChannelData(0)[i] = .08 * Math.sin(i * .1);
        await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, audioStart: 0, duration: 1, trimStart: .05, trimEnd: .9, blob: new Blob([audioBufferToWav(b)], { type: 'audio/wav' }), createdAt: Date.now() });
      }
      for (const [id, name] of [['qa-radio', 'Очень длинное название пресета / Long preset name / Довгий пресет'], ['qa-robot', 'Robot role']]) {
        const result = await qaMutation('voice_preset_update', { action: 'create', id, name, revision: 0, settings: { effects: [{ id: id + '-stage', type: id === 'qa-radio' ? 'radio' : 'robot', amount: .5, enabled: true, parameters: {} }] } }); if (!result.ok) throw Error(JSON.stringify(result));
      }
      const result = await new Promise(resolve => socket.emit('host_grant_moderator', { nick: 'Moderator_Long16' }, resolve)); if (!result.ok) throw Error(JSON.stringify(result));
      selectLine(session.lines[0]);
    });
    await waitFor(setup, () => session.lines[0].takeHistory.length === 1 && !!document.querySelector('.tag.moderator'));
    pw = await chromium.connectOverCDP(browser.wsEndpoint());
    const pages = pw.contexts().flatMap(c => c.pages()).filter(p => p.url() === setup.url());
    const page = (await Promise.all(pages.map(async p => ({ p, nick: await p.evaluate(() => myName) })))).find(item => item.nick === 'Host').p;
    const shot = async name => { await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' }); shots.push(name); };
    const ownBytes = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines[0].audioUrl)).arrayBuffer())));
    await page.locator('.insp-trim .switch-slider').click(); await page.waitForFunction(() => session.lines[0].trimEnabled === false);
    await shot('silence-trim-off');
    await page.locator('.insp-trim .switch-slider').click(); await page.waitForFunction(() => session.lines[0].trimEnabled === true);
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) {
      for (const language of ['en', 'ru', 'uk']) {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.evaluate(async ({ theme, language }) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); document.body.style.zoom = ''; layout.inspector = 640; layout.top = 580; applyLayout(); selectLine(session.lines[0]); document.querySelector('.take-history').open = true; }, { theme, language });
        const result = await page.evaluate(() => {
          const history = document.querySelector('.take-history'), mic = document.querySelector('.insp-mic'), role = document.querySelector('.insp-role-voice');
          const recording = document.querySelector('.insp-recording > h4'), voice = document.querySelector('.insp-section-title h4');
          const style = n => { const s = getComputedStyle(n); return [s.fontSize, s.fontWeight, s.color]; };
          return { history: history.parentElement.classList.contains('insp-recording') && history.getBoundingClientRect().top >= mic.getBoundingClientRect().bottom, roleHidden: !role, sameTitle: JSON.stringify(style(recording)) === JSON.stringify(style(voice)), trimSwitch: !!document.querySelector('.insp-trim [role=switch] + .switch-slider'), icon: !!document.querySelector('.tag.moderator svg'), modifierColor: getComputedStyle(document.querySelector('.tag.moderator')).color, noAB: !document.querySelector('#takeCompareDialog,[data-history-compare],#sequenceRecording') };
        }); assert.ok(result.history && result.roleHidden && result.sameTitle && result.trimSwitch && result.icon && result.noAB, JSON.stringify(result));
        await shot(`inspector-${theme}-${language}`);
      }
    }
    console.log('Inspector, moderator, history and locales verified.');
    // Panel width changes retain all ordinary history controls and compact stacking.
    for (const width of [280, 480, 640, 900]) {
      await page.evaluate(width => { layout.inspector = width; applyLayout(); selectLine(session.lines[0]); document.querySelector('.take-history').open = true; }, width);
      assert.ok(await page.locator('#inspector').evaluate(n => n.scrollWidth <= n.clientWidth + 1)); await shot('inspector-width-' + width);
    }
    await page.evaluate(async () => {
      const r = await qaMutation('voice_update', { scope: 'role', character: 'Hero', revision: 0, presetRevision: 1, settings: { effects: [], pitch: 0, voicePresetId: 'qa-robot', presetModified: false, usePresetPitch: true } }); if (!r.ok) throw Error(JSON.stringify(r));
      selectLine(session.lines[0]);
    });
    assert.match(await page.locator('.insp-role-voice').textContent(), /Robot role/); assert.equal(await page.locator('.insp-role-voice button').count(), 0);
    await page.evaluate(() => { const line = session.lines[0]; line.needsRetake = true; renderTimeline(); selectLine(line); });
    assert.equal(await page.locator('#line-block-1').evaluate(n => n.classList.contains('needs-retake') && n.classList.contains('selected')), true);
    // Long track title: the fixed-size effect button precedes the ellipsized name.
    await page.evaluate(() => { const name = document.querySelector('.char-name'); name.textContent = 'An extremely long role name / Очень длинное имя персонажа'; });
    assert.ok(await page.locator('.char-name-row').first().evaluate(n => { const button = n.querySelector('.track-fx'), name = n.querySelector('.char-name'); return button.nextElementSibling === name && button.getBoundingClientRect().right <= name.getBoundingClientRect().left && name.getBoundingClientRect().right <= n.getBoundingClientRect().right + 1; }));
    await shot('retake-selected-and-long-role');
    for (const count of [1, 8]) {
      await page.setViewportSize({ width: 1280, height: 850 }); await page.evaluate(() => DublineVoiceEditor.open(1, 'takes'));
      for (let i = 0; i < count; i++) await page.locator('[data-fx-type=radio]').click();
      await page.locator('#fxPresetSelect').selectOption('qa-radio');
      const geometry = await page.evaluate(() => { const cards = [...fxRows.children].map(n => n.getBoundingClientRect()), body = document.querySelector('#fxDialog .fx-main').getBoundingClientRect(), sidebar = document.querySelector('#fxDialog .fx-sidebar').getBoundingClientRect(); return { chain: body.width, sidebar: sidebar.width, firstRow: cards.filter(b => Math.abs(b.top - cards[0].top) < 1).length, fits: fxDialog.getBoundingClientRect().right <= innerWidth && fxDialog.scrollWidth <= fxDialog.clientWidth + 1, save: fxApply.textContent === t('chain.applyTake') }; });
      assert.ok(geometry.chain >= 800 && geometry.sidebar >= 320 && geometry.fits && geometry.save, JSON.stringify(geometry)); assert.equal(geometry.firstRow, Math.min(4, count)); await shot('effects-' + count);
      await page.evaluate(() => DublineVoiceEditor.close(true));
    }
    console.log('Four-column effects and expanded preset sidebar verified.');
    // Measure actual text (Range rectangles), not only the popup border, over many frames.
    await page.evaluate(() => { openFilesModal(); switchFilesTab('export'); }); await page.waitForFunction(() => videoExportPanel.dataset.ready === 'true');
    await page.locator('[name=videoExportMode][value=custom]').check();
    for (const [width, height, zoom] of [[1280, 900, 1], [1600, 1000, 1.25], [1600, 1000, 1.5], [820, 900, 1]]) {
      await page.setViewportSize({ width, height }); await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom);
      for (const id of ['videoExportSource', 'videoExportFormat', 'videoExportResolution', 'videoExportFps']) {
        await page.evaluate(id => { DublineDropdown.close(); DublineDropdown.button(document.getElementById(id)).click(); }, id);
        const samples = await page.evaluate(async () => {
          const points = []; for (let i = 0; i < 45; i++) { await new Promise(requestAnimationFrame); if (i < 8) continue; const row = document.querySelector('#dubSelectOptions [role=option]'), range = document.createRange(); range.selectNodeContents(row); const r = range.getBoundingClientRect(), p = dubSelectPopup.getBoundingClientRect(); points.push([r.x, r.y, r.width, p.x, p.y, p.width]); }
          return { spread: Array.from({ length: 6 }, (_, i) => Math.max(...points.map(p => p[i])) - Math.min(...points.map(p => p[i]))), fits: (() => { const b = dubSelectPopup.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1; })() };
        }); assert.ok(samples.fits && samples.spread.every(n => n < .1), JSON.stringify({ id, width, zoom, samples })); measurements.push({ id, width, zoom, ...samples }); await shot(`export-${id}-${width}-${zoom}`); await page.keyboard.press('Escape');
      }
    }
    console.log('All four export lists remain stationary across consecutive frames and fractional zoom.');
    await page.evaluate(() => { closeFilesModal(); document.body.style.zoom = ''; });
    // Invitation provider controls use their existing production state renderer; no network tunnel is started.
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const width of [640, 1280]) for (const mode of ['cloudflare', 'porthole', 'vpn']) for (const language of ['en', 'ru', 'uk']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async ({ mode, language }) => { await DublineI18n.setLanguage(language); desktopInviteState = { mode, room: currentRoom, port: 38521, pin: '1234', connections: Object.fromEntries(['cloudflare', 'porthole', 'vpn'].map(m => [m, { state: 'ready', publicUrl: 'https://example.invalid' }])) }; desktopInviteMode = mode; desktopInviteCollapsed = false; renderDesktopInvite(); }, { mode, language });
      assert.ok(await page.locator('.desktop-pin-row').evaluate(n => { const b = n.querySelector('button.desktop-copy-all-btn').getBoundingClientRect(), pin = n.querySelector('.desktop-pin').getBoundingClientRect(); return Math.abs(b.top - pin.top) < 8 && n.scrollWidth <= n.clientWidth + 1; })); await shot(`invite-${mode}-${language}-${width}`);
    }
    await page.evaluate(() => closeDesktopInvite(false));
    // Native browser fullscreen: real wrapped panel height, long multiline captions and idle return.
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.evaluate(() => { prompterEnabled = true; prompterSize = 40; session.lines[0].caption = 'Long subtitles with several lines. '.repeat(10); video.currentTime = 3.3; invalidatePrompterIndex(); updatePrompter(); });
    await page.locator('[data-studio-action=fullscreen]').click(); await page.waitForFunction(() => !!document.fullscreenElement);
    await page.waitForTimeout(280);
    assert.ok(await page.evaluate(() => { const p = videoPrompter.getBoundingClientRect(), t = document.querySelector('.studio-transport').getBoundingClientRect(); return p.bottom <= t.top - 10 && p.top >= 0; })); await shot('fullscreen-panel-visible');
    await page.evaluate(() => document.querySelector('.video-wrapper').classList.add('fullscreen-idle')); await page.waitForTimeout(280); await shot('fullscreen-panel-hidden');
    assert.ok(await page.evaluate(() => videoPrompter.getBoundingClientRect().bottom >= innerHeight - 25));
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.evaluate(() => document.querySelector('.video-wrapper').classList.remove('fullscreen-idle'));
    assert.equal(await page.locator('#videoPrompter').evaluate(n => getComputedStyle(n).transitionDuration), '0s');
    await page.evaluate(() => document.exitFullscreen());
    assert.deepEqual(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch(session.lines[0].audioUrl)).arrayBuffer()))), ownBytes);
    assert.deepEqual(setup.errors, []); assert.deepEqual(actor.errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ shots, measurements }, null, 2)); console.log('PASS: ' + shots.length + ' Playwright screenshots; recordings unchanged.');
  } finally { if (pw) await pw.close().catch(() => {}); await browser?.close(); await server?.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
