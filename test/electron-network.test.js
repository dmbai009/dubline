const test = require('node:test');
const assert = require('node:assert/strict');
const { PORT_MIN, PORT_MAX, isPrivateGuestHost, normalizeGuestUrl, findFreePort } = require('../electron-network');

test('guest mode accepts loopback and VPN addresses but rejects public HTTP', () => {
  assert.equal(isPrivateGuestHost('localhost'), true);
  assert.equal(isPrivateGuestHost('25.10.20.30'), true);
  assert.equal(isPrivateGuestHost('26.10.20.30'), true);
  assert.equal(isPrivateGuestHost('192.168.1.7'), true);
  assert.equal(isPrivateGuestHost('172.31.4.9'), true);
  assert.equal(isPrivateGuestHost('172.32.4.9'), false);
  assert.equal(normalizeGuestUrl('26.10.20.30:38500'), 'http://26.10.20.30:38500/?room=main');
  assert.equal(normalizeGuestUrl('http://localhost:38500/?room=anime&desktopHost=secret'), 'http://localhost:38500/?room=anime');
  assert.equal(normalizeGuestUrl('https://example.com/room'), 'https://example.com/room?room=main');
  assert.throws(() => normalizeGuestUrl('http://example.com:38500'), /private VPN/);
  assert.throws(() => normalizeGuestUrl('file:///tmp/page'), /http/);
});

test('desktop host chooses a free port from the documented range', async () => {
  const port = await findFreePort();
  assert.ok(port >= PORT_MIN && port <= PORT_MAX);
});
