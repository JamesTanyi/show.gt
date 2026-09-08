const { contextBridge, ipcRenderer } = require('electron');

// ---- Control window API ----
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

  // Send display state to projection window
  setDisplayState: (state) => ipcRenderer.invoke('display:setState', state),

  // Re-detect connected screens and re-place control/display windows accordingly
  relayoutWindows: () => ipcRenderer.invoke('windows:relayout'),
  getLayoutInfo: () => ipcRenderer.invoke('windows:layoutInfo'),

  // Convert absolute Windows path to file:// URL
  toUrl: (absPath) => {
    if (!absPath) return null;
    return 'file:///' + absPath.replace(/\\/g, '/');
  }
});

// ---- Display window API ----
contextBridge.exposeInMainWorld('displayAPI', {
  // Listen for state pushed from control window via main process
  onState: (callback) => {
    ipcRenderer.on('display:state', (_event, state) => callback(state));
  },
  // Get initial state (settings + current program)
  getInitialState: () => ipcRenderer.invoke('display:getInitialState'),
  // Read a local image (or the bundled flake logo if path is empty) as a data URL
  readImageDataUrl: (filePath) => ipcRenderer.invoke('file:readAsDataUrl', filePath || ''),
});
