const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dublineDesktop', Object.freeze({
  language: ipcRenderer.sendSync('app:get-language'),
  setLanguage: language => ipcRenderer.invoke('app:set-language', language),
  getStatus: () => ipcRenderer.invoke('desktop:get-status'),
  setHostingMode: mode => ipcRenderer.invoke('desktop:set-hosting-mode', mode),
  retryHosting: () => ipcRenderer.invoke('desktop:retry-hosting'),
  openNetworkTool: tool => ipcRenderer.invoke('desktop:open-network-tool', tool),
  copyText: value => ipcRenderer.invoke('desktop:copy-text', value),
  clearAllData: () => ipcRenderer.invoke('desktop:clear-all-data'),
  getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
  openUpdate: () => ipcRenderer.invoke('app:open-update'),
  dismissUpdate: () => ipcRenderer.invoke('app:dismiss-update'),
  openProject: () => ipcRenderer.invoke('app:open-project'),
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
