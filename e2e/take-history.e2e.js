const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { readProject } = require('../src/server/projects');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('./helpers');
describe('take history: real uploads, sockets, inspector and portable projects', { skip: skipReason, timeout: 180000 }, () => {
  let server, browser, host, moderator, stranger;
  const read = (page = host, id = 1) => page.evaluate(id => structuredClone(session.lines.find(line => line.id === id)), id);
  const state = page => page.evaluate(() => structuredClone(session));
  async function update(page, action, takeId, extra = {}, id = 1) {
    return page.evaluate((action, takeId, extra, id) => new Promise(resolve => {
      const line = session.lines.find(line => line.id === id);
      socket.emit('take_history_update', { room: currentRoom, sessionId: session.activeSessionId, lineId: id, takeId,
        historyRevision: line.takeHistoryRevision || 0, expectedOwner: getLineOwner(line), action, ...extra }, resolve);
    }), action, takeId, extra, id);
  }
  async function upload(page = host, options = {}) {
    const result = await page.evaluate(async options => {
      const line = session.lines.find(line => line.id === (options.lineId || 1));
      const sequence = options.takeSequence || await reserveTake(line.id, session.activeSessionId);
      const buffer = new OfflineAudioContext(1, 48000, 48000).createBuffer(1, 48000, 48000);
      for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = 0.08 * Math.sin(i * 0.05);
      const form = new FormData();
      const fields = { lineId: line.id, clientId, userName: myName, sessionId: session.activeSessionId, takeSequence: sequence, uploadId: options.uploadId || newUploadId(), audioStart: -0.2, trimStart: 0.1, trimEnd: 0.9, ...options };
      for (const [name, value] of Object.entries(fields)) form.append(name, value);
      form.append('audio', new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), 'take.wav');
      const res = await fetch('/api/upload-line-audio?room=' + encodeURIComponent(currentRoom), { method: 'POST', body: form });
      return { status: res.status, result: await res.json(), uploadId: fields.uploadId, takeSequence: sequence };
    }, options);
    if (result.status === 200) await waitFor(page, (id, url) => session.lines.find(line => line.id === id).audioUrl === url, 10000, options.lineId || 1, result.result.audioUrl);
    return result;
  }
  async function clean() {
    for (const take of (await read()).takeHistory || []) assert.equal((await update(host, 'delete', take.id, { confirmPinned: true })).ok, true);
    const line = await read(); if (line.audioUrl) assert.equal((await update(host, 'delete', line.takeId, { confirmPinned: true })).ok, true);
    await host.evaluate(() => { multiSelection.clear(); selectLine(session.lines[0]); });
  }
  async function waitRevision(page, revision) { await waitFor(page, revision => session.lines[0].takeHistoryRevision >= revision, 10000, revision); }
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('take-history'), 'ActorLongName1234');
    moderator = await openPlayer(browser, server.url('take-history'), 'Moderator');
    stranger = await openPlayer(browser, server.url('take-history'), 'Other');
    await loadFixture(host); await waitFor(moderator, () => session?.loaded); await waitFor(stranger, () => session?.loaded);
    await claimAndSelect(host, 1);
    assert.equal((await host.evaluate(() => new Promise(resolve => socket.emit('host_grant_moderator', { nick: 'Moderator' }, resolve)))).ok, true);
    await waitFor(moderator, () => canModerate());
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('first through fifth recordings archive exactly three previous variants and evict only oldest unpinned file', async () => {
    const ids = [], urls = [];
    for (let n = 0; n < 5; n++) {
      assert.equal((await upload()).status, 200); const line = await read(); ids.push(line.takeId); urls.push(line.audioUrl);
      assert.equal(line.takeHistory.length, Math.min(n, 3)); assert.equal(new Set([line.takeId, ...line.takeHistory.map(take => take.id)]).size, Math.min(n + 1, 4));
    }
    assert.deepEqual((await read()).takeHistory.map(t => t.id), ids.slice(1, 4).reverse());
    assert.equal(fs.existsSync(path.join(server.dirs.uploads, decodeURIComponent(urls[0].slice('/uploads/'.length)))), false);
    assert.equal(fs.readdirSync(server.dirs.uploads).filter(name => name.startsWith('line_')).length, 4);
    const persisted = JSON.parse(fs.readFileSync(path.join(server.dirs.data, 'rooms.json')));
    assert.equal(persisted['take-history'].lines[0].takeHistory.length, 3);
  });
  test('repeat upload and an old evicted upload sequence do not create history twice', async () => {
    const accepted = await upload(), before = await read();
    const retry = await upload(host, { uploadId: accepted.uploadId, takeSequence: accepted.takeSequence });
    assert.equal(retry.result.duplicate, true); assert.deepEqual(await read(), before);
    const late = await upload(host, { uploadId: 'evicted-old-upload', takeSequence: 1 }); assert.equal(late.result.superseded, true); assert.deepEqual(await read(), before);
  });
  test('main actions put one pin between Take and Rerecord, including after inspector redraw', async () => {
    const check = () => host.evaluate(()=>{
      selectLine(session.lines[0]);const buttons=[...inspector.querySelectorAll('.insp-actions.primary button')];
      return buttons.map(button=>button.hasAttribute('data-take-preview')?'take':button.dataset.historyAction||button.id||'other');
    });
    const buttons=await check();assert.deepEqual(buttons.slice(0,3),['take','pin','recBtn']);assert.equal(buttons.filter(action=>action==='pin').length,1);
    const foreign=await moderator.evaluate(()=>{selectLine(session.lines[0]);return [...inspector.querySelectorAll('.insp-actions.primary button')].map(button=>button.hasAttribute('data-take-preview')?'take':button.dataset.historyAction||'other');});
    assert.deepEqual(foreign.slice(0,2),['take','pin']);assert.equal(foreign.filter(action=>action==='delete').length,1);
  });
  test('Take toggles a real source off, cancels a pending start and resets on natural completion', async () => {
    await host.evaluate(()=>{
      window.testTakeSources=[];window.testNativeStart=AudioBufferSourceNode.prototype.start;window.testNativeStop=AudioBufferSourceNode.prototype.stop;
      AudioBufferSourceNode.prototype.start=function(...args){if(this.context instanceof AudioContext)testTakeSources.push({node:this,stopped:false});return testNativeStart.apply(this,args);};
      AudioBufferSourceNode.prototype.stop=function(...args){const entry=testTakeSources.find(entry=>entry.node===this);if(entry)entry.stopped=true;return testNativeStop.apply(this,args);};
    });
    try {
      await host.click('[data-take-preview]');await waitFor(host,()=>testTakeSources.length===1);
      assert.equal(await host.$eval('[data-take-preview]',node=>node.getAttribute('aria-pressed')),'true');
      await host.click('[data-take-preview]');assert.equal(await host.evaluate(()=>testTakeSources[0].stopped),true);
      assert.equal(await host.$eval('[data-take-preview]',node=>node.getAttribute('aria-pressed')),'false');
      const pending=await host.evaluate(async()=>{const before=testTakeSources.length;await Promise.all([previewTake(1),previewTake(1)]);return{added:testTakeSources.length-before,pressed:document.querySelector('[data-take-preview]').getAttribute('aria-pressed')};});
      assert.deepEqual(pending,{added:0,pressed:'false'});
      await host.click('[data-take-preview]');await waitFor(host,()=>testTakeSources.length===2);
      await waitFor(host,()=>document.querySelector('[data-take-preview]').getAttribute('aria-pressed')==='false',3000);
      await host.click('[data-take-preview]');await waitFor(host,()=>testTakeSources.length===3);
      await host.evaluate(()=>playAudio(session.lines[0].originalAudioUrl));
      assert.equal(await host.evaluate(()=>testTakeSources[2].stopped),true);
      assert.equal(await host.$eval('[data-take-preview]',node=>node.getAttribute('aria-pressed')),'false');
    } finally {
      await host.evaluate(()=>{audio.stopPreview();AudioBufferSourceNode.prototype.start=testNativeStart;AudioBufferSourceNode.prototype.stop=testNativeStop;});
    }
  });
  test('main pin moves with the take and oldest pinned history survives replacement', async () => {
    await clean(); await upload(); const old = await read();
    assert.equal((await update(host, 'pin', old.takeId, { value: true })).ok, true);
    for (let n = 0; n < 4; n++) assert.equal((await upload()).status, 200);
    const line = await read(); assert.equal(line.takeHistory.length, 3); assert.ok(line.takeHistory.some(t => t.id === old.takeId && t.pinned));
    assert.ok(fs.existsSync(path.join(server.dirs.uploads, decodeURIComponent(old.audioUrl.slice('/uploads/'.length)))));
  });
  test('three pinned history entries require explicit confirmation; four pinned block even explicit replacement', async () => {
    for (const take of (await read()).takeHistory) assert.equal((await update(host, 'pin', take.id, { value: true })).ok, true);
    const before = await read(), failed = await upload(); assert.equal(failed.status, 409); assert.equal(failed.result.key, 'takeHistory.confirmOverwriteRequired'); assert.equal((await read()).audioUrl, before.audioUrl);
    assert.equal((await upload(host, { discardCurrentId: before.takeId, historyRevision: before.takeHistoryRevision })).status, 200);
    const current = await read(); assert.deepEqual(current.takeHistory, before.takeHistory);
    await update(host, 'pin', current.takeId, { value: true });
    const full = await upload(host, { discardCurrentId: current.takeId, historyRevision: (await read()).takeHistoryRevision }); assert.equal(full.status, 409); assert.equal(full.result.key, 'takeHistory.full');
  });
  test('inspector blocks microphone acquisition with four protected takes and displays overwrite warning only when needed', async () => {
    const before = await host.evaluate(async () => { const capture = DublineAudioDevices.capture; let calls = 0; DublineAudioDevices.capture = () => { calls++; return Promise.reject(Error('must not capture')); }; try { await handleStudioRecord(1); } finally { DublineAudioDevices.capture = capture; } return calls; });
    assert.equal(before, 0); assert.match(await host.$eval('#toast', el => el.textContent), /history is full/i);
    const main = await read(); await update(host, 'pin', main.takeId, { value: false });
    const consent = await host.evaluate(() => DublineTakeHistory.beforeRecord(session.lines[0])); assert.equal(consent.discardCurrentId, main.takeId); assert.ok(host.dialogs.some(text => /not be saved in history/.test(text)));
  });
  test('host/moderator/owner rights are server checked; unrelated actor cannot pin/delete/restore or spoof room/scene', async () => {
    let l = await read(); await waitRevision(moderator, l.takeHistoryRevision); await waitRevision(stranger, l.takeHistoryRevision);
    for (const action of ['pin', 'delete', 'restore']) assert.equal((await update(stranger, action, l.takeHistory[0].id, { value: false, confirmPinned: true })).reason, 'takeHistory.permission');
    assert.equal((await update(moderator, 'pin', l.takeHistory[0].id, { value: false })).ok, true);
    l = await read(); assert.equal((await update(host, 'pin', l.takeHistory[0].id, { value: true, room: 'different' })).reason, 'takeHistory.changed');
    assert.equal((await update(host, 'restore', l.takeHistory[0].id, { sessionId: 'old-scene' })).reason, 'session');
  });
  test('simultaneous restores and pin/delete races apply exactly one revision-bound mutation', async () => {
    const line = await read(); await waitRevision(moderator, line.takeHistoryRevision);
    const results = await Promise.all([update(host, 'restore', line.takeHistory[0].id, { historyRevision: line.takeHistoryRevision }), update(moderator, 'restore', line.takeHistory[1].id, { historyRevision: line.takeHistoryRevision })]);
    assert.equal(results.filter(result => result.ok).length, 1); assert.ok(results.some(result => result.reason === 'takeHistory.changed')); assert.equal((await read()).takeHistory.length, 3);
    const next = await read(); await waitRevision(moderator, next.takeHistoryRevision);
    const race = await Promise.all([update(host, 'pin', next.takeHistory[0].id, { value: !next.takeHistory[0].pinned, historyRevision: next.takeHistoryRevision }), update(moderator, 'delete', next.takeHistory[0].id, { confirmPinned: true, historyRevision: next.takeHistoryRevision })]);
    assert.equal(race.filter(result => result.ok).length, 1);
  });
  test('restore activates exact clip properties, preserves all files and clears stale retake without notification', async () => {
    await clean(); await upload();
    const changed = await host.evaluate(() => new Promise(resolve => { const l = session.lines[0]; socket.emit('set_take_props', { sessionId: session.activeSessionId, lineId: 1, audioUrl: l.audioUrl, takeMixRevision: l.takeMixRevision || 0, effect: 'telephone', pitch: 3, volume: 0.63, pan: -0.25, effectAmount: 0.4 }, resolve); })); assert.equal(changed.ok, true);
    const first = await read(); await upload(); const current = await read();
    const note = await host.evaluate(() => new Promise(resolve => { const l = session.lines[0]; socket.emit('set_needs_retake', { sessionId: session.activeSessionId, lineId: 1, audioUrl: l.audioUrl, retakeRevision: l.retakeRevision || 0, value: true, comment: 'old note' }, resolve); })); assert.equal(note.ok, true);
    const filesBefore = fs.readdirSync(server.dirs.uploads).filter(name => name.startsWith('line_')).sort();
    assert.equal((await update(host, 'restore', first.takeId)).ok, true);
    const restored = await read();
    for (const field of ['audioUrl', 'audioStart', 'recordedStart', 'trimStart', 'trimEnd', 'trimEnabled', 'recordedBy', 'effect', 'pitch', 'volume', 'pan', 'effectAmount']) assert.deepEqual(restored[field], first[field]);
    assert.equal(restored.needsRetake, false); assert.equal(restored.retakeComment, ''); assert.equal(restored.takeHistory[0].id, current.takeId);
    assert.deepEqual(fs.readdirSync(server.dirs.uploads).filter(name => name.startsWith('line_')).sort(), filesBefore);
  });
  test('restore invalidates reserved older uploads; recorded Blob remains queued and can be explicitly retried', async () => {
    const sequence = await host.evaluate(() => reserveTake(1, session.activeSessionId)), line = await read();
    await update(host, 'restore', line.takeHistory[0].id);
    const late = await upload(host, { takeSequence: sequence, uploadId: 'late-after-restore' }); assert.equal(late.status, 409); assert.equal(late.result.key, 'takeHistory.changed');
    await host.evaluate(async sequence => { const buffer = new OfflineAudioContext(1, 48000, 48000).createBuffer(1, 48000, 48000); buffer.getChannelData(0).fill(0.05); await submitTake({ uploadId: 'queued-conflict', room: currentRoom, sessionId: session.activeSessionId, lineId: 1, nick: myName, takeSequence: sequence, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now(), audioStart: 0 }); }, sequence);
    assert.equal(await host.evaluate(() => pendingTakes.get('queued-conflict').historyIssue), 'takeHistory.changed'); assert.ok(await host.evaluate(() => pendingTakes.get('queued-conflict').blob.size > 0));
    await host.reload(); await waitFor(host, () => socket.connected && pendingTakes.get('queued-conflict')?.historyIssue === 'takeHistory.changed' && session?.loaded, 15000);
    assert.ok(await host.evaluate(() => pendingTakes.get('queued-conflict').blob.size > 0));
    await host.evaluate(() => retryHistoryTake('queued-conflict')); await waitFor(host, () => !pendingTakes.has('queued-conflict'));
    assert.equal((await read()).uploadId, 'queued-conflict');
  });
  test('pinned deletion requires explicit server confirmation; deleting main preserves history and restore with no main succeeds', async () => {
    const line = await read(); await update(host, 'pin', line.takeId, { value: true });
    assert.equal((await update(host, 'delete', line.takeId)).reason, 'takeHistory.confirmDeleteRequired');
    assert.equal((await update(host, 'delete', line.takeId, { confirmPinned: true })).ok, true);
    const empty = await read(); assert.equal(empty.audioUrl, null); assert.ok(empty.takeHistory.length);
    await host.evaluate(() => selectLine(session.lines.find(line => line.id === 1))); assert.ok(await host.$('.take-history'));
    assert.equal((await update(host, 'restore', empty.takeHistory[0].id)).ok, true);
  });
  test('durable operation retry returns receipt without double restoration and changed payload is refused', async () => {
    const line = await read(), scene = (await state(host)).activeSessionId;
    const request = await host.evaluate(line => ({ room: currentRoom, sessionId: session.activeSessionId, lineId: 1, takeId: line.takeHistory[0].id, action: 'restore', expectedOwner: getLineOwner(line), historyRevision: line.takeHistoryRevision, operationId: 'history-receipt', operationEpoch: session.editorProtocol.epoch, operationTime: session.editorProtocol.serverTime }), line);
    const send = data => host.evaluate(data => new Promise(resolve => socket.emit('take_history_update', data, resolve)), data);
    assert.equal((await send(request)).ok, true); const after = await read(); assert.equal((await send(request)).ok, true); assert.deepEqual(await read(), after);
    assert.equal((await send({ ...request, takeId: after.takeHistory[0].id })).reason, 'operation'); assert.equal((await state(host)).activeSessionId, scene);
  });
  test('snapshot barrier refuses history mutations and leaves recorded files intact', async () => {
    const l = await read(), barrier = await host.evaluate(() => new Promise(resolve => socket.emit('snapshot_request', { purpose: 'project', sessionId: session.activeSessionId }, resolve)));
    assert.equal(barrier.ok, true); assert.equal((await update(host, 'pin', l.takeId, { value: !l.takePinned })).reason, 'snapshot');
    await host.evaluate(token => socket.emit('snapshot_cancel', { token }), barrier.token);
    await waitFor(host, () => !window.snapshotFrozen);
  });
  test('inspector section preserves expansion/focus on metadata updates and adds nothing to timeline', async () => {
    await host.evaluate(() => { selectLine(session.lines[0]); inspector.querySelector('.take-history').open = false; }); await host.click('.take-history summary');
    assert.equal(await host.$eval('.take-history', el => el.open), true);
    const before = await host.$eval('#timelineTracks', el => el.querySelectorAll('.line-block').length).catch(() => host.evaluate(() => document.querySelectorAll('.line-block').length));
    await host.evaluate(() => { const btn = inspector.querySelector('[data-history-action=pin]'); btn.focus(); showInspector(selectedLine); });
    assert.equal(await host.$eval('.take-history', el => el.open), true); assert.equal(await host.evaluate(() => document.activeElement.dataset.historyAction), 'pin');
    const pin = await read(); await host.click(`[data-history-action=pin][data-history-take="${pin.takeId}"]`);
    await waitFor(host, pinned => session.lines[0].takePinned !== pinned && !editorQueue.length && document.activeElement.dataset.historyAction === 'pin', 10000, pin.takePinned);
    assert.equal(await host.evaluate(() => !!document.querySelector('#timeline [data-history-action], .line-block [data-history-action]')), false);
    assert.equal(await host.evaluate(() => document.querySelectorAll('.line-block').length), before);
  });
  test('historical preview plays/stops locally, preserves video clock/main and stops when another line is selected', async () => {
    await host.evaluate(() => { video.pause(); selectLine(session.lines[0]); });
    const before = await read(), clock = await host.evaluate(() => video.currentTime);
    await host.click('.take-history [data-history-action=play]'); await waitFor(host, () => !!inspector.querySelector('[data-history-action=play].active'));
    await host.click('.take-history [data-history-action=play]'); await waitFor(host, () => !inspector.querySelector('[data-history-action=play].active'));
    assert.deepEqual(await read(), before); assert.equal(await host.evaluate(() => video.currentTime), clock);
    await host.click('.take-history [data-history-action=play]'); await host.evaluate(() => selectLine(session.lines[1])); assert.equal(await host.evaluate(() => !!inspector.querySelector('[data-history-action=play].active')), false);
  });
  test('six themes and three languages fit a narrow inspector at 125%/150% with long names', async () => {
    await host.evaluate(() => { selectLine(session.lines[0]); inspector.style.width = '210px'; inspector.style.minWidth = '210px'; inspector.querySelector('.take-history').open = true; });
    for (const theme of ['dark', 'light', 'graphite', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
      await host.evaluate(async (theme, language) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); document.body.style.zoom = '1.5'; }, theme, language);
      assert.equal(await host.$eval('.take-history', el => el.scrollWidth <= el.clientWidth + 1), true, `${theme}/${language}`);
      assert.equal(await host.$eval('.take-history summary', el => /takeHistory\./.test(el.textContent)), false);
    }
    await host.evaluate(() => { document.body.style.zoom = '1.25'; showInspector(selectedLine); }); assert.equal(await host.$eval('.take-history', el => el.scrollWidth <= el.clientWidth + 1), true);
    await host.evaluate(async () => { inspector.style.width = ''; inspector.style.minWidth = ''; document.body.style.zoom = ''; await DublineI18n.setLanguage('en'); });
  });
  test('starting a real recording from historical preview stops it and retains the live record button through Space save', async () => {
    await host.evaluate(() => { preRollSeconds = 0; video.pause(); selectLine(session.lines[0]); inspector.querySelector('.take-history').open = true; });
    const previous = (await read()).audioUrl;
    await host.click('.take-history [data-history-action=play]'); await waitFor(host, () => !!inspector.querySelector('[data-history-action=play].active'));
    await host.click('#recBtn'); await waitFor(host, () => recordState === 'recording');
    assert.equal(await host.$eval('#recBtn', btn => btn.classList.contains('recording-active')), true);
    assert.equal(await host.evaluate(() => !!inspector.querySelector('[data-history-action=play].active')), false);
    await new Promise(resolve => setTimeout(resolve, 300)); await host.evaluate(() => document.activeElement.blur()); await host.keyboard.press('Space');
    await waitFor(host, previous => recordState === 'idle' && !pendingTakes.size && !processingRecordings.size && session.lines[0].audioUrl !== previous, 15000, previous);
    assert.ok((await read()).takeHistory.length <= 3); assert.deepEqual(host.errors, []);
  });
  test('portable format 6 includes history and pins; opening and restart preserve recordings and IDs', async () => {
    let l = await read(); while (l.takeHistory.length < 3) { await upload(); l = await read(); }
    await update(host, 'pin', l.takeId, { value: true }); l = await read();
    const bytes = await host.evaluate(async () => { const sessionId = session.activeSessionId; const barrier = await new Promise(resolve => socket.emit('snapshot_request', { purpose: 'project', sessionId }, resolve)); const res = await fetch('/api/export-project?room=' + encodeURIComponent(currentRoom), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, sessionId, barrierToken: barrier.token, forceSnapshot: true }) }); if (!res.ok) throw Error(await res.text()); return Array.from(new Uint8Array(await res.arrayBuffer())); });
    const archive = readProject(Buffer.from(bytes)); assert.equal(archive.manifest.formatVersion, 6); assert.equal(archive.manifest.project.lines[0].takeHistory.length, 3);
    const result = await host.evaluate(async bytes => { const form = new FormData(); form.append('clientId', clientId); form.append('sessionId', session.activeSessionId); form.append('project', new Blob([new Uint8Array(bytes)]), 'history.dubline'); const res = await fetch('/api/import-project?room=' + encodeURIComponent(currentRoom), { method: 'POST', body: form }); return { status: res.status, body: await res.json() }; }, bytes);
    assert.equal(result.status, 200); await waitFor(host, id => session.lines[0].takeId === id && session.lines[0].takePinned, 15000, l.takeId);
    const opened = await read(); assert.deepEqual(opened.takeHistory.map(t => [t.id, t.pinned]), l.takeHistory.map(t => [t.id, t.pinned]));
    await server.restart(); await waitFor(host, () => socket.connected && !!session?.loaded, 20000); assert.deepEqual((await read()).takeHistory, opened.takeHistory);
  });
  test('page errors remain empty after the complete history workflow', () => { assert.deepEqual(host.errors, []); assert.deepEqual(moderator.errors, []); assert.deepEqual(stranger.errors, []); });
  test('switching scenes keeps histories separate, rejects stale operations and preserves the original variants', async () => {
    const current = await state(host), oldScene = current.sessionList.find(scene => scene.id !== current.activeSessionId);
    assert.ok(oldScene); const saved = await read();
    await host.evaluate(id => socket.emit('host_switch_session', { id }), oldScene.id); await waitFor(host, id => session.activeSessionId === id, 10000, oldScene.id);
    assert.equal((await update(host, 'restore', saved.takeHistory[0].id, { sessionId: current.activeSessionId })).reason, 'session');
    await host.evaluate(id => socket.emit('host_switch_session', { id }), current.activeSessionId); await waitFor(host, id => session.activeSessionId === id, 10000, current.activeSessionId);
    assert.deepEqual((await read()).takeHistory, saved.takeHistory);
  });
  test('Edit trash and Undo retain all variants; permanent purge frees only the purged scene recordings', async () => {
    const saved = await read(), scene = (await state(host)).activeSessionId;
    const paths = [saved.audioUrl, ...saved.takeHistory.map(t => t.audioUrl)].map(url => path.join(server.dirs.uploads, decodeURIComponent(url.slice('/uploads/'.length))));
    await host.evaluate(() => socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'edit' })); await waitFor(host, () => session.mode === 'edit');
    await host.evaluate(() => socket.emit('host_delete_lines', { sessionId: session.activeSessionId, lineIds: [1] })); await waitFor(host, () => !session.lines.some(l => l.id === 1));
    paths.forEach(file => assert.ok(fs.existsSync(file)));
    await host.evaluate(() => socket.emit('host_undo_delete', { sessionId: session.activeSessionId })); await waitFor(host, () => session.lines.some(l => l.id === 1));
    assert.deepEqual((await read()).takeHistory, saved.takeHistory);
    await host.evaluate(() => socket.emit('host_delete_lines', { sessionId: session.activeSessionId, lineIds: [1] })); await waitFor(host, () => !session.lines.some(l => l.id === 1));
    await host.evaluate(() => socket.emit('host_trash_purge', { sessionId: session.activeSessionId, lineIds: [1] }));
    await waitFor(host, () => session.trashCount === 0); await new Promise(resolve => setTimeout(resolve, 1400));
    paths.forEach(file => assert.equal(fs.existsSync(file), false, file));
    assert.equal((await state(host)).activeSessionId, scene);
    const remaining = JSON.parse(fs.readFileSync(path.join(server.dirs.data, 'rooms.json')))['take-history'];
    assert.equal(remaining.sessions[scene].lines.some(l => l.id === 1), false);
  });
  test('deleting the old scene eventually releases all of its historical recordings', async () => {
    const current = await state(host), old = current.sessionList.find(scene => scene.id !== current.activeSessionId);
    const persisted = JSON.parse(fs.readFileSync(path.join(server.dirs.data, 'rooms.json')))['take-history'];
    const line = persisted.sessions[old.id].lines[0], paths = [line.audioUrl, ...line.takeHistory.map(t => t.audioUrl)].map(url => path.join(server.dirs.uploads, decodeURIComponent(url.slice('/uploads/'.length))));
    await host.evaluate(id => socket.emit('host_delete_session', { id }), old.id); await waitFor(host, id => !session.sessionList.some(scene => scene.id === id), 10000, old.id);
    await new Promise(resolve => setTimeout(resolve, 1400)); paths.forEach(file => assert.equal(fs.existsSync(file), false));
  });
  test('parallel actors keep independent bounded histories; audio stems use only main takes and Voxalike keeps one clip per line', async t => {
    await host.evaluate(() => socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'dub' })); await waitFor(stranger, () => session.mode === 'dub');
    const targets = [[host, 3], [moderator, 2], [stranger, 4]];
    for (const [page, id] of targets) await claimAndSelect(page, id);
    const started = performance.now();
    for (let round = 0; round < 6; round++) {
      const results = await Promise.all(targets.map(([page, lineId]) => upload(page, { lineId })));
      results.forEach(result => assert.equal(result.status, 200));
    }
    for (const [page, id] of targets) { const line = await read(page, id); assert.equal(line.takeHistory.length, 3); assert.equal(new Set([line.takeId, ...line.takeHistory.map(t => t.id)]).size, 4); }
    assert.equal(fs.readdirSync(server.dirs.uploads).filter(name => name.startsWith('line_')).length, 12);
    t.diagnostic(`18 real uploads from 3 parallel actors: ${(performance.now() - started).toFixed(0)} ms, 12 referenced files retained.`);
    const own = await read(stranger, 4);
    assert.equal((await update(stranger, 'pin', own.takeHistory[0].id, { value: true }, 4)).ok, true);
    assert.equal((await update(stranger, 'restore', own.takeHistory[0].id, {}, 4)).ok, true);
    assert.equal((await read(stranger, 4)).takeId, own.takeHistory[0].id);
    const stem = await host.evaluate(async () => {
      const original = requireExportTake, urls = [];
      requireExportTake = async line => { urls.push(line.audioUrl); return original(line); };
      try { const buffer = await renderCharacterStem(session.lines, 12); return { urls, peak: Math.max(...buffer.getChannelData(0).subarray(0, 48000)) }; }
      finally { requireExportTake = original; }
    });
    assert.deepEqual(stem.urls.sort(), (await state(host)).lines.map(line => line.audioUrl).sort());
    assert.ok(stem.peak > 0);
    const before = await state(host);
    const exported = await host.evaluate(async () => {
      const barrier = await new Promise(resolve => socket.emit('snapshot_request', { purpose: 'voxalike', sessionId: session.activeSessionId }, resolve));
      const res = await fetch('/api/export-voxalike-pack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, barrierToken: barrier.token, forceSnapshot: true }) });
      if (!res.ok) throw Error(await res.text()); return Array.from(new Uint8Array(await res.arrayBuffer()));
    });
    const zip = new (require('adm-zip'))(Buffer.from(exported));
    assert.equal(zip.getEntries().filter(entry => entry.entryName.endsWith('.ini') && entry.entryName !== '_pack_info.ini').length, 3);
    assert.equal(zip.getEntries().some(entry => /history|line_project_/.test(entry.entryName)), false);
    const after = await state(host); assert.deepEqual(after.lines, before.lines);
    assert.deepEqual(host.errors, []); assert.deepEqual(moderator.errors, []); assert.deepEqual(stranger.errors, []);
  });
});
