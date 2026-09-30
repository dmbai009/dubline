// The desktop app's PIN-protected room in a real browser: the host and PIN guests get the scene
// (media now needs the device cookie), everyone else gets neither the room nor its files.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, launchBrowser, startServer, openPlayer, waitFor, loadFixture } = require('./helpers');

const HOST_TOKEN = 'b'.repeat(64);
const PIN = '4XQ2';

describe('desktop PIN room in the browser', { skip: skipReason }, () => {
  let server;
  let browser;
  let host;
  let videoUrl;

  before(async () => {
    server = await startServer({ DUBLINE_DESKTOP_HOST_TOKEN: HOST_TOKEN, DUBLINE_ROOM_PIN: PIN, DUBLINE_DESKTOP_ROOM: 'main' });
    browser = await launchBrowser(server.port);
    host = await openPlayer(browser, `http://localhost:${server.port}/?room=main&desktopHost=${HOST_TOKEN}`, 'Host');
    await waitFor(host, () => session && roomHost === myName, 8000);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.cleanup();
  });

  test('the host loads a pack from the library and the video plays', async () => {
    await loadFixture(host);
    videoUrl = await host.evaluate(() => session.videoUrl);
    assert.match(videoUrl, /^\/uploads\//);
    await waitFor(host, () => document.getElementById('mainVideo').readyState >= 2, 15000);
    assert.deepEqual(host.errors, []);
  });

  test('a guest from the public link enters the PIN and gets the scene video', async () => {
    const guest = await openPlayer(browser, server.url('main', 'dubline.test'), 'Guest');
    await waitFor(guest, () => document.getElementById('passwordModal').style.display === 'flex', 5000);
    assert.equal(await guest.evaluate(() => session), null, 'no room data before the PIN');
    await guest.evaluate(pin => { document.getElementById('passwordInput').value = pin; submitRoomPassword(new Event('submit')); }, PIN);
    await waitFor(guest, () => session && session.loaded && document.querySelectorAll('.line-block').length === 4, 10000);
    await waitFor(guest, () => document.getElementById('mainVideo').readyState >= 2, 20000);
    assert.deepEqual(guest.errors, []);
    await guest.close();
  });

  test('someone who opens another room name without the PIN gets neither the room nor its files', async () => {
    const stranger = await openPlayer(browser, server.url('my-own-room', 'dubline.test'), 'Stranger');
    await waitFor(stranger, () => document.getElementById('passwordModal').style.display === 'flex', 5000);
    assert.equal(await stranger.evaluate(() => session), null, 'no unprotected room was created for them');
    const statuses = await stranger.evaluate(async url => {
      const video = await fetch(url);
      const list = await fetch('/api/server-packs');
      return [video.status, list.status];
    }, videoUrl);
    assert.deepEqual(statuses, [403, 403]);
    await stranger.close();
  });
});
