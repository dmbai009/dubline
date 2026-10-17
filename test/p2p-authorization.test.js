const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
function fixture() {
  const handlers = new Map(), sent = [], logs = [];
  const conn = { roomId: 'main', nick: 'Source', clientId: 'source' }, room = { activeSessionId: 'scene', singlePlayer: false };
  const members = { main: { source: conn, target: { nick: 'Target' } } };
  const dependencies = {
    '../state': { roomSockets: members, p2pSeeders: {} },
    '../app': { io: { to: target => ({ emit: (event, data) => sent.push({ target, event, data }) }) } },
    '../log': { logEvent: (...data) => logs.push(data) }, '../rooms': { getRoom: () => room },
    '../presence': { clearSocketSeeds() {}, broadcastSeeders() {} },
    '../mediaAvailability': { peers: () => [{ socketId: 'target' }], allowed: () => new Set(['/video']) }
  };
  const context = { module: { exports: {} }, require: name => dependencies[name] };
  vm.runInNewContext(fs.readFileSync('src/server/sockets/p2p.js', 'utf8'), context);
  context.module.exports({ id: 'source', on: (event, callback) => handlers.set(event, callback) }, conn);
  return { handlers, conn, room, members, sent, logs };
}
test('anonymous, departed-scene and revoked members cannot discover or signal media peers', () => {
  const f = fixture(), find = f.handlers.get('p2p_find'), signal = f.handlers.get('p2p_signal');
  let found;
  find({ url: '/video', sessionId: 'scene', detailed: true }, peers => { found = peers; }); assert.equal(found.length, 1);
  for (const data of [null, [], { url: '/video', sessionId: 'old-scene' }]) {
    find(data, peers => { found = peers; }); assert.equal(found.length, 0);
  }
  signal({ to: 'target', sessionId: 'old-scene', data: { kind: 'offer' } }); assert.equal(f.sent.length, 0);
  f.conn.nick = ''; find({ url: '/video' }, peers => { found = peers; }); assert.equal(found.length, 0);
  signal({ to: 'target', data: { kind: 'offer' } }); assert.equal(f.sent.length, 0);
  f.conn.nick = 'Source'; delete f.members.main.source;
  signal({ to: 'target', data: { kind: 'offer' } }); assert.equal(f.sent.length, 0);
});
test('valid signaling remains room-bound and cannot target an unnamed participant or malformed request', () => {
  const f = fixture(), signal = f.handlers.get('p2p_signal');
  signal(null); signal([]); signal({ to: 'outside', data: { kind: 'offer' } }); assert.equal(f.sent.length, 0);
  f.members.main.target.nick = ''; signal({ to: 'target', data: { kind: 'offer' } }); assert.equal(f.sent.length, 0);
  f.members.main.target.nick = 'Target'; signal({ to: 'target', sessionId: 'scene', data: { kind: 'offer' } });
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].target, 'target'); assert.equal(f.sent[0].data.sessionId, 'scene');
});
test('diagnostic reports accept bounded current-scene counters and ignore invalid or unrelated media', () => {
  const f = fixture(), report = f.handlers.get('p2p_report');
  for (const data of [null, {}, { url: '/private', p2pBytes: 1, httpBytes: 2, peers: 1 },
    { url: '/video', p2pBytes: Infinity, httpBytes: 2, peers: 1 }, { url: '/video', p2pBytes: 1, httpBytes: 2, peers: 999 }]) report(data);
  assert.equal(f.logs.length, 0);
  report({ sessionId: 'scene', url: '/video', p2pBytes: 1, httpBytes: 2, peers: 1 }); assert.equal(f.logs.length, 1);
});
