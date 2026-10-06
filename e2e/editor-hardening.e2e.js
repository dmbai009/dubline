const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, wait } = require('./helpers');

describe('Collaborative editor hardening', { skip: skipReason }, () => {
  let server, browser, page, serial = 0;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => {
    page = await openPlayer(browser, server.url(`hardening-${++serial}`), 'Alice', { autoConfirm: false, audioExpanded: false });
    await loadFixture(page);
    await page.evaluate(() => setStudioMode('edit'));
    await waitFor(page, () => session.mode === 'edit');
  });
  afterEach(async () => { await page?.browserContext().close(); });
  async function collaborator(nick = 'Bob') {
    const room = await page.evaluate(() => currentRoom);
    const other = await openPlayer(browser, server.url(room), nick, { autoConfirm: false, audioExpanded: false });
    await waitFor(other, () => session?.loaded && session.mode === 'edit');
    await page.bringToFront();
    return other;
  }
  async function point(id = 1) {
    await page.$eval(`#line-block-${id}`, block => block.scrollIntoView({ block: 'center', inline: 'nearest' }));
    return page.$eval(`#line-block-${id}`, block => { const box = block.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
  }
  const move = (other, id, changes) => other.evaluate((id, changes) => updateEditorLine(session.lines.find(line => line.id === id), changes), id, changes);
  const resetEvent = selector => page.$eval(selector, input => input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));

  test('lost acknowledgement of A preserves queued B/C/D and never reapplies A', async () => {
    await page.evaluate(() => {
      const emit = socket.emit;
      let lose = true;
      socket.emit = function(event, ...args) {
        if (event === 'editor_update_line' && lose) {
          lose = false;
          const callback = args.pop();
          args.push(() => callback(new Error('Injected lost ACK')));
        }
        return emit.call(this, event, ...args);
      };
      window.editResults = null;
      Promise.all(['A', 'B', 'C', 'D'].map(caption => updateEditorLine(session.lines.find(l => l.id === 1), { caption })))
        .then(results => { window.editResults = results; });
    });
    await waitFor(page, () => !!window.editResults, 20000);
    assert.deepEqual(await page.evaluate(() => editResults.map(r => r.ok)), [true, true, true, true]);
    const state = await page.evaluate(() => new Promise(resolve => socket.emit('editor_resync', {}, r => resolve(r.session.lines.find(l => l.id === 1)))));
    assert.equal(state.caption, 'D');
    assert.equal(state.revision, 4);
    assert.deepEqual(page.errors, []);
  });

  test('offline edits remain visible and pending, reconnect resyncs before delivering them', async () => {
    await page.evaluate(() => {
      socket.disconnect(); window.offlineResult = null;
      updateEditorLine(session.lines.find(line => line.id === 1), { caption: 'Offline intent' }).then(result => { window.offlineResult = result; });
    });
    assert.equal(await page.evaluate(() => session.lines[0].caption), 'Offline intent');
    assert.equal(await page.evaluate(() => editorQueue.length), 1);
    assert.match(await page.$eval('#editorSyncState', button => button.textContent), /Syncing/);
    await page.evaluate(() => socket.connect());
    await waitFor(page, () => window.offlineResult?.ok && !editorQueue.length);
    assert.equal(await page.evaluate(() => session.lines[0].caption), 'Offline intent');
    assert.equal(await page.evaluate(() => session.lines[0].revision), 1);
  });

  test('authoritative A and replacement take update cannot erase newer optimistic B/C', async () => {
    await page.evaluate(() => {
      const emit = socket.emit;
      let held = false;
      socket.emit = function(event, ...args) {
        if (event === 'editor_update_line' && !held) {
          held = true; const callback = args.pop(); args.push((...reply) => { window.releaseFirstAck = () => callback(...reply); });
        }
        return emit.call(this, event, ...args);
      };
      window.optimisticResults = null;
      Promise.all(['A', 'B', 'C'].map(caption => updateEditorLine(session.lines.find(line => line.id === 1), { caption }))).then(results => { window.optimisticResults = results; });
    });
    await waitFor(page, () => typeof releaseFirstAck === 'function');
    assert.equal(await page.evaluate(() => session.lines[0].caption), 'C');
    assert.equal(await page.$eval('#line-block-1', block => block.textContent.includes('C')), true);
    await page.evaluate(() => applyTakeUpdates([{ ...editorAuthoritative.get(1), volume: 0.7 }]));
    assert.equal(await page.evaluate(() => session.lines[0].caption), 'C');
    await page.evaluate(() => releaseFirstAck());
    await waitFor(page, () => window.optimisticResults?.every(result => result.ok));
    assert.equal(await page.evaluate(() => session.lines[0].caption), 'C');
  });

  test('real same-field conflict retains intent and Keep mine requires an explicit new operation', async () => {
    const bob = await collaborator();
    try {
      await page.evaluate(() => {
        const emit = socket.emit;
        socket.emit = function(event, ...args) {
          if (event === 'editor_update_line') { window.releaseLocalRequest = () => emit.call(this, event, ...args); return this; }
          return emit.call(this, event, ...args);
        };
        updateEditorLine(session.lines[0], { caption: 'Mine pending' });
      });
      await waitFor(page, () => typeof releaseLocalRequest === 'function');
      assert.equal((await move(bob, 1, { caption: 'Bob saved' })).ok, true);
      await page.evaluate(() => releaseLocalRequest());
      await waitFor(page, () => editorConflicts.length === 1 && !editorQueue.length);
      assert.equal(await page.evaluate(() => session.lines[0].caption), 'Bob saved');
      await page.click('#editorSyncState');
      assert.match(await page.$eval('#editorConflictPanel', panel => panel.textContent), /Mine pending/);
      await page.evaluate(() => { socket.emit = Object.getPrototypeOf(socket).emit; });
      await page.click('[data-retry-operation]');
      await waitFor(bob, () => session.lines[0].caption === 'Mine pending');
      assert.equal(await page.evaluate(() => editorConflicts.length), 0);
    } finally { await bob.browserContext().close(); }
  });

  test('keyboard burst coalesces to one Undo operation with immediate motion', async () => {
    const initial = await page.evaluate(() => {
      selectLine(session.lines[0]);
      for (let i = 0; i < 12; i++) handleEditorKey({ code: 'ArrowRight', preventDefault() {} });
      return { start: session.lines.find(line => line.id === 1).start, queued: editorQueue.length };
    });
    assert.equal(initial.start, 4.2); assert.equal(initial.queued, 1);
    await waitFor(page, () => !editorQueue.length);
    assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 1).revision), 1);
    assert.equal((await page.evaluate(() => editorUndo())).undone, 1);
    assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 1).start), 3);
  });

  test('unrelated remote edits preserve active drag DOM and gestures finish against captured state', async () => {
    const bob = await collaborator();
    try {
      const origin = await point();
      await page.mouse.move(origin.x, origin.y); await page.mouse.down();
      await page.evaluate(() => { window.dragBlock = document.getElementById('line-block-1'); });
      await page.mouse.move(origin.x + 20, origin.y + 10);
      await move(bob, 2, { caption: 'Unrelated remote edit' });
      await waitFor(page, () => session.lines.find(line => line.id === 2).caption === 'Unrelated remote edit');
      assert.equal(await page.evaluate(() => !!activeEditorGesture && dragBlock.isConnected && dragBlock === document.getElementById('line-block-1')), true);
      await page.mouse.move(origin.x + 35, origin.y + 10); await page.mouse.up();
      await waitFor(page, () => !activeEditorGesture && !editorQueue.length);
      assert.ok(await page.evaluate(() => session.lines.find(line => line.id === 1).start > 3));
      assert.equal(await page.evaluate(() => document.querySelectorAll('.editor-drag-guides,.drop-target,.editor-dragging').length), 0);
    } finally { await bob.browserContext().close(); }
  });

  test('same-line remote edit cancels active drag and preserves the remote work', async () => {
    const bob = await collaborator();
    try {
      const origin = await point();
      await page.mouse.move(origin.x, origin.y); await page.mouse.down(); await page.mouse.move(origin.x + 40, origin.y + 10);
      await move(bob, 1, { start: 3.6, end: 5.1 });
      await waitFor(page, () => !activeEditorGesture);
      await page.mouse.up();
      assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 1).start), 3.6);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.editor-drag-guides,.drop-target,.editor-dragging').length), 0);
    } finally { await bob.browserContext().close(); }
  });

  for (const event of ['pointercancel', 'blur']) test(`${event} removes guides, target, classes and listeners without committing`, async () => {
    const origin = await point();
    await page.mouse.move(origin.x, origin.y); await page.mouse.down(); await page.mouse.move(origin.x + 25, origin.y + 10);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.editor-drag-guides').length), 1);
    await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
    await page.mouse.move(origin.x + 80, origin.y + 20); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => ({ active: !!activeEditorGesture, artifacts: document.querySelectorAll('.editor-drag-guides,.drop-target,.editor-dragging,.axis-locked,.move-blocked').length, start: session.lines.find(line => line.id === 1).start, queue: editorQueue.length })), { active: false, artifacts: 0, start: 3, queue: 0 });
  });

  test('magnet releases and re-engages near origin; guides stay throughout drag', async () => {
    const origin = await point();
    await page.mouse.move(origin.x, origin.y); await page.mouse.down();
    await page.mouse.move(origin.x + 3, origin.y + 20);
    assert.equal(await page.$eval('#line-block-1', block => block.classList.contains('axis-locked')), true);
    await page.mouse.move(origin.x + 40, origin.y + 20);
    assert.equal(await page.$eval('#line-block-1', block => block.classList.contains('axis-locked')), false);
    assert.equal(await page.evaluate(() => !!document.querySelector('.editor-drag-guides')), true);
    await page.mouse.move(origin.x + 4, origin.y + 20);
    assert.equal(await page.$eval('#line-block-1', block => block.classList.contains('axis-locked')), true);
    await page.mouse.up();
    await waitFor(page, () => !editorQueue.length);
    assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 1).start), 3);
    assert.equal(await page.evaluate(() => !!document.querySelector('.editor-drag-guides')), false);
  });

  test('leaving the timeline clears the previously visited role target', async () => {
    const origin = await point();
    const target = await page.$eval('[data-character="Friend"]', row => { const box = row.getBoundingClientRect(); return { x: box.left + 280, y: box.top + 20 }; });
    await page.mouse.move(origin.x, origin.y); await page.mouse.down(); await page.mouse.move(target.x, target.y);
    assert.equal(await page.evaluate(() => !!document.querySelector('.drop-target')), true);
    await page.mouse.move(origin.x, 1);
    assert.equal(await page.evaluate(() => !!document.querySelector('.drop-target')), false);
    await page.mouse.up(); await waitFor(page, () => !editorQueue.length);
    assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 1).character), 'Hero');
  });

  test('three users see stacked selection markers in Edit/Dub, reconnect and clear', async () => {
    const bob = await collaborator(), charlie = await collaborator('Charlie');
    try {
      await page.evaluate(() => { selectLine(session.lines[0]); toggleMultiSelect(2); });
      await bob.evaluate(() => selectLine(session.lines[0]));
      await waitFor(charlie, () => document.querySelectorAll('#line-block-1 .remote-selection-markers span').length === 2);
      assert.deepEqual(await charlie.$$eval('#line-block-1 .remote-selection-markers span', chips => chips.map(chip => chip.textContent).sort()), ['Alice', 'Bob']);
      await page.evaluate(() => setStudioMode('dub'));
      await waitFor(charlie, () => session.mode === 'dub' && document.querySelectorAll('#line-block-1 .remote-selection-markers span').length === 2);
      await bob.evaluate(() => socket.disconnect());
      await waitFor(charlie, () => document.querySelectorAll('#line-block-1 .remote-selection-markers span').length === 1);
      await bob.evaluate(() => socket.connect());
      await waitFor(charlie, () => document.querySelectorAll('#line-block-1 .remote-selection-markers span').length === 2);
      await page.evaluate(() => { clearMultiSelection(); selectedLine = null; publishSelection(); });
      await waitFor(charlie, () => document.querySelectorAll('#line-block-1 .remote-selection-markers span').length === 1 && !document.querySelector('#line-block-2 .remote-selection-markers'));
      assert.deepEqual(charlie.errors, []);
    } finally { await bob.browserContext().close(); await charlie.browserContext().close(); }
  });

  test('delete dialog cannot delete a changed target or another scene; orphan drafts never revive', async () => {
    const bob = await collaborator();
    try {
      await page.evaluate(() => { selectLine(session.lines[0]); window.deleteTask = deleteEditorLines([1]); });
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await move(bob, 1, { caption: 'Changed during confirm' });
      await page.click('#textPromptSave');
      await page.evaluate(() => deleteTask);
      assert.equal(await page.evaluate(() => session.lines.length), 4);
      await page.evaluate(() => { document.getElementById('editorCaption').value = 'Orphan'; document.getElementById('editorCaption').dispatchEvent(new Event('input', { bubbles: true })); });
      await bob.evaluate(() => {
        const line = session.lines.find(line => line.id === 1);
        return queueEditorRequest(() => ['editor_delete_lines', { lines: [{ lineId: 1, revision: line.revision || 0 }] }]);
      });
      await waitFor(page, () => !session.lines.some(line => line.id === 1));
      assert.equal(await page.evaluate(() => editorDrafts.size), 0);
      await bob.evaluate(() => editorUndo());
      await waitFor(page, () => session.lines.some(line => line.id === 1));
      await page.evaluate(() => selectLine(session.lines.find(line => line.id === 1)));
      assert.equal(await page.$eval('#editorCaption', input => input.value), 'Changed during confirm');
    } finally { await bob.browserContext().close(); }
  });

  test('delayed own ACK preserves a subsequent gesture; blur without a gesture preserves DOM', async () => {
    await page.evaluate(() => {
      const emit = socket.emit;
      socket.emit = function(event, ...args) {
        if (event === 'editor_update_line') {
          const callback = args.pop(); args.push((...reply) => { window.releaseGestureAck = () => callback(...reply); });
        }
        return emit.call(this, event, ...args);
      };
      updateEditorLine(session.lines[0], { start: 3.1, end: 4.6 });
    });
    await waitFor(page, () => typeof releaseGestureAck === 'function');
    const origin = await point();
    await page.mouse.move(origin.x, origin.y); await page.mouse.down();
    await page.mouse.move(origin.x + 25, origin.y);
    await page.evaluate(() => releaseGestureAck());
    await waitFor(page, () => editorQueue.length === 0);
    assert.equal(await page.evaluate(() => !!activeEditorGesture), true);
    await page.evaluate(() => window.dispatchEvent(new Event('pointercancel')));
    await page.mouse.up();
    await page.evaluate(() => { window.blurBlock = document.getElementById('line-block-1'); window.dispatchEvent(new Event('blur')); });
    assert.equal(await page.evaluate(() => blurBlock === document.getElementById('line-block-1')), true);
  });

  test('caption-only remote update reuses role blocks and waveform canvases', async () => {
    const bob = await collaborator();
    try {
      await page.evaluate(() => { window.oldBlock = document.getElementById('line-block-1'); window.oldRow = oldBlock.closest('.track-row'); });
      await move(bob, 1, { caption: 'Incremental caption' });
      await waitFor(page, () => session.lines[0].caption === 'Incremental caption');
      assert.equal(await page.evaluate(() => oldBlock === document.getElementById('line-block-1') && oldRow.isConnected), true);
    } finally { await bob.browserContext().close(); }
  });

  test('all personal sliders reset through their canonical handler; dynamic defaults respect ADR and project/monitor mix', async () => {
    const personal = [
      ['settingsMicGain', 150, 100, 'dubline_mic_gain', '1'],
      ['settingsAdrVolume', 20, 100, 'dubline_adr_volume', '1'],
      ['settingsPrompterSize', 30, 20, 'dubline_prompter_size', '20'],
      ['settingsPreRoll', 2.5, 1, 'dubline_pre_roll', '1']
    ];
    for (const [id, from, expected, key, saved] of personal) {
      await page.$eval(`#${id}`, (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, from);
      await resetEvent(`#${id}`);
      assert.deepEqual(await page.evaluate((id, key) => ({ value: Number(document.getElementById(id).value), saved: localStorage.getItem(key) }), id, key), { value: expected, saved });
    }
    await page.evaluate(() => { localStorage.setItem('dubline_adr', 'three'); syncSettingsUi(); });
    await resetEvent('#settingsPreRoll');
    assert.equal(await page.evaluate(() => preRollSeconds), 3);
    await page.evaluate(() => updateProjectAudio('settings', 'autoDuckAmount', 0.75));
    await waitFor(page, () => session.projectAudio.autoDuckAmount === 0.75);
    await resetEvent('#settingsAutoDuckAmount');
    await waitFor(page, () => session.projectAudio.autoDuckAmount === 0.4);
    await page.evaluate(() => { setStudioLocalDuck({ enabled: true, autoDuckAmount: 0.75 }); });
    await resetEvent('#settingsLocalDuckAmount');
    assert.equal(await page.evaluate(() => studioLocalDuck().autoDuckAmount), 0.4);
    await page.evaluate(() => updateProjectAudio('original', 'volume', 0.7));
    await waitFor(page, () => session.projectAudio.original.volume === 0.7);
    await resetEvent('[data-project-channel=original] input[type=range]');
    await waitFor(page, () => session.projectAudio.original.volume === 0);
    await page.evaluate(() => { localStorage.setItem('dubline_audio_collapsed', '0'); renderTimeline(); updateProjectAudio('original', 'volume', 0.6); });
    await waitFor(page, () => session.projectAudio.original.volume === 0.6);
    await page.$eval('[data-studio-mix]', select => { select.value = 'monitor'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.$eval('#volOriginal', input => { input.value = '20'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await resetEvent('#volOriginal');
    assert.equal(await page.$eval('#volOriginal', input => Number(input.value)), 60);
    assert.equal(await page.evaluate(() => session.projectAudio.original.volume), 0.6);
    assert.equal(await page.$$eval('input[type=range]:not(:disabled)', inputs => inputs.every(input => input.dataset.resetValue !== undefined || !!input.dataset.resetResolver)), true);
  });

  test('R auto-claims a free line and records, refuses other ownership and offline starts', async () => {
    const bob = await collaborator();
    try {
      await page.evaluate(() => { setStudioMode('dub'); });
      await waitFor(page, () => session.mode === 'dub');
      await page.evaluate(() => { selectLine(session.lines[0]); document.activeElement.blur(); });
      await page.keyboard.press('r');
      await waitFor(page, () => recordState === 'preparing' && session.lines[0].claimedBy === 'Alice');
      await page.evaluate(() => finishRecording({ discard: true }));
      await bob.evaluate(() => { selectLine(session.lines[0]); return recordSelectedLine(); });
      assert.equal(await bob.evaluate(() => recordState), 'idle');
      await bob.evaluate(() => { socket.disconnect(); return recordSelectedLine(); });
      assert.equal(await bob.evaluate(() => recordState), 'idle');
    } finally { await bob.browserContext().close(); }
  });

  test('two R claim racers start only the winning recorder; a foreign current take needs replacement confirmation', async () => {
    const bob = await collaborator();
    try {
      await page.evaluate(() => setStudioMode('dub')); await waitFor(bob, () => session.mode === 'dub');
      for (const actor of [page, bob]) await actor.evaluate(() => selectLine(session.lines.find(line => line.id === 3)));
      await Promise.all([page.evaluate(() => recordSelectedLine()), bob.evaluate(() => recordSelectedLine())]);
      const states = await Promise.all([page.evaluate(() => recordState), bob.evaluate(() => recordState)]);
      assert.equal(states.filter(state => state === 'preparing').length, 1);
      await Promise.all([page.evaluate(() => finishRecording({ discard: true })), bob.evaluate(() => finishRecording({ discard: true }))]);
      await bob.evaluate(() => claimSingleLine(2));
      await waitFor(bob, () => session.lines.find(line => line.id === 2).claimedBy === 'Bob');
      await bob.evaluate(async () => {
        const context = new OfflineAudioContext(1, 48000, 48000), audio = context.createBuffer(1, 48000, 48000);
        const samples = audio.getChannelData(0); for (let i = 0; i < samples.length; i++) samples[i] = 0.08 * Math.sin(i * 2 * Math.PI * 330 / 48000);
        await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: 2, nick: myName, audioStart: 5, trimStart: 0, trimEnd: 1, blob: new Blob([audioBufferToWav(audio)], { type: 'audio/wav' }), createdAt: Date.now() });
      });
      await waitFor(page, () => !!session.lines.find(line => line.id === 2).audioUrl);
      const oldTake = await page.evaluate(() => session.lines.find(line => line.id === 2).audioUrl);
      await bob.evaluate(() => unclaimSingleLine(2)); await waitFor(page, () => !session.lines.find(line => line.id === 2).claimedBy);
      await page.evaluate(() => { selectLine(session.lines.find(line => line.id === 2)); window.foreignRecord = recordSelectedLine(); });
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await page.click('#textPromptCancel'); await page.evaluate(() => foreignRecord);
      assert.equal(await page.evaluate(() => recordState), 'idle');
      assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 2).claimedBy), null);
      await page.evaluate(() => { window.foreignRecord = recordSelectedLine(); });
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await page.click('#textPromptSave'); await page.evaluate(() => foreignRecord);
      await waitFor(page, () => recordState === 'preparing' && session.lines.find(line => line.id === 2).claimedBy === 'Alice');
      await page.evaluate(() => finishRecording({ discard: true }));
      assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 2).audioUrl), oldTake);
      assert.equal(await page.evaluate(() => session.lines.find(line => line.id === 2).recordedBy), 'Bob');
    } finally { await bob.browserContext().close(); }
  });

  test('scene switch cancels gesture, retains unsent intent, clears drafts/presence and invalidates Delete confirmation', async () => {
    const bob = await collaborator();
    try {
      const origin = await point();
      await page.mouse.move(origin.x, origin.y); await page.mouse.down(); await page.mouse.move(origin.x + 30, origin.y + 15);
      const oldId = await page.evaluate(() => {
        window.oldGestureScene = session.activeSessionId;
        selectLine(session.lines[0]);
        document.getElementById('editorCaption').value = 'Old draft'; document.getElementById('editorCaption').dispatchEvent(new Event('input', { bubbles: true }));
        window.oldDelete = deleteEditorLines([1]);
        return session.activeSessionId;
      });
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await page.evaluate(() => loadSavedPack('test-scene.zip'));
      await waitFor(page, id => session.activeSessionId !== id, 10000, oldId);
      await page.mouse.up();
      await page.click('#textPromptSave'); await page.evaluate(() => oldDelete);
      assert.deepEqual(await page.evaluate(() => ({ active: !!activeEditorGesture, drafts: editorDrafts.size, count: session.lines.length, selected: selectedLine?.id || null })), { active: false, drafts: 0, count: 4, selected: null });
      await waitFor(bob, () => !document.querySelector('.remote-selection-markers'));
      await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit');
      await page.evaluate(() => {
        const emit = socket.emit;
        socket.emit = function(event, ...args) { if (event === 'editor_update_line') { window.releaseOldEdit = () => emit.call(this, event, ...args); return this; } return emit.call(this, event, ...args); };
        updateEditorLine(session.lines[0], { caption: 'Pending in old scene' });
      });
      await waitFor(page, () => typeof releaseOldEdit === 'function');
      const secondId = await page.evaluate(() => session.activeSessionId);
      await page.evaluate(() => loadSavedPack('test-scene.zip'));
      await waitFor(page, id => session.activeSessionId !== id, 10000, secondId);
      await page.evaluate(() => releaseOldEdit());
      assert.equal(await page.evaluate(() => editorQueue.length), 0);
      assert.equal(await page.evaluate(() => editorConflicts.length), 1);
      assert.equal(await page.evaluate(() => session.lines[0].caption), 'Hello there');
    } finally { await bob.browserContext().close(); }
  });

  test('track merge needs confirmation and a changed track invalidates an open rename dialog', async () => {
    const bob = await collaborator();
    try {
      await page.evaluate(() => { window.renameTask = renameCharacterTrack('Hero'); });
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await page.$eval('#textPromptInput', input => { input.value = 'Friend'; });
      await page.click('#textPromptSave');
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open && document.querySelector('dialog.text-prompt').dataset.kind === 'confirm');
      await page.click('#textPromptCancel'); await page.evaluate(() => renameTask);
      assert.deepEqual(await page.evaluate(() => session.trackOrder), ['Hero', 'Friend']);
      await page.evaluate(() => { window.renameTask = renameCharacterTrack('Hero'); });
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await move(bob, 1, { caption: 'Changed during rename' });
      await page.$eval('#textPromptInput', input => { input.value = 'Renamed'; });
      await page.click('#textPromptSave'); await page.evaluate(() => renameTask);
      assert.equal(await page.evaluate(() => session.trackOrder.includes('Renamed')), false);
      await page.evaluate(() => { window.renameTask = renameCharacterTrack('Hero'); });
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await page.$eval('#textPromptInput', input => { input.value = 'Friend'; }); await page.click('#textPromptSave');
      await waitFor(page, () => document.querySelector('dialog.text-prompt').open);
      await page.click('#textPromptSave'); await page.evaluate(() => renameTask);
      await waitFor(page, () => session.trackOrder.length === 1 && session.lines.every(line => line.character === 'Friend'));
      assert.ok((await page.evaluate(() => editorUndo())).undone > 0);
    } finally { await bob.browserContext().close(); }
  });

  test('group preview uses destination row geometry with unequal local role heights and commits relatively', async () => {
    await page.evaluate(() => queueEditorRequest(() => ['editor_add_track', { character: 'Third' }]));
    await page.evaluate(() => {
      for (const [name, height] of [['Hero', 115], ['Friend', 210], ['Third', 130]]) roleHeights[roleHeightKey(name)] = height;
      renderTimeline(); selectLine(session.lines[0]); toggleMultiSelect(2);
    });
    const origin = await point();
    const destination = await page.$eval('[data-character="Friend"]', row => { const box = row.getBoundingClientRect(); return { y: box.top + 20 }; });
    await page.mouse.move(origin.x, origin.y); await page.mouse.down(); await page.mouse.move(origin.x + 2, destination.y);
    const preview = await page.evaluate(() => {
      const second = document.getElementById('line-block-2'), third = document.querySelector('[data-character="Third"]');
      return { actual: second.getBoundingClientRect().top, expected: third.getBoundingClientRect().top + parseFloat(second.style.top), transform: second.style.transform, top: second.style.top, row: second.closest('.track-row').getBoundingClientRect().top, rows: [...document.querySelectorAll('.track-row')].map(row => [row.dataset.character, row.offsetTop, row.getBoundingClientRect().top, row.style.height]), active: !!activeEditorGesture, target: document.querySelector('.drop-target')?.dataset.character, selected: [...multiSelection] };
    });
    assert.ok(Math.abs(preview.actual - preview.expected) < 2, JSON.stringify(preview));
    await page.mouse.up(); await waitFor(page, () => !editorQueue.length);
    assert.deepEqual(await page.evaluate(() => [1, 2].map(id => session.lines.find(line => line.id === id).character)), ['Friend', 'Third']);
  });

  test('stale full snapshots and delayed successful ACKs cannot resurrect a remotely deleted line', async () => {
    const bob = await collaborator();
    try {
      await page.evaluate(() => {
        window.oldSnapshot = structuredClone(session);
        const emit = socket.emit;
        socket.emit = function(event, ...args) {
          if (event === 'editor_update_line') { const ack = args.pop(); args.push((...reply) => { window.releaseDeletedAck = () => ack(...reply); }); }
          return emit.call(this, event, ...args);
        };
        updateEditorLine(session.lines[0], { caption: 'About to be deleted' });
      });
      await waitFor(page, () => typeof releaseDeletedAck === 'function');
      await waitFor(bob, () => session.lines[0].caption === 'About to be deleted');
      await bob.evaluate(() => queueEditorRequest(() => ['editor_delete_lines', { lines: [{ lineId: 1, revision: lineRevision(1) }] }]));
      await waitFor(page, () => !session.lines.some(line => line.id === 1));
      await page.evaluate(() => { applySessionUpdate(oldSnapshot); releaseDeletedAck(); });
      await waitFor(page, () => !editorQueue.length);
      assert.equal(await page.evaluate(() => session.lines.some(line => line.id === 1)), false);
      assert.equal(await page.$('#line-block-1'), null);
    } finally { await bob.browserContext().close(); }
  });

  let longPack = null;
  function buildLongScene() {
    if (longPack) return longPack;
    const videoFile = path.join(server.dirs.data, 'twenty-minutes.mp4');
    const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1:duration=1200', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1200', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '8000', '-b:a', '16k', '-shortest', videoFile], { windowsHide: true, timeout: 60000 });
    assert.equal(result.status, 0, String(result.stderr));
    const zip = new AdmZip(); zip.addLocalFile(videoFile, '', 'dub_video.mp4');
    for (let i = 1; i <= 400; i++) zip.addFile(`${String(i).padStart(3, '0')}.ini`, Buffer.from(`caption=Cue ${i}\ndub_characters=["Role ${i % 5}"]\ndub_timestamps=[${(i - 1) * 3}, ${(i - 1) * 3 + 1.5}]\n`));
    longPack = path.join(server.dirs.packs, 'long-editor-scene.zip'); zip.writeZip(longPack);
    return longPack;
  }
  for (const dpr of [1, 2]) test(`20 minute / 400 clip waveform window skips small-scroll painting at QHD DPR ${dpr}`, async () => {
    buildLongScene();
    await page.setViewport({ width: 2560, height: 1440, deviceScaleFactor: dpr });
    await page.evaluate(() => loadSavedPack('long-editor-scene.zip'));
    await waitFor(page, () => session.lines.length === 400 && video.readyState >= 2, 30000);
    await page.evaluate(() => { localStorage.setItem('dubline_audio_collapsed', '0'); renderTimeline(); });
    await waitFor(page, () => document.querySelector('[data-audio-channel=original] .studio-wave-status').textContent === '', 30000);
    await wait(200);
    const baseline = await page.evaluate(() => {
      window.originalWaveCanvas = document.querySelector('[data-audio-channel=original] canvas');
      return { renders: Number(originalWaveCanvas.dataset.waveRender), width: originalWaveCanvas.width, height: originalWaveCanvas.height, viewport: timelineContainer.clientWidth, roles: sessionCharacters().length };
    });
    assert.equal(baseline.roles, 5); assert.equal(baseline.height, 88 * dpr);
    assert.ok(baseline.width >= baseline.viewport * 2 * dpr);
    for (const left of [40, 80, 120, 180, 240]) await page.evaluate(async left => {
      timelineContainer.scrollLeft = left;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, left);
    assert.equal(await page.evaluate(() => Number(originalWaveCanvas.dataset.waveRender)), baseline.renders);
    await page.evaluate(async () => { timelineContainer.scrollLeft = timelineContainer.clientWidth * 1.7; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.ok(await page.evaluate(() => Number(originalWaveCanvas.dataset.waveRender) > 1));
    assert.equal(await page.evaluate(() => originalWaveCanvas.width), baseline.width);
    const edgeRenders = await page.evaluate(() => Number(originalWaveCanvas.dataset.waveRender));
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await waitFor(page, count => Number(originalWaveCanvas.dataset.waveRender) > count, 5000, edgeRenders);
    const themeRenders = await page.evaluate(() => Number(originalWaveCanvas.dataset.waveRender));
    await page.evaluate(() => updateProjectAudio('original', 'offset', 0.25));
    await waitFor(page, count => Number(originalWaveCanvas.dataset.waveRender) > count, 5000, themeRenders);
    await page.evaluate(() => zoomTimeline(1.25));
    await waitFor(page, () => document.querySelector('[data-audio-channel=original] canvas') !== originalWaveCanvas);
    const beforeResize = await page.$eval('[data-audio-channel=original] canvas', canvas => canvas.width);
    await page.setViewport({ width: 2300, height: 1400, deviceScaleFactor: dpr === 1 ? 2 : 1 });
    await waitFor(page, old => document.querySelector('[data-audio-channel=original] canvas').width !== old, 5000, beforeResize);
    await page.evaluate(() => { localStorage.setItem('dubline_audio_collapsed', '1'); renderTimeline(); });
    assert.equal(await page.$('.studio-audio-row canvas'), null);
    assert.deepEqual(page.errors, []);
  });
});
