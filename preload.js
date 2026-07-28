const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.send('timer:start'),
  pause: () => ipcRenderer.send('timer:pause'),
  reset: () => ipcRenderer.send('timer:reset'),
  setTimes: (t) => ipcRenderer.send('timer:setTimes', t),
  getState: () => ipcRenderer.invoke('timer:getState'),
  getVideos: () => ipcRenderer.invoke('reminder:videos'),
  onTick: (cb) => ipcRenderer.on('timer:tick', (_e, snapshot) => cb(snapshot)),
  closeReminder: () => ipcRenderer.send('reminder:close'),
  getAutostart: () => ipcRenderer.invoke('settings:getAutostart'),
  setAutostart: (enabled) => ipcRenderer.send('settings:setAutostart', enabled),
});
