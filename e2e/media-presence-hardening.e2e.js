const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), AdmZip = require('adm-zip');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, wait, buildFixturePack } = require('./helpers');

describe('Media/presence recovery and local timeline controls', { skip: skipReason }, () => {
  let server, browser, page, serial = 0;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => {
    page = await openPlayer(browser, server.url(`media-presence-${++serial}`), 'Alice', { audioExpanded: false });
    await loadFixture(page); await page.evaluate(() => setStudioMode('edit'));
    await waitFor(page, () => session.mode === 'edit');
  });
  afterEach(async () => { assert.deepEqual(page.errors, []); await page.browserContext().close(); });

  test('initial socket joins only after delayed renderer scripts have installed all state handlers', async () => {
    let held;
    await page.setRequestInterception(true);
    const handler = request => {
      if (request.url().endsWith('/editor.js')) held = request;
      else request.continue();
    };
    page.on('request', handler);
    const navigation = page.reload({ waitUntil: 'networkidle0' });
    try {
      await require('./helpers').waitUntil(() => !!held);
      await wait(500);
      assert.equal(await page.evaluate(() => socket.connected), false, 'joining must wait for the rest of the renderer');
      await held.continue(); held = null;
      await navigation;
      await waitFor(page, () => socket.connected && session?.loaded && !editorNeedsResync);
      assert.equal(await page.evaluate(() => myName), 'Alice');
    } finally {
      if (held) await held.continue();
      await navigation;
      page.off('request', handler); await page.setRequestInterception(false);
    }
  });

  test('locale loading is lazy, failure preserves English, retry works and the latest selection wins', async () => {
    assert.equal(await page.evaluate(() => !!DublineI18n.messages.en && !DublineI18n.messages.ru && !DublineI18n.messages.uk && !window.JSZip), true);
    let block = true, held;
    await page.setRequestInterception(true);
    const handler = request => {
      if (request.url().endsWith('/locale/ru.js') && block) request.abort('failed');
      else if (request.url().endsWith('/locale/ru.js') && !held) held = request;
      else request.continue();
    };
    page.on('request', handler);
    try {
      assert.equal(await page.evaluate(() => DublineI18n.setLanguage('ru')), false);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
      block = false;
      await page.evaluate(() => { window.oldLocaleJob = DublineI18n.setLanguage('ru'); });
      await waitFor(page, () => document.documentElement.lang === 'en');
      await waitFor(page, async () => await DublineI18n.setLanguage('uk'));
      await require('./helpers').waitUntil(() => !!held);
      await held.continue();
      assert.equal(await page.evaluate(() => oldLocaleJob), false);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'uk');
      assert.equal(await page.evaluate(() => DublineI18n.setLanguage('ru')), true);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'ru');
      const zip = await page.evaluate(async () => { const libraries = await Promise.all([DublineLazyScripts.jszip(), DublineLazyScripts.jszip()]); return libraries[0] === libraries[1] && document.querySelectorAll('script[src="/vendor/jszip/jszip.min.js"]').length === 1; });
      assert.equal(zip, true);
    } finally { page.off('request', handler); await page.setRequestInterception(false); }
  });

  test('every archive route requires a one-use barrier matching its purpose and scene', async () => {
    const result = await page.evaluate(async () => {
      const request = async (route, extra = {}) => {
        const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: currentRoom, clientId, sessionId: session.activeSessionId, ...extra }) });
        if (response.ok) { await response.arrayBuffer(); return { status: response.status, key: '' }; }
        return { status: response.status, key: (await response.json()).key };
      };
      const withoutProject = await request('/api/export-project'), withoutPack = await request('/api/export-voxalike-pack');
      const safe = await window.prepareSafeSnapshot('project');
      const wrongPurpose = await request('/api/export-voxalike-pack', safe);
      const saved = await request('/api/export-project', safe);
      let reused;
      for (let attempt = 0; attempt < 20; attempt++) {
        reused = await request('/api/export-project', safe);
        if (reused.key !== 'project.busy') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return { withoutProject, withoutPack, wrongPurpose, saved, reused, frozen: !!window.snapshotFrozen };
    });
    for (const name of ['withoutProject', 'withoutPack', 'wrongPurpose', 'reused']) {
      assert.equal(result[name].status, 409, name); assert.equal(result[name].key, 'snapshot.expired', name);
    }
    assert.equal(result.saved.status, 200); assert.equal(result.frozen, false);
  });

  test('solo provider cards only select a future mode; explicit Start guards busy work and duplicate clicks', async () => {
    const result = await page.evaluate(async () => {
      const before = JSON.stringify({ id: session.activeSessionId, lines: session.lines, mix: session.projectAudio });
      let calls = 0, complete;
      window.dublineDesktop = { setHostingMode: mode => { calls++; return new Promise(resolve => { complete = () => { session.singlePlayer = false; resolve({ ...desktopInviteState, mode, singlePlayer: false, state: 'waitingGuest' }); }; }); } };
      session.singlePlayer = true;
      handleDesktopStatus({ mode: 'single', singlePlayer: true, state: 'idle', tools: {}, port: 38500 });
      openHostingModal(); await selectDesktopHostingMode('vpn'); await selectDesktopHostingMode('porthole');
      const selected = { calls, mode: desktopFutureHostingMode, single: session.singlePlayer };
      recordState = 'preparing'; await startDesktopMultiplayer(); const blocked = calls; recordState = 'idle';
      const first = startDesktopMultiplayer(), second = startDesktopMultiplayer();
      const pending = { calls, disabled: document.getElementById('desktopStartMultiplayerBtn').disabled };
      complete(); await Promise.all([first, second]);
      return { selected, blocked, pending, single: session.singlePlayer, sameScene: before === JSON.stringify({ id: session.activeSessionId, lines: session.lines, mix: session.projectAudio }) };
    });
    assert.deepEqual(result.selected, { calls: 0, mode: 'porthole', single: true }); assert.equal(result.blocked, 0);
    assert.deepEqual(result.pending, { calls: 1, disabled: true }); assert.equal(result.single, false); assert.equal(result.sameScene, true);
  });

  test('CPU jobs transfer PCM copies, preserve pitch and discard results from a departed scene', async () => {
    const result = await page.evaluate(async () => {
      const buffer = new AudioBuffer({ length: 22050, numberOfChannels: 1, sampleRate: 44100 });
      const input = buffer.getChannelData(0);
      for (let at = 0; at < input.length; at++) input[at] = Math.sin(at / 44100 * 2 * Math.PI * 440);
      const stretched = await DublineAudioFx.stretchPreview(buffer, 2, session.activeSessionId);
      const output = stretched.getChannelData(0);
      let crossings = 0;
      for (let at = 1001; at < output.length - 1000; at++) if (output[at - 1] < 0 && output[at] >= 0) crossings++;
      const frequency = crossings / ((output.length - 2000) / 44100);
      let stale = false;
      try { await DublineCpuJobs.run({ kind: 'sha256', bytes: new Uint8Array([1]).buffer }, [], 'departed-scene'); } catch (error) { stale = /Stale/.test(error.message); }
      return { frames: output.length, inputFrames: input.length, frequency, stale, stats: DublineCpuJobs.stats() };
    });
    assert.equal(result.frames, 11025); assert.equal(result.inputFrames, 22050);
    assert.ok(Math.abs(result.frequency - 440) < 15, String(result.frequency));
    assert.equal(result.stale, true); assert.ok(result.stats.completed >= 1); assert.equal(result.stats.active, 0);
  });

  test('snapshot readiness freezes mutations while preserving cached acknowledgments and releases on cancel', async () => {
    const result = await page.evaluate(async () => {
      const operation = {
        sessionId: session.activeSessionId, operationId: crypto.randomUUID(), operationEpoch: session.editorProtocol.epoch,
        operationTime: Date.now(), lineId: session.lines[0].id, revision: session.lines[0].revision || 0, caption: 'Confirmed before snapshot'
      };
      const send = (event, payload) => new Promise(resolve => Object.getPrototypeOf(socket).emit.call(socket, event, payload, resolve));
      const applied = await send('editor_update_line', operation);
      const snapshot = await prepareSafeSnapshot('project');
      const frozen = window.snapshotFrozen;
      const duplicate = await send('editor_update_line', operation);
      const blocked = await send('editor_update_line', { ...operation, operationId: crypto.randomUUID(), caption: 'Must not apply' });
      socket.emit('snapshot_cancel', { token: snapshot.barrierToken });
      return { applied, frozen, duplicate, blocked };
    });
    assert.equal(result.applied.ok, true); assert.equal(result.frozen, true);
    assert.equal(result.duplicate.ok, true); assert.equal(result.blocked.reason, 'snapshot');
    await waitFor(page, () => !window.snapshotFrozen);
    assert.equal(await page.evaluate(() => session.lines[0].caption), 'Confirmed before snapshot');
  });

  test('semantic cursors use independent direct channels, hide on leave and keep selection safety when disabled', async () => {
    const guest = await openPlayer(browser, server.url(`media-presence-${serial}`), 'Bob');
    try {
      await waitFor(guest, () => session?.loaded && session.mode === 'edit' && DublineCursorPresence.stats().actors === 1);
      await waitFor(page, () => DublineCursorPresence.stats().open === 1, 10000);
      await page.evaluate(() => { window.cursorFallbacks = 0; socket.onAnyOutgoing(event => { if (event === 'cursor_fallback') window.cursorFallbacks++; }); });
      await page.evaluate(() => DublineCursorPresence.publish({ active: true, time: 3, rowType: 'role', rowKey: 'Hero', relativeY: .5 }));
      await waitFor(guest, () => [...DublineCursorPresence.samples.values()].some(sample => sample.packet.time === 3));
      assert.equal(await page.evaluate(() => window.cursorFallbacks), 0);
      await page.evaluate(() => { for (const key of [...peers.keys()]) closePeer(key); });
      assert.equal(await page.evaluate(() => DublineCursorPresence.stats().open), 1, 'media connection cleanup does not close presence');
      await page.evaluate(() => DublineCursorPresence.publish({ active: false }));
      await waitFor(guest, () => [...DublineCursorPresence.samples.values()].every(sample => !sample.packet.active));
      await guest.evaluate(() => { const toggle = document.querySelector('[data-i18n="cursor.show"]').parentElement.querySelector('input'); toggle.checked = false; toggle.dispatchEvent(new Event('change')); });
      await page.evaluate(() => { selectLine(session.lines[0]); publishSelection(); });
      await waitFor(guest, () => !!document.querySelector('#line-block-1 .remote-selection-markers'));
      assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); }
  });

  test('snapshot reports a remote draft and forced capture leaves that uncommitted draft untouched', async () => {
    const guest = await openPlayer(browser, server.url(`media-presence-${serial}`), 'Bob');
    try {
      await waitFor(guest, () => session?.loaded && session.mode === 'edit');
      const caption = await guest.evaluate(() => {
        selectLine(session.lines[0]);
        const form = inspector.querySelector('form[data-draft-key]');
        form.querySelector('[data-editor-field="caption"]').value = 'Unsaved remote draft';
        rememberEditorDraft(form); return session.lines[0].caption;
      });
      const token = await page.evaluate(() => new Promise(resolve => socket.emit('snapshot_request', { sessionId: session.activeSessionId, purpose: 'project' }, result => resolve(result.token))));
      await waitFor(page, token => new Promise(resolve => socket.emit('snapshot_status_request', { token }, result => resolve(result.participants?.some(player => player.nick === 'Bob' && player.reason === 'draft')))), 5000, token);
      const saved = await page.evaluate(async token => {
        const response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, sessionId: session.activeSessionId, barrierToken: token, forceSnapshot: true }) });
        if (!response.ok) throw Error(await response.text());
        const JSZip = await DublineLazyScripts.jszip();
        const zip = await JSZip.loadAsync(await response.arrayBuffer());
        return JSON.parse(await zip.file('project.json').async('string')).project.lines[0].caption;
      }, token);
      assert.equal(saved, caption);
      assert.equal(await guest.evaluate(() => inspector.querySelector('[data-editor-field="caption"]').value), 'Unsaved remote draft');
      await waitFor(page, () => !window.snapshotFrozen);
    } finally { await guest.browserContext().close(); }
  });

  test('offline intent survives reload with its original ID and applies once after confirmed resync', async () => {
    const id = await page.evaluate(async () => {
      socket.disconnect(); updateEditorLine(session.lines[0], { caption: 'Durable offline caption' });
      await editorPersistence;
      return editorQueue[0].id;
    });
    assert.ok(id);
    await page.reload({ waitUntil: 'networkidle0' });
    await waitFor(page, () => session?.lines[0]?.caption === 'Durable offline caption' && !editorQueue.length);
    assert.equal(await page.evaluate(() => session.lines[0].revision), 1);
    assert.deepEqual(await page.evaluate(async () => (await DublineLocalDatabase.store('pendingEditorOperations').all()).map(item => item.id)), []);
  });

  test('media clear preserves pending takes and editor recovery records', async () => {
    const result = await page.evaluate(async () => {
      const db = await DublineLocalDatabase.open();
      await DublineLocalDatabase.store('pendingTakes').put({ uploadId: 'retain-take', room: 'different-room' });
      await DublineLocalDatabase.store('pendingEditorOperations').put({ id: 'retain-intent', clientId: 'different-client' });
      await DublineLocalDatabase.store('mediaCacheMetadata').put({ id: 'discard-media' });
      await DublineLocalDatabase.store('mediaCacheChunks').put({ id: 'discard-chunk', bytes: new Uint8Array([1, 2]) });
      await DublineLocalDatabase.clearMedia();
      return { version: db.version, takes: await DublineLocalDatabase.store('pendingTakes').all(),
        intents: await DublineLocalDatabase.store('pendingEditorOperations').all(), media: await DublineLocalDatabase.store('mediaCacheMetadata').all(), chunks: await DublineLocalDatabase.store('mediaCacheChunks').all() };
    });
    assert.equal(result.version, 2); assert.equal(result.takes[0].uploadId, 'retain-take'); assert.equal(result.intents[0].id, 'retain-intent'); assert.deepEqual(result.media, []); assert.deepEqual(result.chunks, []);
  });

  test('persistent verified chunks resume, reject tampering and protect active cache entries', async () => {
    const result = await page.evaluate(async () => {
      const cache = DublineMediaCache, bytes = new Uint8Array(262144 + 37);
      for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
      const parts = [bytes.slice(0, 262144), bytes.slice(262144)];
      const sha256 = await cache.sha(bytes), hashes = await Promise.all(parts.map(cache.sha));
      const manifest = { size: bytes.length, sha256, chunkSize: 262144, layoutVersion: 1, chunks: hashes, id: `${sha256}:${bytes.length}:262144:1` };
      const accepted = await cache.put(manifest, 0, parts[0]);
      const partial = await cache.load(manifest);
      const wrongLength = await cache.put(manifest, 1, parts[1].slice(1));
      const bad = parts[0].slice(); bad[3] ^= 1;
      await DublineLocalDatabase.store('mediaCacheChunks').put({ id: manifest.id + '/0', bytes: bad });
      const invalidated = await cache.load(manifest);
      await cache.put(manifest, 0, parts[0]); await cache.put(manifest, 1, parts[1]);
      const complete = await cache.load(manifest), release = cache.pin(manifest.id);
      await cache.clear(); const protectedEntry = await cache.load(manifest);
      release(); await cache.clear(); const cleared = await cache.load(manifest);
      return { accepted, partial: !!partial[0] && !partial[1], wrongLength, corrupt: !!invalidated[0],
        complete: complete.filter(Boolean).length, protected: protectedEntry.filter(Boolean).length, cleared: cleared.filter(Boolean).length };
    });
    assert.deepEqual(result, { accepted: true, partial: true, wrongLength: false, corrupt: false, complete: 2, protected: 2, cleared: 0 });
  });

  test('media readiness uses decoder events, scopes late snapshots and preserves seeding/recording badges', async () => {
    await waitFor(page, () => video.readyState >= 3);
    await page.evaluate(() => video.dispatchEvent(new Event('waiting')));
    await waitFor(page, () => playerActivities.get('Alice')?.state === 'buffering');
    assert.equal(await page.$eval('#mediaReadinessOverlay', el => el.hidden), false);
    await page.evaluate(() => video.dispatchEvent(new Event('canplay')));
    await waitFor(page, () => playerActivities.get('Alice')?.state === 'ready');
    assert.equal(await page.$eval('#mediaReadinessOverlay', el => el.hidden), true);
    await page.evaluate(() => {
      socket.listeners('media_presence').forEach(handler => handler({ sessionId: 'old-scene', players: [{ nick: 'Alice', state: 'failed' }] }));
    });
    assert.equal(await page.evaluate(() => playerActivities.get('Alice').state), 'ready');
  });

  test('a downloader seeds durable verified chunks before completing its video', async () => {
    const zip = new AdmZip(fs.readFileSync(buildFixturePack())), video = zip.getEntry('dub_video.mp4').getData();
    const padding = Buffer.alloc(3 * 1024 * 1024); padding.writeUInt32BE(padding.length, 0); padding.write('free', 4);
    zip.updateFile('dub_video.mp4', Buffer.concat([video, padding]));
    const room = await page.evaluate(() => currentRoom);
    await page.evaluate(async encoded => {
      const form = new FormData(); form.append('clientId', clientId); form.append('pack', new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]), 'partial-test.zip');
      const response = await fetch('/api/upload-pack?room=' + currentRoom, { method: 'POST', body: form });
      if (!response.ok) throw Error(await response.text());
    }, zip.toBuffer().toString('base64'));
    await waitFor(page, () => session.videoSize > 3 * 1024 * 1024);
    let seed, receiver;
    try {
      seed = await openPlayer(browser, server.url(room, 'dubline.test'), 'Seed', { beforeLoad: async remote => {
        await remote.evaluateOnNewDocument(() => {
          const nativeFetch = window.fetch;
          window.fetch = async (url, options) => {
            const range = options?.headers?.Range;
            if (range && /^bytes=(\d+)-/.test(range) && Number(range.match(/^bytes=(\d+)-/)[1]) >= 1048576) {
              await new Promise(resolve => { window.releaseMediaRange = resolve; });
            }
            return nativeFetch(url, options);
          };
        });
      } });
      await waitFor(seed, () => !!window.releaseMediaRange && [...partialFiles.values()].some(file => file.durable.size > 0 && file.durable.size < file.manifest.chunks.length));
      await wait(400);
      assert.equal(await seed.evaluate(() => !!mediaDownload && !localMedia), true);
      receiver = await openPlayer(browser, server.url(room, 'dubline.test'), 'Receiver');
      await waitFor(receiver, () => !!localMedia?.videoBlob, 20000);
      const result = await receiver.evaluate(() => ({ p2p: p2pStatus.p2p, http: p2pStatus.http }));
      assert.ok(result.p2p > 0, JSON.stringify(result)); assert.ok(result.http > 0, JSON.stringify(result));
      assert.equal(await seed.evaluate(() => !!mediaDownload), true, 'the seed is still below 100%');
    } finally { await receiver?.browserContext().close(); await seed?.browserContext().close(); }
  });

  test('Ctrl+F selects chronological #numbers and role/status filters never mutate scene data', async () => {
    const initial = await page.evaluate(() => JSON.stringify(session.lines));
    await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control');
    await page.type('#timelineSearchInput', '#2'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => selectedLine.id), 2);
    await page.keyboard.press('Escape'); assert.equal(await page.$eval('#timelineSearch', el => el.hidden), true);
    await page.select('#timelineRoleFilter', 'Hero');
    assert.equal(await page.$$eval('.track-row:not([hidden])', rows => rows.every(row => row.dataset.character === 'Hero')), true);
    await page.select('#timelineStatusFilter', 'recorded');
    assert.equal(await page.$$eval('.line-block:not([hidden])', blocks => blocks.length), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(session.lines)), initial);
  });

  test('minimap scrolls the viewport without seeking and stays outside horizontal scroll content', async () => {
    await page.evaluate(() => { pxPerSec = 150; renderTimeline(); video.currentTime = 2; });
    const box = await page.$eval('#timelineMinimap', el => { const r = el.getBoundingClientRect(); return { x: r.right - 20, y: r.top + 15 }; });
    await page.mouse.click(box.x, box.y);
    assert.ok(await page.evaluate(() => timelineContainer.scrollLeft > 0));
    assert.equal(await page.evaluate(() => video.currentTime), 2);
    assert.equal(await page.$eval('#timelineMinimap', el => !!el.closest('#timelineContainer')), false);
  });

  test('master volume and CC stay local and persist while project mix remains identical', async () => {
    const initial = await page.evaluate(() => JSON.stringify(session.projectAudio));
    await page.$eval('#masterVolume', input => { input.value = '35'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.evaluate(() => localMasterVolume()), .35);
    await page.click('#transportCC'); assert.equal(await page.evaluate(() => prompterEnabled), false);
    await page.reload({ waitUntil: 'networkidle0' }); await waitFor(page, () => session?.loaded);
    assert.equal(await page.evaluate(() => localMasterVolume()), .35); assert.equal(await page.evaluate(() => prompterEnabled), false);
    assert.equal(await page.evaluate(() => JSON.stringify(session.projectAudio)), initial);
    await page.$eval('#masterVolume', input => input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    assert.equal(await page.evaluate(() => localMasterVolume()), 1);
  });

  test('WSOLA preview rates retain sine pitch and reduce duration; source offsets follow video rate', async () => {
    const results = await page.evaluate(async () => {
      const sampleRate = 24000, duration = .7;
      const input = new AudioBuffer({ sampleRate, numberOfChannels: 1, length: sampleRate * duration });
      const data = input.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * .2;
      const results = [];
      for (const rate of [1.25, 1.5, 2, 3, 4]) {
        const out = await DublineAudioFx.stretchPreview(input, rate), signal = out.getChannelData(0);
        const from = Math.floor(signal.length * .2), to = Math.floor(signal.length * .8); let crossings = 0;
        for (let i = from + 1; i < to; i++) if (signal[i - 1] <= 0 && signal[i] > 0) crossings++;
        results.push({ rate, duration: out.duration, frequency: crossings * sampleRate / (to - from) });
      }
      setPreviewRate(2); syncProjectSources(true); return { results, videoRate: video.playbackRate, backingRate: backing.playbackRate };
    });
    for (const item of results.results) { assert.ok(Math.abs(item.duration - .7 / item.rate) < .001); assert.ok(Math.abs(item.frequency - 440) < 25, JSON.stringify(item)); }
    assert.equal(results.videoRate, 2); assert.ok(Math.abs(results.backingRate - 2) < .01);
  });

  test('role height drag stretches all overlapping lanes without replacing blocks or font size', async () => {
    const result = await page.evaluate(() => {
      roleHeights[roleHeightKey('Hero')] = 210; renderTimeline();
      const block = document.getElementById('line-block-1'), row = block.closest('.track-row');
      const before = { row: row.getBoundingClientRect().height, cue: block.getBoundingClientRect().height, font: getComputedStyle(block).fontSize };
      row.querySelector('.role-height-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return { ...before, sameBlock: block === document.getElementById('line-block-1'), resetCue: block.getBoundingClientRect().height };
    });
    assert.equal(result.row, 210); assert.equal(result.cue, 198); assert.equal(result.font, '11px');
    assert.equal(result.sameBlock, true); assert.equal(result.resetCue, 48);
  });
});
