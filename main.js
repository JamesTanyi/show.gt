const { app, BrowserWindow, ipcMain, dialog, protocol, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let controlWin, displayWin;

// ---- Crash safety: never fail silently on show day ----
process.on('uncaughtException', (err) => {
  try { dialog.showErrorBox('幕启 · 出现错误', String(err && err.stack || err)); } catch (_) {}
});

// ---- Paths ----
const userDataPath = app.getPath('userData');
const mediaDir = path.join(userDataPath, 'media');
const dataFile = path.join(userDataPath, 'programs.json');
const settingsFile = path.join(userDataPath, 'settings.json');

function ensureDirs() {
  fs.mkdirSync(mediaDir, { recursive: true });
}

// ---- Data persistence ----
function loadData() {
  try {
    if (fs.existsSync(dataFile)) return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (_) {}
  return { programs: [] };
}

function saveData(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

const DEFAULT_SETTINGS = {
  titleDE: 'Herbstkühle · Benefizkonzert',
  hospitalName: 'Geriatrische Klinik Baumgarten',
  titleZH: '仲秋清凉Geriatrische Klinik Baumgarten医院慰问演出',
  logoPath: '',
  welcomeMusicTracks: []
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      const s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
      // Migrate legacy single-file welcomeMusic field to welcomeMusicTracks array
      if (!Array.isArray(s.welcomeMusicTracks) || !s.welcomeMusicTracks.length) {
        if (s.welcomeMusic) {
          s.welcomeMusicTracks = [{ id: 'w_' + Math.random().toString(36).slice(2, 9), path: s.welcomeMusic, name: '' }];
        } else {
          s.welcomeMusicTracks = [];
        }
      }
      delete s.welcomeMusic;
      return s;
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
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v)$/i;
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
    const audios = files.filter(f => AUDIO_EXT.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    const videos = files.filter(f => VIDEO_EXT.test(f.name));
    const bgEntry = images.find(f => /^(bg|background|背景)/i.test(f.name)) || images[0];
    const videoEntry = videos.find(f => /^(bg|video|背景|视频)/i.test(f.name)) || videos[0];

    const rest = folder.name.replace(/^\s*\d+\s*[-_.\s]*/, '');
    const segs = rest.split(/[-_]/).map(s => s.trim()).filter(Boolean);
    const name = segs[0] || folder.name;
    const performer = segs.slice(1).join(' ') || '';

    let bgImagePath = null, bgVideoPath = null, bgVideoName = '';
    if (bgEntry) {
      try { bgImagePath = copyMediaFile(path.join(subPath, bgEntry.name)); } catch (_) {}
    }
    if (videoEntry) {
      try {
        bgVideoPath = copyMediaFile(path.join(subPath, videoEntry.name));
        bgVideoName = videoEntry.name;
      } catch (_) {}
    }
    // All audio files in the folder become tracks, in filename order (unlimited count —
    // supports a performer singing multiple songs under one program slot)
    const audioTracks = [];
    for (const a of audios) {
      try {
        const p = copyMediaFile(path.join(subPath, a.name));
        audioTracks.push({ id: 'p_' + Math.random().toString(36).slice(2, 9), path: p, name: a.name });
      } catch (_) {}
    }

    results.push({
      id: 'p_' + Math.random().toString(36).slice(2, 9),
      name, performer,
      bgColor: PALETTE[results.length % PALETTE.length],
      bgImagePath, bgVideoPath, bgVideoName, audioTracks
    });
  }
  return results;
}

// ---- Custom protocol: app:// serves project root ----
function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const filePath = path.join(__dirname, relativePath);
    return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
  });
}

// ---- Windows ----
function createWindows() {
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const externalDisplay = displays.find(d => d.id !== primaryDisplay.id);

  const webPrefs = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
  };

  if (externalDisplay) {
    // ===== DUAL SCREEN: control on primary, display fullscreen on projector =====
    controlWin = new BrowserWindow({
      x: primaryDisplay.workArea.x,
      y: primaryDisplay.workArea.y,
      width: primaryDisplay.workArea.width,
      height: primaryDisplay.workArea.height,
      backgroundColor: '#0E0B10',
      title: '幕启 · 控制台',
      webPreferences: webPrefs,
    });
    controlWin.loadFile('index.html');
    controlWin.setMenuBarVisibility(false);
    controlWin.maximize();

    displayWin = new BrowserWindow({
      x: externalDisplay.bounds.x,
      y: externalDisplay.bounds.y,
      width: externalDisplay.bounds.width,
      height: externalDisplay.bounds.height,
      backgroundColor: '#0E0B10',
      title: '幕启 · 演出',
      frame: false,
      fullscreen: true,
      webPreferences: webPrefs,
    });
    displayWin.loadFile('display.html');
    displayWin.setMenuBarVisibility(false);
    displayWin.setAlwaysOnTop(true, 'screen-saver');

  } else {
    // ===== SINGLE SCREEN: side-by-side layout for testing =====
    const wa = primaryDisplay.workArea;
    const ctrlW = Math.floor(wa.width * 0.55);

    // Control console takes left 55%
    controlWin = new BrowserWindow({
      x: wa.x,
      y: wa.y,
      width: ctrlW,
      height: wa.height,
      backgroundColor: '#0E0B10',
      title: '幕启 · 控制台',
      webPreferences: webPrefs,
    });
    controlWin.loadFile('index.html');
    controlWin.setMenuBarVisibility(false);

    // Display preview takes right 45% at 16:9 ratio, centered vertically
    const dispW = wa.width - ctrlW;
    const dispH = Math.round(dispW * 9 / 16);
    const dispY = wa.y + Math.round((wa.height - dispH) / 2);
    displayWin = new BrowserWindow({
      x: wa.x + ctrlW,
      y: dispY,
      width: dispW,
      height: dispH,
      backgroundColor: '#0E0B10',
      title: '幕启 · 演出（预览）',
      frame: true,
      resizable: false,
      webPreferences: webPrefs,
    });
    displayWin.loadFile('display.html');
    displayWin.setMenuBarVisibility(false);
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

app.whenReady().then(() => {
  try {
    ensureDirs();
    registerAppProtocol();
    createWindows();
    for (const win of [controlWin, displayWin]) {
      if (!win) continue;
      win.webContents.on('did-fail-load', (_e, code, desc) => {
        dialog.showErrorBox('幕启 · 页面加载失败', `${desc} (${code})\n\n请检查 index.html / display.html 是否与 main.js 在同一目录。`);
      });
      win.webContents.on('render-process-gone', (_e, details) => {
        dialog.showErrorBox('幕启 · 窗口异常退出', `原因：${details.reason}\n\n请重新打开程序。`);
      });
    }
  } catch (err) {
    dialog.showErrorBox('幕启 · 启动失败', String(err && err.stack || err));
  }
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
  const r = await dialog.showOpenDialog(controlWin, {
    properties: ['openDirectory'],
    title: '选择演出文件夹'
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:file', async (_, options) => {
  const r = await dialog.showOpenDialog(controlWin, options);
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('data:export', async (_, data) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(controlWin, {
    title: '导出节目单',
    defaultPath: `节目单_${stamp}.json`,
    filters: [{ name: 'JSON 节目单', extensions: ['json'] }]
  });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
  return true;
});

ipcMain.handle('data:import', async () => {
  const r = await dialog.showOpenDialog(controlWin, {
    title: '导入节目单',
    filters: [{ name: 'JSON 节目单', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled) return null;
  try { return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); }
  catch (e) { return { error: e.message }; }
});

// ---- Display window IPC ----
// Control window sends state → main forwards to display window
ipcMain.handle('display:setState', (_, state) => {
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.webContents.send('display:state', state);
  }
  return true;
});

// Display window requests initial state on load
ipcMain.handle('display:getInitialState', () => {
  return { settings: loadSettings() };
});
