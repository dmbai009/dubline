const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, claimAndSelect, recordTake, buildFixturePack, wait } = require('./helpers');

describe('Group editing reliability', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, host, serial = 0; const guests = [];
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => {
    host = await openPlayer(browser, server.url(`group-${++serial}`), 'Host', { autoConfirm: false });
    await loadFixture(host); await host.evaluate(() => setStudioMode('edit')); await waitFor(host, () => session?.mode === 'edit');
  });
  afterEach(async () => { for (const page of [host, ...guests.splice(0)]) { assert.deepEqual(page.errors, []); await page.browserContext().close(); } });
  async function guest(nick) {
    const room = await host.evaluate(() => currentRoom), page = await openPlayer(browser, server.url(room), nick, { autoConfirm: false });
    guests.push(page); await waitFor(page, () => session?.loaded && session.mode === 'edit'); await host.bringToFront(); return page;
  }
  async function confirm(page = host) { await waitFor(page, () => !!document.querySelector('dialog.text-prompt[open]')); await page.click('#textPromptSave'); }
  test('participant menu and keyboard focus survive repeated room and recording updates', async () => {
    await guest('Guest');
    await host.evaluate(() => {
      window.openMenu = document.querySelector('.participant-menu'); openMenu.open = true;
      window.menuAction = openMenu.querySelector('button'); menuAction.focus();
      for (let i = 0; i < 20; i++) {
        socket.emitEvent(['recording_state', { sessionId: session.activeSessionId, recordings: i % 2 ? [] : [{ lineId: 1, nick: 'Guest' }] }]);
        socket.emitEvent(['room_users_updated', { users: ['Host', 'Guest'], host: 'Host', hostOnline: true, moderators: [] }]);
      }
    });
    assert.equal(await host.evaluate(() => openMenu.isConnected && openMenu.open && document.activeElement === menuAction), true);
    await host.click('.participant-menu .btn-outline'); await confirm();
    await waitFor(host, () => session.moderators.some(entry => entry.nick === 'Guest'));
    await host.evaluate(() => { document.querySelector('.participant-menu').open = true; });
    await host.keyboard.press('Escape'); assert.equal(await host.$eval('.participant-menu', menu => menu.open), false);
    await host.evaluate(() => { document.querySelector('.participant-menu').open = true; });
    await host.click('.participant-menu .btn-outline'); await confirm();
    await waitFor(host, () => !session.moderators.length);
    await host.focus('.participant-menu summary'); await host.keyboard.press('Enter');
    assert.equal(await host.$eval('.participant-menu', menu => menu.open), true);
    await host.click('#zoomFitBtn'); assert.equal(await host.$eval('.participant-menu', menu => menu.open), false);
    await host.evaluate(() => { document.querySelector('.participant-menu').open = true; });
    await host.click('.participant-menu .btn-delete'); await confirm();
    await waitFor(host, () => !document.querySelector('.participant-menu'));
    await waitFor(guests[0], () => !socket.connected && accessDenied);
  });
  test('rapid local reorders preserve their sequence without stale order rejection', async () => {
    const other = await guest('Guest');
    await host.evaluate(async () => { await queueEditorRequest(() => ['editor_add_track', { character: 'Empty' }]); });
    const before = await host.evaluate(() => JSON.stringify(session.lines));
    await host.evaluate(() => {
      for (let i = 0; i < 2; i++) document.querySelector('.track-row[data-character="Hero"] .track-drag-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    });
    await waitFor(host, () => !editorQueue.length);
    assert.deepEqual(await host.evaluate(() => session.trackOrder), ['Friend', 'Empty', 'Hero']);
    assert.equal(await host.evaluate(() => editorConflicts.length), 0);
    await waitFor(other, () => session.trackOrder.join(',') === 'Friend,Empty,Hero');
    assert.equal(await host.evaluate(() => JSON.stringify(session.lines)), before);
    await host.evaluate(() => editorUndo()); await waitFor(host, () => session.trackOrder.join(',') === 'Friend,Hero,Empty');
  });
  test('lost reorder ACK checks the identical receipt and preserves subsequent local intent without repeating a known mutation', async () => {
    const other = await guest('Guest');
    await host.evaluate(async () => { await queueEditorRequest(() => ['editor_add_track', { character: 'Empty' }]); });
    await host.evaluate(() => {
      const original = socket.emit; let lose = true; window.reorderRequests = []; window.reorderReceiptRequests = [];
      socket.emit = function(event, ...args) {
        if (event === 'editor_operation_status') reorderReceiptRequests.push(JSON.stringify(args[0].request));
        if (event === 'editor_reorder_track') {
          reorderRequests.push(JSON.stringify(args[0]));
          if (lose) { lose = false; const callback = args.pop(); args.push(() => callback(new Error('Injected lost reorder ACK'))); }
        }
        return original.call(this, event, ...args);
      };
      for (let i = 0; i < 2; i++) document.querySelector('.track-row[data-character="Hero"] .track-drag-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    });
    await waitFor(host, () => !editorQueue.length && !editorConflicts.length && session.trackOrder.join(',') === 'Friend,Empty,Hero');
    const requests = await host.evaluate(() => reorderRequests);
    assert.equal(requests.length, 2); assert.notEqual(requests[0], requests[1]);
    assert.deepEqual(await host.evaluate(() => reorderReceiptRequests), [requests[0]]);
    await waitFor(other, () => session.trackOrder.join(',') === 'Friend,Empty,Hero');
    await host.evaluate(() => editorUndo()); await waitFor(host, () => session.trackOrder.join(',') === 'Friend,Hero,Empty');
    await host.evaluate(() => editorUndo()); await waitFor(host, () => session.trackOrder.join(',') === 'Hero,Friend,Empty');
  });
  test('a disconnected reorder conflicts with an intervening remote order and remains durable without automatic rebasing', async () => {
    const other = await guest('Guest');
    await host.evaluate(async () => { await queueEditorRequest(() => ['editor_add_track', { character: 'Empty' }]); });
    await waitFor(other, () => session.trackOrder.length === 3);
    const before = await host.evaluate(() => JSON.stringify(session.lines));
    await host.evaluate(() => {
      document.querySelector('.track-row[data-character="Hero"] .track-drag-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
      socket.disconnect();
    });
    await other.evaluate(async () => { await queueEditorRequest(() => ['editor_reorder_track', { character: 'Empty', before: 'Hero', trackOrder: session.trackOrder }]); });
    await host.evaluate(() => socket.connect());
    await waitFor(host, () => !editorQueue.length && editorConflicts.length === 1);
    assert.deepEqual(await host.evaluate(() => session.trackOrder), ['Empty', 'Hero', 'Friend']);
    assert.equal(await host.evaluate(() => JSON.stringify(session.lines)), before);
    assert.equal(await host.evaluate(async () => { await editorPersistence; return (await editorIntentStore.all()).length; }), 1);
    const toast = await host.evaluate(() => document.body.textContent);
    assert.match(toast, /order changed/); assert.doesNotMatch(toast, /Check the line timing/);
  });
  test('conflict close and Escape preserve durable intent across reopen and reload', async () => {
    const other = await guest('Guest');
    await host.evaluate(() => { socket.disconnect(); updateEditorLine(session.lines[0], { caption: 'Local pending caption' }); });
    await other.evaluate(() => updateEditorLine(session.lines[0], { caption: 'Remote caption' }));
    await host.evaluate(() => socket.connect()); await waitFor(host, () => editorConflicts.length === 1 && !editorQueue.length);
    const records = await host.evaluate(async () => { await editorPersistence; return JSON.stringify(await editorIntentStore.all()); });
    await host.evaluate(() => reviewEditorConflicts()); await host.click('[data-close-editor-conflicts]');
    assert.equal(await host.$eval('#editorConflictPanel', panel => panel.hidden), true);
    assert.equal(await host.evaluate(async () => JSON.stringify(await editorIntentStore.all())), records);
    await host.click('#editorSyncState'); await host.keyboard.press('Escape');
    assert.equal(await host.$eval('#editorConflictPanel', panel => panel.hidden), true);
    await host.reload(); await waitFor(host, () => session?.loaded && editorConflicts.length === 1);
    await host.click('#editorSyncState'); assert.match(await host.$eval('#editorConflictPanel', panel => panel.textContent), /Local pending caption/);
  });
  test('a lost clear selection heals for both other participants', async () => {
    const other = await guest('Guest'), third = await guest('Third');
    await host.evaluate(() => { multiSelection.clear(); session.lines.forEach(line => multiSelection.add(line.id)); refreshMultiSelection(); });
    await waitFor(other, () => document.querySelectorAll('.remote-selection-markers').length === session.lines.length);
    await host.evaluate(() => {
      window.originalSelectionEmit = socket.volatile.emit;
      socket.emit = function(event, ...args) { if (event === 'selection_update' && !args[0].lineIds.length) return this; return originalSelectionEmit.call(this, event, ...args); };
      selectedLine = null; clearMultiSelection();
    });
    for (const page of [other, third]) await waitFor(page, () => !document.querySelector('.remote-selection-markers'), 12000);
  });
  test('selection snapshots reject old versions, old scenes and old server epochs', async () => {
    await guest('Guest');
    assert.deepEqual(await host.evaluate(() => {
      const actor = { actorId: 'test-actor', nick: 'Guest', sessionId: session.activeSessionId, lineIds: [1], ttlMs: 6000 };
      const emit = (epoch, version, selections, sessionId = session.activeSessionId) => socket.emitEvent(['selection_presence', { epoch, version, selections, sessionId }]);
      const marked = () => !!document.querySelector('.remote-selection-markers');
      emit('test-first', 10, [actor]); const shown = marked();
      emit('test-first', 12, []); emit('test-first', 11, [actor]); const staleVersion = marked();
      emit('test-first', 13, [actor], 'previous-scene'); const staleScene = marked();
      emit('test-second', 1, []); emit('test-first', 14, [actor]); const staleEpoch = marked();
      return { shown, staleVersion, staleScene, staleEpoch };
    }), { shown: true, staleVersion: false, staleScene: false, staleEpoch: false });
  });
  test('a real 400-cue selection renews its lease, clears on disconnect and never returns after scene switch', async () => {
    const zip = new AdmZip(buildFixturePack());
    for (const entry of zip.getEntries()) if (/\.(ini|wav|mp3)$/.test(entry.entryName)) zip.deleteFile(entry.entryName);
    for (let id = 1; id <= 400; id++) zip.addFile(`${String(id).padStart(3, '0')}.ini`, Buffer.from(`caption = Cue ${id}\ndub_characters = ["Role ${Math.floor((id - 1) / 20)}"]\ndub_timestamps = [${(id - 1) * .025}, ${id * .025}]\n`));
    zip.writeZip(path.join(server.dirs.packs, 'group400.zip'));
    await host.evaluate(() => loadSavedPack('group400.zip')); await waitFor(host, () => session.lines.length === 400);
    await host.evaluate(() => setStudioMode('edit')); await waitFor(host, () => session.mode === 'edit');
    const other = await guest('Guest'), third = await guest('Third');
    await host.evaluate(() => { selectedLine = null; multiSelection.clear(); session.lines.forEach(line => multiSelection.add(line.id)); refreshMultiSelection(); });
    for (const page of [other, third]) await waitFor(page, () => document.querySelectorAll('.remote-selection-markers').length === 400);
    // Keep the tab visible; the 2 s heartbeat must extend the server's 6 s lease.
    await wait(7500);
    assert.equal(await other.$$eval('.remote-selection-markers', nodes => nodes.length), 400);
    assert.equal(await host.$$eval('.role-progress-count', nodes => nodes.every(node => node.textContent === '0 / 20')), true);
    await host.evaluate(() => socket.disconnect());
    for (const page of [other, third]) await waitFor(page, () => !document.querySelector('.remote-selection-markers'));
    await host.evaluate(() => { selectedLine = null; multiSelection.clear(); socket.connect(); });
    await waitFor(host, () => socket.connected && lastOnlineUsers.length === 3);
    await loadFixture(host);
    for (const page of [other, third]) await waitFor(page, () => session.lines.length === 4 && !document.querySelector('.remote-selection-markers'));
  });
  test('closing conflict review during an asynchronous resolution does not cancel the operation', async () => {
    const other = await guest('Guest');
    await host.evaluate(() => { socket.disconnect(); updateEditorLine(session.lines[0], { caption: 'Local intent kept' }); });
    await other.evaluate(() => updateEditorLine(session.lines[0], { caption: 'Remote caption' }));
    await host.evaluate(() => socket.connect()); await waitFor(host, () => editorConflicts.length === 1);
    await host.evaluate(() => {
      const original = resyncEditor;
      resyncEditor = async (...args) => { await new Promise(resolve => { window.releaseConflictReview = resolve; }); return original(...args); };
      reviewEditorConflicts();
    });
    await host.click('[data-review-all="keep"]'); await waitFor(host, () => editorReviewBusy && !!window.releaseConflictReview);
    await host.click('[data-close-editor-conflicts]');
    assert.equal(await host.$eval('#editorConflictPanel', panel => panel.hidden), true);
    await host.evaluate(() => releaseConflictReview());
    await waitFor(host, () => !editorReviewBusy && !editorQueue.length && !editorConflicts.length && session.lines[0].caption === 'Local intent kept');
    await waitFor(other, () => session.lines[0].caption === 'Local intent kept');
    assert.equal(await host.$eval('#editorConflictPanel', panel => panel.hidden), true);
  });
  test('whole-scene minimum follows duration, window and panels; every maximum is 200 percent', async () => {
    for (const duration of [12, 1440, 43200]) {
      await host.evaluate(duration => { Object.defineProperty(video, 'duration', { configurable: true, get: () => duration }); }, duration);
      for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080]]) {
        await host.setViewport({ width, height });
        await host.evaluate(() => fitTimeline());
        await waitFor(host, () => timeline.scrollWidth <= timelineContainer.clientWidth + 1);
        assert.ok(await host.evaluate(() => pxPerSec > 0 && pxPerSec <= 120 && zoomLabel.textContent !== '0%'));
        await host.evaluate(() => setTimelineZoom(1e9)); assert.equal(await host.evaluate(() => pxPerSec), 120);
        await host.click('#zoomInBtn'); assert.equal(await host.evaluate(() => pxPerSec), 120);
        await host.evaluate(() => timelineContainer.dispatchEvent(new WheelEvent('wheel', { metaKey: true, deltaY: -100, cancelable: true })));
        assert.equal(await host.evaluate(() => pxPerSec), 120);
        await host.evaluate(() => { setTimelineZoom(NaN); setTimelineZoom(Infinity); setTimelineZoom(-100); });
        assert.ok(await host.evaluate(() => Number.isFinite(pxPerSec) && pxPerSec >= timelineZoomMinimum()));
      }
    }
    await host.evaluate(() => fitTimeline()); await host.setViewport({ width: 1024, height: 768 });
    await waitFor(host, () => timeline.scrollWidth <= timelineContainer.clientWidth + 1);
    assert.ok(await host.evaluate(() => pxPerSec / ZOOM_DEFAULT * 100 < 1));
    await host.evaluate(() => { document.documentElement.style.setProperty('--lobby-w', '350px'); document.documentElement.style.setProperty('--inspector-w', '450px'); });
    await waitFor(host, () => timeline.scrollWidth <= timelineContainer.clientWidth + 1);
    await host.evaluate(() => localStorage.setItem('dubline_zoom', '99999'));
    await host.reload(); await waitFor(host, () => session?.loaded);
    assert.ok(await host.evaluate(() => pxPerSec <= 120 && pxPerSec >= timelineZoomMinimum()));
    await loadFixture(host); assert.ok(await host.evaluate(() => pxPerSec <= 120 && pxPerSec >= timelineZoomMinimum()));
  });
  test('jump availability follows real cursor packets and expiry without rebuilding cards', async () => {
    const other = await guest('Guest'); await waitFor(host, () => DublineCursorPresence.stats().actors === 1);
    const selector = '[data-jump-collaborator="Guest"]';
    assert.equal(await host.$eval(selector, button => button.disabled), true);
    await host.evaluate(() => { window.jumpButton = document.querySelector('[data-jump-collaborator="Guest"]'); });
    await other.evaluate(() => DublineCursorPresence.publish({ active: true, time: 9, rowType: 'role', rowKey: 'Hero', relativeY: .5 }));
    await waitFor(host, () => !document.querySelector('[data-jump-collaborator="Guest"]').disabled);
    assert.equal(await host.evaluate(() => jumpToCollaborator('Guest')), true);
    await waitFor(host, () => document.querySelector('[data-jump-collaborator="Guest"]').disabled, 4000);
    assert.equal(await host.evaluate(() => jumpToCollaborator('Guest')), false);
    assert.equal(await host.evaluate(() => jumpButton === document.querySelector('[data-jump-collaborator="Guest"]')), true);
    await other.evaluate(() => DublineCursorPresence.publish({ active: true, time: 4, rowType: 'role', rowKey: 'Hero', relativeY: .5 }));
    await waitFor(host, () => !document.querySelector('[data-jump-collaborator="Guest"]').disabled);
    await other.evaluate(() => socket.disconnect()); await waitFor(host, () => !document.querySelector('[data-jump-collaborator="Guest"]'));
  });
  test('role progress follows actual recording, replacement, reassignment and deletion for a second participant', async () => {
    const other = await guest('Guest');
    const counts = page => page.$$eval('.track-row[data-character]', rows => Object.fromEntries(rows.map(row => [row.dataset.character, row.querySelector('.role-progress-count').textContent])));
    await host.evaluate(async () => { await queueEditorRequest(() => ['editor_add_track', { character: 'Empty' }]); });
    assert.deepEqual(await counts(host), { Hero: '0 / 2', Friend: '0 / 2', Empty: '0 / 0' });
    await host.evaluate(() => setStudioMode('dub')); await waitFor(host, () => session.mode === 'dub');
    await claimAndSelect(host, 1); await recordTake(host, 1); await waitFor(other, () => session.lines.find(line => line.id === 1)?.audioUrl);
    assert.equal((await counts(other)).Hero, '1 / 1');
    await recordTake(host, 1); assert.equal((await counts(host)).Hero, '1 / 1');
    const labels = await host.$$eval('.track-row[data-character] .track-label-inner', nodes => nodes.map(node => ({ role: node.closest('.track-row').dataset.character, content: node.scrollHeight, height: node.closest('.track-row').clientHeight })));
    assert.ok(labels.every(label => label.content <= label.height), `progress and role controls fit their existing row height: ${JSON.stringify(labels)}`);
    await host.evaluate(() => setStudioMode('edit')); await waitFor(host, () => session.mode === 'edit');
    await host.evaluate(() => updateEditorLine(session.lines.find(line => line.id === 1), { character: 'Empty' }));
    await waitFor(other, () => session.lines.find(line => line.id === 1).character === 'Empty');
    assert.equal((await counts(other)).Empty, '1 / 0');
    await host.evaluate(async () => {
      const line = session.lines.find(line => line.id === 1);
      await new Promise(resolve => socket.emit('set_needs_retake', { sessionId: session.activeSessionId, lineId: 1, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0, value: true }, resolve));
    });
    await waitFor(other, () => session.lines.find(line => line.id === 1).needsRetake);
    assert.equal((await counts(other)).Empty, '1 / 0', 'retake readiness agrees with scene progress');
    await host.evaluate(() => updateEditorLine(session.lines.find(line => line.id === 1), { character: 'Friend' }));
    await waitFor(other, () => session.lines.find(line => line.id === 1).character === 'Friend');
    assert.deepEqual(await counts(other), { Hero: '0 / 1', Friend: '1 / 2', Empty: '0 / 0' });
    await host.evaluate(() => { deleteLineAudio(1); }); await confirm(); await waitFor(other, () => !session.lines.find(line => line.id === 1).audioUrl);
    assert.equal((await counts(other)).Friend, '0 / 3');
    await host.evaluate(() => { deleteEditorLines([2]); }); await confirm(); await waitFor(other, () => !session.lines.some(line => line.id === 2));
    assert.equal((await counts(other)).Friend, '0 / 2');
    await host.evaluate(() => createEditorLineAt('Empty', 1)); await waitFor(other, () => session.lines.some(line => line.character === 'Empty'));
    assert.equal((await counts(other)).Empty, '0 / 1');
  });
  test('single and bulk character pickers follow all themes and retain keyboard assignment', async () => {
    await host.evaluate(() => selectLine(session.lines[0]));
    for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) {
      await host.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await host.$eval('[data-editor-field="character"]', node => getComputedStyle(node).colorScheme), theme === 'light' ? 'light' : 'dark');
    }
    await host.evaluate(() => { document.documentElement.dataset.theme = 'light'; multiSelection.clear(); multiSelection.add(1); multiSelection.add(3); refreshMultiSelection(); });
    assert.equal(await host.$eval('#multiCharInput', node => getComputedStyle(node).colorScheme), 'light');
    await host.type('#multiCharInput', 'Friend'); await host.keyboard.press('Enter');
    await waitFor(host, () => !editorQueue.length && session.lines.filter(line => line.character === 'Friend').length === 4);
    const destination = path.join(__dirname, '..', 'audit', 'editor-improvements', 'group-visual'); fs.mkdirSync(destination, { recursive: true });
    for (const language of ['ru', 'en', 'uk']) for (const theme of ['light', 'graphite']) {
      await host.evaluate((language, theme) => { i18n.setLanguage(language); document.documentElement.dataset.theme = theme; }, language, theme);
      await host.screenshot({ path: path.join(destination, `${theme}-${language}.png`) });
    }
  });
});
