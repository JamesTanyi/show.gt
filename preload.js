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
  swapWindows: () => ipcRenderer.invoke('windows:swap'),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // Convert absolute Windows path to file:// URL (encode #, spaces, CJK)
  toUrl: (absPath) => {
    if (!absPath) return null;
    const raw = String(absPath).replace(/\\/g, '/');
    const m = raw.match(/^([A-Za-z]:)\/(.*)$/);
    if (m) return 'file:///' + m[1] + '/' + m[2].split('/').map(encodeURIComponent).join('/');
    if (raw.startsWith('/')) return 'file://' + raw.split('/').map((seg, i) => i === 0 ? '' : encodeURIComponent(seg)).join('/');
    return 'file:///' + raw.split('/').map(encodeURIComponent).join('/');
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
});
