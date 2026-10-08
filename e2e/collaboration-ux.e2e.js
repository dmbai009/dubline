const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, wait, claimAndSelect } = require('./helpers');

describe('Collaboration latency and UX', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, page, serial = 0; const guests = [];
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => { page = await openPlayer(browser, server.url(`collaboration-ux-${++serial}`), 'Host', { audioExpanded: false }); await loadFixture(page); await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit'); });
  afterEach(async () => { for (const item of [page, ...guests.splice(0)]) { assert.deepEqual(item.errors, []); await item.browserContext().close(); } });
  async function guest(nick = 'Guest') { const item = await openPlayer(browser, server.url(await page.evaluate(() => currentRoom)), nick, { audioExpanded: false }); guests.push(item); await waitFor(item, () => session?.loaded); await page.bringToFront(); return item; }
  async function delayLease(delay, lose = false) {
    await page.evaluate((delay, lose) => {
      const original = socket.emit; window.dragMutations = 0;
      socket.emit = function(event, ...args) {
        if (event === 'edit_lease_acquire') {
          const callback = args.pop();
          args.push((...values) => setTimeout(() => lose ? callback(new Error('Lost lease ACK')) : callback(...values), delay));
        }
        if (['editor_update_line', 'editor_update_lines'].includes(event)) dragMutations++;
        return original.call(this, event, ...args);
      };
    }, delay, lose);
  }
  async function beginDrag(edge = null, dy = 0) {
    await page.bringToFront();
    const rect = await page.$eval(edge ? `#line-block-1 .line-resize-handle.${edge}` : '#line-block-1', node => { const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
    await page.mouse.move(rect.x, rect.y); await page.mouse.down(); await page.mouse.move(rect.x + 40, rect.y + dy);
    return rect;
  }
  test('disabled slider help preserves its existing label, value handler and full-width seek layout', async () => {
    const result = await page.evaluate(() => {
      const label = document.createElement('label'), input = document.createElement('input'), output = document.createElement('output');
      input.type = 'range'; label.append(input, output); document.getElementById('inspector').append(label);
      input.oninput = () => { input.parentElement.querySelector('output').textContent = input.value; };
      input.disabled = true; setControlHelp(input, 'Temporarily unavailable');
      const sameParent = input.parentElement === label;
      input.disabled = false; setControlHelp(input, ''); input.value = '42'; input.dispatchEvent(new Event('input'));
      const value = output.textContent; label.remove();
      const seek = document.getElementById('transportSeek'); seek.disabled = true; setControlHelp(seek, 'Temporarily unavailable');
      const width = seek.getBoundingClientRect().width, bar = document.querySelector('.studio-transport').getBoundingClientRect().width;
      return { sameParent, value, width, bar };
    });
    assert.equal(result.sameParent, true); assert.equal(result.value, '42');
    assert.ok(result.width >= result.bar - 32, JSON.stringify(result));
    const reasons = await page.evaluate(() => {
      const panel = document.createElement('section'); panel.dataset.takeMix = ''; panel.dataset.pending = 'true';
      const input = document.createElement('input'); input.dataset.clipField = 'pan'; input.disabled = true; panel.append(input); document.getElementById('inspector').append(panel);
      recordState = 'preparing'; refreshStudioTransport(); refreshActionHelp();
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const result = { mix: input.parentElement.dataset.tooltip, transport: document.getElementById('transportSeek').parentElement.dataset.tooltip };
        panel.remove(); recordState = 'idle'; refreshStudioTransport(); refreshActionHelp(); resolve(result);
      })));
    });
    assert.match(reasons.mix, /current operation/); assert.match(reasons.transport, /recording to finish/);
    await page.click('[data-studio-action=fullscreen]'); await waitFor(page, () => document.fullscreenElement?.contains(document.getElementById('dublineTooltip')));
    await page.$eval('#transportSeek', input => { input.disabled = true; setControlHelp(input, 'Temporarily unavailable'); input.parentElement.focus(); });
    await waitFor(page, () => !document.getElementById('dublineTooltip').hidden);
    assert.equal(await page.evaluate(() => document.fullscreenElement.contains(document.getElementById('dublineTooltip'))), true);
    await page.evaluate(() => document.exitFullscreen());
    await waitFor(page, () => !document.fullscreenElement && document.getElementById('dublineTooltip').parentElement === document.body);
  });
  for (const delay of [0, 100, 300, 800, 1500, 3000]) test(`held drag with ${delay}ms lease ACK begins only after permission and uses current pointer`, async () => {
    await delayLease(delay);
    const before = await page.evaluate(() => ({ left: document.getElementById('line-block-1').style.left, start: session.lines.find(line => line.id === 1).start }));
    await beginDrag();
    if (delay >= 800) {
      await waitFor(page, () => !!document.querySelector('.editor-lease-notice'));
      assert.equal(await page.$eval('#line-block-1', node => node.style.left), before.left);
      assert.equal(await page.evaluate(() => dragMutations), 0);
    }
    await waitFor(page, () => document.getElementById('line-block-1').classList.contains('editor-dragging'), delay + 4000);
    assert.equal(await page.$('.editor-lease-notice'), null);
    await page.mouse.up();
    await waitFor(page, () => !activeEditorGesture && !editorQueue.length && session.lines.find(line => line.id === 1).start > 3, delay + 7000);
    assert.equal(await page.evaluate(() => dragMutations), 1);
    await waitFor(page, () => DublineEditLeases.stats().own === 0);
    assert.equal(await page.evaluate(() => editorConflicts.length), 0);
  });
  for (const delay of [100, 300, 800, 1500, 3000]) test(`release before ${delay}ms ACK cancels without late movement or lease`, async () => {
    await delayLease(delay); const before = await page.evaluate(() => JSON.stringify(session.lines));
    await beginDrag(); await page.mouse.up(); await wait(delay + 150);
    assert.equal(await page.evaluate(() => JSON.stringify(session.lines)), before);
    assert.equal(await page.evaluate(() => dragMutations), 0); assert.equal(await page.evaluate(() => editorQueue.length + editorConflicts.length), 0);
    assert.equal(await page.evaluate(() => DublineEditLeases.stats().own), 0);
    assert.equal(await page.$('.editor-lease-notice'), null); assert.equal(await page.evaluate(() => activeEditorGesture), null);
    const other = await guest();
    assert.equal(await other.evaluate(async () => { const result = await acquireEditLease([{ type: 'line', key: 1, group: 'timing' }], { result: true }); releaseEditLease(result.token); return result.ok; }), true);
  });
  test('lost lease ACK cancels the server reservation and leaves no editor operation', async () => {
    await delayLease(3000, true); await beginDrag();
    await waitFor(page, () => !!document.querySelector('.editor-lease-notice'));
    await waitFor(page, () => !activeEditorGesture, 6000); await page.mouse.up();
    assert.equal(await page.evaluate(() => dragMutations + editorQueue.length + editorConflicts.length), 0);
    assert.match(await page.$eval('body', node => node.textContent), /host did not respond/);
    const other = await guest();
    assert.equal(await other.evaluate(async () => { const result = await acquireEditLease([{ type: 'line', key: 1, group: 'timing' }], { result: true }); releaseEditLease(result.token); return result.ok; }), true);
  });
  test('pending drag cancels on pointercancel, blur, mode/protection changes, redraw and disconnect', async () => {
    await delayLease(800);
    for (const kind of ['pointercancel', 'blur', 'protection', 'mode', 'redraw', 'disconnect']) {
      await beginDrag();
      await page.evaluate(kind => {
        if (kind === 'pointercancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
        if (kind === 'blur') window.dispatchEvent(new Event('blur'));
        if (kind === 'protection') toggleProtectTimings();
        if (kind === 'mode') socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'dub' });
        if (kind === 'redraw') renderTimeline();
        if (kind === 'disconnect') socket.disconnect();
      }, kind);
      await page.mouse.up(); await wait(950);
      assert.equal(await page.evaluate(() => dragMutations), 0, kind);
      assert.equal(await page.evaluate(() => activeEditorGesture), null, kind);
      assert.equal(await page.$('.editor-lease-notice'), null, kind);
      await page.evaluate(() => { if (!socket.connected) socket.connect(); });
      await waitFor(page, () => socket.connected && session?.loaded);
      await page.evaluate(() => { if (session.protectTimings) toggleProtectTimings(); if (session.mode !== 'edit') socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'edit' }); });
      await waitFor(page, () => !session.protectTimings && session.mode === 'edit');
    }
  });
  test('delayed resize on both edges and group movement use one authorized operation', async () => {
    await delayLease(800);
    for (const edge of ['start', 'end']) {
      const old = await page.evaluate(() => ({ ...session.lines.find(line => line.id === 1) }));
      await beginDrag(edge); await waitFor(page, () => document.getElementById('line-block-1').classList.contains('editor-dragging'));
      await page.mouse.up(); await waitFor(page, (edge, previous) => !editorQueue.length && !activeEditorGesture && session.lines.find(line => line.id === 1)[edge] !== previous, 5000, edge, old[edge]);
      await page.evaluate(() => editorUndo());
    }
    await page.evaluate(() => { multiSelection.clear(); multiSelection.add(1); multiSelection.add(3); renderTimeline(); });
    await beginDrag(); await waitFor(page, () => document.getElementById('line-block-3').classList.contains('editor-dragging'));
    await page.mouse.up(); await waitFor(page, () => !editorQueue.length && !activeEditorGesture && session.lines.find(line => line.id === 3).start > 7.5, 5000);
    assert.equal(await page.evaluate(() => Number((session.lines.find(line => line.id === 3).start - session.lines.find(line => line.id === 1).start).toFixed(3))), 4.5);
    assert.equal(await page.evaluate(() => dragMutations), 3);
  });
  test('sync indicator distinguishes confirmed, pending, resync, offline and unconfirmed reconnect', async () => {
    await waitFor(page, () => document.getElementById('editorSyncState').dataset.syncState === 'confirmed');
    assert.match(await page.$eval('#editorSyncState', node => node.getAttribute('aria-label')), /All editor operations are confirmed by the host/);
    await page.evaluate(() => {
      const original = socket.emit;
      socket.emit = function(event, ...args) {
        if (event === 'editor_update_line') { const callback = args.pop(); args.push((...values) => { window.releaseEditorAck = () => callback(...values); }); }
        return original.call(this, event, ...args);
      };
      window.pendingEdit = updateEditorLine(session.lines[0], { caption: 'Waiting for host ACK' });
    });
    await waitFor(page, () => !!window.releaseEditorAck);
    assert.equal(await page.$eval('#editorSyncState', node => node.dataset.syncState), 'pending');
    await page.evaluate(() => releaseEditorAck()); await page.evaluate(() => pendingEdit);
    await waitFor(page, () => document.getElementById('editorSyncState').dataset.syncState === 'confirmed');
    await page.evaluate(() => {
      const original = socket.emit;
      socket.emit = function(event, ...args) { if (event === 'editor_resync') { const callback = args.pop(); args.push((...values) => { window.releaseResync = () => callback(...values); }); } return original.call(this, event, ...args); };
      window.syncCheck = resyncEditor();
    });
    await waitFor(page, () => !!window.releaseResync);
    assert.equal(await page.$eval('#editorSyncState', node => node.dataset.syncState), 'syncing');
    await page.evaluate(() => releaseResync()); await page.evaluate(() => syncCheck);
    await page.evaluate(() => socket.disconnect());
    assert.equal(await page.$eval('#editorSyncState', node => node.dataset.syncState), 'offline');
    await page.evaluate(() => {
      const original = socket.emit;
      socket.emit = function(event, ...args) { if (event === 'join_room') { window.releaseJoin = () => original.call(this, event, ...args); return this; } return original.call(this, event, ...args); };
      socket.connect();
    });
    await waitFor(page, () => !!window.releaseJoin);
    assert.equal(await page.$eval('#editorSyncState', node => node.dataset.syncState), 'unknown');
    await page.evaluate(() => releaseJoin());
    await waitFor(page, () => document.getElementById('editorSyncState').dataset.syncState === 'confirmed');
  });
  test('an unreadable recovery journal prevents a false green even after a confirmed operation', async () => {
    await page.evaluate(async () => {
      window.originalJournalRead = editorIntentStore.all;
      editorIntentStore.all = () => Promise.reject(new Error('Journal read failure'));
      restoredEditorRecords = null; await restoreEditorOperations();
    });
    assert.equal(await page.$eval('#editorSyncState', node => node.dataset.syncState), 'storage');
    assert.equal((await page.evaluate(() => updateEditorLine(session.lines[0], { caption: 'Confirmed with unreadable old journal' }))).ok, true);
    assert.equal(await page.$eval('#editorSyncState', node => node.dataset.syncState), 'storage');
    await page.evaluate(async () => { editorIntentStore.all = originalJournalRead; await restoreEditorOperations(); });
    await waitFor(page, () => document.getElementById('editorSyncState').dataset.syncState === 'confirmed');
  });
  test('adding a disabled-action explanation preserves the focused draft and caret', async () => {
    await page.evaluate(() => selectLine(session.lines[0])); await page.focus('#editorCaption');
    await page.evaluate(() => { const input = document.getElementById('editorCaption'); input.value = 'Draft with a caret'; input.setSelectionRange(3, 7); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => socket.disconnect());
    await waitFor(page, () => document.getElementById('editorCaption').readOnly && !!document.getElementById('editorCaption').parentElement.dataset.tooltip);
    assert.deepEqual(await page.$eval('#editorCaption', input => ({ focus: document.activeElement === input, value: input.value, from: input.selectionStart, to: input.selectionEnd })), { focus: true, value: 'Draft with a caret', from: 3, to: 7 });
  });
  test('the record button remains usable to stop the current recording', async () => {
    await page.evaluate(() => setStudioMode('dub')); await waitFor(page, () => session.mode === 'dub'); await claimAndSelect(page, 1);
    await page.click('#recBtn'); await waitFor(page, () => recordState === 'recording'); await wait(300);
    assert.equal(await page.$eval('#recBtn', node => node.disabled), false);
    await page.click('#recBtn'); await waitFor(page, () => recordState === 'idle' && !!session.lines.find(line => line.id === 1).audioUrl, 15000);
  });
  test('data-channel accounting is exact and idempotent, with no Socket.IO/HTTP double-counting', async () => {
    const result = await page.evaluate(() => {
      const before = DublineNetwork.stats().bytes, channel = new EventTarget(); let sends = 0;
      channel.send = () => sends++;
      DublineNetwork.channel(channel); DublineNetwork.channel(channel);
      channel.send(new Uint8Array(65540)); channel.send('я');
      channel.dispatchEvent(new MessageEvent('message', { data: new Uint8Array(4096) }));
      const after = DublineNetwork.stats().bytes;
      return { up: after.up - before.up, down: after.down - before.down, sends };
    });
    assert.deepEqual(result, { up: 65542, down: 4096, sends: 2 });
  });
  test('unsupported HTTP timing does not break measured Socket.IO traffic or uploads', async () => {
    const limited = await openPlayer(browser, server.url(await page.evaluate(() => currentRoom)), 'Limited metrics', { audioExpanded: false, beforeLoad: async page => page.evaluateOnNewDocument(() => { window.PerformanceObserver = class { observe() { throw new Error('Unsupported timing'); } }; }) });
    guests.push(limited);
    await waitFor(limited, () => DublineNetwork.rtt() !== null, 12000);
    assert.equal(await limited.evaluate(() => DublineNetwork.stats().scope), 'observed');
    assert.equal(await limited.evaluate(() => typeof DublineNetwork.upload), 'function');
  });
  test('an editor mutation waits for a busy connected transport instead of dropping and waiting for ACK timeout', async () => {
    const result = await page.evaluate(async () => {
      const original = socket.emit, before = session.lines[0].revision || 0; let held = false, sends = 0, checks = 0;
      socket.emit = function(event, ...args) {
        if (event === 'edit_lease_acquire' && !held) {
          held = true; const callback = args.pop(); args.push((...values) => {
            const transport = socket.io.engine.transport, write = transport.write;
            transport.write = function(packets) { this.write = write; this.writable = false; setTimeout(() => write.call(this, packets), 250); };
            socket.emit('time_sync', Date.now(), () => {});
            callback(...values);
          });
        }
        if (event === 'editor_update_line') sends++;
        if (event === 'editor_operation_status') checks++;
        return original.call(this, event, ...args);
      };
      const started = performance.now(); const result = await updateEditorLine(session.lines[0], { caption: 'Sent after transport drain' });
      return { ok: result.ok, sends, checks, revision: session.lines[0].revision - before, elapsed: performance.now() - started };
    });
    assert.equal(result.ok, true); assert.equal(result.sends, 1); assert.equal(result.checks, 0); assert.equal(result.revision, 1);
    assert.ok(result.elapsed >= 200 && result.elapsed < 3000, JSON.stringify(result));
  });
  test('timing protection and semantic leases have accessible reasons without disabling independent text or assignment', async () => {
    const other = await guest();
    await page.evaluate(() => { selectLine(session.lines[0]); toggleProtectTimings(); });
    await waitFor(page, () => document.getElementById('editorStart')?.disabled && document.getElementById('editorStart').parentElement.dataset.tooltip);
    assert.equal(await page.$eval('#editorCaption', node => node.readOnly || node.disabled), false);
    assert.equal(await page.$eval('#editorCharacter', node => node.disabled), false);
    await page.$eval('#editorStart', node => node.parentElement.focus());
    await waitFor(page, () => !document.getElementById('dublineTooltip').hidden);
    assert.match(await page.$eval('#dublineTooltip', node => node.textContent), /Timings are protected/);
    await page.evaluate(() => toggleProtectTimings()); await waitFor(page, () => !document.getElementById('editorStart').disabled);
    await page.evaluate(() => { const input = document.getElementById('editorCaption'); input.value = 'Local unsaved text'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await other.evaluate(async () => { window.captionLease = await acquireEditLease([{ type: 'line', key: 1, group: 'caption' }]); });
    await waitFor(page, () => document.getElementById('editorCaption').readOnly && !!document.getElementById('editorCaption').parentElement.dataset.tooltip);
    assert.equal(await page.$eval('#editorStart', node => node.disabled || node.readOnly), false);
    assert.equal(await page.$eval('#editorCharacter', node => node.disabled), false);
    assert.match(await page.$eval('#editorCaption', node => node.parentElement.dataset.tooltip), /Another participant/);
    assert.equal(await page.$eval('#editorLineForm .btn-delete', node => node.disabled), true, 'deletion conflicts with a caption lease even though independent timing/assignment remain editable');
    await other.evaluate(() => releaseEditLease(captionLease)); await waitFor(page, () => !document.getElementById('editorCaption').readOnly);
    assert.equal(await page.$eval('#editorCaption', node => node.value), 'Local unsaved text');
    assert.equal(await page.$eval('#editorCaption', node => node.parentElement.hasAttribute('data-tooltip')), false);
    assert.equal(await page.$eval('#editorLineForm .btn-delete', node => node.disabled), false);
    assert.equal(await other.$eval('#editModeBtn', node => node.disabled), true);
    assert.match(await other.$eval('#editModeBtn', node => node.parentElement.dataset.tooltip), /host or a moderator/);
    await page.evaluate(() => socket.emit('host_grant_moderator', { nick: 'Guest' }));
    await waitFor(other, () => !document.getElementById('editModeBtn').disabled);
    assert.equal(await other.$eval('#editModeBtn', node => node.parentElement.hasAttribute('data-tooltip')), false);
    await page.evaluate(() => socket.disconnect()); await waitFor(page, () => document.getElementById('editorCaption').readOnly);
    assert.match(await page.$eval('#editorCaption', node => node.parentElement.dataset.tooltip), /Connection to the host is lost/);
  });
  test('RTT expires when reports stop, cannot cross rooms and resets on reconnect', async () => {
    const other = await guest();
    await waitFor(page, () => document.querySelector('[data-lobby-key="player:Guest"] [data-rtt]').textContent !== '—', 15000);
    await other.evaluate(() => { const original = socket.emit; socket.emit = function(event, ...args) { return event === 'network_telemetry_update' ? this : original.call(this, event, ...args); }; });
    await waitFor(page, () => document.querySelector('[data-lobby-key="player:Guest"] [data-rtt]').textContent === '—', 19000);
    await page.evaluate(() => socket.emitEvent(['network_telemetry', { roomId: 'another-room', players: [{ nick: 'Guest', rtt: 1, up: 1, down: 1, age: 0 }] }]));
    assert.equal(await page.$eval('[data-lobby-key="player:Guest"] [data-rtt]', node => node.textContent), '—');
    await page.evaluate(() => socket.disconnect());
    assert.equal(await page.$eval('[data-lobby-key="player:Host"] [data-rtt]', node => node.textContent), '—');
    await page.evaluate(() => socket.connect()); await waitFor(page, () => document.querySelector('[data-lobby-key="player:Host"] [data-rtt]').textContent !== '—', 15000);
  });
  test('delayed RTT is measured to the room host, remains independent of clock offset and reaches other participants', async () => {
    const other = await guest();
    await other.evaluate(() => {
      const original = socket.emit;
      socket.emit = function(event, ...args) { if (event === 'time_sync') { const callback = args.pop(); args.push((...values) => setTimeout(() => callback(...values), 500)); } return original.call(this, event, ...args); };
      socket.disconnect(); socket.connect();
    });
    await waitFor(page, () => Number(document.querySelector('[data-lobby-key="player:Guest"] [data-rtt]').textContent) >= 450, 12000);
    assert.equal(await page.$eval('[data-lobby-key="player:Guest"] .network-ping', node => node.classList.contains('network-poor')), true);
    const before = await other.evaluate(() => DublineNetwork.rtt());
    await other.evaluate(() => clockOffset += 86400000);
    assert.equal(await other.evaluate(() => DublineNetwork.rtt()), before);
  });
  test('lease cancellation is socket-bound and HTTP LAN can generate acquisition nonces without randomUUID', async () => {
    const other = await guest();
    const id = '12345678-1234-1234-1234-123456789012';
    const result = await page.evaluate(id => new Promise(resolve => socket.timeout(3000).emit('edit_lease_acquire', { sessionId: session.activeSessionId, targets: [{ type: 'line', key: 1, group: 'timing' }], acquisitionId: id }, (error, result) => resolve(result))), id);
    assert.equal(result.ok, true);
    await other.evaluate(id => socket.emit('edit_lease_cancel', { acquisitionId: id }), id);
    const foreign = await other.evaluate(() => acquireEditLease([{ type: 'line', key: 1, group: 'timing' }], { result: true }));
    assert.equal(foreign.reason, 'locked');
    await page.evaluate(id => socket.emit('edit_lease_cancel', { acquisitionId: id }), id);
    await other.evaluate(() => { Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }); });
    const acquired = await other.evaluate(async () => { const result = await acquireEditLease([{ type: 'line', key: 1, group: 'timing' }], { result: true }); releaseEditLease(result.token); return result; });
    assert.equal(acquired.ok, true);
  });
  test('network badges, help and sync remain readable in all themes/languages and compact layouts', async () => {
    const fs = require('node:fs'), path = require('node:path');
    const screenshots = path.join(__dirname, '..', 'audit', 'editor-improvements', 'collaboration-screens'); fs.mkdirSync(screenshots, { recursive: true });
    await guest('Long participant nickname');
    await waitFor(page, () => [...document.querySelectorAll('[data-rtt]')].every(node => node.textContent !== '—'), 15000);
    for (const language of ['en', 'ru', 'uk']) {
      await page.evaluate(language => DublineI18n.setLanguage(language), language);
      for (const theme of ['graphite', 'light', 'midnight', 'forest', 'ocean', 'sunset']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        for (const scale of [1, 1.25, 1.5]) {
          const size = scale === 1 ? { width: 1920, height: 1080 } : scale === 1.25 ? { width: 1280, height: 720 } : { width: 1024, height: 768 };
          // Emulate the reduced CSS viewport at browser/OS zoom. Zooming only
          // body would incorrectly enlarge 100vh beyond the native window.
          await page.setViewport({ width: Math.round(size.width / scale), height: Math.round(size.height / scale), deviceScaleFactor: scale });
          await page.evaluate(scale => { document.body.classList.toggle('lobby-compact', scale > 1); }, scale);
          const geometry = await page.evaluate(() => {
            const panel = document.getElementById('lobbyPanel'), ping = panel.querySelector('.network-ping');
            return { overflow: panel.scrollWidth > panel.clientWidth, ping: !!ping.getClientRects().length, label: document.getElementById('editorSyncState').getAttribute('aria-label'), localized: t('network.scope') !== 'network.scope' && t('help.protected') !== 'help.protected' };
          });
          assert.equal(geometry.overflow, false, `${language}/${theme}/${scale}`); assert.equal(geometry.ping, true); assert.equal(geometry.localized, true); assert.ok(geometry.label);
          const contrast = await page.evaluate(() => {
            const node = document.querySelector('.network-ping'), original = node.className;
            const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
            const luminance = rgb => rgb.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
            const results = [];
            for (const category of ['good', 'fair', 'slow', 'poor', 'unknown']) {
              node.className = 'network-ping network-' + category;
              const text = rgb(getComputedStyle(node).color), background = rgb(getComputedStyle(node.closest('.player-card')).backgroundColor);
              // Compact badges have no background. Expanded badges tint their
              // card by 12%; check the less favourable tinted background too.
              const tinted = background.map((value, i) => value * .88 + text[i] * .12);
              const a = luminance(text), b = luminance(tinted);
              results.push((Math.max(a, b) + .05) / (Math.min(a, b) + .05));
            }
            node.className = original; return results;
          });
          assert.ok(contrast.every(value => value >= 4.5), `${language}/${theme}/${scale}: ${contrast}`);
        }
        if (language === 'en' && ['graphite', 'light'].includes(theme)) await page.screenshot({ path: path.join(screenshots, `${theme}-compact-150.png`) });
      }
    }
  });
  test('three participants receive real RTT; telemetry patches preserve moderation menu and focus', async () => {
    await guest('Guest'); await guest('Third participant with a long nickname');
    await waitFor(page, () => [...document.querySelectorAll('[data-rtt]')].length === 3 && [...document.querySelectorAll('[data-rtt]')].every(node => node.textContent !== '—'), 20000);
    await page.evaluate(() => { window.networkCard = [...lobbyList.querySelectorAll('.player-card')].find(card => card.dataset.lobbyKey === 'player:Guest'); window.networkMenu = networkCard.querySelector('details'); networkMenu.open = true; networkMenu.querySelector('summary').focus(); window.rendersBefore = DublineDiagnostics.sample().timeline.fullRenders; });
    await wait(2300);
    assert.deepEqual(await page.evaluate(() => ({ same: networkCard.querySelector('details') === networkMenu, open: networkMenu.open, focus: document.activeElement === networkMenu.querySelector('summary'), renders: DublineDiagnostics.sample().timeline.fullRenders - rendersBefore })), { same: true, open: true, focus: true, renders: 0 });
    await page.evaluate(() => document.body.classList.add('lobby-compact'));
    assert.equal(await page.$eval('#lobbyPanel', node => Math.round(node.getBoundingClientRect().width)), 68);
    assert.equal(await page.$eval('#lobbyPanel', node => node.scrollWidth <= node.clientWidth), true);
    await page.focus('.network-ping'); await waitFor(page, () => !document.getElementById('dublineTooltip').hidden);
    assert.match(await page.$eval('#dublineTooltip', node => node.textContent), /observed DubLine traffic/);
  });
  test('passive upload/HTTP transfer is observed and returns toward idle; reports cannot spoof a nickname', async () => {
    const other = await guest();
    await page.evaluate(() => { const original = socket.emit; window.observedTraffic = []; socket.emit = function(event, ...args) { if (event === 'network_telemetry_update') observedTraffic.push(args[0]); return original.call(this, event, ...args); }; });
    const response = await page.evaluate(async () => { const form = new FormData(); form.append('clientId', clientId); form.append('pack', new Blob([new Uint8Array(1024 * 1024)]), 'invalid.zip'); const result = await DublineNetwork.upload('/api/upload-pack?room=' + encodeURIComponent(currentRoom), { method: 'POST', body: form }); return result.status; });
    assert.equal(response, 400);
    await page.evaluate(async () => { await (await fetch(session.videoUrl + '?telemetry=' + Date.now(), { cache: 'no-store' })).arrayBuffer(); });
    await waitFor(page, () => observedTraffic.some(report => report.up > 100000) && observedTraffic.some(report => report.down > 1000), 5000);
    await waitFor(page, () => observedTraffic.length > 5 && observedTraffic.at(-1).up < 10000 && observedTraffic.at(-1).down < 10000, 9000);
    await page.evaluate(() => socket.emit('network_telemetry_update', { rtt: 1, up: 100, down: 100, nick: 'Spoof' }));
    await wait(1100); assert.equal(await other.$eval('body', node => node.textContent.includes('Spoof')), false);
    await waitFor(page, () => document.querySelector('[data-up]').textContent !== '↑ —', 5000);
  });
});
