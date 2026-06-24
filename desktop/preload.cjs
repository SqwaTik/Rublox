// Preload: безопасный мост для управления окном из веб-страницы.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rublox', {
  win: (action) => ipcRenderer.send('win', action),
  // Прогресс установки обновления: main шлёт {stage, pct}.
  onUpdateProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update-progress', handler);
    return () => ipcRenderer.removeListener('update-progress', handler);
  },
});
