const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');

let win;

// ---- Paths ----
const userDataPath = app.getPath('userData');
const mediaDir = path.join(userDataPath, 'media');
const dataFile = path.join(userDataPath, 'programs.json');
const settingsFile = path.join(userDataPath, 'settings.json');

function ensureDirs() {
  fs.mkdirSync(mediaDir, { recursive: true });
}

// ---- Data persistence (JSON files) ----
function loadData() {
  try {
    if (fs.existsSync(dataFile)) {
      return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
  } catch (_) {}
  return { programs: [] };
}

function saveData(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

const DEFAULT_SETTINGS = {
  showTitle: 'XXXX医院慰问演出',
  organizerLine1: '主办单位：请在设置中填写',
  organizerLine2: '',
  welcomeMusic: ''
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
}

// ---- File operations ----
function copyMediaFile(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  const stamp = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const newName = `media_${stamp}${ext}`;
  const destPath = path.join(mediaDir, newName);
  fs.copyFileSync(srcPath, destPath);
  return destPath;
}

const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|aac|flac)$/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif)$/i;
const PALETTE = ['#7A1F3D', '#1F3D4A', '#3D2F1F', '#1F4A2E', '#4A1F3D', '#2A2438'];

function scanShowFolder(folderPath) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const subfolders = entries
    .filter(e => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));

  const results = [];
  for (const folder of subfolders) {
    const subPath = path.join(folderPath, folder.name);
    let files;
    try { files = fs.readdirSync(subPath, { withFileTypes: true }).filter(f => f.isFile()); }
    catch (_) { continue; }

    const images = files.filter(f => IMAGE_EXT.test(f.name));
    const audios = files.filter(f => AUDIO_EXT.test(f.name));
    const bgEntry = images.find(f => /^(bg|background|背景)/i.test(f.name)) || images[0];
    const audioEntry = audios.find(f => /^(music|audio|bgm|音乐)/i.test(f.name)) || audios[0];

    // Parse folder name → name + performer
    const rest = folder.name.replace(/^\s*\d+\s*[-_.\s]*/, '');
    const segs = rest.split(/[-_]/).map(s => s.trim()).filter(Boolean);
    const name = segs[0] || folder.name;
    const performer = segs.slice(1).join(' ') || '';

    let bgImagePath = null, audioPath = null, audioName = '';
    if (bgEntry) {
      try { bgImagePath = copyMediaFile(path.join(subPath, bgEntry.name)); } catch (_) {}
    }
    if (audioEntry) {
      try {
        audioPath = copyMediaFile(path.join(subPath, audioEntry.name));
        audioName = audioEntry.name;
      } catch (_) {}
    }

    results.push({
      id: 'p_' + Math.random().toString(36).slice(2, 9),
      name, performer,
      bgColor: PALETTE[results.length % PALETTE.length],
      bgImagePath,
      audioPath,
      audioName
    });
  }
  return results;
}

// ---- Custom protocol: app:// serves project root ----
// Allows the renderer to load fonts from node_modules via app://node_modules/...
function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    // url.pathname is like /node_modules/@fontsource/...
    const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const filePath = path.join(__dirname, relativePath);
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
}

// ---- Window ----
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#0E0B10',
    title: '幕启 · 演出管理系统',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  win.loadFile('index.html');
  win.setMenuBarVisibility(false);
}

// Must be called before app.whenReady() to register the scheme
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

app.whenReady().then(() => {
  ensureDirs();
  registerAppProtocol();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC handlers ----
ipcMain.handle('data:get', () => loadData());
ipcMain.handle('data:save', (_, data) => { saveData(data); return true; });

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_, s) => { saveSettings(s); return true; });

ipcMain.handle('file:copyMedia', (_, srcPath) => {
  try { return { ok: true, path: copyMediaFile(srcPath) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('file:scanFolder', (_, folderPath) => {
  try { return { ok: true, programs: scanShowFolder(folderPath) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '选择演出文件夹'
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:file', async (_, options) => {
  const r = await dialog.showOpenDialog(win, options);
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('data:export', async (_, data) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, {
    title: '导出节目单',
    defaultPath: `节目单_${stamp}.json`,
    filters: [{ name: 'JSON 节目单', extensions: ['json'] }]
  });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
  return true;
});

ipcMain.handle('data:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '导入节目单',
    filters: [{ name: 'JSON 节目单', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled) return null;
  try {
    return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  } catch (e) {
    return { error: e.message };
  }
});
