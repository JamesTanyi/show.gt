const { app, BrowserWindow, ipcMain, dialog, protocol, net, screen, powerSaveBlocker, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

// ---- Keep the machine awake for the whole session (show day: no screen-off, no sleep) ----
let powerSaveBlockerId = null;
function startPowerSaveBlocker() {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) return;
  powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
}
function stopPowerSaveBlocker() {
  if (powerSaveBlockerId !== null) {
    try { powerSaveBlocker.stop(powerSaveBlockerId); } catch (_) {}
  }
  powerSaveBlockerId = null;
}

// Connecting a projector can turn on Windows "Presentation Settings"
// (no sleep / no screen saver). That flag lives in the user profile and
// survives after this app exits, so we clear it on quit.
function clearWindowsSleepHolds() {
  if (process.platform !== 'win32') return;
  const script = [
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class MuqiPower {',
    '  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);',
    '}',
    "'@ -ErrorAction SilentlyContinue",
    '[void][MuqiPower]::SetThreadExecutionState([uint]2147483648)',
    "$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PresentationSettings','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\PresentationSettings')",
    'foreach ($k in $keys) {',
    '  if (Test-Path $k) {',
    "    foreach ($n in @('NoSleep','NoScreenSave','NoScreenSaver')) {",
    '      Set-ItemProperty -Path $k -Name $n -Value 0 -ErrorAction SilentlyContinue',
    '    }',
    '  }',
    '}'
  ].join('\n');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { timeout: 5000, windowsHide: true });
  } catch (_) {}
}

function restoreComputerPower() {
  stopPowerSaveBlocker();
  releaseCursorClip();
}

function destroyDisplayWindow() {
  const win = displayWin;
  displayWin = null;
  if (!win || win.isDestroyed()) return;
  try { win.setAlwaysOnTop(false); } catch (_) {}
  try { win.hide(); } catch (_) {}
  try { if (win.isFullScreen()) win.setFullScreen(false); } catch (_) {}
  try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
}

let controlWin, displayWin;
let lastDisplayState = null;
let isQuitting = false;
let replacingDisplay = false;

function quitEntireApp() {
  if (isQuitting) return;
  isQuitting = true;
  stopPowerSaveBlocker();
  releaseCursorClip();
  destroyDisplayWindow();
  if (controlWin && !controlWin.isDestroyed()) {
    try { controlWin.destroy(); } catch (_) {}
  }
  controlWin = null;
  app.quit();
}

// ---- Crash safety: never fail silently on show day ----
process.on('uncaughtException', (err) => {
  try { restoreComputerPower(); } catch (_) {}
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
  welcomeMusicTracks: [],
  audioOutputId: '',
  projX: 0,
  projY: 0,
  projRot: 0,
  projScale: 1
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

    const images = files.filter(f => IMAGE_EXT.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    const audios = files.filter(f => AUDIO_EXT.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    const videos = files.filter(f => VIDEO_EXT.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));

    const rest = folder.name.replace(/^\s*\d+\s*[-_.\s]*/, '');
    const segs = rest.split(/[-_]/).map(s => s.trim()).filter(Boolean);
    const name = segs[0] || folder.name;
    const performer = segs.slice(1).join(' ') || '';

    const bgImagePaths = [];
    const bgVideoPaths = [];
    for (const img of images) {
      try {
        const p = copyMediaFile(path.join(subPath, img.name));
        bgImagePaths.push({ id: 'i_' + Math.random().toString(36).slice(2, 9), path: p, name: img.name });
      } catch (_) {}
    }
    for (const v of videos) {
      try {
        const p = copyMediaFile(path.join(subPath, v.name));
        bgVideoPaths.push({ id: 'v_' + Math.random().toString(36).slice(2, 9), path: p, name: v.name });
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
      bgImagePaths, bgVideoPaths, audioTracks
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
const webPrefs = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
};

// ---- Cursor confinement (Windows ClipCursor via inline PowerShell) ----
// The operator only ever needs to interact with the control console — never
// the projection output. Once two real screens are active, physically confine
// the mouse cursor to the control console's monitor via the Win32 ClipCursor
// API, so it can never wander onto (or get stuck on) the projection screen.
// We shell out to PowerShell (bundled with every Windows install) instead of
// a native node addon, to avoid adding a node-gyp/electron-rebuild dependency
// to a project that currently has zero native modules.
let isDualMode = false;

// ClipCursor operates in real physical-pixel coordinates. A plain PowerShell
// process is not "per-monitor DPI aware" by default, so Windows virtualizes
// (scales down) every screen-geometry API for it to match the display's scale
// factor (e.g. a 3840x2160 monitor at 150% scaling is reported as 2560x1440).
// Feeding it any bounds computed elsewhere — Electron's DIP values included —
// leads to a clip rectangle covering only a fraction of the real screen. The
// fix: make the calling thread Per-Monitor-V2 DPI aware first, then have it
// look up the primary monitor's true physical bounds itself via
// MonitorFromPoint/GetMonitorInfo, so the rect ClipCursor receives is always
// self-consistent with the real coordinate space the OS moves the cursor in.
const CLIP_TYPE_DEF = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class MuqiCursorClip {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct POINT { public int X; public int Y; }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }',
  '  [DllImport("user32.dll")] public static extern bool ClipCursor(ref RECT lpRect);',
  '  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr lpRect);',
  '  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);',
  '  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);',
  '  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);',
  '}'
].join('\n');

function buildAddTypeScript() {
  return [
    "Add-Type -TypeDefinition @'",
    CLIP_TYPE_DEF,
    "'@ -ErrorAction SilentlyContinue"
  ].join('\n');
}

function runPowerShell(script) {
  if (process.platform !== 'win32') return;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], (err) => {
    if (err) console.error('幕启 · 鼠标限制脚本执行失败：', err.message);
  });
}

// Confine the OS mouse cursor to the control console's monitor (always the
// Windows-designated primary display — see pickLayout). The rect is looked up
// by the PowerShell script itself, in real physical pixels, so it can never
// drift out of sync with whatever coordinate space ClipCursor expects.
function clipCursorToControlScreen() {
  const script = [
    buildAddTypeScript(),
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
    '[void][MuqiCursorClip]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))',
    '$pt = New-Object MuqiCursorClip+POINT',
    '$pt.X = 0; $pt.Y = 0',
    // MONITOR_DEFAULTTOPRIMARY = 1 — (0,0) is always on the primary monitor,
    // since the primary display sits at the virtual desktop's origin.
    '$hMon = [MuqiCursorClip]::MonitorFromPoint($pt, 1)',
    '$mi = New-Object MuqiCursorClip+MONITORINFO',
    '$mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)',
    '[void][MuqiCursorClip]::GetMonitorInfo($hMon, [ref]$mi)',
    '[MuqiCursorClip]::ClipCursor([ref]$mi.rcMonitor)'
  ].join('\n');
  runPowerShell(script);
}

// Release any cursor confinement — mouse can move freely across all screens again.
function releaseCursorClip() {
  const script = [
    buildAddTypeScript(),
    '[MuqiCursorClip]::ClipCursor([IntPtr]::Zero)'
  ].join('\n');
  runPowerShell(script);
}

// Decide whether we have a real second screen (projector/external monitor) and
// where each window should go. This only runs when the operator explicitly asks
// for it — either on first launch (as a side-by-side preview, never guessing at
// dual-screen) or via the "检测投影" button (real detection, on demand).
// forceSingle=true skips display detection entirely and always returns the
// single-screen preview layout — used for the initial boot layout so the app
// never silently guesses wrong about the projector at startup.
function getExternalDisplay() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find(d => d.id !== primary.id) || null;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function placeOnDisplay(win, display) {
  if (!win || win.isDestroyed() || !display) return;
  const b = display.bounds;
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, false);
}

// Move the window onto the projector in DIP space, wait for Windows to attach
// the HWND to that monitor's DPI, then enter OS fullscreen ONCE. Calling
// setBounds after setFullScreen(true) on Windows kicks the window out of
// true fullscreen and leaves a strip of desktop (the white bar) at the top.
async function enterProjectorFullscreen(win, display) {
  if (!win || win.isDestroyed() || !display) return;
  try {
    if (win.isFullScreen()) win.setFullScreen(false);
  } catch (_) {}
  placeOnDisplay(win, display);
  await waitMs(80);
  if (win.isDestroyed()) return;
  const landed = screen.getDisplayMatching(win.getBounds());
  const target = (landed && landed.id === display.id) ? landed : display;
  placeOnDisplay(win, target);
  win.setFullScreen(true);
  await waitMs(100);
  if (win.isDestroyed()) return;
  // If Windows still left a gap (typical: window sits too low, desktop shows
  // as a white bar at the top), drop fullscreen and pin to the display bounds
  // without touching setBounds again afterwards.
  const after = win.getBounds();
  const b = target.bounds;
  if (after.y > b.y + 1 || after.height < b.height - 1) {
    try { win.setFullScreen(false); } catch (_) {}
    await waitMs(40);
    if (win.isDestroyed()) return;
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, false);
  }
}

function pickLayout(forceSingle) {
  const primaryDisplay = screen.getPrimaryDisplay();
  let displayCount = 1;

  if (!forceSingle) {
    const displays = screen.getAllDisplays();
    displayCount = displays.length;
    const externalDisplay = displays.find(d => d.id !== primaryDisplay.id) || null;
    if (externalDisplay) {
      return { dual: true, count: displayCount, control: primaryDisplay.workArea, display: externalDisplay.bounds };
    }
  }

  // Single screen (or forced): side-by-side preview layout for testing
  const wa = primaryDisplay.workArea;
  const ctrlW = Math.floor(wa.width * 0.68);
  const dispW = wa.width - ctrlW;
  const dispH = Math.round(dispW * 9 / 16);
  const dispY = wa.y + Math.round((wa.height - dispH) / 2);
  return {
    dual: false,
    count: displayCount,
    control: { x: wa.x, y: wa.y, width: ctrlW, height: wa.height },
    displayPreview: { x: wa.x + ctrlW, y: dispY, width: dispW, height: dispH },
  };
}

function attachWindowSafety(win) {
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    dialog.showErrorBox('幕启 · 页面加载失败', `${desc} (${code})\n\n请检查 index.html / display.html 是否与 main.js 在同一目录。`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    dialog.showErrorBox('幕启 · 窗口异常退出', `原因：${details.reason}\n\n请重新打开程序。`);
  });
}

// Apply the current layout: reposition the control window, and (re)create the
// display window with the frame/fullscreen settings appropriate to that mode.
// Recreating the display window is intentional — it's simple and reliable, and
// the window immediately re-syncs to whatever was last shown via lastDisplayState.
function layoutWindows(forceSingle) {
  const layout = pickLayout(forceSingle);

  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.unmaximize();
    controlWin.setBounds(layout.control);
    if (layout.dual) controlWin.maximize();
  }

  replacingDisplay = true;
  destroyDisplayWindow();

  // Dual mode: first place the window on the projector using bounds, then
  // call setFullScreen so it truly covers that screen (no desktop/white strip).
  // ClipCursor keeps the mouse on the control console so the operator is not
  // trapped on the fullscreen output.
  const bounds = layout.dual ? layout.display : layout.displayPreview;
  displayWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    backgroundColor: '#0E0B10',
    title: layout.dual ? '幕启 · 演出' : '幕启 · 演出（预览）',
    frame: !layout.dual,
    resizable: !layout.dual,
    fullscreenable: !!layout.dual,
    thickFrame: !layout.dual,
    hasShadow: !layout.dual,
    skipTaskbar: !!layout.dual,
    autoHideMenuBar: true,
    enableLargerThanScreen: !!layout.dual,
    webPreferences: webPrefs,
  });
  displayWin.setMenu(null);
  displayWin.loadFile('display.html');
  displayWin.setMenuBarVisibility(false);
  attachWindowSafety(displayWin);
  const createdDisplay = displayWin;
  createdDisplay.on('closed', () => {
    if (displayWin === createdDisplay) displayWin = null;
    if (isQuitting || replacingDisplay) return;
    quitEntireApp();
  });
  replacingDisplay = false;
  displayWin.webContents.on('did-finish-load', () => {
    displayWin.webContents.setZoomFactor(1);
    if (lastDisplayState) displayWin.webContents.send('display:state', lastDisplayState);
  });

  const shown = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    displayWin.once('ready-to-show', async () => {
      if (!displayWin || displayWin.isDestroyed()) { finish(); return; }
      if (layout.dual) {
        const ext = getExternalDisplay();
        if (ext) {
          placeOnDisplay(displayWin, ext);
          displayWin.show();
          await enterProjectorFullscreen(displayWin, ext);
        } else {
          displayWin.show();
        }
      } else {
        displayWin.setBounds(bounds, false);
        displayWin.show();
      }
      finish();
    });
    setTimeout(finish, 2500);
  });
  layout.ready = shown;

  // Confine the mouse to the control console's monitor in dual mode — the
  // operator never needs to reach the projection screen with the mouse, so
  // this makes it physically impossible to get "stuck" over there. In single-
  // screen preview mode both windows share one monitor, so no confinement.
  isDualMode = !!layout.dual;
  if (isDualMode) {
    clipCursorToControlScreen();
    startPowerSaveBlocker();
  } else {
    releaseCursorClip();
    stopPowerSaveBlocker();
  }

  return layout;
}

function createWindows() {
  controlWin = new BrowserWindow({
    backgroundColor: '#0E0B10',
    title: '幕启 · 控制台',
    webPreferences: webPrefs,
  });
  controlWin.loadFile('index.html');
  controlWin.setMenuBarVisibility(false);
  attachWindowSafety(controlWin);

  // Closing either the control console or the projection window exits the
  // whole app. Power-restore PowerShell is not run here — it blocked close
  // and left the fullscreen projection window behind.
  controlWin.on('close', () => {
    quitEntireApp();
  });

  // Windows automatically drops ClipCursor confinement whenever focus moves
  // to a different window/app (e.g. a file dialog, or Alt-Tab). Re-apply it
  // every time the control console regains focus so it doesn't just silently
  // stop working after the first focus change.
  controlWin.on('focus', () => {
    if (isDualMode) clipCursorToControlScreen();
  });

  // Auto-split when a projector/second screen is already connected.
  // If there is only one screen, fall back to side-by-side preview.
  layoutWindows();
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

app.whenReady().then(() => {
  try {
    ensureDirs();
    registerAppProtocol();
    // Allow enumerating / selecting audio output devices (HDMI projector, etc.)
    // without a microphone prompt. Labels would otherwise be blank on file://.
    session.defaultSession.setDevicePermissionHandler((details) => {
      return details.deviceType === 'audioOutput';
    });
    createWindows();
    // Do not block sleep at boot — only while dual-screen projection is active.
  } catch (err) {
    dialog.showErrorBox('幕启 · 启动失败', String(err && err.stack || err));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') quitEntireApp();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopPowerSaveBlocker();
  releaseCursorClip();
  destroyDisplayWindow();
});

app.on('will-quit', () => {
  stopPowerSaveBlocker();
  clearWindowsSleepHolds();
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

function mimeFromImageBuffer(buf, filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.svg' || buf[0] === 0x3C) return 'image/svg+xml';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/png';
}

ipcMain.handle('file:readAsDataUrl', (_, filePath) => {
  try {
    const abs = filePath
      ? filePath
      : path.join(__dirname, 'assets', 'logo-flake.png');
    if (!abs || !fs.existsSync(abs)) return { ok: false, error: 'not found' };
    const buf = fs.readFileSync(abs);
    const mime = mimeFromImageBuffer(buf, abs);
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
  const r = await dialog.showOpenDialog(controlWin, options || {});
  if (r.canceled) return null;
  const multi = options && Array.isArray(options.properties) && options.properties.includes('multiSelections');
  return multi ? r.filePaths : r.filePaths[0];
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
  lastDisplayState = state;
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.webContents.send('display:state', state);
  }
  return true;
});

// Display window requests initial state on load
ipcMain.handle('display:getInitialState', () => {
  if (lastDisplayState) return lastDisplayState;
  return { settings: loadSettings() };
});

ipcMain.handle('windows:layoutInfo', () => ({
  dual: !!isDualMode,
  count: screen.getAllDisplays().length
}));

// Re-detect connected screens on demand (button in control console only) —
// e.g. after plugging in the projector while the app is already running.
// Also pops a native OS dialog with the raw detection result — this is
// intentionally impossible to miss/hide, so we always know for sure whether
// the click reached main.js and exactly how many screens Windows reported,
// independent of anything that could go wrong in the web page itself.
ipcMain.handle('windows:relayout', async () => {
  const layout = layoutWindows(false);
  if (layout.ready) await layout.ready;
  const displays = screen.getAllDisplays();
  const detail = displays.map((d, i) => {
    const main = d.id === screen.getPrimaryDisplay().id ? ' [主屏]' : ' [投影]';
    return `屏幕${i + 1}：${d.bounds.width}x${d.bounds.height} @ (${d.bounds.x},${d.bounds.y}) 缩放${Math.round((d.scaleFactor || 1) * 100)}%${main}`;
  }).join('\n');
  let winLine = '投影窗口：未创建';
  if (displayWin && !displayWin.isDestroyed()) {
    const b = displayWin.getBounds();
    winLine = `投影窗口：${b.width}x${b.height} @ (${b.x},${b.y}) ${displayWin.isFullScreen() ? '已全屏' : '未全屏'}`;
  }
  dialog.showMessageBoxSync(controlWin, {
    type: 'info',
    title: '幕启 · 屏幕检测结果',
    message: layout.dual ? `已检测到 ${layout.count} 个屏幕，投影窗口已移动到外接屏并全屏。` : `仅检测到 ${layout.count} 个屏幕，未分屏（画面并排预览）。`,
    detail: (detail || '（未能获取屏幕列表）') + '\n' + winLine,
  });
  return { dual: layout.dual, count: layout.count };
});
