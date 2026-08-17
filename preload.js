const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Data
  getData:      ()       => ipcRenderer.invoke('data:get'),
  saveData:     (data)   => ipcRenderer.invoke('data:save', data),
  exportData:   (data)   => ipcRenderer.invoke('data:export', data),
  importData:   ()       => ipcRenderer.invoke('data:import'),

  // Settings
  getSettings:  ()       => ipcRenderer.invoke('settings:get'),
  saveSettings: (s)      => ipcRenderer.invoke('settings:save', s),

  // File operations
  copyMedia:    (src)    => ipcRenderer.invoke('file:copyMedia', src),
  scanFolder:   (p)      => ipcRenderer.invoke('file:scanFolder', p),

  // Dialogs
  openFolder:   ()       => ipcRenderer.invoke('dialog:folder'),
  openFile:     (opts)   => ipcRenderer.invoke('dialog:file', opts),

  // Convert an absolute Windows path to a file:// URL the renderer can use
  toUrl: (absPath) => {
    if (!absPath) return null;
    return 'file:///' + absPath.replace(/\\/g, '/');
  }
});
