// Runtime receipts never enter rooms.json or portable projects. A retry has the
// original payload and actor identity, including after nickname/reconnect changes.
const { createHash, randomUUID } = require('node:crypto');
const { roomSockets } = require('./state');
const epoch = randomUUID();
const snapshotVersions = new WeakMap();
function snapshotProtocol(room) {
  const version = (snapshotVersions.get(room) || 0) + 1;
  snapshotVersions.set(room, version);
  return { epoch, serverTime: Date.now(), version };
}
const MAX_RECEIPTS = 4000;
const MAX_BYTES = 16 * 1024 * 1024;
const TTL_MS = 30 * 60 * 1000;
const receipts = new Map();
let bytes = 0;

function prune(now) {
  for (const [key, entry] of receipts) {
    if (entry.expires > now) break;
    receipts.delete(key); bytes -= entry.bytes;
  }
}

function registerMutation(socket, conn, event, handler) {
  socket.on(event, (data = {}, ack) => {
    if (typeof data === 'function') { ack = data; data = {}; }
    const reply = typeof ack === 'function' ? ack : () => {};
    // Legacy callers still receive the existing revision-bound behavior.
    if (!data?.operationId) return handler(data, reply);
    if (!conn.roomId || !conn.nick || roomSockets[conn.roomId]?.[socket.id]?.clientId !== conn.clientId) return reply({ ok: false, reason: 'room' });
    if (typeof data.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(data.operationId)) return reply({ ok: false, reason: 'invalid' });
    const room = require('./rooms').getRoom(conn.roomId);
    if (data.sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    const now = Date.now(); prune(now);
    const key = JSON.stringify([conn.roomId, data.sessionId, conn.clientId, data.operationId]);
    const fingerprint = createHash('sha256').update(JSON.stringify([event, data])).digest('hex');
    const cached = receipts.get(key);
    if (cached) return reply(cached.fingerprint === fingerprint ? JSON.parse(cached.result) : { ok: false, reason: 'operation' });
    if (data.operationEpoch !== epoch || !Number.isFinite(data.operationTime) || now - data.operationTime >= TTL_MS || data.operationTime > now + 60000) return reply({ ok: false, reason: 'expired' });
    if (receipts.size >= MAX_RECEIPTS) return reply({ ok: false, reason: 'capacity' });
    handler(data, result => {
      result = { ...result, editorProtocol: snapshotProtocol(room) };
      let serialized = JSON.stringify(result);
      // Keep a tombstone rather than ever replay an applied request.
      if (bytes + Buffer.byteLength(serialized) > MAX_BYTES) serialized = JSON.stringify({ ok: false, reason: 'expired' });
      const size = Buffer.byteLength(serialized);
      receipts.set(key, { fingerprint, result: serialized, expires: now + TTL_MS, bytes: size });
      bytes += size; prune(now);
      reply(JSON.parse(serialized));
    });
  });
}

// Timing is one semantic group, even when only one edge was patched. Assignment
// retains strict revisions because it also changes claims and track structure.
function patchMatches(line, data) {
  if (Number(data.revision) === Number(line.revision || 0)) return true;
  const base = data.base;
  if (!base || typeof base !== 'object' || data.character !== undefined) return false;
  if (data.caption !== undefined && (!Object.hasOwn(base, 'caption') || base.caption !== line.caption)) return false;
  if (data.start !== undefined || data.end !== undefined) {
    if (!Object.hasOwn(base, 'start') || !Object.hasOwn(base, 'end') || base.start !== line.start || base.end !== line.end) return false;
  }
  return data.caption !== undefined || data.start !== undefined || data.end !== undefined;
}

module.exports = { registerMutation, patchMatches, epoch, snapshotProtocol };
