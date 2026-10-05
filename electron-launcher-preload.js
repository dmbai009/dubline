const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dublineLauncher', Object.freeze({
  language: ipcRenderer.sendSync('app:get-language'),
  setLanguage: language => ipcRenderer.invoke('app:set-language', language),
  getStorage: () => ipcRenderer.invoke('app:get-storage'),
  chooseStorage: () => ipcRenderer.invoke('app:choose-storage'),
  onStorageProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('app:storage-progress', listener);
    return () => ipcRenderer.removeListener('app:storage-progress', listener);
  },
  detectTools: () => ipcRenderer.invoke('launcher:detect-tools'),
  startHost: mode => ipcRenderer.invoke('launcher:start-host', mode),
  startSingle: () => ipcRenderer.invoke('launcher:start-host', 'single'),
  openProjectFile: mode => ipcRenderer.invoke('launcher:open-project-file', mode),
  joinGuest: address => ipcRenderer.invoke('launcher:join-guest', address),
  openNetworkTool: tool => ipcRenderer.invoke('desktop:open-network-tool', tool),
  getUpdateStatus: () => ipcRenderer.invoke('app:get-update-status'),
  openUpdate: () => ipcRenderer.invoke('app:open-update'),
  dismissUpdate: () => ipcRenderer.invoke('app:dismiss-update'),
  openProject: () => ipcRenderer.invoke('app:open-project'),
  onUpdateStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('app:update-status', listener);
    return () => ipcRenderer.removeListener('app:update-status', listener);
  }
}));
