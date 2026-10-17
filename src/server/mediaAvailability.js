const { roomSockets } = require('./state');
const { getRoom } = require('./rooms');
const { validRanges } = require('../public/transfer-utils');
const records = new Map();
function allowed(room) {
  const sources = require('../public/project-audio').sources(room);
  return new Set([room.videoUrl, room.backingUrl, sources.original, sources.backing].filter(Boolean));
}
async function update(socket, conn, data) {
  const roomId = conn.roomId, sessionId = data.sessionId;
  if (!Array.isArray(data.files) || data.files.length > 4 || !Number.isSafeInteger(data.sequence) || data.sequence < 1 || records.get(socket.id)?.sequence >= data.sequence) return false;
  const room = getRoom(roomId), urls = allowed(room), files = [];
  for (const file of data.files) {
    if (!file || !urls.has(file.url) || typeof file.id !== 'string') return false;
    const manifest = await require('./mediaManifest').build(file.url);
    if (file.id !== manifest.id || !validRanges(file.ranges, manifest.chunks.length)) return false;
    files.push({ url: file.url, id: manifest.id, ranges: file.ranges, complete: file.ranges.length === 1 && file.ranges[0][0] === 0 && file.ranges[0][1] === manifest.chunks.length - 1 });
  }
  if (conn.roomId !== roomId || room.activeSessionId !== sessionId || !roomSockets[roomId]?.[socket.id]?.nick || records.get(socket.id)?.sequence >= data.sequence) return false;
  records.set(socket.id, { roomId, sessionId, files, sequence: data.sequence, at: Date.now() }); return true;
}
function peers(roomId, url, exceptSocketId) {
  const room = getRoom(roomId), result = [];
  for (const [socketId, record] of records) {
    if (!roomSockets[record.roomId]?.[socketId] || getRoom(record.roomId).activeSessionId !== record.sessionId || record.at + 30000 < Date.now()) { records.delete(socketId); continue; }
    if (record.roomId !== roomId || record.sessionId !== room.activeSessionId || socketId === exceptSocketId) continue;
    const file = record.files.find(file => file.url === url);
    if (file?.ranges.length) result.push({ socketId, ...file });
  }
  return result;
}
function clear(socketId) { records.delete(socketId); }
module.exports = { update, peers, clear, allowed };
