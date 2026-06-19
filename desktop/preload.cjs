// Preload: безопасный мост для управления окном из веб-страницы.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rublox', {
  win: (action) => ipcRenderer.send('win', action),
});
