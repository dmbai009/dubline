// Owned temporary scene: actual 25-minute video, 400 takes and ten live clients.
// Synthetic voices/noise establish resource and consistency checks, not listening quality.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const baseline = process.argv.includes('--baseline'), levels = process.argv.includes('--levels');
if (baseline && levels) throw Error('The baseline has no voice level setting');
const baselineRoot = process.env.DUBLINE_BASELINE_DIR || path.resolve(__dirname, '../../dubline-baseline-audit-4992faf');
const { startServer, launchBrowser, openPlayer, waitFor } = require(baseline ? path.join(baselineRoot, 'e2e/helpers') : '../e2e/helpers');
const directory = path.resolve('audit/live-presets/' + (baseline ? 'baseline-stress' : levels ? 'level-stress' : 'linked-stress')); fs.mkdirSync(directory, { recursive: true });
(async () => {
  let server, browser;
  try {
    server = await startServer(); const video = path.join(server.dirs.data, 'long.mp4');
    const generated = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x72:r=2:d=1500', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video], { windowsHide: true }); assert.equal(generated.status, 0, String(generated.stderr));
    browser = await launchBrowser(server.port); const pages=[]; for(let i=0;i<10;i++) pages.push(await openPlayer(browser,server.url('chain-stress'),i ? 'Actor '+i : 'Host')); const [host,a,b]=pages;
    const stamp = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
    const srt = Array.from({ length: 400 }, (_, i) => { const at = i === 399 ? 1499 : i * 3 + 1; return `${i + 1}\n${stamp(at)} --> ${stamp(at + 1)}\nLine ${i + 1}\n`; }).join('\n');
    await host.evaluate(async (bytes, srt) => {
      const form = new FormData(); form.append('room', currentRoom); form.append('clientId', clientId); form.append('sessionId', session.activeSessionId || ''); form.append('title', '25-minute chain stress');
      form.append('video', new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), 'long.mp4'); form.append('subtitles', new Blob([srt], { type: 'text/plain' }), 'long.srt');
      const response = await fetch('/api/upload-custom?room=' + encodeURIComponent(currentRoom), { method: 'POST', body: form }); if (!response.ok) throw Error(await response.text());
    }, Array.from(fs.readFileSync(video)), srt);
    await waitFor(host, () => session.lines.length === 400 && Number.isFinite(video.duration), 30000);
    for (const page of pages.slice(1)) await waitFor(page, () => session.lines.length === 400);
    // Mode switches have no ACK; observe the authoritative scene before edits.
    await host.evaluate(() => socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'edit' })); await waitFor(host, () => session.mode === 'edit');
    await host.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        const lines = session.lines.filter((_, index) => index % 10 === i).map(line => ({ lineId: line.id, revision: line.revision || 0 }));
        const result = await new Promise(resolve => socket.emit('set_lines_character', { sessionId: session.activeSessionId, character: 'Role ' + i, lines }, resolve)); if (!result.ok) throw Error(JSON.stringify(result));
      }
      socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'dub' });
    }); await waitFor(host, () => session.mode === 'dub');
    let setup=0; for (let actorIndex=0;actorIndex<pages.length;actorIndex++) setup += await pages[actorIndex].evaluate(async actorIndex => {
      const roles = ['Role '+actorIndex]; for (const role of roles) socket.emit('claim_character', { sessionId: session.activeSessionId, character: role });
      while (roles.some(role => session.characterClaims[role] !== myName)) await new Promise(resolve => setTimeout(resolve, 20));
      const started = performance.now(), buffer = new AudioBuffer({ length: 38400, sampleRate: 48000, numberOfChannels: 1 }), pcm = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) pcm[i] = .07 * Math.sin(2 * Math.PI * (210 * i / 48000 + 100 * (i / 48000) ** 2));
      const blob = new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' });
      for (const line of session.lines.filter(line=>line.character===roles[0])) await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: line.id, nick: myName, audioStart: line.start, blob, createdAt: Date.now() });
      for (const line of session.lines.filter(line=>line.character===roles[0]).slice(0,1)) await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: line.id, nick: myName, audioStart: line.start, blob, createdAt: Date.now() });
      return performance.now() - started;
    },actorIndex);
    await waitFor(host, () => session.lines.every(line => line.audioUrl) && !pendingTakes.size, 90000);
    const before = Object.fromEntries(fs.readdirSync(server.dirs.uploads).filter(name => name.startsWith('line_')).map(name => [name, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(server.dirs.uploads, name))).digest('hex')]));
    const configured = await host.evaluate(async baseline => {
      const send = (event, data) => new Promise(resolve => socket.emit(event, { sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), ...data }, resolve));
      const pairs = [['robot', 'echo'], ['telephone', 'cave'], ['monster', 'echo'], ['thoughts', 'radio']];
      for (let i = 0; i < 10; i++) {
        const result = await send('voice_update', { scope: 'role', character: 'Role ' + i, revision: 0, settings: { pitch: [-2, 1, -4, 0][i%4], effects: pairs[i%4].map((type, index) => ({ id: type, type, amount: index ? .3 : .45, enabled: true, parameters: type === 'echo' ? { delay: .15, feedback: .3 } : {} })) } });
        if (!result.ok) throw Error(JSON.stringify(result));
      }
      const created = await send('voice_preset_update', { action: 'create', id: 'shared-phone', revision: 0, name: '400 shared lines', settings: { effects: [{ id: 'phone', type: 'telephone', enabled: true, amount: .4, parameters: {} }] } }); if (!created.ok) throw Error(JSON.stringify(created));
      const started = performance.now();
      const owns = await send('voice_update', { scope: 'takes', action: 'replace', takes: session.lines.map(line => ({ lineId: line.id, character: line.character, takeId: line.takeId, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision })), editPreset: !baseline, presetRevision: 1, settings: { effects: baseline ? [{ id: 'phone', type: 'telephone', enabled: true, amount: .4, parameters: {} }] : [], pitchMode: 'inherit', inheritRoleEffects: true, excludedRoleEffectIds: [], ...(baseline ? {} : { voicePresetId: 'shared-phone', usePresetPitch: false }) } });
      if (!owns.ok) throw Error(JSON.stringify(owns)); return { roles: 10, pairs, bulkMilliseconds: performance.now() - started, linked: !baseline };
    }, baseline);
    for (const page of pages) {
      const answer=await page.evaluate(()=>new Promise(resolve=>socket.emit('noise_update',{...DublineNoiseModel.protocol(),actor:{enabled:true,strength:.6},sessionId:session.activeSessionId,revision:session.noiseReduction.revision,operationId:newUploadId(),operationEpoch:session.editorProtocol.epoch,operationTime:Date.now()},resolve))); assert.equal(answer.ok,true,JSON.stringify(answer));
      await waitFor(host,count=>Object.keys(session.noiseReduction.actors).length>=count,10000,pages.indexOf(page)+1);
    }
    for(const page of pages) await waitFor(page,()=>Object.keys(session.noiseReduction.actors).length===10 && session.lines.every(line=>DublineNoiseModel.resolve(line,session)?.strength===.6));
    if (levels) { const answer = await host.evaluate(() => new Promise(resolve => socket.emit('project_audio_update', { sessionId: session.activeSessionId, channel: 'settings', field: 'normalizeVoices', value: true, revision: session.projectAudio.revision }, resolve))); assert.equal(answer.ok, true); for (const page of pages) await waitFor(page, () => session.projectAudio.normalizeVoices); }
    const parity = []; for (const page of [host, a, b]) parity.push(await page.evaluate(async () => { const line = session.lines[0], pcm = (await getProcessedTake(line)).getChannelData(0); return { levelGain: audio.getLevelGain(await getProcessedTake(line), line), samples: Array.from(pcm), length: pcm.length, energy: pcm.reduce((sum, value) => sum + value * value, 0), config: DublineVoiceChain.resolve(line, session), noise: DublineNoiseModel.resolve(line, session)?.strength, stats: DublineNoiseAudio.stats(), rawRate: (await audio.getRawTake(line.audioUrl)).sampleRate }; }));
    for (const result of parity.slice(1)) {
      assert.equal(result.length, parity[0].length); assert.ok(Math.abs(result.levelGain - parity[0].levelGain) < 1e-9); assert.deepEqual(result.config, parity[0].config); let maximum = 0;
      for (let i = 0; i < result.samples.length; i++) maximum = Math.max(maximum, Math.abs(result.samples[i] - parity[0].samples[i]));
      result.maximumSampleDifference = maximum; assert.ok(maximum < 2e-6, 'PCM mismatch: ' + maximum);
    }
    parity.forEach(result => delete result.samples);
    const behavior=await a.evaluate(async()=>{
      const take=session.lines[0], first=await getProcessedTake(take); await audio.getNoiseWet(take); while(DublineNoiseAudio.stats().active || DublineNoiseAudio.stats().queued) await new Promise(resolve=>setTimeout(resolve,20)); const completed=DublineNoiseAudio.stats().completed;
      const mixStarted=performance.now();for(const strength of [.25,.5,.6,.75,1])await getProcessedTake({...take,_exportNoise:{...DublineNoiseModel.protocol(),enabled:true,strength}});
      const mixesMs=performance.now()-mixStarted;const reprocess=DublineNoiseAudio.stats().completed-completed;
      for(let i=0;i<80;i++){video.currentTime=(i*137)%1490;audio.precacheTakes(video.currentTime);}
      await new Promise(resolve=>setTimeout(resolve,1000));
      const long=new AudioBuffer({length:48000*60,sampleRate:48000,numberOfChannels:2});for(let i=0;i<long.length;i++){long.getChannelData(0)[i]=.05*Math.sin(i*.03);long.getChannelData(1)[i]=.02*Math.sin(i*.11);}
      const start=performance.now();await DublineNoiseAudio.wet(long);const longMs=performance.now()-start;
      return {mixesMs,neuralRerunsForStrength:reprocess,longStereoSeconds:60,longMs,longMetrics:DublineNoiseAudio.stats().last,cache:audio.cacheStats(),queue:DublineNoiseAudio.stats()};
    }); assert.equal(behavior.neuralRerunsForStrength,0);
    const exportResult = await a.evaluate(async () => {
      const started = performance.now(), samples = [], snapshot = createExportSnapshot(); if(snapshot.takes.length!==400 || snapshot.takes.some(line=>line._exportNoise?.strength!==.6))throw Error('Incomplete RNNoise export snapshot'); snapshot.originalUrl = ''; snapshot.backingUrl = ''; snapshot.gains.original = 0; snapshot.gains.backing = 0;
      const blob = await renderWithWebCodecs(() => { samples.push({ heap: performance.memory?.usedJSHeapSize || null, cache: audio.cacheStats() }); }, snapshot);
      return { milliseconds: performance.now() - started, bytes: blob.size, output: Array.from(new Uint8Array(await blob.arrayBuffer())), memorySamples: samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 20)) === 0), cache: audio.cacheStats(),queue:DublineNoiseAudio.stats(),analysis:window.DublineSpeechAnalysis?.stats() };
    });
    assert.ok(exportResult.queue.completed>=400,JSON.stringify(exportResult.queue));
    const output = path.join(directory, 'stress-output.mp4'); fs.writeFileSync(output, Buffer.from(exportResult.output)); delete exportResult.output;
    const hash = file => { const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { windowsHide: true, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    assert.equal(hash(video), hash(output));
    const probe = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', output], { windowsHide: true, encoding: 'utf8' });
    const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr); assert.ok(duration);
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]); assert.ok(Math.abs(seconds - 1500) < .1);
    for (const [name, digest] of Object.entries(before)) assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(server.dirs.uploads, name))).digest('hex'), digest);
    const result = { baseline, levels, baseCommit: '4992faf10b8130c5ee91b895936ec1b58fc68469', node: process.version, platform: process.platform, cpus: require('node:os').cpus().length, totalMemoryBytes: require('node:os').totalmem(), durationSeconds: 1500, outputDurationSeconds: seconds, lines: 400, participants: 10, originalAudioFiles: Object.keys(before).length, uploadMilliseconds: setup, configuration: configured, behavior, parity, export: exportResult, videoPacketsIdentical: true, originalFilesUnchanged: true };
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, export: { ...exportResult, memorySamples: exportResult.memorySamples.length } }, null, 2));
  } finally { await browser?.close(); await server?.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
