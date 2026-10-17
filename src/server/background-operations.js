// Ephemeral room operations. Never serialize these into a project or rooms.json.
const crypto = require('node:crypto');
function createOperations({ publish = () => {}, now = Date.now, id = crypto.randomUUID } = {}) {
  const rooms = new Map();
  let revision = 0;
  const view = record => ({
    ...record,
    quietMs: Math.max(0, now() - record.advancedAt),
    elapsedMs: Math.max(0, (record.finishedAt ?? now()) - record.startedAt)
  });
  function snapshot(roomId) {
    const fresh = (rooms.get(roomId) || []).filter(record => record.state === 'running' || now() - record.finishedAt < 300000);
    if (fresh.length) rooms.set(roomId, fresh); else rooms.delete(roomId);
    return fresh.map(view);
  }
  function begin(roomId, { operationId, section = 'video', cancellable = false } = {}) {
    if (snapshot(roomId).some(record => record.state === 'running')) {
      throw Object.assign(Error('A scene operation is already running'), { status: 409, key: 'project.busy' });
    }
    const record = {
      id: typeof operationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(operationId) ? operationId : id(),
      revision: ++revision, kind: 'scene', section: ['video', 'packs', 'projects'].includes(section) ? section : 'video',
      state: 'running', stage: 'upload', percent: null, startedAt: now(), advancedAt: now(), cancellable: !!cancellable
    };
    rooms.set(roomId, [...snapshot(roomId).slice(-1), record]);
    const send = () => publish(roomId, view(record));
    send();
    return {
      id: record.id,
      update(stage, percent = null, backend = null) {
        if (record.state !== 'running' || !['upload', 'download', 'preparing', 'compressing', 'audio'].includes(stage)) return;
        percent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
        backend = ['gpu', 'cpu', 'cpu-fallback'].includes(backend) ? backend : null;
        if (record.stage === stage && record.percent === percent && record.backend === backend) return;
        Object.assign(record, { backend, stage, percent, advancedAt: now(), revision: ++revision });
        send();
      },
      finish(state = 'success') {
        if (record.state !== 'running') return;
        record.state = ['success', 'cancelled', 'error'].includes(state) ? state : 'error';
        record.cancellable = false;
        record.finishedAt = record.advancedAt = now();
        record.percent = record.state === 'success' ? 100 : record.percent;
        record.revision = ++revision;
        send();
      }
    };
  }
  return { begin, snapshot, current: roomId => snapshot(roomId).find(record => record.state === 'running') };
}
const service = createOperations({ publish: (roomId, operation) => require('./app').io.to(roomId).emit('scene_operation', { roomId, operation }) });
function startRequest(req, res, options = {}) {
  if (req.sceneOperation) return req.sceneOperation;
  const roomId = require('./desktop').resolveRoomId(req.query.room || req.body?.room);
  try { req.sceneOperation = service.begin(roomId, { ...options, operationId: req.body?.requestId }); }
  catch (error) { throw new (require('./config').HttpError)(error.status || 409, error.message, error.key || 'project.busy'); }
  res.once('finish', () => req.sceneOperation.finish(res.statusCode < 400 ? 'success' : 'error'));
  res.once('close', () => {
    if (!res.writableFinished) req.sceneOperation.finish(req.uploadAbort?.signal.aborted ? 'cancelled' : 'error');
  });
  req.uploadAbort?.signal.addEventListener('abort', () => req.sceneOperation.finish('cancelled'), { once: true });
  return req.sceneOperation;
}
module.exports = { ...service, startRequest, createOperations };
