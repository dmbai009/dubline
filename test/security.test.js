// Access control: the desktop room PIN, media behind it, upload rights and the password lockout.
// Each suite starts a real server in temporary folders (the real data/ and uploads/ are never touched)
// and talks to it over Socket.IO and HTTP like a browser would.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { io: connect } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const HOST_TOKEN = 'a'.repeat(64);
const PIN = '7K9A';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-security-'));
  const dirs = { data: path.join(base, 'data'), uploads: path.join(base, 'uploads'), packs: path.join(base, 'packs') };
  // Loaded into the server process only for the test: answers how much memory the server holds
  const memoryProbe = path.join(base, 'memory-probe.js');
  fs.writeFileSync(memoryProbe, "process.on('message', m => { if (m === 'memory?') process.send({ type: 'memory', rss: process.memoryUsage().rss }); });\n");
  const proc = fork(path.join(ROOT, 'server.js'), [], {
    cwd: ROOT,
    silent: true,
    execArgv: ['--require', memoryProbe],
    env: {
      ...process.env,
      PORT: String(port),
      DUBLINE_DATA_DIR: dirs.data,
      DUBLINE_UPLOAD_DIR: dirs.uploads,
      DUBLINE_PACKS_DIR: dirs.packs,
      DUBLINE_OPEN_BROWSER: '',
      DUBLINE_DESKTOP_HOST_TOKEN: '',
      DUBLINE_ROOM_PIN: '',
      ...extraEnv
    }
  });
  let output = '';
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000);
    proc.on('message', message => {
      if (message && message.type === 'ready') {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', code => reject(new Error(`server exited with ${code}:\n${output}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    rssMb() {
      return new Promise(resolve => {
        const onMessage = message => {
          if (!message || message.type !== 'memory') return;
          proc.off('message', onMessage);
          resolve(message.rss / (1024 * 1024));
        };
        proc.on('message', onMessage);
        proc.send('memory?');
      });
    },
    dirs,
    output: () => output,
    async stop() {
      proc.kill();
      await new Promise(resolve => proc.once('exit', resolve));
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

const sockets = [];

function openSocket(server) {
  const socket = connect(server.url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  return socket;
}

// Resolves with the server's answer to join_room: admitted (the session arrives) or refused
function join(socket, data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer to join_room')), 5000);
    const done = result => {
      clearTimeout(timer);
      socket.off('join_denied', onDenied);
      socket.off('session_updated', onSession);
      resolve(result);
    };
    const onDenied = ({ reason, pin }) => done({ joined: false, reason, pin });
    const onSession = session => done({ joined: true, session });
    socket.on('join_denied', onDenied);
    socket.on('session_updated', onSession);
    socket.emit('join_room', data);
  });
}

// A new socket that joins and stays connected (a player in the room)
async function player(server, data) {
  const socket = openSocket(server);
  const result = await join(socket, data);
  return { socket, ...result };
}

function get(server, urlPath, clientId = null) {
  const headers = clientId ? { cookie: `dubline_client=${encodeURIComponent(clientId)}` } : {};
  return fetch(server.url + urlPath, { headers });
}

async function postFile(server, urlPath, fields, fileField, fileName, content) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append(fileField, new Blob([content]), fileName);
  const res = await fetch(server.url + urlPath, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

function packZip(extraFiles = {}) {
  const zip = new AdmZip();
  zip.addFile('dub_video.mp4', Buffer.from('not really a video'));
  zip.addFile('line_1.ini', Buffer.from('caption = "Hello"\ndub_characters = ["Hero"]\ndub_timestamps = [1.0, 2.0]\n'));
  for (const [name, content] of Object.entries(extraFiles)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

after(() => sockets.forEach(socket => socket.disconnect()));

describe('desktop app room (PIN)', () => {
  let server;
  let host;
  const hostId = 'host-device';

  before(async () => {
    server = await startServer({ DUBLINE_DESKTOP_HOST_TOKEN: HOST_TOKEN, DUBLINE_ROOM_PIN: PIN, DUBLINE_DESKTOP_ROOM: 'main' });
    fs.writeFileSync(path.join(server.dirs.uploads, 'probe.txt'), 'scene media');
    fs.writeFileSync(path.join(server.dirs.packs, 'library.zip'), packZip());
    host = await player(server, { room: 'main', clientId: hostId, nick: 'Host', desktopHostToken: HOST_TOKEN });
    assert.equal(host.joined, true);
  });

  after(async () => {
    sockets.forEach(socket => socket.disconnect());
    await server.stop();
  });

  test('any other room name leads to the PIN prompt instead of a new unprotected room', async () => {
    for (const room of ['other', 'main', '../x', '']) {
      const stranger = await player(server, { room, clientId: `stranger-${room}`, nick: 'Stranger' });
      assert.deepEqual({ joined: stranger.joined, reason: stranger.reason, pin: stranger.pin },
        { joined: false, reason: 'password', pin: true }, `room "${room}"`);
    }
  });

  test('media, the pack library and its list need the PIN', async () => {
    for (const urlPath of ['/uploads/probe.txt', '/packs/library.zip', '/api/server-packs']) {
      assert.equal((await get(server, urlPath)).status, 403, `${urlPath} without a device`);
      assert.equal((await get(server, urlPath, 'unknown-device')).status, 403, `${urlPath} for a device without the PIN`);
    }
    const hostRes = await get(server, '/uploads/probe.txt', hostId);
    assert.equal(hostRes.status, 200);
    assert.equal(await hostRes.text(), 'scene media');
  });

  test('a guest with the right PIN is admitted, even via another room name, and can fetch media', async () => {
    const guest = await player(server, { room: 'other', clientId: 'guest-device', nick: 'Guest', password: PIN });
    assert.equal(guest.joined, true);
    const res = await get(server, '/uploads/probe.txt', 'guest-device');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    const list = await get(server, '/api/server-packs', 'guest-device');
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).map(pack => pack.filename), ['library.zip']);
  });

  test('uploads are refused for players who are not the host', async () => {
    const byStranger = await postFile(server, '/api/upload-pack?room=other', { clientId: 'unknown-device' }, 'pack', 'evil.zip', packZip());
    assert.equal(byStranger.status, 403);
    assert.equal(byStranger.body.key, 'error.hostOnlyPack');
    const byGuest = await postFile(server, '/api/upload-pack?room=main', { clientId: 'guest-device' }, 'pack', 'evil.zip', packZip());
    assert.equal(byGuest.status, 403);
    const scene = await postFile(server, '/api/upload-custom?room=other', { clientId: 'unknown-device' }, 'video', 'v.mp4', 'x');
    assert.equal(scene.status, 403);
    assert.equal(scene.body.key, 'error.hostOnlyScene');
  });

  test('the host uploads into the protected room; only media and text files are extracted', async () => {
    const zip = packZip({ 'evil.html': '<script>alert(1)</script>', 'evil.svg': '<svg onload="alert(1)"/>', 'script.js': 'x' });
    const res = await postFile(server, '/api/upload-pack?room=elsewhere', { clientId: hostId }, 'pack', 'scene.zip', zip);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.session.title, 'scene');
    assert.equal(res.body.session.lines.length, 1);
    const extracted = fs.readdirSync(path.join(server.dirs.uploads, 'pack_scene')).sort();
    assert.deepEqual(extracted, ['.ready', 'dub_video.mp4', 'line_1.ini']);
  });

  test('an archive with falsified sizes is refused as damaged, not with an internal error', async () => {
    const zip = new AdmZip();
    zip.addFile('backing_track.wav', Buffer.alloc(2 * 1024 * 1024, 7));
    const buf = zip.toBuffer();
    for (const [signature, offset] of [[0x04034b50, 22], [0x02014b50, 24]]) {
      for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === signature) buf.writeUInt32LE(10, i + offset);
    }
    const res = await postFile(server, '/api/upload-pack?room=main', { clientId: hostId }, 'pack', 'bomb.zip', buf);
    assert.equal(res.status, 400);
    assert.equal(res.body.key, 'error.notZip');
  });

  test('a kicked guest loses access to media', async () => {
    const victim = await player(server, { room: 'main', clientId: 'kicked-device', nick: 'Victim', password: PIN });
    assert.equal(victim.joined, true);
    assert.equal((await get(server, '/uploads/probe.txt', 'kicked-device')).status, 200);
    const kicked = new Promise(resolve => victim.socket.once('kicked', resolve));
    host.socket.emit('host_kick', { nick: 'Victim' });
    await kicked;
    assert.equal((await get(server, '/uploads/probe.txt', 'kicked-device')).status, 403);
  });

  test('a malformed P2P report does not break the server', async () => {
    host.socket.emit('p2p_report', { url: '/uploads/%E0%A4%A', p2pBytes: 1, httpBytes: 1, peers: 1 });
    const serverTime = await new Promise(resolve => host.socket.emit('time_sync', Date.now(), resolve));
    assert.equal(typeof serverTime, 'number');
  });

  // Last: it locks the room for new devices
  test('wrong PINs from many sockets lock the room; admitted players still get in', async () => {
    const socket = openSocket(server);
    for (let i = 1; i <= 5; i++) {
      const answer = await join(socket, { room: 'main', clientId: 'guesser-0', nick: 'Guesser', password: 'ZZZZ' });
      assert.equal(answer.reason, i < 5 ? 'wrongPassword' : 'tooMany');
    }
    assert.equal((await join(socket, { room: 'main', clientId: 'guesser-0', nick: 'Guesser', password: PIN })).reason, 'tooMany',
      'the same socket stays blocked');

    // Reconnecting used to reset the counter: fresh sockets keep guessing until the room-wide limit
    for (let n = 1; n < 4; n++) {
      const fresh = openSocket(server);
      for (let i = 0; i < 5; i++) await join(fresh, { room: 'main', clientId: `guesser-${n}`, nick: 'Guesser', password: 'ZZZZ' });
    }
    const late = await player(server, { room: 'main', clientId: 'late-device', nick: 'Late', password: PIN });
    assert.deepEqual({ joined: late.joined, reason: late.reason }, { joined: false, reason: 'tooMany' });
    assert.match(server.output(), /Too many wrong passwords from different devices/);

    const returning = await player(server, { room: 'main', clientId: 'guest-device', nick: 'Guest' });
    assert.equal(returning.joined, true);
  });
});

describe('browser server (start.bat)', () => {
  let server;
  const hostId = 'browser-host';

  before(async () => {
    server = await startServer();
    fs.writeFileSync(path.join(server.dirs.uploads, 'probe.txt'), 'scene media');
    const host = await player(server, { room: 'party', clientId: hostId, nick: 'Host' });
    assert.equal(host.joined, true);
  });

  after(async () => {
    sockets.forEach(socket => socket.disconnect());
    await server.stop();
  });

  test('media stays open as before (the browser server is for trusted groups)', async () => {
    assert.equal((await get(server, '/uploads/probe.txt')).status, 200);
    assert.equal((await get(server, '/api/server-packs')).status, 200);
  });

  test('rooms stay separate and the first player becomes the host', async () => {
    const other = await player(server, { room: 'another', clientId: 'another-host', nick: 'Other' });
    assert.equal(other.joined, true);
    const res = await postFile(server, '/api/upload-pack?room=another', { clientId: 'another-host' }, 'pack', 'mine.zip', packZip());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const denied = await postFile(server, '/api/upload-pack?room=party', { clientId: 'another-host' }, 'pack', 'mine.zip', packZip());
    assert.equal(denied.status, 403);
  });

  test('a take from an unconfirmed nickname is refused', async () => {
    const res = await postFile(server, '/api/upload-line-audio?room=party',
      { lineId: '1', userName: 'Host', clientId: 'someone-else' }, 'audio', 'take.webm', 'x');
    assert.equal(res.status, 403);
    assert.equal(res.body.key, 'error.nickNotConfirmed');
  });

  test('a refused upload is discarded instead of being buffered in memory', async () => {
    const MB = 1024 * 1024;
    const boundary = 'dublineBoundary';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="clientId"\r\n\r\nnot-the-host\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="pack"; filename="big.zip"\r\nContent-Type: application/zip\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const before = await server.rssMb();
    let peak = before;
    const sampler = setInterval(() => server.rssMb().then(mb => { peak = Math.max(peak, mb); }), 50);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${server.url}/api/upload-pack?room=party`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(head.length + 200 * MB + tail.length) }
      }, res => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.write(head);
      const chunk = Buffer.alloc(MB);
      let sent = 0;
      const pump = () => {
        while (sent < 200) {
          sent++;
          if (!req.write(chunk)) return req.once('drain', pump);
        }
        req.end(tail);
      };
      pump();
    });
    clearInterval(sampler);
    peak = Math.max(peak, await server.rssMb());
    assert.equal(status, 403);
    assert.ok(peak - before < 100, `the server grew by ${Math.round(peak - before)} MB for a refused 200 MB upload`);
  });
});
