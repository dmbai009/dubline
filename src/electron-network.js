const crypto = require('crypto');
const net = require('net');

const ROOM_ID = 'main';
const PORT_MIN = 38473;
const PORT_MAX = 38637;

function isPrivateGuestHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^(10|127|25|26)\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

function normalizeGuestUrl(value) {
  let candidate = String(value || '').trim();
  if (!candidate) throw new Error('Enter the Radmin, Hamachi, or Porthole room address.');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// room links are supported.');
  if (url.protocol === 'http:' && !isPrivateGuestHost(url.hostname)) {
    throw new Error('Insecure guest mode is limited to localhost and private VPN addresses.');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  if (!url.searchParams.has('room')) url.searchParams.set('room', ROOM_ID);
  url.searchParams.delete('desktopHost');
  return url.toString();
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', err => err.code === 'EADDRINUSE' || err.code === 'EACCES' ? resolve(false) : reject(err));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

async function findFreePort(preferred) {
  if (Number.isInteger(preferred) && preferred >= PORT_MIN && preferred <= PORT_MAX && await checkPort(preferred)) return preferred;
  const count = PORT_MAX - PORT_MIN + 1;
  const first = crypto.randomInt(count);
  for (let offset = 0; offset < count; offset++) {
    const port = PORT_MIN + ((first + offset) % count);
    if (await checkPort(port)) return port;
  }
  throw new Error(`No free TCP port is available in the Dubline range ${PORT_MIN}-${PORT_MAX}.`);
}

module.exports = { ROOM_ID, PORT_MIN, PORT_MAX, isPrivateGuestHost, normalizeGuestUrl, findFreePort };
