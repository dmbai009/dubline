const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preloads cannot import a local helper; keep this aligned with the guest bridge.
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

contextBridge.exposeInMainWorld('dublineVideoExport', Object.freeze({
  choose: data => exportRequest('choose', data),
  write: data => exportRequest('write', data),
  reset: data => exportRequest('reset', data),
  commit: data => exportRequest('commit', data),
  cancel: data => exportRequest('cancel', data),
  reveal: data => exportRequest('reveal', data)
}));

contextBridge.exposeInMainWorld('dublineDesktop', Object.freeze({
  language: ipcRenderer.sendSync('app:get-language'),
  getClientId: previous => ipcRenderer.sendSync('desktop:get-client-id', previous),
  setLanguage: language => ipcRenderer.invoke('app:set-language', language),
  getStorage: () => ipcRenderer.invoke('app:get-storage'),
  chooseStorage: () => ipcRenderer.invoke('app:choose-storage'),
  getStatus: () => ipcRenderer.invoke('desktop:get-status'),
  setHostingMode: mode => ipcRenderer.invoke('desktop:set-hosting-mode', mode),
  setCloudflareEnabled: enabled => ipcRenderer.invoke('desktop:set-cloudflare-enabled', enabled),
  retryHosting: () => ipcRenderer.invoke('desktop:retry-hosting'),
  openNetworkTool: tool => ipcRenderer.invoke('desktop:open-network-tool', tool),
  copyText: value => ipcRenderer.invoke('desktop:copy-text', value),
  clearAllData: () => ipcRenderer.invoke('desktop:clear-all-data'),
  getBuildInfo: () => ipcRenderer.invoke('app:get-build-info'),
  getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
  openUpdate: () => ipcRenderer.invoke('app:open-update'),
  openUpdateDetails: () => ipcRenderer.invoke('app:open-update-details'),
  projectAssociation: operation => ipcRenderer.invoke('app:project-association', operation),
  dismissUpdate: () => ipcRenderer.invoke('app:dismiss-update'),
  openProject: () => ipcRenderer.invoke('app:open-project'),
  chooseProjectDestination: data => ipcRenderer.invoke('desktop:choose-project-destination', data),
  saveProject: data => ipcRenderer.invoke('desktop:save-project', data),
  cancelProjectSave: data => ipcRenderer.invoke('desktop:cancel-project-save', data),
  onProjectSaveProgress: callback => {
    const listener=(_event,progress)=>callback(progress);ipcRenderer.on('desktop:project-save-progress',listener);
    return ()=>ipcRenderer.removeListener('desktop:project-save-progress',listener);
  },
  onProjectOpenWaiting: callback => {
    const listener = () => callback(); ipcRenderer.on('desktop:project-open-waiting', listener);
    return () => ipcRenderer.removeListener('desktop:project-open-waiting', listener);
  },
  onUpdateStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('app:update-status', listener);
    return () => ipcRenderer.removeListener('app:update-status', listener);
  },
  onTunnelStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:hosting-status', listener);
    return () => ipcRenderer.removeListener('desktop:hosting-status', listener);
  }
}));
