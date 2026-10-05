const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readProject } = require('../server/projects');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('./helpers');

describe('clip mixing: real sockets, inspector and audio', { skip: skipReason, timeout: 90000 }, () => {
  let server, browser, host, guest, other, baseline;
  const lines = page => page.evaluate(() => structuredClone(session.lines));
  const update = (page, ids, props, overrides = {}) => page.evaluate((ids, props, overrides) => new Promise(resolve => {
    const takes = ids.map(id => { const line = session.lines.find(item => item.id === id); return { lineId: id, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0 }; });
    socket.emit('set_takes_props', { sessionId: session.activeSessionId, takes, props, ...overrides }, resolve);
  }), ids, props, overrides);
  async function upload(page, id) {
    const previous = await page.evaluate(id => session.lines.find(line => line.id === id).audioUrl, id);
    await page.evaluate(async id => {
      const ctx = new OfflineAudioContext(1, 48000, 48000), buffer = ctx.createBuffer(1, 48000, 48000);
      const signal = buffer.getChannelData(0);
      for (let i = 0; i < signal.length; i++) signal[i] = 0.08 * Math.sin(2 * Math.PI * 330 * i / 48000);
      await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: id, nick: myName, audioStart: 0,
        trimStart: 0, trimEnd: 1, blob: new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), createdAt: Date.now() });
    }, id);
    await waitFor(page, (id, previous) => {
      const url = session.lines.find(line => line.id === id).audioUrl;
      return url && url !== previous;
    }, 15000, id, previous);
  }
  async function change(page, field, value) {
    await page.$eval(`[data-clip-field="${field}"]`, (input, value) => {
      input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('clip-mix'), 'Alice');
    guest = await openPlayer(browser, server.url('clip-mix'), 'Bob');
    other = await openPlayer(browser, server.url('clip-mix'), 'Eve');
    await loadFixture(host); await waitFor(guest, () => session?.loaded); await waitFor(other, () => session?.loaded);
    for (const [page, id] of [[host, 1], [guest, 2], [host, 3], [guest, 4]]) { await claimAndSelect(page, id); await upload(page, id); }
    await waitFor(host, () => session.lines.every(line => line.audioUrl));
    await waitFor(guest, () => session.lines.every(line => line.audioUrl));
    baseline = await lines(host);
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });

  test('authors set their own clip; another actor is denied atomically; host adjusts any author', async () => {
    assert.equal((await update(guest, [2], { volume: 0.72, pan: -0.35, effect: 'radio', effectAmount: 0.4 })).ok, true);
    await waitFor(host, () => session.lines[1].volume === 0.72);
    const before = await lines(host);
    assert.equal((await update(guest, [2, 1], { volume: 0.1 })).reason, 'owner');
    assert.deepEqual(await lines(host), before);
    assert.equal((await update(host, [2], { volume: 0.62 })).ok, true);
    await waitFor(guest, () => session.lines[1].volume === 0.62);
  });

  test('releasing and reclaiming a line keeps mix rights with the recording author', async () => {
    await guest.evaluate(() => unclaimSingleLine(2));
    await waitFor(other, () => !session.lines[1].claimedBy);
    await other.evaluate(() => claimSingleLine(2));
    await waitFor(guest, () => session.lines[1].claimedBy === 'Eve');
    assert.equal((await update(other, [2], { pan: 1 })).reason, 'owner');
    assert.equal((await update(guest, [2], { pan: 0.25 })).ok, true);
    await waitFor(host, () => session.lines[1].pan === 0.25);
    await other.evaluate(() => { selectLine(session.lines[1]); });
    assert.equal(await other.$eval('[data-clip-field=volume]', input => input.disabled), true);
    await guest.evaluate(() => { selectLine(session.lines[1]); });
    assert.equal(await guest.$eval('[data-clip-field=volume]', input => input.disabled), false);
  });

  test('invalid values, duplicated targets, stale revisions and replaced URLs reject whole batches', async () => {
    const before = await lines(host);
    for (const props of [{ volume: 3.01 }, { pan: -1.01 }, { effectAmount: null }, { effect: 'missing' }]) assert.equal((await update(host, [1, 2], props)).reason, 'invalid');
    assert.equal((await update(host, [1, 1], { volume: 1 })).reason, 'invalid');
    const targets = before.slice(0, 2).map(line => ({ lineId: line.id, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0 }));
    assert.equal((await update(host, [1, 2], { volume: 1 }, { takes: targets.map((take, index) => index ? { ...take, takeMixRevision: 9999 } : take) })).reason, 'conflict');
    assert.equal((await update(host, [1, 2], { volume: 1 }, { takes: targets.map((take, index) => index ? { ...take, audioUrl: '/old-take' } : take) })).reason, 'take');
    assert.equal((await update(host, [1, 2], { volume: 1 }, { sessionId: 'inactive' })).reason, 'session');
    assert.deepEqual(await lines(host), before);
  });

  test('Ctrl selection across roles shows mixed values and bulk volume sets one absolute value', async () => {
    await host.evaluate(() => selectLine(session.lines[0]));
    await host.keyboard.down('Control'); await host.click('#line-block-2'); await host.keyboard.up('Control');
    await waitFor(host, () => multiSelection.size === 2);
    assert.equal(await host.$eval('[data-clip-field=volume]', input => input.parentElement.querySelector('output').textContent), 'Mixed');
    const prior = await lines(host);
    await change(host, 'volume', 43);
    await waitFor(guest, () => session.lines[0].volume === 0.43 && session.lines[1].volume === 0.43);
    const after = await lines(host);
    for (let i = 0; i < 2; i++) { assert.equal(after[i].pan, prior[i].pan); assert.equal(after[i].effect, prior[i].effect); }
    assert.equal(after[2].volume, prior[2].volume);
    fs.mkdirSync(path.join(__dirname, '../docs/qa'), { recursive: true });
    await host.screenshot({ path: path.join(__dirname, '../docs/qa/clip-mix-bulk.png') });
  });

  test('bulk effect, strength and pan apply in both modes; guest selection changes only own recordings', async () => {
    await change(host, 'effect', 'behindDoor'); await waitFor(guest, () => session.lines[0].effect === 'behindDoor' && session.lines[1].effect === 'behindDoor');
    await change(host, 'effectAmount', 55); await waitFor(guest, () => session.lines[0].effectAmount === 0.55 && session.lines[1].effectAmount === 0.55);
    await change(host, 'pan', -60); await waitFor(guest, () => session.lines[0].pan === -0.6 && session.lines[1].pan === -0.6);
    await guest.evaluate(() => { selectLine(session.lines[0]); toggleMultiSelect(2); });
    assert.match(await guest.$eval('.clip-mix-panel .take-hint', node => node.textContent), /Editing 1 of 2/);
    await change(guest, 'volume', 79); await waitFor(host, () => session.lines[1].volume === 0.79);
    assert.equal((await lines(host))[0].volume, 0.43);
    await host.evaluate(() => { clearMultiSelection(); setStudioMode('edit'); });
    await waitFor(host, () => session.mode === 'edit');
    await host.evaluate(() => selectLine(session.lines[0]));
    await host.type('#editorCaption', ' draft');
    const caption = await host.$eval('#editorCaption', node => node.value);
    await change(host, 'pan', 100); await waitFor(guest, () => session.lines[0].pan === 1);
    assert.equal(await host.$eval('#editorCaption', node => node.value), caption, 'mix updates preserve unsaved editor drafts');
    await host.screenshot({ path: path.join(__dirname, '../docs/qa/clip-mix-editor.png') });
    await host.evaluate(() => setStudioMode('dub')); await waitFor(host, () => session.mode === 'dub');
  });

  test('effect blend has dry and wet endpoints, midpoint and no preset pitch/tail at zero', async () => {
    const result = await host.evaluate(async () => {
      const ctx = new OfflineAudioContext(1, 4800, 48000), buffer = ctx.createBuffer(1, 4800, 48000);
      const data = buffer.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = 0.015 * Math.sin(2 * Math.PI * 1000 * i / 48000);
      const dry = await DublineAudioFx.renderVoice(buffer, 'behindDoor', 0, null, 0);
      const wet = await DublineAudioFx.renderVoice(buffer, 'behindDoor', 0, null, 1);
      const half = await DublineAudioFx.renderVoice(buffer, 'behindDoor', 0, null, 0.5);
      let error = 0; for (let i = 0; i < data.length; i++) error = Math.max(error, Math.abs(half.getChannelData(0)[i] - (dry.getChannelData(0)[i] + wet.getChannelData(0)[i]) / 2));
      const monster = await DublineAudioFx.renderVoice(buffer, 'monster', 0, null, 0);
      const pitchedDry = await DublineAudioFx.renderVoice(buffer, 'none', 3);
      const pitchedZero = await DublineAudioFx.renderVoice(buffer, 'monster', 3, null, 0);
      return { error, dryIdentity: dry === buffer, monsterIdentity: monster === buffer, tail: DublineAudioFx.effectTailSeconds('cave', 0),
        pitchPreserved: pitchedDry.getChannelData(0).every((sample, i) => sample === pitchedZero.getChannelData(0)[i]) };
    });
    assert.ok(result.error < 0.000001, JSON.stringify(result));
    assert.equal(result.dryIdentity, true); assert.equal(result.monsterIdentity, true); assert.equal(result.tail, 0); assert.equal(result.pitchPreserved, true);
  });

  test('actual offline soundtrack and stereo stems preserve volume, pan and frozen settings', async () => {
    const result = await host.evaluate(async () => {
      const scene = structuredClone(session); scene.projectAudio = DublineProjectAudio.normalize({ projectAudio: { dub: { solo: true } } });
      const take = { ...scene.lines[0], audioStart: 0, trimEnabled: false, effect: 'none', pitch: 0, effectAmount: 1, volume: 1, pan: 0 };
      scene.lines = [take]; scene.takeLatency = {}; scene.latency = {};
      function snapshot(line) { const captured = { ...scene, lines: [line] }; return { scene: captured, takes: [line], gains: DublineProjectAudio.gains(captured.projectAudio), originalUrl: '', backingUrl: '' }; }
      const measure = buffer => Array.from({ length: buffer.numberOfChannels }, (_, c) => {
        const data = buffer.getChannelData(c).subarray(14000, 22000); return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
      });
      const measurements = [];
      for (const [volume, pan] of [[1, 0], [0.25, 0], [0.25, -1], [0.25, 1], [0.25, -0.5], [0, 0]]) {
        const line = { ...take, volume, pan }, frozen = snapshot(line);
        const mixed = await mixSoundtrack(2, frozen.gains, () => {}, frozen), stem = await renderCharacterStem([line], 2, 48000, frozen);
        measurements.push({ mixed: measure(mixed), stem: measure(stem) });
      }
      const line = { ...take, volume: 0.25, pan: -1 }, frozen = snapshot(line);
      const rendering = renderCharacterStem([line], 2, 48000, frozen); line.volume = 1; line.pan = 1;
      return { measurements, captured: measure(await rendering) };
    });
    const [unity, quarter, left, right, partial, silent] = result.measurements;
    for (const kind of ['mixed', 'stem']) {
      assert.equal(unity[kind].length, 2);
      assert.ok(unity[kind][0] > 0.01);
      assert.ok(Math.abs(quarter[kind][0] / unity[kind][0] - 0.25) < 0.003);
      assert.ok(left[kind][0] > 0.01); assert.ok(left[kind][1] < 1e-6);
      assert.ok(right[kind][0] < 1e-6); assert.ok(right[kind][1] > 0.01);
      assert.ok(partial[kind][0] > partial[kind][1] && partial[kind][1] > 0.001);
      assert.deepEqual(silent[kind], [0, 0]);
    }
    assert.ok(result.captured[0] > 0.01); assert.ok(result.captured[1] < 1e-6);
  });

  test('preview and timeline apply the clip graph and ramp live changes without restart', async () => {
    const result = await host.evaluate(async () => {
      const fx = DublineAudioFx, connect = fx.connectTake, seen = [];
      fx.connectTake = (...args) => { const graph = connect(...args); seen.push(graph); return graph; };
      const line = { ...session.lines[0], audioStart: 0, effect: 'none', pitch: 0, effectAmount: 1, volume: 0.25, pan: -1, trimEnabled: false };
      const v = document.createElement('video'), b = document.createElement('audio'); v.src = video.src;
      const values = { original: 1, backing: 1, recorded: 1, isMuted: false };
      const playback = DublineAudio.createController({ video: v, backing: b, getSession: () => ({ lines: [line] }), getVolumes: () => values,
        getSettings: () => ({ autoDuckEnabled: true, autoDuckAmount: 0.6 }), isRenderInProgress: () => false, getRecordingLineId: () => null });
      try {
        await playback.previewTake(line);
        const preview = { volume: seen[0].gain.gain.value / seen[0].scale, pan: seen[0].panner.pan.value };
        playback.stopPreview(); await v.play(); v.currentTime = 0.15; playback.scheduleTakes(0.15);
        await new Promise(resolve => setTimeout(resolve, 180));
        const graph = seen[1], count = seen.length;
        playback.updateLine(line, { ...line, volume: 0.75, pan: 0.5 });
        await new Promise(resolve => setTimeout(resolve, 70));
        const live = { volume: graph.gain.gain.value / graph.scale, pan: graph.panner.pan.value, restarted: seen.length !== count };
        playback.stopAllTakes(); v.pause();
        return { preview, live };
      } finally { fx.connectTake = connect; playback.stopAllTakes(); playback.stopPreview(); v.pause(); }
    });
    assert.ok(Math.abs(result.preview.volume - 0.25) < 0.000001); assert.equal(result.preview.pan, -1);
    assert.ok(Math.abs(result.live.volume - 0.75) < 0.001); assert.ok(Math.abs(result.live.pan - 0.5) < 0.001); assert.equal(result.live.restarted, false);
  });

  test('muted clips leave background alone; unmuting ducks smoothly without restarting', async () => {
    const result = await host.evaluate(async () => {
      const create = AudioContext.prototype.createGain, gains = [];
      AudioContext.prototype.createGain = function() { const node = create.call(this); gains.push(node); return node; };
      const line = { ...session.lines[0], audioStart: 0, trimEnabled: false, effect: 'none', pitch: 0, volume: 0, pan: 0 };
      const v = document.createElement('video'), b = document.createElement('audio'); v.src = video.src;
      const playback = DublineAudio.createController({ video: v, backing: b, getSession: () => ({ lines: [line] }),
        getVolumes: () => ({ original: 1, backing: 1, recorded: 1, isMuted: false }),
        getSettings: () => ({ autoDuckEnabled: true, autoDuckAmount: 0.6 }), isRenderInProgress: () => false, getRecordingLineId: () => null });
      const ctx = playback.ensurePlayCtx();
      AudioContext.prototype.createGain = create;
      try {
        await v.play(); v.currentTime = 0.05; playback.scheduleTakes(0.05);
        await new Promise(resolve => setTimeout(resolve, 120));
        const muted = gains[1].gain.value;
        playback.updateLine(line, { ...line, volume: 1 });
        await new Promise(resolve => setTimeout(resolve, 400));
        const active = gains[1].gain.value;
        playback.updateLine({ ...line, volume: 1 }, line);
        await new Promise(resolve => setTimeout(resolve, 1200));
        return { muted, active, restored: gains[1].gain.value };
      } finally { AudioContext.prototype.createGain = create; playback.stopAllTakes(); v.pause(); await ctx.close(); }
    });
    assert.equal(result.muted, 1); assert.ok(Math.abs(result.active - 0.4) < 0.001, JSON.stringify(result));
    assert.ok(Math.abs(result.restored - 1) < 0.001, JSON.stringify(result));
  });

  test('delayed effect rendering cannot start an old take after settings change or preview cancellation', async () => {
    const result = await host.evaluate(async () => {
      const fx = DublineAudioFx, decode = fx.fetchAndDecode, render = fx.renderVoice, connect = fx.connectTake;
      const ctx = new OfflineAudioContext(1, 48000, 48000), buffer = ctx.createBuffer(1, 48000, 48000);
      let release, connected = 0;
      fx.fetchAndDecode = () => new Promise(resolve => { release = resolve; });
      fx.renderVoice = async b => b;
      fx.connectTake = (...args) => { connected++; return connect(...args); };
      const line = { id: 99, audioUrl: '/pending-clip', audioStart: 0, start: 0, effect: 'none', pitch: 0, volume: 1 };
      const v = document.createElement('video'), b = document.createElement('audio'); v.src = video.src;
      const playback = DublineAudio.createController({ video: v, backing: b, getSession: () => ({ lines: [line] }),
        getVolumes: () => ({ original: 0, backing: 0, recorded: 1, isMuted: false }), getSettings: () => ({ autoDuckEnabled: false }),
        isRenderInProgress: () => false, getRecordingLineId: () => null });
      const playCtx = playback.ensurePlayCtx();
      try {
        await v.play(); v.currentTime = 0.1; playback.scheduleTakes(0.1);
        await new Promise(resolve => setTimeout(resolve, 10));
        playback.updateLine(line, { ...line, effectAmount: 0.5 }); release(buffer);
        await new Promise(resolve => setTimeout(resolve, 30));
        const obsolete = connected;
        const preview = playback.previewTake({ ...line, audioUrl: '/cancelled-preview' });
        await new Promise(resolve => setTimeout(resolve, 10)); playback.stopPreview(); release(buffer);
        const canceled = await preview;
        const pendingLine = { ...line, audioUrl: '/pending-mix' }, latestPreview = playback.previewTake(pendingLine);
        await new Promise(resolve => setTimeout(resolve, 10)); playback.updateLine(pendingLine, { ...pendingLine, volume: 0.25, pan: -1 });
        release(buffer); await latestPreview;
        return { obsolete, canceled, connected };
      } finally { fx.fetchAndDecode = decode; fx.renderVoice = render; fx.connectTake = connect; playback.stopAllTakes(); playback.stopPreview(); v.pause(); await playCtx.close(); }
    });
    assert.equal(result.obsolete, 0); assert.equal(result.canceled, false); assert.equal(result.connected, 1);
  });

  test('rerecord and deletion preserve chosen mix; a delayed batch cannot change the replacement', async () => {
    const before = (await lines(host))[0];
    const target = { lineId: 1, audioUrl: before.audioUrl, takeMixRevision: before.takeMixRevision || 0 };
    await upload(host, 1);
    const after = (await lines(host))[0];
    for (const field of ['volume', 'pan', 'effectAmount']) assert.equal(after[field], before[field]);
    assert.equal((await update(host, [1, 3], { volume: 0.1 }, { takes: [target, { lineId: 3, audioUrl: baseline[2].audioUrl, takeMixRevision: 0 }] })).reason, 'take');
    const status = await host.evaluate(async () => (await fetch('/api/delete-line-audio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, userName: myName,
        sessionId: session.activeSessionId, lineId: 1, audioUrl: session.lines[0].audioUrl })
    })).status);
    assert.equal(status, 200); await waitFor(host, () => !session.lines[0].audioUrl);
    for (const field of ['volume', 'pan', 'effectAmount']) assert.equal((await lines(host))[0][field], before[field]);
    await upload(host, 1);
  });

  test('save and reopen format 3 through production HTTP; persisted settings survive restart', async () => {
    const expected = await lines(host);
    const bytes = await host.evaluate(async () => {
      const response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: currentRoom, clientId, sessionId: session.activeSessionId }) });
      if (!response.ok) throw new Error(await response.text());
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    });
    const archive = Buffer.from(bytes), parsed = readProject(archive);
    assert.equal(parsed.manifest.formatVersion, 3);
    assert.equal(parsed.manifest.project.lines[0].take.volume, expected[0].volume);
    const oldId = await host.evaluate(() => session.activeSessionId);
    const filename = path.join(server.dirs.data, 'clip-settings.dubline'); fs.writeFileSync(filename, archive);
    await host.evaluate(() => { openFilesModal(); switchFilesTab('import'); });
    await (await host.$('#projectInput')).uploadFile(filename);
    await waitFor(host, id => session.activeSessionId !== id && session.lines[0].audioUrl, 15000, oldId);
    for (const [i, line] of (await lines(host)).entries()) {
      for (const field of ['volume', 'pan', 'effectAmount', 'effect', 'pitch', 'recordedBy']) assert.equal(line[field], expected[i][field]);
      assert.equal(line.takeMixRevision, 0);
    }
    await server.restart(); await host.reload(); await waitFor(host, () => session?.loaded && session.lines.length === 4);
    assert.equal((await lines(host))[0].volume, expected[0].volume);
    assert.equal((await lines(host))[0].pan, expected[0].pan);
    assert.equal((await lines(host))[0].effectAmount, expected[0].effectAmount);
  });
});
