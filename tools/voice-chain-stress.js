// Owned temporary scene: actual 25-minute video, 400 takes and three live clients.
// Synthetic voices/noise establish resource and consistency checks, not listening quality.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { startServer, launchBrowser, openPlayer, waitFor } = require('../e2e/helpers');
const directory = path.resolve('audit/voice-chains'); fs.mkdirSync(directory, { recursive: true });
(async () => {
  let server, browser;
  try {
    server = await startServer(); const video = path.join(server.dirs.data, 'long.mp4');
    const generated = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x72:r=2:d=1500', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video], { windowsHide: true }); assert.equal(generated.status, 0, String(generated.stderr));
    browser = await launchBrowser(server.port); const host = await openPlayer(browser, server.url('chain-stress'), 'Host'), a = await openPlayer(browser, server.url('chain-stress'), 'Listener A'), b = await openPlayer(browser, server.url('chain-stress'), 'Listener B');
    const stamp = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
    const srt = Array.from({ length: 400 }, (_, i) => { const at = i === 399 ? 1499 : i * 3 + 1; return `${i + 1}\n${stamp(at)} --> ${stamp(at + 1)}\nLine ${i + 1}\n`; }).join('\n');
    await host.evaluate(async (bytes, srt) => {
      const form = new FormData(); form.append('room', currentRoom); form.append('clientId', clientId); form.append('sessionId', session.activeSessionId || ''); form.append('title', '25-minute chain stress');
      form.append('video', new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), 'long.mp4'); form.append('subtitles', new Blob([srt], { type: 'text/plain' }), 'long.srt');
      const response = await fetch('/api/upload-custom?room=' + encodeURIComponent(currentRoom), { method: 'POST', body: form }); if (!response.ok) throw Error(await response.text());
    }, Array.from(fs.readFileSync(video)), srt);
    await waitFor(host, () => session.lines.length === 400 && Number.isFinite(video.duration), 30000);
    for (const page of [a, b]) await waitFor(page, () => session.lines.length === 400);
    // Mode switches have no ACK; observe the authoritative scene before edits.
    await host.evaluate(() => socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'edit' })); await waitFor(host, () => session.mode === 'edit');
    await host.evaluate(async () => {
      for (let i = 0; i < 4; i++) {
        const lines = session.lines.filter((_, index) => index % 4 === i).map(line => ({ lineId: line.id, revision: line.revision || 0 }));
        const result = await new Promise(resolve => socket.emit('set_lines_character', { sessionId: session.activeSessionId, character: 'Role ' + i, lines }, resolve)); if (!result.ok) throw Error(JSON.stringify(result));
      }
      socket.emit('set_session_mode', { sessionId: session.activeSessionId, mode: 'dub' });
    }); await waitFor(host, () => session.mode === 'dub');
    const setup = await host.evaluate(async () => {
      const roles = [...new Set(session.lines.map(line => line.character))]; for (const role of roles) socket.emit('claim_character', { sessionId: session.activeSessionId, character: role });
      while (roles.some(role => session.characterClaims[role] !== myName)) await new Promise(resolve => setTimeout(resolve, 20));
      const started = performance.now(), buffer = new AudioBuffer({ length: 38400, sampleRate: 48000, numberOfChannels: 1 }), pcm = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) pcm[i] = .07 * Math.sin(2 * Math.PI * (210 * i / 48000 + 100 * (i / 48000) ** 2));
      const blob = new Blob([audioBufferToWav(buffer)], { type: 'audio/wav' });
      for (const line of session.lines) await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: line.id, nick: myName, audioStart: line.start, blob, createdAt: Date.now() });
      for (const line of session.lines.slice(0, 4)) await submitTake({ uploadId: newUploadId(), room: currentRoom, sessionId: session.activeSessionId, lineId: line.id, nick: myName, audioStart: line.start, blob, createdAt: Date.now() });
      return performance.now() - started;
    });
    await waitFor(host, () => session.lines.every(line => line.audioUrl) && !pendingTakes.size, 90000);
    const before = Object.fromEntries(fs.readdirSync(server.dirs.uploads).filter(name => name.startsWith('line_')).map(name => [name, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(server.dirs.uploads, name))).digest('hex')]));
    const configured = await host.evaluate(async () => {
      const send = (event, data) => new Promise(resolve => socket.emit(event, { sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now(), ...data }, resolve));
      const noise = await send('noise_update', { ...DublineNoiseModel.protocol(), revision: session.noiseReduction.revision, actor: { enabled: true, strength: .6 } });
      if (!noise.ok) throw Error(JSON.stringify(noise));
      const pairs = [['robot', 'echo'], ['telephone', 'cave'], ['monster', 'echo'], ['thoughts', 'radio']];
      for (let i = 0; i < 4; i++) {
        const result = await send('voice_update', { scope: 'role', character: 'Role ' + i, revision: 0, settings: { pitch: [-2, 1, -4, 0][i], effects: pairs[i].map((type, index) => ({ id: type, type, amount: index ? .3 : .45, enabled: true, parameters: type === 'echo' ? { delay: .15, feedback: .3 } : {} })) } });
        if (!result.ok) throw Error(JSON.stringify(result));
      }
      const owns = await send('voice_update', { scope: 'takes', action: 'replace', takes: session.lines.slice(0, 100).map(line => ({ lineId: line.id, character: line.character, takeId: line.takeId, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision })), settings: { effects: [{ id: 'phone', type: 'telephone', enabled: true, amount: .4, parameters: {} }], pitchMode: 'inherit', inheritRoleEffects: true, excludedRoleEffectIds: [] } });
      if (!owns.ok) throw Error(JSON.stringify(owns)); return { roles: 4, pairs };
    });
    for (const page of [a, b]) await waitFor(page, () => session.lines[0].effects?.[0]?.type === 'telephone');
    const parity = []; for (const page of [host, a, b]) parity.push(await page.evaluate(async () => { const line = session.lines[0], pcm = (await getProcessedTake(line)).getChannelData(0); return { samples: Array.from(pcm), length: pcm.length, energy: pcm.reduce((sum, value) => sum + value * value, 0), config: DublineVoiceChain.resolve(line, session), noise: DublineNoiseModel.resolve(line, session)?.strength, stats: DublineNoiseAudio.stats(), rawRate: (await audio.getRawTake(line.audioUrl)).sampleRate }; }));
    for (const result of parity.slice(1)) {
      assert.equal(result.length, parity[0].length); assert.deepEqual(result.config, parity[0].config); let maximum = 0;
      for (let i = 0; i < result.samples.length; i++) maximum = Math.max(maximum, Math.abs(result.samples[i] - parity[0].samples[i]));
      result.maximumSampleDifference = maximum; assert.ok(maximum < 2e-6, 'PCM mismatch: ' + maximum);
    }
    parity.forEach(result => delete result.samples);
    const exportResult = await a.evaluate(async () => {
      const started = performance.now(), samples = [], snapshot = createExportSnapshot(); snapshot.originalUrl = ''; snapshot.backingUrl = ''; snapshot.gains.original = 0; snapshot.gains.backing = 0;
      const blob = await renderWithWebCodecs(() => { samples.push({ heap: performance.memory?.usedJSHeapSize || null, cache: audio.cacheStats() }); }, snapshot);
      return { milliseconds: performance.now() - started, bytes: blob.size, output: Array.from(new Uint8Array(await blob.arrayBuffer())), memorySamples: samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 20)) === 0), cache: audio.cacheStats() };
    });
    const output = path.join(directory, 'stress-output.mp4'); fs.writeFileSync(output, Buffer.from(exportResult.output)); delete exportResult.output;
    const hash = file => { const result = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { windowsHide: true, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
    assert.equal(hash(video), hash(output));
    const probe = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', output], { windowsHide: true, encoding: 'utf8' });
    const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr); assert.ok(duration);
    const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]); assert.ok(Math.abs(seconds - 1500) < .1);
    for (const [name, digest] of Object.entries(before)) assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(server.dirs.uploads, name))).digest('hex'), digest);
    const result = { durationSeconds: 1500, outputDurationSeconds: seconds, lines: 400, participants: 3, originalAudioFiles: Object.keys(before).length, uploadMilliseconds: setup, configuration: configured, parity, export: exportResult, videoPacketsIdentical: true, originalFilesUnchanged: true };
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, export: { ...exportResult, memorySamples: exportResult.memorySamples.length } }, null, 2));
  } finally { await browser?.close(); await server?.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
