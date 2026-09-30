const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dublineDesktop', Object.freeze({
  getStatus: () => ipcRenderer.invoke('desktop:get-status'),
  copyText: value => ipcRenderer.invoke('desktop:copy-text', value),
  clearAllData: () => ipcRenderer.invoke('desktop:clear-all-data'),
  onTunnelStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:tunnel-status', listener);
    return () => ipcRenderer.removeListener('desktop:tunnel-status', listener);
  }
}));
