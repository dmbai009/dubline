// Room: host, recording status, watch-together, sessions, reliable take uploads,
// password and kicking, the connection banner on a server restart
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  skipReason, wait, launchBrowser, startServer, openPlayer, waitFor, waitUntil,
  loadFixture, claimAndSelect, recordTake, uploadFileCount, FIXTURE_LINES, FIXTURE_PACK, answerTextPrompt
} = require('./helpers');

describe('room', { skip: skipReason }, () => {
  let server;
  let browser;
  let host;
  let bob;
  const room = 'room';
  const allPages = [];

  before(async () => {
    server = await startServer();
    browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url(room), 'Alice');
    await loadFixture(host);
    bob = await openPlayer(browser, server.url(room), 'Bob');
    await waitFor(bob, () => session && session.loaded);
    allPages.push(host, bob);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.cleanup();
  });

  test('live recording status; pause-all confirms and discards the take', async () => {
    const line = FIXTURE_LINES[1];
    await claimAndSelect(bob, line.id);
    await bob.evaluate(id => handleStudioRecord(id), line.id);
    await waitFor(host, id => document.getElementById(`line-block-${id}`).classList.contains('live-recording'), 5000, line.id);
    assert.ok(await host.evaluate(() => [...document.querySelectorAll('.player-card.recording')].some(c => c.innerText.includes('Bob'))));
    assert.match(server.log, /Bob is recording line/);

    host.dialogs.length = 0;
    await host.evaluate(() => hostForcePause());
    await waitFor(host, id => !document.getElementById(`line-block-${id}`).classList.contains('live-recording'), 5000, line.id);
    assert.ok(host.dialogs.some(d => d.includes('Bob')), 'confirmation names the recording player');
    await waitFor(bob, () => recordState === 'idle');
    await wait(800);
    assert.equal(await bob.evaluate(id => session.lines.find(l => l.id === id).audioUrl, line.id), null, 'interrupted take is not saved');
  });

  test('watch together: countdown, synced start, drift correction, host pause, recording lock, stop', async () => {
    await host.evaluate(() => { window.confirm = () => true; hostWatchStart(); });
    const counting = await waitFor(bob, () => watchMode && document.getElementById('watchCountdown').style.display === 'block' && document.getElementById('watchCountdown').textContent);
    assert.match(counting, /[1-3]/);
    await waitFor(bob, () => !video.paused, 6000);
    await waitFor(host, () => !video.paused, 2000);
    const [a, b] = await Promise.all([host, bob].map(p => p.evaluate(() => video.currentTime)));
    assert.ok(Math.abs(a - b) < 0.4, `start in sync (${a} vs ${b})`);

    await bob.evaluate(() => { video.currentTime = 1; });
    await wait(3800);
    const [a2, b2] = await Promise.all([host, bob].map(p => p.evaluate(() => video.currentTime)));
    assert.ok(Math.abs(a2 - b2) < 0.6, `drift corrected (${a2} vs ${b2})`);

    await bob.evaluate(id => handleStudioRecord(id), FIXTURE_LINES[1].id);
    await waitFor(bob, () => /watching/i.test(document.getElementById('toast').textContent), 3000);

    await host.evaluate(() => video.pause());
    await waitFor(bob, () => video.paused, 3000);
    await host.evaluate(() => hostWatchStop());
    await waitFor(bob, () => !watchMode && document.getElementById('watchOverlay').style.display === 'none', 3000);
  });

  test('changing the pack during watch-together does not leave anyone stuck', async () => {
    await host.evaluate(() => hostWatchStart());
    await waitFor(bob, () => watchMode, 3000);
    await loadFixture(host);
    await waitFor(host, () => !watchMode, 5000);
    await waitFor(bob, () => !watchMode, 5000);
  });

  test('sessions: every import is a new session, switch / rename / delete with files', async () => {
    const line = FIXTURE_LINES[0];
    await claimAndSelect(host, line.id);
    const takeUrl = await recordTake(host, line.id);
    const takeFile = path.join(server.dirs.uploads, decodeURIComponent(takeUrl).split('/').pop());
    assert.ok(fs.existsSync(takeFile));
    const withTake = await host.evaluate(() => session.activeSessionId);

    await loadFixture(host);
    const list = await host.evaluate(() => session.sessionList);
    assert.ok(list.length >= 2, 'new session created');
    assert.equal(list.find(s => s.active).recorded, 0);
    assert.equal(list.find(s => s.id === withTake).recorded, 1, 'old session keeps its take');
    assert.ok(fs.existsSync(takeFile));

    await bob.evaluate(id => socket.emit('host_switch_session', { id }), withTake);
    await wait(500);
    assert.notEqual(await host.evaluate(() => session.activeSessionId), withTake, 'non-host cannot switch');
    await host.evaluate(id => switchSession(id), withTake);
    await waitFor(bob, (id, lineId) => session.activeSessionId === id && !!session.lines.find(l => l.id === lineId).audioUrl, 5000, withTake, line.id);

    await host.evaluate(id => { renameSession(id); }, withTake);
    await answerTextPrompt(host, 'Renamed');
    await waitFor(bob, () => session.title === 'Renamed', 5000);

    await server.restart();
    await waitFor(host, id => socket.connected && session && session.activeSessionId === id && session.title === 'Renamed', 20000, withTake);

    await host.evaluate(id => { window.confirm = () => true; deleteSession(id); }, withTake);
    await waitFor(host, id => session.activeSessionId !== id && !session.sessionList.some(s => s.id === id), 5000, withTake);
    await waitUntil(() => !fs.existsSync(takeFile), 3000);
  });

  test('reliable upload: a failed upload waits in the browser and is delivered later', async () => {
    const line = FIXTURE_LINES[2];
    await claimAndSelect(host, line.id);
    // Simulate a drop: the first take uploads fail (network, then "502 from the tunnel")
    let failures = 0;
    await host.setRequestInterception(true);
    const handler = request => {
      if (request.url().includes('/api/upload-line-audio') && failures < 2) {
        failures++;
        return failures === 1 ? request.abort('failed') : request.respond({ status: 502, body: 'Bad Gateway' });
      }
      request.continue();
    };
    host.on('request', handler);

    await host.evaluate(id => handleStudioRecord(id), line.id);
    await waitFor(host, id => document.getElementById(`line-block-${id}`).classList.contains('pending-upload'), 20000, line.id);
    assert.ok(await host.evaluate(() => !!document.querySelector('.insp-pending')), 'inspector shows the pending notice');
    assert.match(await host.evaluate(() => document.getElementById('toast').textContent), /connection/i);

    const url = await waitFor(host, id => { const l = session.lines.find(x => x.id === id); return l.audioUrl && !document.getElementById(`line-block-${id}`).classList.contains('pending-upload') && l.audioUrl; }, 25000, line.id);
    assert.ok(url && failures === 2, `delivered after ${failures} failures`);
    host.off('request', handler);
    await host.setRequestInterception(false);
  });

  test('reliable upload: a pending take survives a page reload', async () => {
    const line = FIXTURE_LINES[3];
    await claimAndSelect(host, line.id);
    let block = true;
    await host.setRequestInterception(true);
    const handler = request => (block && request.url().includes('/api/upload-line-audio') ? request.abort('failed') : request.continue());
    host.on('request', handler);

    await host.evaluate(id => handleStudioRecord(id), line.id);
    await waitFor(host, id => document.getElementById(`line-block-${id}`).classList.contains('pending-upload'), 20000, line.id);
    await waitUntil(async () => (await host.evaluate(() => new Promise(resolve => {
      const req = indexedDB.open('dubline');
      req.onerror = () => resolve(0);
      req.onsuccess = () => { const all = req.result.transaction('pendingTakes').objectStore('pendingTakes').getAll(); all.onsuccess = () => resolve(all.result.length); };
    }))) > 0, 5000);

    await host.evaluate(() => { window.onbeforeunload = null; });
    await host.reload();
    await waitFor(host, () => socket.connected && session && session.loaded, 10000);
    await waitFor(host, id => document.getElementById(`line-block-${id}`)?.classList.contains('pending-upload'), 5000, line.id);
    block = false;
    await waitFor(host, id => !!session.lines.find(l => l.id === id).audioUrl, 25000, line.id);
    host.off('request', handler);
    await host.setRequestInterception(false);
  });

  test('reliable upload: resending the same upload does not save twice; late takes go to their own session', async () => {
    const result = await host.evaluate(async (lineId) => {
      window.__dupTakeSequence = await reserveTake(lineId, session.activeSessionId);
      const send = async (uploadId) => {
        const form = new FormData();
        form.append('lineId', lineId); form.append('userName', myName); form.append('clientId', clientId);
        form.append('uploadId', uploadId); form.append('sessionId', session.activeSessionId); form.append('audioStart', '1');
        form.append('takeSequence', window.__dupTakeSequence);
        form.append('audio', new Blob([new Uint8Array(200)]), 'take.webm');
        const res = await fetch(`/api/upload-line-audio?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: form });
        return res.json();
      };
      const first = await send('dup-test-id');
      window.__filesAfterFirst = true;
      return { first };
    }, FIXTURE_LINES[2].id);
    const afterFirst = uploadFileCount(server);
    const second = await host.evaluate(async (lineId) => {
      const form = new FormData();
      form.append('lineId', lineId); form.append('userName', myName); form.append('clientId', clientId);
      form.append('uploadId', 'dup-test-id'); form.append('sessionId', session.activeSessionId); form.append('audioStart', '1');
      form.append('takeSequence', window.__dupTakeSequence);
      form.append('audio', new Blob([new Uint8Array(200)]), 'take.webm');
      const res = await fetch(`/api/upload-line-audio?room=${encodeURIComponent(currentRoom)}`, { method: 'POST', body: form });
      return res.json();
    }, FIXTURE_LINES[2].id);
    assert.ok(result.first.success && !result.first.duplicate);
    assert.ok(second.duplicate, 'second send recognized as duplicate');
    assert.equal(uploadFileCount(server), afterFirst, 'the repeat did not store another file');

    // The take was recorded in session A but arrived after the host had opened session B
    const line = FIXTURE_LINES[0];
    await claimAndSelect(host, line.id);
    const sessionA = await host.evaluate(() => session.activeSessionId);
    let block = true;
    await host.setRequestInterception(true);
    const handler = request => (block && request.url().includes('/api/upload-line-audio') ? request.abort('failed') : request.continue());
    host.on('request', handler);
    await host.evaluate(id => handleStudioRecord(id), line.id);
    await waitFor(host, id => document.getElementById(`line-block-${id}`).classList.contains('pending-upload'), 20000, line.id);
    await loadFixture(host); // session B
    const sessionB = await host.evaluate(() => session.activeSessionId);
    assert.notEqual(sessionA, sessionB);
    block = false;
    await host.evaluate(() => retryPendingTakes());
    await waitFor(host, id => { const a = session.sessionList.find(s => s.id === id); return a && a.recorded >= 1; }, 15000, sessionA);
    assert.equal(await host.evaluate(id => session.lines.find(l => l.id === id).audioUrl, line.id), null, 'session B untouched');
    host.off('request', handler);
    await host.setRequestInterception(false);
  });

  test('room password: new players enter it once; wrong / too many attempts', async () => {
    await host.evaluate(() => { document.getElementById('roomPasswordInput').value = 'secret123'; setRoomPassword(); });
    await waitFor(bob, () => session.hasPassword && document.getElementById('roomLockIcon').style.display === 'inline', 5000);
    assert.ok(await bob.evaluate(() => socket.connected), 'players already inside stay');

    const carol = await openPlayer(browser, server.url(room), 'Carol');
    await waitFor(carol, () => document.getElementById('passwordModal').style.display === 'flex', 5000);
    assert.equal(await carol.evaluate(() => session), null, 'no room data before the password');
    await carol.evaluate(() => { document.getElementById('passwordInput').value = 'nope'; submitRoomPassword(new Event('submit')); });
    await waitFor(carol, () => document.getElementById('passwordError').style.display === 'block', 5000);
    await carol.evaluate(() => { document.getElementById('passwordInput').value = 'secret123'; submitRoomPassword(new Event('submit')); });
    await waitFor(carol, () => document.getElementById('passwordModal').style.display === 'none' && session && session.loaded, 5000);
    await carol.reload();
    await waitFor(carol, () => socket.connected && session && session.loaded, 8000);
    assert.equal(await carol.evaluate(() => document.getElementById('passwordModal').style.display), 'none', 'not asked again on this device');
    allPages.push(carol);

    const mallory = await openPlayer(browser, server.url(room), 'Mallory');
    // Wait for the password form and for the answer to each guess: a guess sent before the
    // first answer has no nickname yet and never reaches the server
    await waitFor(mallory, () => document.getElementById('passwordModal').style.display === 'flex', 5000);
    for (let i = 0; i < 5; i++) {
      await mallory.evaluate(() => { document.getElementById('passwordError').textContent = ''; });
      await mallory.evaluate(n => { document.getElementById('passwordInput').value = `guess${n}`; submitRoomPassword(new Event('submit')); }, i);
      await waitFor(mallory, () => document.getElementById('passwordError').textContent !== '', 5000);
    }
    await waitFor(mallory, () => /many/i.test(document.getElementById('passwordError').textContent), 5000);
    await mallory.evaluate(() => { document.getElementById('passwordInput').value = 'secret123'; submitRoomPassword(new Event('submit')); });
    await wait(500);
    assert.equal(await mallory.evaluate(() => session), null, 'blocked after too many attempts');
    await mallory.close();
  });

  test('kick: the player is removed and cannot come back until allowed', async () => {
    const carol = allPages.find(p => p !== host && p !== bob);
    await host.evaluate(() => { window.confirm = () => true; kickPlayer('Carol'); });
    await waitFor(carol, () => document.getElementById('deniedModal').style.display === 'flex', 5000);
    await waitFor(host, () => !document.getElementById('lobbyList').innerText.includes('Carol') || [...document.querySelectorAll('.player-card.offline .player-name')].some(n => n.textContent === 'Carol'), 5000);
    await carol.reload();
    await waitFor(carol, () => document.getElementById('deniedModal').style.display === 'flex', 5000);
    assert.equal(await carol.evaluate(() => session), null);

    await host.evaluate(() => { openSettingsModal(); switchSettingsTab('player'); openSettingsCategory('player', 'room'); });
    await host.locator('#unbanBtn').click();
    await waitFor(host, () => !session.bannedCount, 5000);
    assert.equal(await host.$eval('#roomBanSettings', node => getComputedStyle(node).display), 'none', 'empty ban controls take no space');
    await host.evaluate(() => closeSettingsModal());
    await carol.reload();
    await waitFor(carol, () => document.getElementById('passwordModal').style.display === 'flex', 5000);
    await carol.evaluate(() => { document.getElementById('passwordInput').value = 'secret123'; submitRoomPassword(new Event('submit')); });
    await waitFor(carol, () => session && session.loaded, 5000);
    await host.evaluate(() => removeRoomPassword());
    await waitFor(host, () => !session.hasPassword, 5000);
  });

  test('connection banner on server restart, then automatic rejoin', async () => {
    await server.stop();
    await waitFor(bob, () => document.getElementById('connectionBanner').style.display === 'block' && /No connection/.test(document.getElementById('connectionBanner').textContent), 8000);
    await server.start();
    await waitFor(bob, () => socket.connected && session && session.loaded && document.querySelectorAll('.line-block').length === 4, 20000);
    await waitFor(bob, () => document.getElementById('connectionBanner').style.display === 'none', 6000);
  });

  test('server log records joins, takes, sessions and security events', () => {
    for (const pattern of [/→ Bob joined/, /💾 Alice saved a take/, /opened session/, /deleted session/, /set a room password/, /kicked Carol/, /Wrong room password/]) {
      assert.match(server.log, pattern);
    }
  });

  test('no page errors', () => {
    for (const page of allPages) assert.deepEqual(page.errors, [], JSON.stringify(page.errors));
  });
});
