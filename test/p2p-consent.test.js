const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync('public/p2p.js', 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(preferences = {}, { readFails = false, writeFails = false } = {}) {
  const saved = new Map(Object.entries(preferences)), handlers = new Map(), sent = [], pcs = [], nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { checked: false, open: false, hidden: false, style: {}, parentElement: { style: {} }, listeners: {},
      addEventListener(event, callback) { this.listeners[event] = callback; }, focus() {},
      showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); },
      getClientRects() { return []; } });
    return nodes.get(id);
  };
  class PC {
    constructor() { pcs.push(this); }
    close() { this.closed = true; }
    setRemoteDescription() { return this.remoteWait || Promise.resolve(); }
    createAnswer() { return Promise.resolve({ type: 'answer' }); }
    setLocalDescription(value) { this.localDescription = value; return Promise.resolve(); }
    createOffer() { return Promise.resolve({ type: 'offer' }); }
    createDataChannel() { return channel(); }
  }
  function channel() {
    return { readyState: 'open', bufferedAmount: 0, messages: [], addEventListener() {}, removeEventListener() {},
      send(value) { this.messages.push(value); }, close() { this.readyState = 'closed'; this.onclose?.(); } };
  }
  const state = {
    console, Blob, Uint8Array, ArrayBuffer, DataView, AbortController, URLSearchParams, performance, crypto: webcrypto, RTCPeerConnection: PC,
    isSecureContext: true, hasSceneMediaAccess: () => true, DublineProjectAudio: { sources: () => ({}) },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem(key) { if (readFails) throw Error('Read failed'); return saved.get(key) ?? null; },
      setItem(key, value) { if (writeFails) throw Error('Write failed'); saved.set(key, value); }, removeItem: key => saved.delete(key) },
    document: { getElementById: node, querySelectorAll: () => [], activeElement: null },
    MutationObserver: class { observe() {} }, getComputedStyle: () => ({ visibility: 'visible' }), addEventListener() {}, dispatchEvent() {}, CustomEvent: class {},
    session: { activeSessionId: 'scene', videoUrl: '/video', singlePlayer: false }, currentRoom: 'main', clientId: 'test',
    socket: { connected: true, id: 'local', on(event, callback) { handlers.set(event, callback); }, emit(event, payload, ack) { sent.push({ event, payload }); if (event === 'p2p_find') ack([]); } },
    localMedia: { forVideoUrl: '/video', videoBlob: new Blob(['video']) },
    seedingNicks: new Set(), renderLobby() {}, t: key => key, esc: value => value, formatSize: () => '', showToast() {},
    location: { hostname: 'localhost' }, video: {}, backing: {}, DublineNetwork: { channel: value => value },
    DublineTransferUtils: { rangesFromIndexes: () => [] }, fetch: () => Promise.reject(Error('No manifest'))
  };
  state.window = state; vm.createContext(state); vm.runInContext(source, state);
  const run = code => vm.runInContext(code, state);
  run("p2pJoined = true; heldManifests.set('/video', {id:'manifest',size:5,chunks:['chunk']}); verifiedHeldBlobs.set(localMedia.videoBlob, 'manifest');");
  return { state, saved, sent, pcs, node, channel, run, handlers };
}
test('legacy flags, missing/corrupt consent and failed reads cannot create peers or advertise media', async () => {
  for (const [preferences, options] of [[{}, {}], [{ dubline_p2p: '1' }, {}], [{ dubline_p2p: '0' }, {}],
    [{ dubline_p2p: '1', dubline_p2p_consent_v1: 'broken' }, {}], [{ dubline_p2p: '1', dubline_p2p_consent_v1: 'accepted' }, { readFails: true }]]) {
    const f = fixture(preferences, options);
    await f.run('announceHave(true)');
    await f.handlers.get('p2p_signal')({ from: 'remote', sessionId: 'scene', data: { kind: 'offer', sdp: {} } });
    await assert.rejects(f.run("connectToSeeder('remote')"), /disabled/);
    assert.equal(f.pcs.length, 0); assert.equal(f.node('settingsP2P').checked, false);
    assert.equal(f.sent.some(item => item.event === 'p2p_signal' || item.event === 'p2p_find' || item.payload.files?.length), false);
  }
});
test('consent write failure stays disabled and does not leave accepted consent behind', () => {
  const f = fixture({ dubline_p2p: '1' }, { writeFails: true });
  f.run('maybeShowP2pConsent(); decideP2pConsent(true)');
  assert.equal(f.run('p2pAllowed()'), false); assert.equal(f.node('p2pConsentError').hidden, false);
  assert.equal(f.saved.has('dubline_p2p_consent_v1'), false);
});
test('failed preference writes stop sharing and revoke a stored enable instead of silently restoring it', () => {
  const f = fixture({ dubline_p2p: '1', dubline_p2p_consent_v1: 'accepted' }, { writeFails: true });
  assert.equal(f.run('p2pAllowed()'), true);
  f.node('settingsP2P').checked = false; f.node('settingsP2P').listeners.change();
  assert.equal(f.run('p2pAllowed()'), false); assert.equal(f.node('settingsP2P').checked, false);
  assert.equal(f.saved.has('dubline_p2p_consent_v1'), false);
  f.run('readP2pPreference(); syncP2pSetting()');
  assert.equal(f.run('p2pAllowed()'), false);
});

test('accepted preference is independent from consent and Solo never allows media peers', async () => {
  const f = fixture({ dubline_p2p: '0', dubline_p2p_consent_v1: 'accepted' });
  f.run('heldManifests.clear(); verifiedHeldBlobs.delete(localMedia.videoBlob)');
  assert.equal(f.run('DublineMediaTransfer.stats().currentVideoVerified'), false, 'missing verification evidence cannot mean a verified local file');
  assert.equal(f.run('p2pAllowed()'), false);
  f.node('settingsP2P').checked = true; f.node('settingsP2P').listeners.change();
  assert.equal(f.run('p2pAllowed()'), true);
  f.state.session.singlePlayer = true; f.run('maybeShowP2pConsent()');
  assert.equal(f.node('settingsP2P').checked, false); assert.equal(f.node('p2pConsentDialog').open, false);
  await assert.rejects(f.run("connectToSeeder('remote')"), /disabled/);
});
test('an offer awaiting remote description cannot signal or accept a late channel after disable/re-enable', async () => {
  const f = fixture({ dubline_p2p: '1', dubline_p2p_consent_v1: 'accepted' }), gate = deferred();
  await f.run('probeMediaIntegrity()');
  f.state.RTCPeerConnection.prototype.remoteWait = gate.promise;
  const offer = f.handlers.get('p2p_signal')({ from: 'remote', sessionId: 'scene', data: { kind: 'offer', sdp: {} } });
  await new Promise(resolve => setImmediate(resolve));
  const old = f.pcs[0];
  f.node('settingsP2P').checked = false; f.node('settingsP2P').listeners.change();
  f.node('settingsP2P').checked = true; f.node('settingsP2P').listeners.change();
  gate.resolve(); await offer;
  const late = f.channel(); old.ondatachannel({ channel: late });
  assert.equal(old.closed, true); assert.equal(late.readyState, 'closed');
  assert.equal(f.sent.some(item => item.event === 'p2p_signal'), false);
});
test('upload waiting on the limiter cannot send bytes after disabling, even if re-enabled', async () => {
  const f = fixture({ dubline_p2p: '1', dubline_p2p_consent_v1: 'accepted' }), gate = deferred();
  f.state.testChannel = f.channel(); f.state.mediaUploadLimiter = { take: () => gate.promise };
  f.run("peers.set('seed:remote', {pc:{close(){}},channel:testChannel,sessionId:'scene',generation:p2pGeneration}); serveChannel(testChannel,'seed:remote');");
  f.state.testChannel.onmessage({ data: JSON.stringify({ t: 'open', url: '/video', id: 'manifest' }) });
  f.state.testChannel.onmessage({ data: JSON.stringify({ t: 'get', i: 0 }) });
  await new Promise(resolve => setImmediate(resolve));
  f.node('settingsP2P').checked = false; f.node('settingsP2P').listeners.change();
  f.node('settingsP2P').checked = true; f.node('settingsP2P').listeners.change();
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.testChannel.readyState, 'closed'); assert.equal(f.run('peers.size'), 0);
  assert.equal(f.state.testChannel.messages.filter(value => typeof value !== 'string').length, 0); assert.equal(f.run('uploadedBytes'), 0);
});
test('late manifest verification cannot advertise files after disabling', async () => {
  const f = fixture({ dubline_p2p: '1', dubline_p2p_consent_v1: 'accepted' }), gate = deferred();
  f.run('heldManifests.clear()'); f.state.fetch = () => gate.promise;
  const announce = f.run('announceHave(true)');
  f.node('settingsP2P').checked = false; f.node('settingsP2P').listeners.change();
  gate.resolve({ ok: false }); await announce;
  assert.equal(f.sent.some(item => item.payload.files?.length), false);
});
test('late seeder discovery cannot start a connection after disabling and re-enabling', async () => {
  const f = fixture({ dubline_p2p: '1', dubline_p2p_consent_v1: 'accepted' }); let reply;
  f.state.socket.emit = (event, payload, ack) => { if (event === 'p2p_find') reply = ack; };
  const found = f.run("findSeeders('/video')");
  f.node('settingsP2P').checked = false; f.node('settingsP2P').listeners.change();
  f.node('settingsP2P').checked = true; f.node('settingsP2P').listeners.change();
  reply([{ socketId: 'old-peer', id: 'manifest' }]);
  assert.equal((await found).length, 0); assert.equal(f.pcs.length, 0);
});

test('consent never substitutes for secure APIs, WebRTC capability or confirmed room admission', async () => {
  for (const condition of ['isSecureContext = false', 'crypto = {}', 'RTCPeerConnection = undefined', 'hasSceneMediaAccess = () => false']) {
    const f = fixture({ dubline_p2p: '1', dubline_p2p_consent_v1: 'accepted' });
    f.run(condition); assert.equal(f.run('p2pAllowed()'), false);
    await f.handlers.get('p2p_signal')({ from: 'remote', sessionId: 'scene', data: { kind: 'offer', sdp: {} } });
    await assert.rejects(f.run("connectToSeeder('remote')"), /disabled/);
    assert.equal(f.pcs.length, 0);
  }
});

test('a delayed capability probe cannot revive an offer after disabling and re-enabling P2P', async () => {
  const f = fixture({ dubline_p2p: '1', dubline_p2p_consent_v1: 'accepted' }), gate = deferred();
  f.state.crypto = { subtle: { digest: () => gate.promise } };
  const offer = f.handlers.get('p2p_signal')({ from: 'remote', sessionId: 'scene', data: { kind: 'offer', sdp: {} } });
  f.node('settingsP2P').checked = false; f.node('settingsP2P').listeners.change();
  f.node('settingsP2P').checked = true; f.node('settingsP2P').listeners.change();
  gate.resolve(new ArrayBuffer(32)); await offer;
  assert.equal(f.pcs.length, 0);
  assert.equal(f.sent.some(item => item.event === 'p2p_signal'), false);
});
