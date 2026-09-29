// Media: P2P video sharing, fallback through the host, video from disk, WebCodecs export
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  skipReason, launchBrowser, startServer, openPlayer, waitFor,
  loadFixture, claimAndSelect, recordTake, buildFixturePack, FIXTURE_LINES, buildMultiTrackVideo
} = require('./helpers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('media', { skip: skipReason }, () => {
  let server;
  let browser;
  let host;
  const room = 'media';
  const pages = [];

  // "Tunnel" players use the second address: P2P is deliberately not used on localhost
  const remote = nick => openPlayer(browser, server.url(room, 'dubline.test'), nick);
  const report = nick => (server.log.match(new RegExp(`${nick} received dub_video\\.mp4: ([\\d.]+) MB from players \\((\\d+)\\), ([\\d.]+) MB from the server`)) || []).slice(1).map(Number);

  before(async () => {
    server = await startServer();
    browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url(room), 'Alice');
    await loadFixture(host);
    pages.push(host);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.cleanup();
  });

  test('first remote player downloads the video from the host and plays it locally', async () => {
    const bob = await remote('Bob');
    pages.push(bob);
    await waitFor(bob, () => localMedia && localMedia.source === 'p2p' && video.currentSrc.startsWith('blob:'), 15000);
    const [fromPeers, peers, fromHost] = report('Bob');
    assert.equal(fromPeers, 0);
    assert.equal(peers, 0);
    assert.ok(fromHost > 0);
  });

  test('the next player gets the video peer-to-peer from the first one', async () => {
    const carol = await remote('Carol');
    pages.push(carol);
    await waitFor(carol, () => localMedia && localMedia.source === 'p2p' && video.currentSrc.startsWith('blob:'), 15000);
    await waitFor(host, () => /Carol received dub_video/.test(document.body.innerText) || true);
    const [fromPeers, peers, fromHost] = report('Carol');
    assert.ok(fromPeers > 0, 'bytes came from players');
    assert.equal(peers, 1);
    assert.equal(fromHost, 0);
    const bob = pages[1];
    await waitFor(bob, () => /shared/i.test(document.getElementById('p2pStatusText').textContent), 5000);
    await waitFor(host, () => ['Bob', 'Carol'].every(nick => [...document.querySelectorAll('.player-card')].some(c => c.innerText.includes(nick) && /sharing/.test(c.innerText))), 5000);
  });

  test('when nobody shares, the video comes from the host', async () => {
    for (const page of pages.slice(1)) {
      await page.evaluate(() => { const box = document.getElementById('settingsP2P'); box.checked = false; box.dispatchEvent(new Event('change')); });
    }
    const dave = await remote('Dave');
    await waitFor(dave, () => localMedia && video.currentSrc.startsWith('blob:'), 15000);
    const [fromPeers, peers] = report('Dave');
    assert.equal(fromPeers, 0);
    assert.equal(peers, 0);
    await dave.close();
  });

  test('a player can play the scene from a pack .zip on their own disk', async () => {
    const eve = await openPlayer(browser, server.url(room), 'Eve');
    pages.push(eve);
    await waitFor(eve, () => session && session.loaded);
    await eve.evaluate(() => openFilesModal());
    const input = await eve.$('#localMediaInput');
    await input.uploadFile(buildFixturePack());
    await waitFor(eve, () => localMedia && localMedia.source === 'disk' && video.currentSrc.startsWith('blob:') && backing.currentSrc.startsWith('blob:'), 10000);
    await eve.evaluate(() => { resetLocalMedia(); closeFilesModal(); });
    await waitFor(eve, () => video.currentSrc.startsWith('http'), 5000);
  });

  test('WebCodecs export produces an MP4 with video, audio and the take', async () => {
    const line = FIXTURE_LINES[0];
    await claimAndSelect(host, line.id);
    await recordTake(host, line.id);
    const result = await host.evaluate(async () => {
      renderDubVol.value = 100; renderBackingVol.value = 100; renderOrigVol.value = 0;
      const blob = await renderWithWebCodecs(() => {});
      const mb = await import('/vendor/mediabunny/mediabunny.min.mjs');
      const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
      const videoTrack = await input.getPrimaryVideoTrack();
      const audioTrack = await input.getPrimaryAudioTrack();
      const line = session.lines.find(l => l.audioUrl);
      const from = takeStartTime(line) + line.trimStart;
      const to = takeStartTime(line) + line.trimEnd;
      let peak = 0;
      for await (const { buffer } of new mb.AudioBufferSink(audioTrack).buffers(from, to)) {
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      }
      return { video: await videoTrack.getCodec(), audio: await audioTrack.getCodec(), duration: await input.computeDuration(), source: video.duration, peak };
    });
    assert.ok(result.video && result.audio);
    assert.ok(Math.abs(result.duration - result.source) < 0.5, `duration ${result.duration} vs ${result.source}`);
    assert.ok(result.peak > 0.01, 'the take is audible in the export');
  });

  test('no page errors', () => {
    for (const page of pages) assert.deepEqual(page.errors, [], JSON.stringify(page.errors));
  });
});

describe('audio tracks', { skip: skipReason }, () => {
  let server;
  let browser;
  let host;
  let player;
  const room = 'tracks';

  before(async () => {
    server = await startServer();
    browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url(room), 'Alice');
    player = await openPlayer(browser, server.url(room), 'Bob');
    const srt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-srt-')), 'episode.srt');
    fs.writeFileSync(srt, [
      '1', '00:00:01,000 --> 00:00:02,500', 'A: first', '',
      '2', '00:00:04,000 --> 00:00:05,500', 'B: second', ''
    ].join('\n'));
    await host.evaluate(() => openFilesModal());
    await (await host.$('#customVideoInput')).uploadFile(buildMultiTrackVideo());
    await (await host.$('#customSubInput')).uploadFile(srt);
    await host.evaluate(() => uploadCustomScene());
    await waitFor(host, () => session.loaded && session.lines.length === 2, 15000);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.cleanup();
  });

  test('both audio tracks are extracted and offered with their languages', async () => {
    const tracks = await waitFor(host, () => session.audioTracks && session.audioTracks.length === 2 && session.audioTracks, 20000);
    assert.deepEqual(tracks.map(t => t.language), ['jpn', 'rus']);
    await waitFor(host, () => getComputedStyle(document.getElementById('trackPicker')).display === 'flex' && document.getElementById('originalTrackSelect').options.length === 3);
    // Untitled tracks are named by their language in the interface language
    const optionTexts = await host.evaluate(() => [...document.getElementById('originalTrackSelect').options].slice(1).map(o => o.textContent));
    assert.match(optionTexts[0], /Japanese/);
    assert.match(optionTexts[1], /Russian/);
    const durations = await host.evaluate(async () => Promise.all(session.audioTracks.map(async t => (await fetchAndDecode(t.url)).duration)));
    durations.forEach(d => assert.ok(Math.abs(d - 8) < 0.3, `track length ${d}`));
    // Initially the original is the first track, played by a separate player with the video muted
    await waitFor(player, () => session.audioTracks && video.muted && document.getElementById('originalTrackAudio').getAttribute('src').endsWith('track_0.m4a'), 10000);
  });

  test('only the host can choose tracks', async () => {
    assert.ok(await player.evaluate(() => document.getElementById('originalTrackSelect').disabled));
    await player.evaluate(() => socket.emit('host_set_audio_tracks', { original: 1, backing: 0 }));
    await new Promise(r => setTimeout(r, 500));
    assert.equal(await host.evaluate(() => session.originalTrack), 0);
  });

  test('host picks the Russian track as original and the Japanese one as background — applied for everyone', async () => {
    await host.evaluate(() => {
      document.getElementById('originalTrackSelect').value = '1';
      document.getElementById('backingTrackSelect').value = '0';
      document.getElementById('backingTrackSelect').dispatchEvent(new Event('change'));
    });
    await waitFor(player, () => session.originalTrack === 1 && session.backingTrack === 0
      && document.getElementById('originalTrackAudio').getAttribute('src').endsWith('track_1.m4a')
      && backing.getAttribute('src').endsWith('track_0.m4a') && video.muted, 8000);
    // Export uses the chosen track too
    assert.ok((await host.evaluate(() => selectedOriginalTrack().url)).endsWith('track_1.m4a'));
  });

  test('"none" turns the original off', async () => {
    await host.evaluate(() => {
      document.getElementById('originalTrackSelect').value = '-1';
      document.getElementById('originalTrackSelect').dispatchEvent(new Event('change'));
    });
    await waitFor(player, () => session.originalTrack === -1 && !document.getElementById('originalTrackAudio').getAttribute('src') && video.muted, 8000);
  });

  test('the choice survives a server restart', async () => {
    await server.restart();
    await waitFor(player, () => socket.connected && session && session.audioTracks && session.originalTrack === -1 && session.backingTrack === 0, 20000);
  });

  test('no page errors', () => {
    for (const page of [host, player]) assert.deepEqual(page.errors, [], JSON.stringify(page.errors));
  });
});
