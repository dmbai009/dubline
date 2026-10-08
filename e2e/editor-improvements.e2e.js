const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, wait } = require('./helpers');

describe('Editor improvements in the browser', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, page, serial = 0; const others = [];
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => { page = await openPlayer(browser, server.url(`editor-ui-${++serial}`), 'Host', { autoConfirm: false, audioExpanded: false }); await loadFixture(page); await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit'); });
  afterEach(async () => { assert.deepEqual(page.errors, []); await page.browserContext().close(); for (const other of others.splice(0)) { assert.deepEqual(other.errors, []); await other.browserContext().close(); } });
  async function guest(nick = 'Guest') { const room = await page.evaluate(() => currentRoom); const other = await openPlayer(browser, server.url(room), nick, { autoConfirm: false }); others.push(other); await waitFor(other, () => session?.loaded && session.mode === 'edit'); await page.bringToFront(); return other; }
  async function confirm() { await waitFor(page, () => !!document.querySelector('dialog.text-prompt[open]')); await page.click('#textPromptSave'); }
  async function conflicts() {
    const other = await guest();
    await page.evaluate(() => { socket.disconnect(); for (const id of [1, 2]) updateEditorLine(session.lines.find(line => line.id === id), { caption: `Local ${id}` }); });
    await other.evaluate(async () => { for (const id of [1, 2]) await updateEditorLine(session.lines.find(line => line.id === id), { caption: `Remote ${id}` }); });
    await page.evaluate(() => socket.connect()); await waitFor(page, () => editorConflicts.length === 2 && !editorQueue.length); return other;
  }
  test('bulk Keep all sequentially rebases two actual conflicts and preserves only successful acknowledgements', async () => {
    await conflicts(); await page.evaluate(() => reviewEditorConflicts()); await page.click('[data-review-all=keep]');
    await waitFor(page, () => !editorReviewBusy && !editorConflicts.length && !editorQueue.length);
    assert.deepEqual(await page.evaluate(() => session.lines.slice(0, 2).map(line => line.caption)), ['Local 1', 'Local 2']);
    assert.match(await page.$eval('#editorConflictPanel', node => node.textContent), /Applied: 2/);
    assert.equal(await page.evaluate(async () => (await DublineLocalDatabase.store('pendingEditorOperations').all()).length), 0);
  });
  test('bulk discard requires confirmation, survives reload and clears durable conflicts without overwriting remote edits', async () => {
    await conflicts(); await page.reload(); await waitFor(page, () => session?.loaded && editorConflicts.length === 2);
    await page.evaluate(() => reviewEditorConflicts()); await page.click('[data-review-all=discard]');
    await waitFor(page, () => !!document.querySelector('dialog[open]')); assert.equal(await page.$eval('#textPromptSave', button => button.className), 'btn-delete');
    await page.click('#textPromptCancel'); assert.equal(await page.evaluate(() => editorConflicts.length), 2);
    await page.click('[data-review-all=discard]'); await confirm(); await waitFor(page, () => !editorReviewBusy && !editorConflicts.length);
    assert.deepEqual(await page.evaluate(() => session.lines.slice(0, 2).map(line => line.caption)), ['Remote 1', 'Remote 2']);
    assert.equal(await page.evaluate(async () => (await DublineLocalDatabase.store('pendingEditorOperations').all()).length), 0);
  });
  test('failed durable conflict replacement retains the originals until an atomic IndexedDB transaction succeeds', async () => {
    await conflicts(); await page.evaluate(() => { window.savedReplaceIntent = editorIntentStore.replace; editorIntentStore.replace = () => Promise.reject(new Error('Injected disk failure')); reviewEditorConflicts(); });
    await page.click('[data-review-all=keep]'); await waitFor(page, () => !editorReviewBusy);
    assert.equal(await page.evaluate(() => editorConflicts.length), 2); assert.equal(await page.evaluate(async () => (await DublineLocalDatabase.store('pendingEditorOperations').all()).length), 2);
    await page.evaluate(() => { editorIntentStore.replace = savedReplaceIntent; });
    await page.click('[data-review-all=keep]'); await waitFor(page, () => !editorReviewBusy && !editorConflicts.length && !editorQueue.length);
    assert.deepEqual(await page.evaluate(() => session.lines.slice(0, 2).map(line => line.caption)), ['Local 1', 'Local 2']);
  });

  test('timing protection disables Inspector timing and creation, preserves drafts and allows vertical reassignment', async () => {
    await page.evaluate(() => selectLine(session.lines[0])); await page.type('#editorCaption', ' draft');
    await page.click('#protectTimingsBtn'); await waitFor(page, () => session.protectTimings);
    assert.equal(await page.$eval('#addEditorLineBtn', button => button.disabled), true);
    const fields = await page.evaluate(() => [...document.querySelectorAll('[data-editor-field="start"],[data-editor-field="end"]')].every(input => input.disabled)); assert.equal(fields, true);
    assert.match(await page.$eval('#editorCaption', input => input.value), /draft/);
    const initial = await page.evaluate(() => [session.lines[0].start, session.lines[0].end]);
    await page.evaluate(() => updateEditorLine(session.lines[0], { character: 'Friend' })); await waitFor(page, () => session.lines[0].character === 'Friend');
    assert.deepEqual(await page.evaluate(() => [session.lines[0].start, session.lines[0].end]), initial);
  });
  test('track handle reorders with pointer and keyboard and Undo restores the original order', async () => {
    const handle = await page.$('.track-row[data-character="Friend"] .track-drag-handle'); const bounds = await handle.boundingBox();
    const top = await page.$eval('.track-row[data-character="Hero"]', row => row.getBoundingClientRect().top);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + 5, top + 2, { steps: 8 }); await page.mouse.up();
    await waitFor(page, () => session.trackOrder[0] === 'Friend' && !editorQueue.length);
    await page.evaluate(() => editorUndo()); await waitFor(page, () => session.trackOrder[0] === 'Hero');
    await page.focus('.track-row[data-character="Hero"] .track-drag-handle'); await page.keyboard.down('Alt'); await page.keyboard.press('ArrowDown'); await page.keyboard.up('Alt');
    await waitFor(page, () => session.trackOrder[0] === 'Friend');
  });
  test('track deletion dialog transfers all lines and uses the existing Undo', async () => {
    await page.click('.track-row[data-character="Hero"] .track-delete-button'); await waitFor(page, () => document.querySelector('.track-delete-dialog').open);
    assert.match(await page.$eval('.track-delete-dialog', node => node.textContent), /2 lines/);
    await page.click('[data-track-decision=transfer]'); await waitFor(page, () => !session.trackOrder.includes('Hero') && !editorQueue.length);
    assert.equal(await page.evaluate(() => session.lines.length), 4); assert.equal(await page.evaluate(() => session.lines.every(line => line.character === 'Friend')), true);
    await page.evaluate(() => editorUndo()); await waitFor(page, () => session.trackOrder.includes('Hero'));
    assert.equal(await page.evaluate(() => session.lines.filter(line => line.character === 'Hero').length), 2);
  });
  test('moderator appointment/revocation updates controls live, preserves Inspector drafts and keeps project actions host-only', async () => {
    const other = await guest('Moderator'); await other.evaluate(() => selectLine(session.lines[0])); await other.type('#editorCaption', ' draft');
    await page.evaluate(() => { changeModerator('Moderator', ''); }); await confirm(); await waitFor(other, () => amModerator());
    assert.equal(await other.$eval('#protectTimingsBtn', button => button.disabled), false); assert.equal(await other.$eval('#projectExportBtn', button => button.disabled), true);
    assert.match(await other.$eval('#editorCaption', input => input.value), /draft/);
    const id = await page.evaluate(() => session.moderators[0].id); await page.evaluate(id => { changeModerator('Moderator', id); }, id); await confirm(); await waitFor(other, () => !amModerator());
    assert.equal(await other.$eval('#protectTimingsBtn', button => button.disabled), true); assert.match(await other.$eval('#editorCaption', input => input.value), /draft/);
  });
  test('Space works after a timeline click and retains native button activation and text entry', async () => {
    await page.click('#line-block-1'); await page.keyboard.press('Space'); await waitFor(page, () => !video.paused);
    await page.keyboard.press('Space'); await waitFor(page, () => video.paused);
    await page.focus('#editorCaption'); const before = await page.$eval('#editorCaption', input => input.value); await page.keyboard.press('Space');
    assert.equal(await page.$eval('#editorCaption', input => input.value.length), before.length + 1); assert.equal(await page.evaluate(() => video.paused), true);
    await page.focus('#masterMute'); const muted = await page.evaluate(() => volumes.isMuted); await page.keyboard.press('Space'); assert.equal(await page.evaluate(() => volumes.isMuted), !muted); assert.equal(await page.evaluate(() => video.paused), true);
  });
  test('focused seek follows playback again after scrubbing is released or cancelled', async () => {
    await page.focus('#transportSeek'); await page.evaluate(() => { const seek = document.getElementById('transportSeek'); seek.value = '2'; seek.dispatchEvent(new Event('input')); window.dispatchEvent(new Event('pointerup')); video.currentTime = 3; video.dispatchEvent(new Event('timeupdate')); });
    assert.equal(await page.$eval('#transportSeek', input => Number(input.value)), 3); assert.equal(await page.evaluate(() => transportScrubbing), false);
    for (const event of ['pointercancel', 'blur']) {
      await page.evaluate(event => { const seek = document.getElementById('transportSeek'); seek.value = '4'; seek.dispatchEvent(new Event('input')); window.dispatchEvent(new Event(event)); video.currentTime = 5; video.dispatchEvent(new Event('timeupdate')); }, event);
      assert.equal(await page.$eval('#transportSeek', input => Number(input.value)), 5);
    }
  });
  test('search first Previous selects the last result, wraps and resets when query changes', async () => {
    await page.evaluate(() => openTimelineSearch()); await page.type('#timelineSearchInput', 'Hero');
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); assert.equal(await page.evaluate(() => selectedLine.id), 3);
    await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => selectedLine.id), 1);
    await page.$eval('#timelineSearchInput', input => { input.value = 'Friend'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); assert.equal(await page.evaluate(() => selectedLine.id), 4);
  });
  test('Ctrl/Cmd+F and Escape respect text fields, dialogs and the timeline search', async () => {
    await page.evaluate(() => selectLine(session.lines[0])); await page.focus('#editorCaption'); await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control');
    assert.equal(await page.$eval('#timelineSearch', element => element.hidden), true);
    await page.click('#line-block-1'); await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control'); assert.equal(await page.$eval('#timelineSearch', element => element.hidden), false);
    await page.evaluate(() => { askConfirm('Test modal'); }); await page.keyboard.press('Escape'); assert.equal(await page.$eval('#timelineSearch', element => element.hidden), false);
    await page.keyboard.press('Escape'); assert.equal(await page.$eval('#timelineSearch', element => element.hidden), true);
  });
  test('master volume coordinates stay fixed at all digit boundaries', async () => {
    const boxes = await page.evaluate(() => [0, 9, 10, 99, 100].map(value => { const input = document.getElementById('masterVolume'); input.value = value; input.dispatchEvent(new Event('input')); const a = input.getBoundingClientRect(), b = document.getElementById('masterMute').getBoundingClientRect(); return [a.left, a.width, b.left]; }));
    boxes.forEach(box => assert.deepEqual(box, boxes[0]));
  });
  test('Files tabs preserve content, keyboard navigation, host scopes, localization, themes and responsive bounds', async () => {
    const other = await guest();
    await page.evaluate(() => openFilesModal()); assert.equal(await page.$eval('#filesModal [role=tab][aria-selected=true]', tab => tab.id), 'tabBtnPacks');
    await page.keyboard.press('ArrowRight'); assert.equal(await page.$eval('#filesModal [role=tab][aria-selected=true]', tab => tab.id), 'tabBtnVideo');
    assert.equal(await page.$eval('#localMediaInput', input => input.closest('[role=tabpanel]').id), 'tabContentVideo');
    assert.equal(await page.$eval('#projectExportBtn', input => input.closest('[role=tabpanel]').id), 'tabContentProjects');
    assert.equal(await other.$eval('#projectInput', input => input.disabled), true); assert.equal(await other.$eval('#localMediaInput', input => input.disabled), false);
    for (const language of ['ru', 'en', 'uk']) for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) {
      await page.evaluate(async (language, theme) => { await i18n.setLanguage(language); document.documentElement.dataset.theme = theme; }, language, theme);
      for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080]]) {
        await page.setViewport({ width, height });
        for (const scale of [1, 1.25, 1.5]) {
          await page.evaluate(scale => { document.documentElement.style.zoom = scale; }, scale);
          for (const tab of ['packs', 'video', 'projects', 'export']) {
            const result = await page.evaluate(tab => { switchFilesTab(tab); const card = document.querySelector('#filesModal .files-card'), box = card.getBoundingClientRect(); return { overflow: card.scrollWidth > card.clientWidth + 1, right: box.right, left: box.left, width: innerWidth, ids: [...document.querySelectorAll('#filesModal [id]')].map(element => element.id) }; }, tab);
            assert.equal(result.overflow, false, `${language} ${theme} ${width} ${scale} ${tab}`); assert.ok(result.left >= 0 && result.right <= result.width + 1); assert.equal(new Set(result.ids).size, result.ids.length);
          }
        }
      }
    }
    await page.evaluate(() => { document.documentElement.style.zoom = 1; }); await page.keyboard.press('Escape'); assert.equal(await page.$eval('#filesModal', modal => modal.style.display), 'none');
  });
});
