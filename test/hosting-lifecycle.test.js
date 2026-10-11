const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise the production main-process functions with child-process/network
// boundaries mocked; no public tunnel or duplicate local server is created.
const source = fs.readFileSync('electron-main.js', 'utf8');
const segment = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture(mode = 'porthole') {
  const children = [], deadlines = new Map(); let serial = 0;
  const state = {
    hostingMode: mode, hostingModeRequest: 0, cloudflareEnabled: false, tunnelGeneration: 0, tunnelChild: null, tunnelTimeout: null,
    tunnelStatus: { state: 'idle', publicUrl: '', error: '' }, localPort: 38500, firstGuestConnected: true,
    serverChild: {}, serverFailure: '', shuttingDown: false, ROOM_ID: 'main', roomPin: 'TEST', PORT_MIN: 38500, PORT_MAX: 38599,
    HOSTING_MODES: new Set(['cloudflare', 'porthole', 'vpn']), interfaceLanguage: 'en', app: { isPackaged: false },
    fs: { existsSync: () => true }, resourcePath: () => 'cloudflared.exe',
    currentNetworkTools: async () => ({ porthole: { installed: true, running: true }, radmin: { installed: true, running: true, ip: '26.10.20.30' }, hamachi: {} }),
    publishHostingStatus: () => {}, desktopOperationBusy: async () => false, projectMessages: () => ({ transitionBusy: 'busy' }), requestServer: async () => {},
    setTimeout: callback => { const id = ++serial; deadlines.set(id, callback); return id; }, clearTimeout: id => deadlines.delete(id),
    killProcessTree: child => { child.killed = true; },
    spawn: (file, args) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.args = args; children.push(child); return child; }
  };
  vm.createContext(state);
  vm.runInContext(segment('async function getHostingStatus()', 'function publishHostingStatus()') + segment('function setTunnelStatus(', 'function startServer(') + segment('function stopTunnel(', 'function createLauncherWindow('), state);
  return { state, children, deadlines };
}
test('Cloudflare runs independently, duplicate enable is idempotent and all methods share room/PIN/port', async () => {
  const { state, children } = fixture();
  assert.equal((await state.getHostingStatus()).cloudflare.enabled, false);
  await state.setCloudflareEnabled(true); await state.setCloudflareEnabled(true);
  assert.equal(children.length, 1); assert.ok(children[0].args.includes('http://127.0.0.1:38500'));
  children[0].stderr.emit('data', 'https://first.trycloudflare.com');
  for (const mode of ['porthole', 'vpn', 'cloudflare', 'porthole']) {
    const status = await state.setHostingMode(mode);
    assert.equal(status.cloudflare.publicUrl, 'https://first.trycloudflare.com');
    assert.equal(status.cloudflare.state, 'ready'); assert.equal(status.room, 'main'); assert.equal(status.pin, 'TEST'); assert.equal(status.port, 38500);
    assert.equal(status.firstGuestConnected, true); assert.equal(children.length, 1); assert.equal(children[0].killed, undefined);
    assert.equal(status.connections.porthole.publicUrl, 'http://localhost:38500'); assert.equal(status.connections.vpn.publicUrl, 'http://26.10.20.30:38500');
  }
  const off = await state.setCloudflareEnabled(false); assert.equal(off.cloudflare.publicUrl, ''); assert.equal(off.cloudflare.enabled, false);
  assert.equal(children[0].killed, true); assert.equal(off.connections.vpn.publicUrl, 'http://26.10.20.30:38500');
  await state.setCloudflareEnabled(true); children[0].stderr.emit('data', 'https://stale.trycloudflare.com');
  assert.equal((await state.getHostingStatus()).cloudflare.publicUrl, '');
  children[1].stdout.emit('data', 'https://second.trycloudflare.com'); assert.equal((await state.getHostingStatus()).cloudflare.publicUrl, 'https://second.trycloudflare.com');
});
test('timeout, missing binary, spawn error and child exit clear URLs without stopping local connections', async () => {
  for (const failure of ['timeout', 'missing', 'spawn', 'exit']) {
    const { state, children, deadlines } = fixture('vpn');
    if (failure === 'missing') state.fs.existsSync = () => false;
    await state.setCloudflareEnabled(true);
    if (failure === 'timeout') [...deadlines.values()][0]();
    if (failure === 'spawn') children[0].emit('error', Error('Failed to launch'));
    if (failure === 'exit') { children[0].stderr.emit('data', 'https://old.trycloudflare.com'); children[0].emit('exit', 1); }
    const status = await state.getHostingStatus(); assert.equal(status.cloudflare.state, 'error'); assert.equal(status.cloudflare.publicUrl, '');
    assert.equal(status.connections.vpn.state, 'ready'); assert.equal(status.connections.porthole.state, 'ready');
    state.fs.existsSync = () => true; await state.setCloudflareEnabled(true);
    assert.equal((await state.getHostingStatus()).cloudflare.state, 'connecting');
  }
});
test('late output after stop and concurrent enable/disable cannot revive a stale tunnel; Solo forbids enable', async () => {
  const { state, children } = fixture();
  await Promise.all([state.setCloudflareEnabled(true), state.setCloudflareEnabled(false), state.setCloudflareEnabled(true)]);
  assert.equal(children.length, 2); assert.equal(children[0].killed, true);
  children[0].stdout.emit('data', 'https://stale.trycloudflare.com'); assert.equal(state.tunnelStatus.publicUrl, '');
  state.stopTunnel(); state.hostingMode = 'single';
  assert.throws(() => state.setCloudflareEnabled(true), /multiplayer/);
  children[1].stdout.emit('data', 'https://late.trycloudflare.com'); assert.equal(state.tunnelStatus.publicUrl, '');
  const solo = await state.getHostingStatus();
  assert.equal(solo.publicUrl, ''); assert.equal(solo.cloudflare.enabled, false); assert.equal(solo.cloudflare.publicUrl, '');
  assert.equal(Object.keys(solo.connections).length, 0);
  state.desktopOperationBusy = async () => true;
  await assert.rejects(() => state.setHostingMode('vpn'), /busy/);
  assert.equal(state.hostingMode, 'single');
});
