const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('./helpers');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
describe('bundled RNNoise: actual DSP, private drafts, acknowledged author settings and projects', { skip: skipReason, timeout: 240000 }, () => {
  let server, browser, host, guest, originalHash;
  const scene = page => page.evaluate(() => structuredClone(session));
  async function update(page, actor, extra = {}) {
    return page.evaluate((actor, extra) => new Promise(resolve => socket.emit('noise_update', {
      ...DublineNoiseModel.protocol(), actor, sessionId: session.activeSessionId, revision: session.noiseReduction.revision,
      operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), ...extra
    }, resolve)), actor, extra);
  }
  async function upload(page, id, seconds = 2) {
    const result = await page.evaluate(async (id, seconds) => {
      const sequence = await reserveTake(id, session.activeSessionId), buffer = new AudioBuffer({ length: Math.round(48000 * seconds), numberOfChannels: 1, sampleRate: 48000 });
      let random = 13; const pcm = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; pcm[i] = .08 * Math.sin(i * .1) + .025 * (random / 4294967296 * 2 - 1); }
      const form = new FormData();
      for (const [key, value] of Object.entries({ lineId: id, clientId, userName: myName, sessionId: session.activeSessionId, takeSequence: sequence, uploadId: newUploadId(), audioStart: 0 })) form.append(key, value);
      form.append('audio', new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' }), 'take.wav');
      const response = await fetch('/api/upload-line-audio?room=' + currentRoom, { method: 'POST', body: form }); return response.status;
    }, id, seconds);
    assert.equal(result, 200); await waitFor(page, id => !!session.lines.find(l => l.id === id).audioUrl, 10000, id);
  }
  const open = async () => { await guest.evaluate(() => DublineNoise.open()); await waitFor(guest, () => !!DublineNoise.snapshot()); };
  const setStrength = value => guest.evaluate(value => { noiseStrength.value = value; noiseStrength.dispatchEvent(new Event('input')); }, value);
  const close = async () => { await guest.evaluate(() => closeSettingsModal()); await waitFor(guest, () => settingsModal.style.display === 'none'); };
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('noise'), 'Host'); guest = await openPlayer(browser, server.url('noise'), 'Actor');
    await loadFixture(host); await waitFor(guest, () => session?.loaded);
    await guest.evaluate(() => socket.emit('claim_character', { character: 'Hero', sessionId: session.activeSessionId }));
    await host.evaluate(() => socket.emit('claim_character', { character: 'Friend', sessionId: session.activeSessionId }));
    await waitFor(guest, () => session.characterClaims.Hero === 'Actor');
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('no calibration or offer; settings work before the first recording', async () => {
    await open(); assert.equal(await guest.evaluate(() => !!document.querySelector('#noiseOffer, #noiseCalibrate, #noiseDialog')), false);
    assert.equal(await guest.evaluate(() => noisePreviewPlay.disabled), true);
    assert.deepEqual(await guest.evaluate(() => DublineNoise.snapshot().draft), { enabled: false, strength: .6 });
    await guest.click('#noiseCard .switch-ui'); await close();
    assert.equal((await scene(guest)).noiseReduction.actors.Actor.enabled, true);
    assert.equal(await guest.evaluate(() => DublineAudioDevices.busy()), false);
    assert.equal((await update(guest, { enabled: false, strength: .6 })).ok, true);
  });
  test('real model handles partial frames, resampling, stereo isolation and independent tasks', async () => {
    const result = await guest.evaluate(async () => {
      const rows = [], setting = { ...DublineNoiseModel.protocol(), enabled: true, strength: 1 };
      for (const [length, rate, channels] of [[1,48000,1],[99,44100,1],[1001,44100,2],[48091,48000,2]]) {
        const raw = new AudioBuffer({ length, sampleRate: rate, numberOfChannels: channels });
        for (let i = 0; i < length; i++) raw.getChannelData(0)[i] = .13 * Math.sin(i * .073) + .03 * Math.sin(i * 91.73);
        const before = raw.getChannelData(0).slice(), a = await DublineNoiseAudio.clean(raw, setting, null, true), b = await DublineNoiseAudio.clean(raw, setting, null, true);
        rows.push({ length: a.length, rate: a.sampleRate, channels: a.numberOfChannels, finite: [...a.getChannelData(0)].every(Number.isFinite),
          original: before.every((v,i) => v === raw.getChannelData(0)[i]), repeat: a.getChannelData(0).every((v,i) => v === b.getChannelData(0)[i]),
          silent: channels === 1 || a.getChannelData(1).every(v => v === 0), difference: before.reduce((s,v,i) => s + (v-a.getChannelData(0)[i])**2, 0) });
      }
      return { rows, stats: DublineNoiseAudio.stats() };
    });
    assert.deepEqual(result.rows.map(r => [r.length,r.rate,r.channels]), [[1,48000,1],[99,44100,1],[1001,44100,2],[48091,48000,2]]);
    assert.ok(result.rows.every(r => r.finite && r.original && r.repeat && r.silent), JSON.stringify(result));
    assert.ok(result.rows[3].difference > .01); assert.equal(result.stats.last.delay, 960); assert.equal(result.stats.queuedBytes, 0);
  });
  test('current and historical takes use recordedBy, without binding or changing stored bytes', async () => {
    await upload(guest, 1); await upload(guest, 1); await upload(guest, 3); await upload(host, 2);
    await waitFor(guest, () => session.lines.find(l => l.id === 1).takeHistory.length === 1 && session.lines.find(l => l.id === 2).recordedBy === 'Host');
    const state = await scene(guest), take = state.lines.find(l => l.id === 1);
    originalHash = hash(fs.readFileSync(path.join(server.dirs.uploads, path.basename(take.audioUrl))));
    assert.equal(Object.hasOwn(take, 'noiseProfileId'), false); assert.equal(Object.hasOwn(take.takeHistory[0], 'noiseProfileId'), false);
    assert.equal((await update(guest, { enabled: true, strength: .6 })).ok, true);
    await waitFor(host, () => session.noiseReduction.actors.Actor?.enabled);
    assert.deepEqual((await scene(guest)).lines, state.lines);
    const resolved = await guest.evaluate(() => { const l = session.lines.find(l => l.id === 1); return [DublineNoiseModel.resolve(l, session)?.strength,
      DublineNoiseModel.resolve({ ...l, ...l.takeHistory[0] }, session)?.strength, DublineNoiseModel.resolve(session.lines.find(l => l.id === 2), session)]; });
    assert.deepEqual(resolved, [.6,.6,null]);
    assert.equal((await update(host, { enabled: true, strength: .9 }, { author: 'Actor' })).ok, false);
    assert.equal((await update(guest, { enabled: true, strength: .6 }, { profileId: 'old' })).ok, false);
  });
  test('stable private preview reuses Wet, keeps its position and commits once on exit', async () => {
    await guest.evaluate(() => { window.noiseSent = []; const original = socket.emit.bind(socket); socket.emit = function(event,...args) { if (event === 'noise_update') noiseSent.push(structuredClone(args[0])); return original(event,...args); }; });
    const before = await scene(guest), time = await guest.evaluate(() => video.currentTime);
    await open(); await guest.click('#noisePreviewPlay'); await waitFor(guest, () => DublineNoise.snapshot()?.playing && DublineNoise.previewPosition() > .05);
    const sample = await guest.evaluate(() => DublineNoise.snapshot().sampleId), count = await guest.evaluate(() => DublineNoiseAudio.stats().completed);
    await setStrength(25); await waitFor(guest, () => !DublineNoise.snapshot().preparing && DublineNoise.snapshot().draft.strength === .25);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await guest.evaluate(() => DublineNoise.snapshot().sampleId), sample);
    assert.equal(await guest.evaluate(() => DublineNoiseAudio.stats().completed), count);
    assert.equal(await guest.evaluate(() => noiseSent.length), 0); assert.deepEqual((await scene(guest)).noiseReduction, before.noiseReduction);
    assert.equal(await guest.evaluate(() => video.currentTime), time);
    await close(); assert.equal(await guest.evaluate(() => noiseSent.length), 1); assert.equal((await scene(guest)).noiseReduction.actors.Actor.strength, .25);
    await open(); await close(); assert.equal(await guest.evaluate(() => noiseSent.length), 1);
  });
  test('a commit preserves already playing takes and leaving the category commits a draft', async () => {
    await host.evaluate(async () => { window.noiseEnded = false; await audio.previewTake(session.lines.find(l => l.id === 1), { onEnded: () => noiseEnded = true }); });
    await open(); await setStrength(50); await guest.evaluate(() => openSettingsCategory('user', 'interface'));
    await waitFor(guest, () => session.noiseReduction.actors.Actor.strength === .5 && document.getElementById('settings-user-audio').hidden);
    assert.equal(await host.evaluate(() => noiseEnded), false); await host.evaluate(() => audio.stopPreview()); await close();
  });
  test('lost acknowledgements resolve through the same immutable operation receipt', async () => {
    await open(); await setStrength(60);
    await guest.evaluate(() => { window.noiseEmit = socket.emit; window.lostIds = []; socket.emit = function(event,...args) {
      if (event === 'noise_update') { lostIds.push(args[0].operationId); const cb = args.pop(); args.push(() => {}); setTimeout(() => cb(Error('Simulated lost ACK')), 5100); }
      return noiseEmit.call(this,event,...args);
    }; });
    try { await close(); assert.deepEqual(await guest.evaluate(() => lostIds), await guest.evaluate(() => [lostIds[0],lostIds[0]])); }
    finally { await guest.evaluate(() => { socket.emit = noiseEmit; }); }
    assert.equal((await scene(guest)).noiseReduction.actors.Actor.strength, .6);
  });
  test('disk failure retains draft and confirmed state until explicit retry', async () => {
    await open(); await setStrength(75);
    const blocker = path.join(server.dirs.data, 'rooms.json.tmp'); fs.mkdirSync(blocker);
    try {
      assert.equal(await guest.evaluate(() => DublineNoise.beforeExit()), false);
      assert.equal((await scene(guest)).noiseReduction.actors.Actor.strength, .6);
      assert.equal(await guest.evaluate(() => DublineNoise.snapshot().draft.strength), .75);
      assert.equal(await guest.evaluate(() => noiseRetry.hidden), false);
    } finally { fs.rmdirSync(blocker); }
    await guest.click('#noiseRetry'); await waitFor(guest, () => session.noiseReduction.actors.Actor.strength === .75); await close();
  });
  test('strength zero bypasses the model; frozen exports and Dry/Wet match the exact formula', async () => {
    const result = await guest.evaluate(async () => {
      const line = session.lines.find(l => l.id === 3), raw = await audio.getRawTake(line.audioUrl), wet = await audio.getNoiseWet(line);
      const rows = [];
      for (const strength of [0,.25,.5,.6,.75,1]) {
        const count = DublineNoiseAudio.stats().completed, setting = { ...DublineNoiseModel.protocol(), enabled: true, strength };
        const output = await getProcessedTake({ ...line, _exportNoise: setting }); let error = 0;
        for (let i=0;i<output.length;i++) error=Math.max(error,Math.abs(output.getChannelData(0)[i]-(raw.getChannelData(0)[i]*(1-strength)+wet.getChannelData(0)[i]*strength)));
        rows.push({ error, work: DublineNoiseAudio.stats().completed-count });
      }
      const snapshot = createExportSnapshot(), frozen = snapshot.takes.find(l=>l.id===3);
      return { rows, frozen: frozen._exportNoise.strength, normal: session.noiseReduction.actors.Actor.strength };
    });
    assert.ok(result.rows.every(r => r.error < 1e-7 && r.work === 0), JSON.stringify(result)); assert.equal(result.frozen,.75);
  });
  test('zero strength on a cold source bypasses RNNoise; model failure retries but cannot silently export dry audio', async () => {
    const result = await guest.evaluate(async () => {
      const line = session.lines.find(l => l.id === 3), strength = session.noiseReduction.actors.Actor.strength;
      DublineNoiseAudio.cancelAll(); audio.invalidateSource(line.audioUrl);
      const completed = DublineNoiseAudio.stats().completed;
      const zero = await getProcessedTake({ ...line, _exportNoise: { ...DublineNoiseModel.protocol(), enabled: true, strength: 0 } });
      const bypass = DublineNoiseAudio.stats().completed === completed;
      audio.invalidateSource(line.audioUrl); const originalWorker = window.Worker; window.Worker = undefined;
      let fallback, exportRefused = false;
      try {
        fallback = await getProcessedTake(line);
        try { await requireExportTake({ ...line, _exportNoise: { ...DublineNoiseModel.protocol(), enabled: true, strength } }); } catch { exportRefused = true; }
      } finally { window.Worker = originalWorker; }
      const retried = await getProcessedTake(line);
      return { bypass, zero: zero.length, fallback: fallback.length, retried: retried.length, exportRefused,
        neuralRuns: DublineNoiseAudio.stats().completed - completed, fallbackCount: DublineNoiseAudio.stats().fallback };
    });
    assert.ok(result.bypass && result.zero > 0 && result.fallback > 0 && result.retried > 0 && result.exportRefused, JSON.stringify(result));
    assert.equal(result.neuralRuns, 1); assert.ok(result.fallbackCount > 0);
  });
  test('Next chooses another own recording; Escape commits one draft without timeline changes', async () => {
    await open(); await guest.click('#noisePreviewPlay'); await waitFor(guest, () => DublineNoise.snapshot()?.playing);
    const previous = await guest.evaluate(() => DublineNoise.snapshot().sampleUrl), time = await guest.evaluate(() => video.currentTime);
    await guest.click('#noiseNext'); await guest.click('#noisePreviewPlay'); await waitFor(guest, () => DublineNoise.snapshot()?.playing);
    assert.notEqual(await guest.evaluate(() => DublineNoise.snapshot().sampleUrl), previous);
    await setStrength(60); await guest.keyboard.press('Escape'); await waitFor(guest, () => settingsModal.style.display === 'none' && session.noiseReduction.actors.Actor.strength === .6);
    assert.equal(await guest.evaluate(() => video.currentTime), time);
    assert.equal((await update(guest, { enabled: true, strength: .75 })).ok, true);
  });
  test('edits during first preparation use the latest strength; pause cancels a queued refresh', async () => {
    await guest.evaluate(() => {
      DublineNoiseAudio.cancelAll(); for (const item of DublineNoise.ownTakes()) audio.invalidateSource(item.take.audioUrl);
      window.auditionApi = DublineNoiseAudio; window.auditionMixes = [];
      window.DublineNoiseAudio = { ...auditionApi, mix(dry, wet, strength) { auditionMixes.push(strength); return auditionApi.mix(dry,wet,strength); } };
    });
    try {
      await open(); await guest.click('#noisePreviewPlay'); await waitFor(guest, () => DublineNoise.snapshot()?.preparing);
      await setStrength(25); await waitFor(guest, () => DublineNoise.snapshot()?.playing && !DublineNoise.snapshot().preparing);
      assert.equal(await guest.evaluate(() => auditionMixes.at(-1)), .25);
      await guest.evaluate(() => { noiseStrength.value = 50; noiseStrength.dispatchEvent(new Event('input')); noisePreviewPlay.click(); });
      await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(await guest.evaluate(() => DublineNoise.snapshot().playing), false);
      await setStrength(75); await close();
    } finally { await guest.evaluate(() => { window.DublineNoiseAudio = auditionApi; }); }
  });
  test('legacy clients are refused active RNNoise and block enabling until they leave', async () => {
    const { io } = require('socket.io-client');
    const join = () => {
      const socket = io(`http://localhost:${server.port}`, { transports: ['websocket'], reconnection: false });
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Legacy join timeout')), 5000);
        socket.once('connect', () => socket.emit('join_room', { room: 'noise', nick: 'Legacy', clientId: crypto.randomUUID() }));
        socket.once('join_denied', answer => { clearTimeout(timer); resolve(answer); });
        socket.once('nick_state', answer => { clearTimeout(timer); resolve(answer); });
      });
      return { socket, result };
    };
    let old = join(); try { assert.equal((await old.result).reason, 'noiseVersion'); } finally { old.socket.disconnect(); }
    assert.equal((await update(guest, { enabled: false, strength: .75 })).ok, true);
    old = join();
    try {
      assert.equal((await old.result).nick, 'Legacy'); await waitFor(guest, () => lastOnlineUsers.includes('Legacy'));
      const blocked = await update(guest, { enabled: true, strength: .75 }); assert.equal(blocked.reason, 'noise.clientUpdate');
      assert.equal((await scene(guest)).noiseReduction.actors.Actor.enabled, false);
    } finally { old.socket.disconnect(); }
    await waitFor(guest, () => !lastOnlineUsers.includes('Legacy'));
    assert.equal((await update(guest, { enabled: true, strength: .75 })).ok, true);
  });
  test('confirmed nickname changes move settings with current and historical authors', async () => {
    for (const name of ['Renamed', 'Actor']) {
      const answer = await guest.evaluate(newName => new Promise(resolve => socket.emit('rename_user', { newName }, resolve)), name); assert.equal(answer.ok, true);
      await waitFor(guest, name => myName === name && session.noiseReduction.actors[name]?.strength === .75, 10000, name);
      const result = await guest.evaluate(name => { const line = session.lines.find(l => l.id === 1); return { current: line.recordedBy, historical: line.takeHistory[0].recordedBy,
        currentStrength: DublineNoiseModel.resolve(line, session)?.strength, historyStrength: DublineNoiseModel.resolve(line.takeHistory[0], session)?.strength }; }, name);
      assert.deepEqual(result, { current: name, historical: name, currentStrength: .75, historyStrength: .75 });
    }
  });
  test('project v9 reopen and restart retain author settings/history/original bytes', async () => {
    const before = await scene(guest);
    const bytes = await host.evaluate(async () => { const snapshot = await prepareSafeSnapshot('project'); const response = await fetch('/api/export-project', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({room:currentRoom,clientId,...snapshot}) }); if(!response.ok) throw Error(await response.text()); return [...new Uint8Array(await response.arrayBuffer())]; });
    const project = require('../src/server/projects').readProject(Buffer.from(bytes)); assert.equal(project.manifest.formatVersion,9);
    assert.deepEqual(project.manifest.project.noiseReduction.actors,before.noiseReduction.actors);
    assert.equal(project.manifest.project.lines.find(l=>l.id===1).takeHistory.length,1);
    await server.restart(); await waitFor(guest, () => socket.connected && myName === 'Actor' && session.noiseReduction.actors.Actor?.strength === .75,15000);
    assert.deepEqual((await scene(guest)).noiseReduction.actors,before.noiseReduction.actors);
    const take = (await scene(guest)).lines.find(l=>l.id===1); assert.equal(hash(fs.readFileSync(path.join(server.dirs.uploads,path.basename(take.audioUrl)))),originalHash);
    const imported = await host.evaluate(async bytes => {
      const form = new FormData(); form.append('clientId', clientId); form.append('sessionId', session.activeSessionId);
      form.append('project', new Blob([new Uint8Array(bytes)]), 'rnnoise.dubline');
      const response = await fetch('/api/import-project?room=' + currentRoom, { method: 'POST', body: form });
      if (!response.ok) throw Error(await response.text()); return (await response.json()).session.activeSessionId;
    }, bytes);
    await waitFor(guest, id => session.activeSessionId === id, 10000, imported);
    const reopened = await scene(guest), reopenedTake = reopened.lines.find(l => l.id === 1);
    assert.deepEqual(reopened.noiseReduction.actors, before.noiseReduction.actors); assert.equal(reopenedTake.takeHistory.length, 1);
    assert.equal(hash(fs.readFileSync(path.join(server.dirs.uploads, path.basename(reopenedTake.audioUrl)))), originalHash);
  });
  test('six themes and three languages fit the compact settings card at 150% zoom', async () => {
    await guest.setViewport({width:800,height:650});
    for (const theme of ['midnight','graphite','light','ocean','forest','sunset']) for(const language of ['en','ru','uk']) {
      await open(); const size=await guest.evaluate((theme,language)=>{document.documentElement.dataset.theme=theme;DublineI18n.setLanguage(language);document.body.style.zoom='1.5';return {width:noiseCard.clientWidth,scroll:noiseCard.scrollWidth,text:noiseCard.querySelector('[data-i18n="noise.title"]').textContent};},theme,language);
      assert.ok(size.scroll<=size.width+1,JSON.stringify(size)); assert.ok(!size.text.startsWith('noise.')); await close();
    }
    await guest.evaluate(()=>{document.body.style.zoom='';});
  });
  test('ordinary HTTP loads the local model; a fresh scene does not inherit the old author draft', async () => {
    const httpBrowser=await launchBrowser(server.port,{secureOrigin:false});
    try { const page=await openPlayer(httpBrowser,server.url('noise','dubline.test'),'HTTP Listener'); await waitFor(page,()=>session?.loaded);
      const result=await page.evaluate(async()=>({secure:isSecureContext,length:(await getProcessedTake(session.lines.find(l=>l.id===1))).length,engine:DublineNoiseModel.resolve(session.lines.find(l=>l.id===1),session).engine}));
      assert.equal(result.secure,false); assert.ok(result.length>0); assert.equal(result.engine,'rnnoise');
    } finally { await httpBrowser.close(); }
    await open(); await setStrength(90); const id=(await scene(guest)).activeSessionId;
    await host.evaluate(()=>loadSavedPack('test-scene.zip')); await waitFor(guest,id=>session.activeSessionId!==id,10000,id);
    assert.deepEqual(await guest.evaluate(()=>DublineNoise.snapshot().draft),{enabled:false,strength:.6}); await close();
  });
  test('no unhandled renderer errors',()=>{assert.deepEqual(host.errors,[]);assert.deepEqual(guest.errors,[]);});
});
