// Remote rooms receive language preferences and selected export tickets, never host/launcher capabilities.
const { contextBridge, ipcRenderer } = require('electron');
// Validate before IPC serialization, including the backing buffer of a small view.
function exportRequest(operation, data = {}) {
  const ticket = typeof data.ticket === 'string' ? data.ticket.slice(0, 160) : '';
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.slice(0, 160) : '';
  let payload = { ticket };
  if (operation === 'choose') payload = { sessionId, extension: String(data.extension || '').slice(0, 8), title: String(data.title || '').slice(0, 100), estimatedBytes: Number(data.estimatedBytes) };
  if (operation === 'write') {
    if (!(data.bytes instanceof Uint8Array) || !data.bytes.byteLength || data.bytes.byteLength > 1024 * 1024 || !Number.isSafeInteger(data.position) || data.position < 0) return Promise.resolve({ ok: false, key: 'exportVideo.fileError' });
    payload = { ticket, sessionId, position: data.position, bytes: new Uint8Array(data.bytes) };
  }
  if (operation === 'commit') payload = { ticket, sessionId, bytes: Number(data.bytes) };
  if (operation === 'reset') payload = { ticket, sessionId };
  return ipcRenderer.invoke('video-export:' + operation, payload);
}
if (process.isMainFrame) contextBridge.exposeInMainWorld('dublineVideoExport', Object.freeze({
  choose: data => exportRequest('choose', data),
  write: data => exportRequest('write', data),
  reset: data => exportRequest('reset', data),
  commit: data => exportRequest('commit', data),
  cancel: data => exportRequest('cancel', data),
  reveal: data => exportRequest('reveal', data)
}));
if (process.isMainFrame) contextBridge.exposeInMainWorld('dublinePreferences', Object.freeze({
  language: ipcRenderer.sendSync('app:get-language'),
  setLanguage: language => ipcRenderer.invoke('app:set-language', language)
}));
