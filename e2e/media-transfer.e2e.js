const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'), AdmZip = require('adm-zip');
const { mediaProxy } = require('./media-transfer-proxy');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, claimAndSelect, recordTake } = require('./helpers');

describe('Authorized media delivery with optional P2P', { skip: skipReason }, () => {
  let server, browser, insecure, host;
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    const pack = path.join(server.dirs.packs, 'test-scene.zip'), zip = new AdmZip(pack);
    const padding = Buffer.alloc(2 * 1024 * 1024); padding.writeUInt32BE(padding.length); padding.write('free', 4);
    zip.updateFile('dub_video.mp4', Buffer.concat([zip.readFile('dub_video.mp4'), padding])); zip.writeZip(pack);
    insecure = await launchBrowser(server.port, { secureOrigin: false });
    host = await openPlayer(browser, server.url('media-transfer'), 'Host'); await loadFixture(host);
  });
  after(async () => { await browser?.close(); await insecure?.close(); await server?.cleanup(); });
  test('Porthole loopback guests show real download progress in both participant lists', async () => {
    const proxy = await mediaProxy(server.port, { rule: req => req.url.includes('dub_video.mp4') ? { rate: 384 * 1024 } : {} });
    try {
      for (const hostname of ['localhost', '127.0.0.1']) {
        const nick = hostname === 'localhost' ? 'Port local' : 'Port IPv4';
        const guest = await openPlayer(browser, proxy.url('media-transfer').replace('dubline.test', hostname), nick);
        try {
          await waitFor(guest, () => !!mediaDownload && playerActivities.get(myName)?.state === 'downloading' && playerActivities.get(myName).pct > 0 && playerActivities.get(myName).pct < 100);
          await waitFor(host, name => playerActivities.get(name)?.state === 'downloading' && playerActivities.get(name).pct > 0 && playerActivities.get(name).pct < 100, 10000, nick);
          for (const page of [host, guest]) {
            await waitFor(page, name => [...document.querySelectorAll('.player-card')].find(node => node.dataset.lobbyKey === `player:${name}`)?.innerText.includes(t('media.downloading', { pct: Math.round(playerActivities.get(name)?.pct) })), 5000, nick);
            const status = await page.evaluate(name => {
              const card = [...document.querySelectorAll('.player-card')].find(node => node.dataset.lobbyKey === `player:${name}`);
              return { text: card?.innerText, expected: t('media.downloading', { pct: Math.round(playerActivities.get(name).pct) }), progress: card?.querySelectorAll('.progress').length };
            }, nick);
            assert.ok(status.text.includes(status.expected), 'the participant card must explain the active transfer');
            assert.equal(status.progress, 2, 'recording coverage and download progress remain separate');
            await page.evaluate(() => document.body.classList.add('lobby-compact'));
            await waitFor(page, name => [...document.querySelectorAll('.player-card')].find(node => node.dataset.lobbyKey === `player:${name}`)?.querySelector('.player-status-icons')?.innerText.includes('↓'), 5000, nick);
            await page.evaluate(() => document.body.classList.remove('lobby-compact'));
          }
          await waitFor(guest, () => !mediaDownload && localMedia?.videoBlob && video.readyState >= 3, 20000);
          await waitFor(host, name => playerActivities.get(name)?.state === 'ready', 10000, nick);
          assert.deepEqual(guest.errors, []);
        } finally { await guest.browserContext().close(); }
      }
      assert.equal(await host.evaluate(() => amHost() && isOnServerMachine() && !mediaDownload && !localMedia?.videoBlob), true, 'the actual local host still streams its own file without downloading a copy');
    } finally { await proxy.close(); }
  });
  test('a fresh HTTP user starts no protected download before nickname confirmation and loads after admission', async () => {
    let premature = 0;
    const guest = await openPlayer(insecure, server.url('media-transfer', 'dubline.test'), '', {
      p2pConsent: null, helpSeen: false, beforeLoad: page => {
        page.on('request', request => { if (request.url().includes('/api/media-manifest')) premature++; });
        return page.evaluateOnNewDocument(() => localStorage.clear());
      }
    });
    try {
      await waitFor(guest, () => session?.loaded && nickModal.style.display === 'flex');
      assert.deepEqual(await guest.evaluate(() => ({ secure: isSecureContext, digest: !!crypto.subtle, nick: localStorage.getItem('dubline_nick') })), { secure: false, digest: false, nick: null });
      assert.equal(insecure.process().spawnargs.some(arg => /unsafely-treat-insecure|ignore-certificate-errors/.test(arg)), false);
      assert.equal(premature, 0, 'protected manifests must wait for server-confirmed membership');
      await guest.evaluate(() => closeHelpModal());
      await guest.type('#modalNickInput', 'Fresh guest'); await guest.click('#nickModal button[type=submit]');
      await waitFor(guest, () => myName === 'Fresh guest' && localMedia?.videoBlob && !mediaDownload && video.readyState >= 2, 15000);
      assert.equal(await guest.evaluate(() => p2pAllowed() || peers.size > 0), false);
      for (const language of ['en', 'ru', 'uk']) {
        const state = await guest.evaluate(async language => {
          await i18n.setLanguage(language); updateLocalMediaStatus();
          return { source: DublineMediaTransfer.stats().source, active: document.getElementById('localMediaStatus').textContent,
            expected: t('localMedia.activeP2p', { size: formatSize(localMedia.size) }), done: document.getElementById('p2pStatusText').textContent,
            reason: DublineMediaTransfer.stats().p2pReasonLabel };
        }, language);
        assert.equal(state.source, 'local'); assert.equal(state.active, state.expected);
        assert.doesNotMatch(state.active + state.done, /share|раздавать|делитесь|ділитеся|роздавати/i);
        assert.ok(state.reason && !state.reason.startsWith('p2p.reason.'));
      }
    } finally { await guest.browserContext().close(); }
  });
  test('HTTP Range ignored with a full 200 downloads one response rather than the whole file per range', async () => {
    let ranges = 0, responseBytes = 0;
    const guest = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), 'Range guest', {
      beforeLoad: async page => {
        await page.setRequestInterception(true);
        page.on('request', async request => {
          if (request.resourceType() !== 'fetch' || !/^bytes=\d+-\d+$/.test(request.headers().range || '') || !request.url().includes('dub_video.mp4')) return request.continue();
          ranges++;
          const response = await fetch(request.url().replace('dubline.test', 'localhost'));
          const bytes = Buffer.from(await response.arrayBuffer());
          responseBytes += bytes.length;
          return request.respond({ status: 200, contentType: 'video/mp4', headers: { 'Content-Length': String(bytes.length) }, body: bytes });
        });
      }
    });
    try {
      await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload, 15000);
      const videoBytes = await guest.evaluate(() => session.videoSize);
      console.log('Range ignored measurement:', JSON.stringify({ requests: ranges, responseBytes, videoBytes }));
      assert.equal(ranges, 1); assert.equal(responseBytes, videoBytes);
      assert.equal(await guest.evaluate(async () => await sha256Hex(localMedia.videoBlob) === session.videoHash), true);
    } finally { await guest.browserContext().close(); }
  });
  test('audio source changes preserve the current video job and completed video Blob URL', async () => {
    await waitFor(host, () => session.audioTracks?.length && !session.audioTracksPending);
    const guest = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), 'Audio guest', {
      beforeLoad: page => page.evaluateOnNewDocument(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const download = downloadFile;
          window.videoDownloads = 0;
          downloadFile = async (file, ...args) => {
            if (file.role === 'video') {
              videoDownloads++;
              await new Promise(resolve => { window.releaseVideoDownload = resolve; });
            }
            return download(file, ...args);
          };
        }, { once: true });
      })
    });
    try {
      await waitFor(guest, () => typeof window.releaseVideoDownload === 'function');
      await guest.evaluate(() => { window.firstVideoJob = mediaDownload; });
      await host.evaluate(() => socket.emit('host_set_audio_tracks', { sessionId: session.activeSessionId, original: -1, backing: -1 }));
      await waitFor(guest, () => session.originalTrack === -1);
      assert.equal(await guest.evaluate(() => mediaDownload === firstVideoJob && !firstVideoJob.abort.signal.aborted), true);
      await guest.evaluate(() => releaseVideoDownload());
      await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload, 15000);
      const source = await guest.evaluate(() => localMedia.videoUrl);
      await host.evaluate(() => socket.emit('host_set_audio_tracks', { sessionId: session.activeSessionId, original: 0, backing: -1 }));
      await waitFor(guest, () => session.originalTrack === 0 && !mediaDownload);
      assert.deepEqual(await guest.evaluate(() => ({ source: localMedia.videoUrl, calls: videoDownloads })), { source, calls: 1 });
    } finally { await guest.browserContext().close(); }
  });
  test('a true HTTPS peer serves media while a mixed ordinary HTTP client safely uses the host', async () => {
    const proxy = await mediaProxy(server.port, { tls: true }); let secureBrowser, seed, receiver, plain;
    try {
      secureBrowser = await launchBrowser(proxy.port, { secureOrigin: false, certificateSPKI: proxy.spki });
      assert.equal(secureBrowser.process().spawnargs.some(arg => arg.startsWith('--unsafely-treat-insecure')), false);
      seed = await openPlayer(secureBrowser, proxy.url('media-transfer'), 'TLS seed', { p2pConsent: 'accepted' });
      await waitFor(seed, () => localMedia?.videoBlob && !mediaDownload);
      assert.deepEqual(await seed.evaluate(() => ({ protocol: location.protocol, secure: isSecureContext, digest: !!crypto.subtle, p2p: p2pAllowed() })), { protocol: 'https:', secure: true, digest: true, p2p: true });
      await waitFor(host, () => seedingNicks.has('TLS seed'));
      receiver = await openPlayer(secureBrowser, proxy.url('media-transfer'), 'TLS receiver', { p2pConsent: 'accepted' });
      await waitFor(receiver, () => localMedia?.videoBlob && !mediaDownload);
      assert.ok(await receiver.evaluate(() => DublineMediaTransfer.stats().files.find(file => file.role === 'video').p2pBytes > 0));
      plain = await openPlayer(insecure, server.url('media-transfer', 'dubline.test'), 'HTTP receiver', { p2pConsent: 'accepted' });
      await waitFor(plain, () => localMedia?.videoBlob && !mediaDownload);
      assert.deepEqual(await plain.evaluate(() => ({ secure: isSecureContext, allowed: p2pAllowed(), peers: peers.size, checked: settingsP2P.checked, disabled: settingsP2P.disabled, reason: DublineMediaTransfer.stats().p2pReason })),
        { secure: false, allowed: false, peers: 0, checked: false, disabled: true, reason: 'insecure' });
      for (const page of [seed, receiver, plain]) assert.deepEqual(page.errors, []);
    } finally { await plain?.browserContext().close(); await secureBrowser?.close(); await proxy.close(); }
  });
  test('wrong then correct PIN and a fresh nickname admit an insecure HTTP client without reload', async () => {
    const secured = await startServer({ DUBLINE_DESKTOP_ROOM: 'main', DUBLINE_DESKTOP_HOST_TOKEN: 'media-host-proof', DUBLINE_ROOM_PIN: 'ABCD' });
    let owner, guest, manifests = 0;
    try {
      owner = await openPlayer(browser, secured.url('main') + '&desktopHost=media-host-proof', 'PIN host'); await loadFixture(owner);
      guest = await openPlayer(insecure, secured.url('main', 'dubline.test'), '', { p2pConsent: null,
        beforeLoad: page => { page.on('request', request => { if (request.url().includes('/api/media-manifest')) manifests++; }); } });
      await waitFor(guest, () => passwordModal.style.display === 'flex'); assert.equal(manifests, 0);
      await guest.type('#passwordNickInput', 'PIN guest'); await guest.type('#passwordInput', 'ZZZZ'); await guest.click('#passwordModal button[type=submit]');
      await waitFor(guest, () => passwordError.style.display === 'block'); assert.equal(manifests, 0);
      await guest.type('#passwordInput', 'ABCD'); await guest.click('#passwordModal button[type=submit]');
      await waitFor(guest, () => myName === 'PIN guest' && localMedia?.videoBlob && !mediaDownload, 15000);
      assert.ok(manifests > 0); assert.equal(await guest.evaluate(() => isSecureContext || p2pAllowed()), false);
      await waitFor(guest, () => p2pConsentDialog.open); await guest.click('#p2pConsentDecline');
      assert.deepEqual(guest.errors, []);
    } finally { await guest?.browserContext().close(); await owner?.browserContext().close(); await secured.cleanup(); }
  });
  test('a taken nickname cannot trigger protected manifests and a different nickname resumes the deferred scene', async () => {
    let manifests = 0;
    const guest = await openPlayer(insecure, server.url('media-transfer', 'dubline.test'), 'Host', {
      beforeLoad: page => { page.on('request', request => { if (request.url().includes('/api/media-manifest')) manifests++; }); }
    });
    try {
      await waitFor(guest, () => nickModal.style.display === 'flex'); assert.equal(manifests, 0);
      await guest.$eval('#modalNickInput', input => { input.value = ''; });
      await guest.type('#modalNickInput', 'Unique guest'); await guest.click('#nickModal button[type=submit]');
      await waitFor(guest, () => myName === 'Unique guest' && localMedia?.videoBlob && !mediaDownload);
      assert.ok(manifests > 0); assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); }
  });
  test('temporary manifest failures retry within a limit and reconnect recovers the same unchanged scene', async () => {
    let blocked = true, requests = 0;
    const proxy = await mediaProxy(server.port, { rule: req => {
      if (req.url.startsWith('/api/media-manifest') && new URL(req.url, 'http://host').searchParams.get('url')?.endsWith('dub_video.mp4')) {
        requests++; if (blocked) return { status: 503 };
      }
    } });
    const guest = await openPlayer(insecure, proxy.url('media-transfer'), 'Retry guest');
    try {
      await waitFor(guest, () => DublineMediaTransfer.stats().status === 'failed'); assert.equal(requests, 3);
      await guest.evaluate(() => { for (let index = 0; index < 10; index++) applySessionUpdate({ ...session }); });
      assert.equal(requests, 3, 'unrelated snapshots cannot restart a failed download forever');
      blocked = false; await guest.evaluate(() => { socket.disconnect(); socket.connect(); });
      await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload && DublineMediaTransfer.stats().status === 'ready');
      assert.equal(requests, 4); assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); await proxy.close(); }
  });
  test('permanent HTTP failures retain their reason, do not loop and permit an explicit safe retry', async () => {
    for (const status of [403, 404, 409, 416]) {
      let blocked = true, requests = 0;
      const proxy = await mediaProxy(server.port, { rule: req => {
        if (req.url.startsWith('/api/media-manifest') && new URL(req.url, 'http://host').searchParams.get('url')?.endsWith('dub_video.mp4')) {
          requests++; if (blocked) return { status };
        }
      } });
      const guest = await openPlayer(insecure, proxy.url('media-transfer'), `Refused ${status}`);
      try {
        await waitFor(guest, () => DublineMediaTransfer.stats().status === 'failed');
        assert.equal(await guest.evaluate(() => DublineMediaTransfer.stats().error.status), status); assert.equal(requests, 1);
        blocked = false; await guest.click('#p2pStatusText button');
        await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload); assert.equal(requests, 2);
        assert.deepEqual(guest.errors, []);
      } finally { await guest.browserContext().close(); await proxy.close(); }
    }
  });
  test('an unreachable WebRTC peer cannot defer host loading until the connection timeout', async () => {
    const guest = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), 'Unreachable peer receiver', {
      p2pConsent: 'accepted', beforeLoad: page => page.evaluateOnNewDocument(() => {
        document.addEventListener('DOMContentLoaded', () => {
          findSeeders = async url => {
            window.peerLookupAt ??= performance.now(); const manifest = heldManifests.get(url);
            return [{ socketId: 'unreachable-test-peer', id: manifest.id, ranges: [[0, manifest.chunks.length - 1]] }];
          };
          const original = fetch;
          window.fetch = (url, options) => {
            if (/^bytes=\d+-\d+$/.test(options?.headers?.Range || '')) window.httpStartedAt ??= performance.now();
            return original(url, options);
          };
        }, { once: true });
      })
    });
    try {
      await waitFor(guest, () => typeof httpStartedAt === 'number');
      const firstHttpMs = await guest.evaluate(() => httpStartedAt - peerLookupAt);
      console.log('Peer fallback measurement:', JSON.stringify({ firstHttpMs }));
      assert.ok(firstHttpMs < 3000, `HTTP started after ${firstHttpMs} ms`);
      await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload);
      const result = await guest.evaluate(() => ({ delay: httpStartedAt - peerLookupAt, peers: peers.size, hash: localMedia.videoHash,
        expected: session.videoHash, bytes: DublineMediaTransfer.stats().files.find(file => file.role === 'video').httpBytes }));
      assert.ok(result.delay < 3000, JSON.stringify(result)); assert.equal(result.peers, 0); assert.equal(result.hash, result.expected); assert.ok(result.bytes > 0);
      assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); }
  });
  test('peer disconnection preserves received chunks and corrupt P2P data is repaired exclusively from canonical HTTP', async () => {
    for (const corrupt of [false, true]) {
      const seed = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), corrupt ? 'Corrupt seed' : 'Partial seed', { p2pConsent: 'accepted' }); let guest;
      try {
        await waitFor(seed, () => localMedia?.videoBlob && !mediaDownload);
        await seed.evaluate(corrupt => {
          // Exercise a real peer that connects after the HTTP fallback grace.
          // The scenario requires some peer bytes before disconnect/corruption.
          const setRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;
          RTCPeerConnection.prototype.setRemoteDescription = async function(...args) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return setRemoteDescription.apply(this, args);
          };
          if (corrupt) {
            window.corruptedTestBytes = 0;
            const channel = DublineNetwork.channel;
            DublineNetwork.channel = value => {
              const wrapped = channel(value), send = wrapped.send.bind(wrapped);
              wrapped.send = data => {
                if (data instanceof Uint8Array && data.byteLength > 4) { data = data.slice(); data[4] ^= 1; }
                send(data);
                if (data instanceof Uint8Array && data.byteLength > 4) window.corruptedTestBytes += data.byteLength - 4;
              }; return wrapped;
            };
          } else {
            let sent = 0;
            window.mediaUploadLimiter = { take: bytes => {
              // The scheduler can pick the short final chunk first. Let the
              // frame crossing the threshold through so the receiver really
              // has >= 256 KiB before this fixture blocks the next frame.
              if (sent >= 262144) return new Promise(resolve => { window.releasePartialUpload = resolve; });
              sent += bytes;
            } };
          }
        }, corrupt);
        await waitFor(host, name => seedingNicks.has(name), 10000, await seed.evaluate(() => myName));
        guest = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), corrupt ? 'Integrity receiver' : 'Partial receiver', { p2pConsent: 'accepted',
          beforeLoad: page => page.evaluateOnNewDocument(() => {
            const original = fetch;
            // Both scenarios require peer bytes to actually enter the receiver.
            // Keep HTTP from winning this setup race; the fallback latency has its
            // own separate real-time test and production settings remain untouched.
            const gate = new Promise(resolve => { window.releasePartialHttp = resolve; });
            window.fetch = async (url, options) => {
              if (options?.headers?.Range) await gate;
              return original(url, options);
            };
          })
        });
        if (!corrupt) {
          await waitFor(guest, () => [...partialFiles.values()].some(file => file.durable.size > 0) && mediaDownload?.diagnostic?.p2pBytes >= 262144);
          await seed.evaluate(() => { settingsP2P.checked = false; settingsP2P.dispatchEvent(new Event('change')); releasePartialUpload?.(); });
          await waitFor(guest, () => typeof releasePartialHttp === 'function'); await guest.evaluate(() => releasePartialHttp());
        } else {
          await waitFor(seed, () => corruptedTestBytes >= 262144);
          await guest.evaluate(() => releasePartialHttp());
        }
        await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload);
        const result = await guest.evaluate(async () => {
          const file = DublineMediaTransfer.stats().files.find(file => file.role === 'video');
          const manifest = heldManifests.get(session.videoUrl), cache = await DublineMediaCache.load(manifest);
          return { ...file, size: session.videoSize, correct: await sha256Hex(localMedia.videoBlob) === session.videoHash,
            cacheChunks: cache.filter(Boolean).length, expectedChunks: manifest.chunks.length, peers: peers.size };
        });
        assert.equal(result.correct, true); assert.equal(result.uniqueBytes, result.size); assert.equal(result.cacheChunks, result.expectedChunks);
        assert.equal(result.peers, 0); assert.ok(result.httpBytes > 0);
        if (corrupt) { assert.ok(result.invalidChunks > 0); assert.equal(result.p2pBytes, 0); assert.ok(result.p2pWireBytes > 0); }
        else assert.ok(result.p2pBytes >= 262144);
        assert.deepEqual(guest.errors, []);
      } finally { await guest?.browserContext().close(); await seed.browserContext().close(); }
    }
  });
  test('a prepared video is usable while an independent audio download is still pending', async () => {
    const guest = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), 'Audio pending guest', {
      beforeLoad: page => page.evaluateOnNewDocument(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const download = downloadFile;
          downloadFile = async (file, ...args) => {
            if (file.role === 'backing') await new Promise(resolve => { window.finishAudioDownload = resolve; });
            return download(file, ...args);
          };
        }, { once: true });
      })
    });
    try {
      await waitFor(guest, () => localMedia?.videoBlob && video.readyState >= 2 && typeof finishAudioDownload === 'function');
      assert.equal(await guest.evaluate(() => !!mediaDownload && DublineMediaTransfer.stats().videoReady && video.currentSrc.startsWith('blob:')), true);
      const source = await guest.evaluate(() => localMedia.videoUrl);
      await guest.evaluate(() => finishAudioDownload()); await waitFor(guest, () => !mediaDownload);
      assert.equal(await guest.evaluate(() => localMedia.videoUrl), source); assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); }
  });
  test('three mixed clients stream a large file with bounded full-200 retries, delays and no duplicated download jobs', async () => {
    const zip = new AdmZip(path.join(server.dirs.packs, 'test-scene.zip'));
    const padding = Buffer.alloc(32 * 1024 * 1024); padding.writeUInt32BE(padding.length); padding.write('free', 4);
    zip.updateFile('dub_video.mp4', Buffer.concat([zip.readFile('dub_video.mp4'), padding]));
    zip.writeZip(path.join(server.dirs.packs, 'stress-scene.zip'));
    const owner = await openPlayer(browser, server.url('media-stress'), 'Stress host');
    await owner.evaluate(() => loadSavedPack('stress-scene.zip')); await waitFor(owner, () => session?.videoSize > 32 * 1024 * 1024);
    const first = new Set();
    let releasePrefixes;
    const prefixesRead = new Promise(resolve => { releasePrefixes = resolve; });
    const rule = req => {
      if (!/^bytes=\d+-\d+$/.test(req.headers.range || '') || !req.url.endsWith('dub_video.mp4')) return;
      const key = require('node:crypto').createHash('sha256').update(req.headers.cookie || '').digest('hex');
      const truncate = !first.has(key); first.add(key);
      return { ignoreRange: true, rate: 2 * 1024 * 1024, truncateAfter: truncate ? 524288 : null, beforeTruncate: () => prefixesRead };
    };
    const tls = await mediaProxy(server.port, { tls: true, rule }), plain = await mediaProxy(server.port, { rule });
    let protectedBrowser, guests = [], inspectors = [], monitor, memory = { proxyRss: process.memoryUsage().rss, clientHeap: 0, clientBacking: 0 };
    const started = performance.now();
    try {
      protectedBrowser = await launchBrowser(tls.port, { secureOrigin: false, certificateSPKI: tls.spki });
      guests = await Promise.all([
        openPlayer(protectedBrowser, tls.url('media-stress'), 'Stress secure A', { beforeLoad: page => page.setCacheEnabled(false) }),
        openPlayer(protectedBrowser, tls.url('media-stress'), 'Stress secure B', { beforeLoad: page => page.setCacheEnabled(false) }),
        openPlayer(insecure, plain.url('media-stress'), 'Stress HTTP', { beforeLoad: page => page.setCacheEnabled(false) })
      ]);
      // Observe the real downloader; do not replace fetch or its reader. Only
      // then close all three short responses and exercise the actual retry.
      await Promise.all(guests.map(page => waitFor(page, () => {
        const diagnostic = DublineMediaTransfer.stats().diagnostic;
        return diagnostic?.role === 'video' && diagnostic.httpBytes === 524288;
      })));
      releasePrefixes();
      const sessions = await Promise.all(guests.map(page => page.createCDPSession())); let sampling = false;
      inspectors = sessions;
      const sample = async () => {
        if (sampling) return; sampling = true;
        try {
          const usage = await Promise.all(sessions.map(session => session.send('Runtime.getHeapUsage').catch(() => ({}))));
          memory.proxyRss = Math.max(memory.proxyRss, process.memoryUsage().rss);
          memory.clientHeap = Math.max(memory.clientHeap, usage.reduce((sum, value) => sum + (value.usedSize || 0), 0));
          memory.clientBacking = Math.max(memory.clientBacking, usage.reduce((sum, value) => sum + (value.backingStorageSize || 0), 0));
        } finally { sampling = false; }
      };
      await sample(); monitor = setInterval(sample, 500);
      await Promise.all(guests.map(page => waitFor(page, () => localMedia?.videoBlob && !mediaDownload && video.readyState >= 2, 60000)));
      await sample();
      const reports = await Promise.all(guests.map(page => page.evaluate(() => ({ size: localMedia.videoBlob.size, files: DublineMediaTransfer.stats().files }))));
      const size = await owner.evaluate(() => session.videoSize), bytes = tls.stats.managedVideoBytes + plain.stats.managedVideoBytes;
      console.log('Stress transport details:', JSON.stringify({ requests: tls.stats.managedVideoRequests + plain.stats.managedVideoRequests,
        videoRequests: tls.stats.videoRequests + plain.stats.videoRequests, responseBytes: bytes, videoWireBytes: tls.stats.videoBytes + plain.stats.videoBytes,
        expected: 3 * (size + 524288), reports: reports.map(report => report.files.find(file => file.role === 'video')) }));
      assert.equal(tls.stats.managedVideoRequests + plain.stats.managedVideoRequests, 6, 'one interrupted response and one complete response per client');
      assert.equal(tls.stats.videoRequests + plain.stats.videoRequests, 6, 'audio preparation does not fetch the same video separately');
      assert.equal(bytes, 3 * (size + 524288));
      reports.forEach(report => {
        assert.equal(report.size, size);
        const video = report.files.find(file => file.role === 'video');
        assert.equal(video.uniqueBytes, size); assert.equal(video.httpBytes, size + 524288); assert.equal(video.retries, 1);
      });
      assert.deepEqual(reports.map(report => report.files.find(file => file.role === 'video').verified), [true, true, false]);
      for (const page of guests) assert.deepEqual(page.errors, []);
      console.log('Media stress measurement:', JSON.stringify({ clients: 3, videoBytes: size, responseBytes: bytes, videoRequests: 6,
        durationMs: Math.round(performance.now() - started), proxyRssMiB: +(memory.proxyRss / 1024 ** 2).toFixed(1),
        clientHeapMiB: +(memory.clientHeap / 1024 ** 2).toFixed(1), clientBackingMiB: +(memory.clientBacking / 1024 ** 2).toFixed(1) }));
    } finally {
      releasePrefixes();
      clearInterval(monitor); await Promise.all(inspectors.map(session => session.detach().catch(() => {})));
      await Promise.all(guests.map(page => page.browserContext().close()));
      await protectedBrowser?.close(); await tls.close(); await plain.close(); await owner.browserContext().close();
    }
  });
  test('missing audible audio blocks manual playback and microphone capture until its real HTTP source is prepared', async () => {
    const backingUrl = await host.evaluate(() => session.backingUrl);
    const proxy = await mediaProxy(server.port, { tls: true, rule: req => new URL(req.url, 'http://host').pathname === backingUrl ? { delayHeaders: 3500 } : {} });
    let recordingBrowser, guest;
    try {
      recordingBrowser = await launchBrowser(proxy.port, { secureOrigin: false, certificateSPKI: proxy.spki });
      guest = await openPlayer(recordingBrowser, proxy.url('media-transfer'), 'Delay recorder', {
        beforeLoad: page => page.evaluateOnNewDocument(() => {
          const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); window.captureCalls = 0;
          navigator.mediaDevices.getUserMedia = options => { captureCalls++; return capture(options); };
        })
      });
      await waitFor(guest, () => localMedia?.videoBlob && mediaDownload && backing.readyState < 3);
      await guest.click('[data-studio-action="play"]');
      assert.equal(await guest.evaluate(() => video.paused), true, 'manual playback cannot start an incomplete audible mix');
      await claimAndSelect(guest, 1); await guest.click('#recBtn');
      assert.deepEqual(await guest.evaluate(() => ({ captures: captureCalls, recording: recordState })), { captures: 0, recording: 'idle' });
      await waitFor(guest, () => !mediaDownload && backing.readyState >= 3);
      await guest.click('[data-studio-action="play"]'); await waitFor(guest, () => !video.paused);
      await guest.click('[data-studio-action="play"]'); await waitFor(guest, () => video.paused);
      await recordTake(guest, 1);
      assert.ok(await guest.evaluate(() => captureCalls > 0 && session.lines.find(line => line.id === 1).audioUrl));
      assert.deepEqual(guest.errors, []);
    } finally { await recordingBrowser?.close(); await proxy.close(); }
  });
  test('verified chunks resume across socket disconnect and server restart without replaying the completed prefix', async () => {
    const proxy = await mediaProxy(server.port, { tls: true, rule: req => new URL(req.url, 'http://host').pathname.endsWith('dub_video.mp4') ? { rate: 256 * 1024 } : {} });
    let resumeBrowser, guest;
    try {
      resumeBrowser = await launchBrowser(proxy.port, { secureOrigin: false, certificateSPKI: proxy.spki });
      guest = await openPlayer(resumeBrowser, proxy.url('media-transfer'), 'Resume guest');
      await waitFor(guest, () => !!mediaDownload && [...partialFiles.values()].some(file => file.durable.size > 0));
      const before = await guest.evaluate(() => ({ id: session.activeSessionId, epoch: session.editorProtocol.epoch, lines: JSON.stringify(session.lines) }));
      await guest.evaluate(() => { socket.disconnect(); socket.connect(); });
      await waitFor(guest, () => socket.connected && hasSceneMediaAccess() && !!mediaDownload && [...partialFiles.values()].some(file => file.durable.size > 0));
      await server.restart();
      await waitFor(guest, epoch => session?.editorProtocol.epoch !== epoch && hasSceneMediaAccess(), 15000, before.epoch);
      await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload, 20000);
      const result = await guest.evaluate(async () => ({ id: session.activeSessionId, lines: JSON.stringify(session.lines), correct: await sha256Hex(localMedia.videoBlob) === session.videoHash,
        file: DublineMediaTransfer.stats().files.find(file => file.role === 'video') }));
      assert.equal(result.id, before.id); assert.equal(result.lines, before.lines); assert.equal(result.correct, true);
      assert.ok(result.file.cachedBytes >= 262144); assert.equal(result.file.httpBytes + result.file.cachedBytes, result.file.uniqueBytes);
      assert.ok(proxy.stats.observations.filter(value => value.kind === 'video').some(value => !value.range.startsWith('bytes=0-')));
      assert.deepEqual(guest.errors, []);
    } finally { await resumeBrowser?.close(); await proxy.close(); }
  });
  test('blocked cryptographic operations and a forbidden RTC constructor fail closed once while HTTP remains usable', async () => {
    const seed = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), 'Capability seed', { p2pConsent: 'accepted' });
    try {
      await waitFor(seed, () => localMedia?.videoBlob && !mediaDownload);
      await waitFor(host, () => seedingNicks.has('Capability seed'));
      for (const kind of ['crypto', 'rtc']) {
        const guest = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), `Blocked ${kind}`, { p2pConsent: 'accepted',
          beforeLoad: page => page.evaluateOnNewDocument(kind => {
            window.rtcAttempts = 0; const native = RTCPeerConnection;
            if (kind === 'crypto') crypto.subtle.digest = () => Promise.reject(new DOMException('Digest forbidden', 'SecurityError'));
            window.RTCPeerConnection = function(...args) { rtcAttempts++; if (kind === 'rtc') throw new DOMException('RTC forbidden', 'NotSupportedError'); return new native(...args); };
          }, kind)
        });
        try {
          await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload);
          const result = await guest.evaluate(() => ({ attempts: rtcAttempts, allowed: p2pAllowed(), peers: peers.size, checked: settingsP2P.checked,
            reason: DublineMediaTransfer.stats().p2pReason, verified: DublineMediaTransfer.stats().files.find(file => file.role === 'video').verified }));
          assert.deepEqual(result, { attempts: kind === 'crypto' ? 0 : 1, allowed: false, peers: 0, checked: false, reason: kind === 'crypto' ? 'integrity' : 'unavailable', verified: kind !== 'crypto' });
          assert.deepEqual(guest.errors, []);
        } finally { await guest.browserContext().close(); }
      }
    } finally { await seed.browserContext().close(); }
  });
  test('resetting a completed local copy preserves playback and does not silently restart on snapshots or renaming', async () => {
    const guest = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), 'Reset guest');
    try {
      await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload && video.readyState >= 2);
      await guest.evaluate(async () => {
        video.currentTime = 0.4; await video.play();
        window.resetTime = video.currentTime;
        const revoke = URL.revokeObjectURL; window.revokedWhileActive = [];
        URL.revokeObjectURL = url => {
          if ([video, originalTrackAudio, backing].some(element => element.getAttribute('src') === url)) revokedWhileActive.push(url);
          revoke.call(URL, url);
        };
      });
      await guest.click('[onclick="openFilesModal()"]');
      await guest.click('#tabBtnVideo');
      await guest.click('#localMediaResetBtn');
      await waitFor(guest, () => !localMedia && video.readyState >= 2 && !video.paused && video.currentTime >= resetTime);
      assert.deepEqual(await guest.evaluate(() => ({ activeRevocations: revokedWhileActive.length, state: DublineMediaTransfer.stats().status })), { activeRevocations: 0, state: 'cancelled' });
      await guest.evaluate(() => { for (let i = 0; i < 5; i++) applySessionUpdate(session); });
      await guest.evaluate(() => new Promise(resolve => socket.emit('rename_user', { newName: 'Reset renamed' }, resolve)));
      await waitFor(guest, () => myName === 'Reset renamed');
      assert.equal(await guest.evaluate(() => !!mediaDownload || !!localMedia), false);
      await guest.evaluate(() => retrySceneMedia());
      await waitFor(guest, () => localMedia?.videoBlob && !mediaDownload);
      assert.deepEqual(guest.errors, []);
    } finally { await guest.browserContext().close(); }
  });
  test('a cached manifest cannot make a different disk Blob announce or serve canonical video', async () => {
    const seed = await openPlayer(browser, server.url('media-transfer', 'dubline.test'), 'Disk seed', { p2pConsent: 'accepted' });
    try {
      await waitFor(seed, () => localMedia?.videoBlob && !mediaDownload);
      await waitFor(host, () => seedingNicks.has('Disk seed'));
      await seed.evaluate(async () => {
        window.canonicalVideo = localMedia.videoBlob;
        const wrong = new Blob([canonicalVideo.slice(0, canonicalVideo.size - 1), new Uint8Array([1])], { type: 'video/mp4' });
        setLocalMedia({ video: wrong, backing: null, source: 'disk' }); await announceHave(true);
      });
      await waitFor(host, () => !seedingNicks.has('Disk seed'));
      assert.equal(await seed.evaluate(() => verifiedHeldBlobs.has(localMedia.videoBlob)), false);
      await seed.evaluate(async () => { setLocalMedia({ video: canonicalVideo, backing: null, source: 'disk' }); await announceHave(true); });
      await waitFor(host, () => seedingNicks.has('Disk seed'));
      assert.deepEqual(seed.errors, []);
    } finally { await seed.browserContext().close(); }
  });
});
