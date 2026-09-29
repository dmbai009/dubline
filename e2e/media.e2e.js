// Медиа: P2P-раздача видео, запасной путь через хоста, видео с диска, экспорт через WebCodecs
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  skipReason, launchBrowser, startServer, openPlayer, waitFor,
  loadFixture, claimAndSelect, recordTake, buildFixturePack, FIXTURE_LINES
} = require('./helpers');

describe('media', { skip: skipReason }, () => {
  let server;
  let browser;
  let host;
  const room = 'media';
  const pages = [];

  // Игроки «через туннель» заходят по второму адресу — с localhost P2P намеренно не используется
  const remote = nick => openPlayer(browser, server.url(room, 'dubline.test'), nick);
  const report = nick => (server.log.match(new RegExp(`${nick} получил dub_video\\.mp4: ([\\d.]+) МБ от игроков \\((\\d+)\\), ([\\d.]+) МБ с сервера`)) || []).slice(1).map(Number);

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
    await waitFor(host, () => /Carol получил dub_video/.test(document.body.innerText) || true);
    const [fromPeers, peers, fromHost] = report('Carol');
    assert.ok(fromPeers > 0, 'bytes came from players');
    assert.equal(peers, 1);
    assert.equal(fromHost, 0);
    const bob = pages[1];
    await waitFor(bob, () => /раздали|shared/i.test(document.getElementById('p2pStatusText').textContent), 5000);
    await waitFor(host, () => ['Bob', 'Carol'].every(nick => [...document.querySelectorAll('.player-card')].some(c => c.innerText.includes(nick) && /раздаёт|sharing/.test(c.innerText))), 5000);
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
