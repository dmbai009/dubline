// Remote rooms receive only language preferences, never host/launcher capabilities.
const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('dublinePreferences', Object.freeze({
  language: ipcRenderer.sendSync('app:get-language'),
  setLanguage: language => ipcRenderer.invoke('app:set-language', language)
}));
