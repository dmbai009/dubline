const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), AdmZip = require('adm-zip');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, buildFixturePack } = require('./helpers');

describe('Editor outcomes and durable recovery', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, page, serial = 0; const guests = [];
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => {
    page = await openPlayer(browser, server.url(`outcomes-${++serial}`), 'Host', { autoConfirm: false, audioExpanded: false });
    await loadFixture(page); await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit');
  });
  afterEach(async () => {
    for (const item of [page, ...guests.splice(0)]) { assert.deepEqual(item.errors, []); await item.browserContext().close(); }
  });
  async function guest(nick = 'Guest') {
    const other = await openPlayer(browser, server.url(await page.evaluate(() => currentRoom)), nick, { autoConfirm: false, audioExpanded: false });
    guests.push(other); await waitFor(other, () => session?.loaded && session.mode === 'edit'); return other;
  }
  async function stored() { return page.evaluate(async () => { await editorPersistence; return editorIntentStore.all(); }); }
  async function reload() { await page.reload({ waitUntil: 'networkidle0' }); await waitFor(page, () => session?.loaded && !editorRecoveryLoading && !editorQueue.length); }

  test('empty Undo is a final refusal, leaves no durable conflict and stays absent after reload', async () => {
    const result = await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]).then(editorResult));
    assert.equal(result, false); assert.match(await page.$eval('body', node => node.textContent), /no changes to undo/);
    assert.equal(await page.evaluate(() => editorConflicts.length), 0); assert.deepEqual(await stored(), []);
    await reload(); assert.equal(await page.evaluate(() => editorConflicts.length), 0);
  });
  test('existing tracks, invalid values, missing lines and long captions are not version conflicts', async () => {
    const results = await page.evaluate(async () => {
      const requests = [['editor_add_track', { character: 'Hero' }], ['editor_create_line', { character: 'Hero', start: -5, end: -1, caption: '' }],
        ['editor_update_line', { lineId: 99999, revision: 0, caption: 'Missing' }], ['editor_create_line', { character: 'Hero', start: 1, end: 2, caption: 'x'.repeat(2001) }]];
      const results = []; for (const request of requests) results.push(await queueEditorRequest(() => request)); return results;
    });
    // A nonexistent target is rejected by lease acquisition before the mutation.
    assert.deepEqual(results.map(result => result.reason), ['exists', 'invalid', 'invalid', 'caption']);
    assert.deepEqual(await stored(), []); assert.equal(await page.evaluate(() => editorConflicts.length), 0);
    assert.equal(await page.evaluate(() => session.trackOrder.filter(name => name === 'Hero').length), 1);
    await reload(); assert.equal(await page.evaluate(() => editorConflicts.length), 0);
  });
  test('a real foreign structural lease refuses without a conflict and permits a manual retry after release', async () => {
    const other = await guest();
    await other.evaluate(async () => { window.heldLease = await acquireEditLease([{ type: 'session', key: '*', group: 'structural' }]); });
    const refused = await page.evaluate(() => queueEditorRequest(() => ['editor_add_track', { character: 'Blocked track' }]).then(result => { editorResult(result); return result; }));
    assert.equal(refused.reason, 'locked'); assert.equal(await page.evaluate(() => editorConflicts.length), 0);
    assert.match(await page.$eval('body', node => node.textContent), /temporarily holds this edit/); assert.deepEqual(await stored(), []);
    await other.evaluate(() => releaseEditLease(heldLease));
    await waitFor(page, () => DublineEditLeases.stats().remote === 0);
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_add_track', { character: 'Blocked track' }]))).ok, true);
    await waitFor(other, () => session.trackOrder.includes('Blocked track'));
  });
  test('wrong mode and timing protection refuse with rollback and no persisted conflict', async () => {
    await page.evaluate(() => toggleProtectTimings()); await waitFor(page, () => session.protectTimings);
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_create_line', { character: 'Hero', start: 1, end: 2, caption: '' }]))).reason, 'timingsProtected');
    await page.evaluate(() => setStudioMode('dub')); await waitFor(page, () => session.mode === 'dub');
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_update_line', { lineId: 1, revision: 0, caption: 'Must roll back' }]))).reason, 'mode');
    assert.equal(await page.evaluate(() => session.lines[0].caption), 'Hello there');
    assert.equal(await page.evaluate(() => editorConflicts.length), 0); assert.deepEqual(await stored(), []);
  });
  test('lost ACK is reconciled through an exact receipt without a second creation or extra Undo entry', async () => {
    await page.evaluate(() => {
      const emit = socket.emit; let lose = true; window.sentCreates = []; window.receiptRequests = [];
      socket.emit = function(event, ...args) {
        if (event === 'editor_create_line') {
          sentCreates.push(JSON.stringify(args[0]));
          if (lose) { lose = false; const callback = args.pop(); args.push(() => callback(new Error('Lost ACK'))); }
        }
        if (event === 'editor_operation_status') receiptRequests.push(JSON.stringify(args[0].request));
        return emit.call(this, event, ...args);
      };
      window.created = queueEditorRequest(() => ['editor_create_line', { character: 'Hero', start: 1, end: 2, caption: 'Created once' }]);
    });
    assert.equal((await page.evaluate(() => created)).ok, true);
    const requests = await page.evaluate(() => ({ creates: sentCreates, checks: receiptRequests, count: session.lines.length }));
    assert.equal(requests.creates.length, 1); assert.deepEqual(requests.checks, requests.creates); assert.equal(requests.count, 5);
    assert.equal(await page.evaluate(() => editorConflicts.length), 0); assert.deepEqual(await stored(), []);
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]))).ok, true);
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]))).reason, 'empty');
  });
  test('an applied edit with a lost ACK stays confirmed when the room changes to Dub Mode', async () => {
    await page.evaluate(() => {
      const emit = socket.emit; let hold = true;
      socket.emit = function(event, ...args) {
        if (event === 'editor_update_line' && hold) { hold = false; const callback = args.pop(); args.push(() => { window.releaseModeAck = () => callback(new Error('ACK lost across mode switch')); }); }
        return emit.call(this, event, ...args);
      };
      window.modeResult = updateEditorLine(session.lines[0], { caption: 'Applied before Dub Mode' });
    });
    await waitFor(page, () => !!window.releaseModeAck);
    await page.evaluate(() => socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'dub' }));
    await waitFor(page, () => session.mode === 'dub'); await page.evaluate(() => releaseModeAck());
    assert.equal((await page.evaluate(() => modeResult)).ok, true);
    assert.equal(await page.evaluate(() => editorConflicts.length), 0); assert.deepEqual(await stored(), []);
    assert.equal(await page.evaluate(() => session.lines[0].caption), 'Applied before Dub Mode');
  });
  async function makeConflict() {
    const other = await guest();
    await page.evaluate(() => { socket.disconnect(); updateEditorLine(session.lines[0], { caption: 'My durable caption' }); });
    await other.evaluate(() => updateEditorLine(session.lines[0], { caption: 'Remote caption' }));
    await page.evaluate(() => socket.connect()); await waitFor(page, () => editorConflicts.length === 1 && !editorQueue.length);
    return other;
  }
  test('a true field conflict retains diagnostics and both versions through close/reload; Keep mine is deliberate', async () => {
    const other = await makeConflict();
    assert.deepEqual((await stored()).map(item => [item.status, item.outcome.reason, item.outcome.confirmed, item.sent]), [['conflict', 'conflict', true, true]]);
    await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]));
    await reload(); assert.equal(await page.evaluate(() => editorConflicts.length), 1);
    await page.evaluate(() => reviewEditorConflicts());
    const text = await page.$eval('#editorConflictPanel', node => node.textContent);
    assert.match(text, /My durable caption/); assert.match(text, /Remote caption/); assert.match(text, /Request sent/);
    await page.click('[data-close-editor-conflicts]'); await page.click('#editorSyncState');
    await page.evaluate(() => {
      const transport = socket.io.engine.transport;
      transport.writable = false;
      setTimeout(() => { transport.writable = true; socket.io.engine.flush(); }, 100);
      document.querySelector('[data-retry-operation]').click();
    });
    await waitFor(page, () => !editorConflicts.length && !editorQueue.length && !editorReviewBusy);
    await waitFor(other, () => session.lines[0].caption === 'My durable caption'); assert.deepEqual(await stored(), []);
  });
  test('three participants merge independent text/timing while stale assignments remain atomically protected', async () => {
    const a = await guest('Text'), b = await guest('Timing');
    const stale = await b.evaluate(() => session.lines.slice(0, 2).map(line => ({ lineId: line.id, revision: line.revision || 0 })));
    await a.evaluate(() => updateEditorLine(session.lines[0], { caption: 'Independent text' }));
    const result = await b.evaluate(() => queueEditorRequest(() => ['editor_update_line', { lineId: 1, revision: 0, base: { caption: 'Hello there', start: 3, end: 4.5, character: 'Hero' }, start: 3.2, end: 4.7 }]));
    assert.equal(result.ok, true); await waitFor(page, () => session.lines[0].caption === 'Independent text' && session.lines[0].start === 3.2);
    const assignment = await b.evaluate(lines => queueEditorRequest(() => ['set_lines_character', { lines, character: 'Other role' }]), stale);
    assert.equal(assignment.reason, 'conflict');
    assert.deepEqual(await page.evaluate(() => session.lines.slice(0, 2).map(line => line.character)), ['Hero', 'Friend']);
    await b.evaluate(() => reviewEditorConflicts());
    assert.equal(await b.$('[data-retry-operation]'), null); assert.equal(await b.$('[data-review-all=keep]'), null);
  });
  test('an invalid operation rolls back without losing subsequent independent edits or reconnect state', async () => {
    const other = await guest();
    const results = await page.evaluate(() => Promise.all([
      queueEditorRequest(() => ['editor_update_line', { lineId: 1, revision: 0, start: -1, end: -0.5 }]),
      updateEditorLine(session.lines[1], { caption: 'Independent valid edit' }),
      updateEditorLine(session.lines[0], { caption: 'Valid after refusal' })
    ]));
    assert.deepEqual(results.map(result => result.reason || result.ok), ['invalid', true, true]);
    assert.equal(await page.evaluate(() => editorConflicts.length), 0);
    await page.evaluate(() => { socket.disconnect(); socket.connect(); });
    await waitFor(other, () => session.lines[0].caption === 'Valid after refusal' && session.lines[1].caption === 'Independent valid edit');
    assert.equal(await other.evaluate(() => session.lines[0].start), 3); assert.deepEqual(await stored(), []);
  });
  test('initial IndexedDB failure never sends the mutation, retains a form draft and resumes with the original identity', async () => {
    await page.evaluate(() => {
      selectLine(session.lines[0]); document.getElementById('editorCaption').value = 'Draft on failed disk'; rememberEditorDraft(document.getElementById('editorLineForm'));
      window.savedPut = editorIntentStore.put; editorIntentStore.put = () => Promise.reject(new Error('Disk unavailable'));
      const emit = socket.emit; window.mutationIds = [];
      socket.emit = function(event, ...args) { if (event === 'editor_update_line') mutationIds.push(args[0].operationId); return emit.call(this, event, ...args); };
      window.failedSave = saveEditorLine({ preventDefault() {}, currentTarget: document.getElementById('editorLineForm') }, 1);
    });
    await page.evaluate(() => failedSave);
    assert.equal(await page.$eval('#editorCaption', input => input.value), 'Draft on failed disk');
    assert.equal(await page.evaluate(() => mutationIds.length), 0);
    const id = await page.evaluate(() => editorConflicts[0].id);
    assert.equal(await page.evaluate(() => editorConflicts[0].status), 'recovery');
    assert.match(await page.$eval('#editorSyncState', node => node.textContent), /recovery/);
    await page.evaluate(() => { editorIntentStore.put = savedPut; reviewEditorConflicts(); });
    assert.equal(await page.$('[data-retry-operation]'), null);
    await page.click('[data-check-operation]'); await waitFor(page, () => !editorQueue.length && !editorConflicts.length);
    assert.deepEqual(await page.evaluate(() => mutationIds), [id]); assert.equal(await page.evaluate(() => session.lines[0].caption), 'Draft on failed disk');
  });
  test('failed deletion leaves a terminal tombstone, never a resurrected refusal after reload', async () => {
    await page.evaluate(() => { editorIntentStore.remove = () => Promise.reject(new Error('Delete failed')); });
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]))).reason, 'empty');
    assert.deepEqual((await stored()).map(record => record.status), ['rejected']);
    await reload(); assert.equal(await page.evaluate(() => editorConflicts.length), 0); assert.deepEqual(await stored(), []);
  });
  test('both completion writes failing recover an applied structural operation from its receipt after reload', async () => {
    await page.evaluate(() => {
      const put = editorIntentStore.put; editorIntentStore.put = value => ['confirmed', 'rejected'].includes(value.status) ? Promise.reject(new Error('Terminal write failed')) : put(value);
      editorIntentStore.remove = () => Promise.reject(new Error('Delete failed'));
    });
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_create_line', { character: 'Hero', start: 1, end: 2, caption: 'Recovered applied creation' }]))).ok, true);
    assert.deepEqual((await stored()).map(record => record.status), ['in-flight']);
    await reload(); assert.equal(await page.evaluate(() => session.lines.length), 5); assert.equal(await page.evaluate(() => editorConflicts.length), 0);
    assert.deepEqual(await stored(), []);
    await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]));
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]))).reason, 'empty');
  });
  test('epoch change after an applied creation with a lost ACK retains recovery intent without blind replay', async () => {
    await page.evaluate(() => {
      const emit = socket.emit; window.createCount = 0;
      socket.emit = function(event, ...args) {
        if (event === 'editor_create_line') { createCount++; const callback = args.pop(); args.push(() => { window.releaseLostAck = () => callback(new Error('Lost before restart')); }); }
        return emit.call(this, event, ...args);
      };
      window.pendingCreate = queueEditorRequest(() => ['editor_create_line', { character: 'Hero', start: 1, end: 2, caption: 'Applied before restart' }]);
    });
    await waitFor(page, () => session.lines.length === 5 && !!window.releaseLostAck);
    await server.restart(); await page.evaluate(() => releaseLostAck());
    await waitFor(page, () => socket.connected && !editorQueue.length && editorConflicts.length === 1);
    assert.equal(await page.evaluate(() => createCount), 1); assert.equal(await page.evaluate(() => session.lines.length), 5);
    assert.deepEqual((await stored()).map(record => [record.status, record.outcome.reason]), [['recovery', 'expired']]);
    await reload(); assert.equal(await page.evaluate(() => session.lines.length), 5); assert.equal(await page.evaluate(() => editorConflicts[0].status), 'recovery');
    await page.evaluate(() => reviewEditorConflicts()); assert.equal(await page.$('[data-retry-operation]'), null);
  });
  test('old conflict records without metadata survive as recovery rather than being deleted or replayed blindly', async () => {
    await page.evaluate(async () => {
      const id = crypto.randomUUID();
      await editorIntentStore.put({ id, event: 'editor_undo', payload: {}, request: { sessionId: session.activeSessionId, operationId: id, operationEpoch: 'old-server', operationTime: 1 },
        sessionId: session.activeSessionId, roomId: currentRoom, clientId, status: 'conflict', sent: true, targetBases: [] });
    });
    await reload(); assert.equal(await page.evaluate(() => editorConflicts.length), 1);
    assert.deepEqual((await stored()).map(record => [record.event, record.status]), [['editor_undo', 'recovery']]);
    await page.evaluate(() => reviewEditorConflicts()); assert.equal(await page.$('[data-retry-operation]'), null);
  });
  test('expired caption intent already satisfied by authority completes without replay or a new revision', async () => {
    await page.evaluate(async () => {
      await updateEditorLine(session.lines[0], { caption: 'Already satisfied caption' });
      const id = crypto.randomUUID(), payload = { lineId: 1, revision: 0, caption: 'Already satisfied caption' };
      await editorIntentStore.put({ id, event: 'editor_update_line', payload, request: { ...payload, sessionId: session.activeSessionId, operationId: id, operationEpoch: 'expired-epoch', operationTime: 1 },
        sessionId: session.activeSessionId, roomId: currentRoom, clientId, status: 'in-flight', sent: true, targetBases: [] });
    });
    await reload(); assert.equal(await page.evaluate(() => editorConflicts.length), 0); assert.deepEqual(await stored(), []);
    assert.equal(await page.evaluate(() => session.lines[0].revision), 1);
  });
  test('legacy records with no immutable request remain reviewable and cannot expose a blind retry', async () => {
    await page.evaluate(async () => editorIntentStore.put({ id: crypto.randomUUID(), event: 'editor_undo', sessionId: session.activeSessionId, roomId: currentRoom, clientId, status: 'conflict' }));
    await reload(); assert.equal(await page.evaluate(() => editorConflicts.length), 1);
    await page.evaluate(() => reviewEditorConflicts());
    assert.equal(await page.$('[data-retry-operation]'), null); assert.equal(await page.$('[data-check-operation]'), null);
    assert.equal((await stored())[0].outcome.reason, 'legacy');
  });
  test('a request lost before execution retries the exact original payload and operation ID after receipt inspection', async () => {
    const result = await page.evaluate(async () => {
      const emit = socket.emit; let drop = true; const requests = [], checks = [];
      socket.emit = function(event, ...args) {
        if (event === 'editor_add_track') {
          requests.push(JSON.stringify(args[0]));
          if (drop) { drop = false; args.at(-1)(new Error('Dropped before execution')); return this; }
        }
        if (event === 'editor_operation_status') checks.push(JSON.stringify(args[0].request));
        return emit.call(this, event, ...args);
      };
      const result = await queueEditorRequest(() => ['editor_add_track', { character: 'Retried immutable track' }]);
      return { result, requests, checks };
    });
    assert.equal(result.result.ok, true); assert.equal(result.requests.length, 2); assert.equal(result.requests[0], result.requests[1]);
    assert.deepEqual(result.checks, [result.requests[0]]); assert.equal(await page.evaluate(() => editorConflicts.length), 0);
    await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]));
    assert.equal((await page.evaluate(() => queueEditorRequest(() => ['editor_undo', {}]))).reason, 'empty');
  });
  test('unavailable recovery stops after three attempts and an explicit check resolves the original applied operation', async () => {
    await page.evaluate(() => {
      const emit = socket.emit; window.unavailableResyncs = 0; window.sentMutations = 0; window.networkBlocked = true;
      socket.emit = function(event, ...args) {
        if (event === 'editor_resync' && networkBlocked) { unavailableResyncs++; args.at(-1)(new Error('No resync reply')); return this; }
        if (event === 'editor_add_track') { sentMutations++; const callback = args.pop(); args.push(() => callback(new Error('Lost result'))); }
        return emit.call(this, event, ...args);
      };
      window.unconfirmed = queueEditorRequest(() => ['editor_add_track', { character: 'Pending recovery check' }]);
    });
    await page.evaluate(() => unconfirmed); await waitFor(page, () => !editorQueue.length && editorConflicts.length === 1);
    assert.equal(await page.evaluate(() => editorConflicts[0].status), 'recovery');
    assert.ok(await page.evaluate(() => unavailableResyncs <= 3)); assert.equal(await page.evaluate(() => sentMutations), 1);
    await page.evaluate(() => { networkBlocked = false; reviewEditorConflicts(); });
    assert.equal(await page.$('[data-retry-operation]'), null);
    await page.click('[data-check-operation]'); await waitFor(page, () => !editorConflicts.length && !editorQueue.length);
    assert.equal(await page.evaluate(() => sentMutations), 1); assert.deepEqual(await stored(), []);
  });
  test('legacy false conflicts are removed only after a server receipt proves the ordinary refusal', async () => {
    await page.evaluate(async () => {
      const id = crypto.randomUUID(), request = { sessionId: session.activeSessionId, operationId: id, operationEpoch: session.editorProtocol.epoch, operationTime: session.editorProtocol.serverTime };
      const result = await new Promise(resolve => socket.emit('editor_undo', request, resolve));
      if (result.reason !== 'empty') throw Error(JSON.stringify(result));
      await editorIntentStore.put({ id, event: 'editor_undo', payload: {}, request, sessionId: session.activeSessionId, roomId: currentRoom, clientId, status: 'conflict', sent: true, targetBases: [] });
    });
    await reload(); assert.equal(await page.evaluate(() => editorConflicts.length), 0); assert.deepEqual(await stored(), []);
  });
  test('partial Keep all retains a refused replacement with its cause and permits an explicit save after lease release', async () => {
    const other = await guest();
    await page.evaluate(() => { socket.disconnect(); for (const line of session.lines.slice(0, 2)) updateEditorLine(line, { caption: 'My caption ' + line.id }); });
    await other.evaluate(async () => { for (const line of session.lines.slice(0, 2)) await updateEditorLine(line, { caption: 'Remote caption ' + line.id }); });
    await page.evaluate(() => socket.connect()); await waitFor(page, () => editorConflicts.length === 2 && !editorQueue.length);
    await other.evaluate(async () => { window.heldLease = await acquireEditLease([{ type: 'line', key: 2, group: 'caption' }]); });
    await page.evaluate(() => reviewEditorConflicts()); await page.click('[data-review-all=keep]'); await waitFor(page, () => !editorReviewBusy && !editorQueue.length);
    assert.equal(await page.evaluate(() => editorConflicts.length), 1);
    assert.deepEqual((await stored()).map(record => [record.status, record.outcome.reason, record.outcome.confirmed]), [['recovery', 'locked', true]]);
    assert.match(await page.$eval('#editorConflictPanel', node => node.textContent), /Applied: 1. Rejected: 1/);
    assert.equal(await page.$eval('[data-retry-operation]', node => node.textContent), 'Retry saving');
    await other.evaluate(() => updateEditorLine(session.lines[1], { caption: 'Changed while save was refused' }));
    await other.evaluate(() => releaseEditLease(heldLease)); await waitFor(page, () => DublineEditLeases.stats().remote === 0);
    await page.click('[data-retry-operation]'); await waitFor(page, () => !editorReviewBusy && !editorQueue.length && editorConflicts.length === 1);
    assert.equal(await page.evaluate(() => editorConflicts[0].status), 'conflict');
    assert.equal(await page.evaluate(() => session.lines[1].caption), 'Changed while save was refused');
    assert.equal(await page.$eval('[data-retry-operation]', node => node.textContent), 'Keep my version');
    await page.click('[data-retry-operation]'); await waitFor(page, () => !editorReviewBusy && !editorConflicts.length && !editorQueue.length);
    await waitFor(other, () => session.lines[1].caption === 'My caption 2'); assert.deepEqual(await stored(), []);
  });
  test('three participants drain 120 concurrent edits in a 400-cue scene without false conflicts or timing/media changes', async () => {
    const zip = new AdmZip(buildFixturePack());
    for (const entry of zip.getEntries()) if (/\.(ini|wav|mp3)$/.test(entry.entryName)) zip.deleteFile(entry.entryName);
    for (let id = 1; id <= 400; id++) zip.addFile(`${String(id).padStart(3, '0')}.ini`, Buffer.from(`caption = Cue ${id}\ndub_characters = ["Role ${Math.floor((id - 1) / 20)}"]\ndub_timestamps = [${(id - 1) * .025}, ${id * .025}]\n`));
    const file = path.join(server.dirs.packs, 'outcomes400.zip'); zip.writeZip(file); assert.ok(fs.existsSync(file));
    await page.evaluate(() => loadSavedPack('outcomes400.zip')); await waitFor(page, () => session.lines.length === 400);
    await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit');
    const a = await guest('Actor A'), b = await guest('Actor B');
    const original = await page.evaluate(() => session.lines.map(({ id, start, end, character, audioUrl, originalAudioUrl }) => ({ id, start, end, character, audioUrl, originalAudioUrl })));
    const results = await Promise.all([page, a, b].map((client, actor) => client.evaluate(actor => Promise.all(session.lines.slice(actor * 140, actor * 140 + 40).map(line => updateEditorLine(line, { caption: `Actor ${actor}: ${line.id}` }))), actor)));
    assert.ok(results.flat().every(result => result.ok));
    for (const client of [page, a, b]) {
      await waitFor(client, () => !editorQueue.length && session.lines.filter(line => line.caption.startsWith('Actor ')).length === 120);
      assert.equal(await client.evaluate(() => editorConflicts.length), 0);
      assert.deepEqual(await client.evaluate(() => session.lines.map(({ id, start, end, character, audioUrl, originalAudioUrl }) => ({ id, start, end, character, audioUrl, originalAudioUrl }))), original);
      assert.equal(await client.evaluate(async () => { await editorPersistence; return (await editorIntentStore.all()).length; }), 0);
    }
  });
  test('recovery explanations exist in RU/UK/EN across all themes and 150 percent interface scale', async () => {
    await makeConflict(); await page.evaluate(() => reviewEditorConflicts());
    await page.setViewport({ width: 1024, height: 768 });
    await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
    const screenshots = path.join(__dirname, '..', 'audit', 'editor-improvements', 'conflict-review'); fs.mkdirSync(screenshots, { recursive: true });
    for (const language of ['ru', 'uk', 'en']) {
      await page.evaluate(language => DublineI18n.setLanguage(language), language);
      for (const theme of ['graphite', 'light', 'midnight', 'forest', 'ocean', 'sunset']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; renderEditorConflicts(); }, theme);
        assert.equal(await page.$eval('#editorConflictPanel', node => node.scrollWidth <= node.clientWidth), true);
        const contrasts = await page.evaluate(() => {
          showToast(editorFailureMessage('conflict'));
          const luminance = color => {
            const values = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
            return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
          };
          return ['#editorConflictPanel', '.toast'].map(selector => {
            const style = getComputedStyle(document.querySelector(selector)), a = luminance(style.color), b = luminance(style.backgroundColor);
            return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          });
        });
        assert.ok(contrasts.every(ratio => ratio >= 4.5), `${language}/${theme}: explanation contrast ${contrasts}`);
        if (['light', 'graphite'].includes(theme)) await page.screenshot({ path: path.join(screenshots, `${language}-${theme}.png`) });
      }
      assert.equal(await page.evaluate(() => [...DublineI18n.missing].some(key => key.startsWith('editor.'))), false);
    }
  });
});
