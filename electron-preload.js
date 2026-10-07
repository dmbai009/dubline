const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dublineDesktop', Object.freeze({
  language: ipcRenderer.sendSync('app:get-language'),
  getClientId: previous => ipcRenderer.sendSync('desktop:get-client-id', previous),
  setLanguage: language => ipcRenderer.invoke('app:set-language', language),
  getStorage: () => ipcRenderer.invoke('app:get-storage'),
  chooseStorage: () => ipcRenderer.invoke('app:choose-storage'),
  getStatus: () => ipcRenderer.invoke('desktop:get-status'),
  setHostingMode: mode => ipcRenderer.invoke('desktop:set-hosting-mode', mode),
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
