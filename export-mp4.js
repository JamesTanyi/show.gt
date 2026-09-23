const { BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const EXPORT_W = 1920;
const EXPORT_H = 1080;
const MIN_DURATION = 2;
const DEFAULT_DURATION = 10;
const MAX_IMAGES = 8;

let cancelled = false;
let currentProc = null;
let exportWin = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFfmpeg() {
  let bin = null;
  try { bin = require('ffmpeg-static'); } catch (_) { bin = null; }
  if (typeof bin === 'string' && bin) {
    bin = bin.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(bin)) return bin;
  }
  const local = path.join(__dirname, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(local)) return local;
  return 'ffmpeg';
}

function existingPaths(list) {
  return (Array.isArray(list) ? list : []).filter((p) => p && fs.existsSync(p));
}

function hexColor(color) {
  const m = String(color || '#7A1F3D').replace('#', '').trim();
  if (/^[0-9a-fA-F]{6}$/.test(m)) return m.toUpperCase();
  return '7A1F3D';
}

function probeDuration(ffmpegPath, file) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) return resolve(0);
    execFile(ffmpegPath, ['-i', file], { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || stdout || ''));
      if (!m) return resolve(0);
      resolve((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]));
    });
  });
}

function sendProgress(controlWin, payload) {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('export:progress', payload);
  }
}

function cancelExport() {
  cancelled = true;
  if (currentProc && !currentProc.killed) {
    try { currentProc.kill(); } catch (_) {}
  }
}

function destroyExportWindow() {
  const win = exportWin;
  exportWin = null;
  if (!win || win.isDestroyed()) return;
  try { win.destroy(); } catch (_) {}
}

async function createExportWindow(webPrefs) {
  destroyExportWindow();
  const win = new BrowserWindow({
    width: EXPORT_W,
    height: EXPORT_H,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#00FF00',
    webPreferences: {
      ...webPrefs,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);
  exportWin = win;
  await win.loadFile('display.html', { query: { export: '1' } });
  try { win.webContents.setZoomFactor(1); } catch (_) {}
  try { win.webContents.setFrameRate(30); } catch (_) {}
  await wait(400);
  return win;
}

async function captureOverlay(win, item) {
  await new Promise((resolve) => {
    const finish = () => resolve();
    win.webContents.once('paint', finish);
    win.webContents.send('display:state', {
      mode: 'exportOverlay',
      program: item.program,
    });
    try { win.webContents.invalidate(); } catch (_) {}
    setTimeout(finish, 800);
  });
  await wait(150);
  if (win.isDestroyed()) throw new Error('导出窗口已关闭');
  const image = await win.webContents.capturePage();
  const overlayPath = path.join(os.tmpdir(), `muqi_ov_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`);
  fs.writeFileSync(overlayPath, image.toPNG());
  return overlayPath;
}

function runFfmpeg(ffmpegPath, args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentProc = proc;
    let errBuf = '';
    proc.stdout.on('data', (buf) => {
      const s = buf.toString();
      const m = /out_time_us=(\d+)/.exec(s);
      if (m && duration && onProgress) {
        onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
      if (/progress=end/.test(s) && onProgress) onProgress(1);
    });
    proc.stderr.on('data', (buf) => {
      errBuf += buf.toString();
      if (errBuf.length > 12000) errBuf = errBuf.slice(-6000);
    });
    proc.on('error', (err) => {
      currentProc = null;
      reject(err);
    });
    proc.on('close', (code) => {
      currentProc = null;
      if (cancelled) {
        const e = new Error('cancelled');
        e.cancelled = true;
        reject(e);
        return;
      }
      if (code === 0) resolve();
      else {
        const tail = errBuf.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(tail || ('ffmpeg 退出码 ' + code)));
      }
    });
  });
}

function overlayFilter(overlayIndex) {
  return `[${overlayIndex}:v]scale=${EXPORT_W}:${EXPORT_H},colorkey=0x00FF00:0.22:0.08,format=rgba[ov]`;
}

function scaleFilter(inputIndex, outName) {
  return `[${inputIndex}:v]scale=${EXPORT_W}:${EXPORT_H}:force_original_aspect_ratio=increase,crop=${EXPORT_W}:${EXPORT_H},setsar=1,fps=30,format=yuv420p[${outName}]`;
}

function buildFfmpegArgs(item, overlayPath, duration, tmpOut) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats'];
  const videos = existingPaths(item.bgVideoPaths);
  const images = existingPaths(item.bgImagePaths).slice(0, MAX_IMAGES);
  const audio = item.audioPath && fs.existsSync(item.audioPath) ? item.audioPath : null;
  const dur = duration.toFixed(3);
  let overlayIndex;
  let audioIndex;
  const filters = [];

  if (videos.length) {
    args.push('-stream_loop', '-1', '-i', videos[0]);
    overlayIndex = 1;
    args.push('-i', overlayPath);
    audioIndex = 2;
    if (audio) args.push('-i', audio);
    else args.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=44100:cl=stereo');
    filters.push(scaleFilter(0, 'bg'));
    filters.push(overlayFilter(overlayIndex));
    filters.push('[bg][ov]overlay=0:0:format=auto,format=yuv420p[v]');
  } else if (images.length) {
    const n = images.length;
    const seg = Math.max(0.4, duration / n);
    for (let i = 0; i < n; i++) {
      args.push('-loop', '1', '-framerate', '30', '-t', seg.toFixed(3), '-i', images[i]);
    }
    overlayIndex = n;
    args.push('-i', overlayPath);
    audioIndex = n + 1;
    if (audio) args.push('-i', audio);
    else args.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=44100:cl=stereo');
    if (n === 1) {
      filters.push(scaleFilter(0, 'bg'));
    } else {
      const names = [];
      for (let i = 0; i < n; i++) {
        filters.push(scaleFilter(i, 'v' + i));
        names.push('[v' + i + ']');
      }
      filters.push(names.join('') + `concat=n=${n}:v=1:a=0[bg]`);
    }
    filters.push(overlayFilter(overlayIndex));
    filters.push('[bg][ov]overlay=0:0:format=auto,format=yuv420p[v]');
  } else {
    args.push('-f', 'lavfi', '-t', dur, '-i', `color=c=0x${hexColor(item.bgColor)}:s=${EXPORT_W}x${EXPORT_H}:r=30`);
    overlayIndex = 1;
    args.push('-i', overlayPath);
    audioIndex = 2;
    if (audio) args.push('-i', audio);
    else args.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=44100:cl=stereo');
    filters.push(scaleFilter(0, 'bg'));
    filters.push(overlayFilter(overlayIndex));
    filters.push('[bg][ov]overlay=0:0:format=auto,format=yuv420p[v]');
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    '-map', `${audioIndex}:a`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-ar', '44100',
    '-t', dur,
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    tmpOut
  );
  return args;
}

function moveOutput(tmpOut, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    fs.renameSync(tmpOut, destPath);
  } catch (_) {
    fs.copyFileSync(tmpOut, destPath);
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
}

async function runExport(job, getControlWindow, webPrefs) {
  cancelled = false;
  const controlWin = getControlWindow();
  const items = Array.isArray(job && job.items) ? job.items : [];
  const outputDir = job && job.outputDir;
  if (!items.length) return { ok: false, error: '没有可导出的曲目' };
  if (!outputDir) return { ok: false, error: '未选择保存文件夹' };

  const ffmpegPath = resolveFfmpeg();
  const done = [];
  const failed = [];
  let overlayPath = null;

  try {
    const win = await createExportWindow(webPrefs);
    if (cancelled) return { ok: false, cancelled: true };
    for (let i = 0; i < items.length; i++) {
      if (cancelled) break;
      const item = items[i];
      sendProgress(controlWin, {
        current: i + 1,
        total: items.length,
        label: item.label || item.filename,
        ratio: i / items.length,
        phase: 'overlay',
      });

      const videos = existingPaths(item.bgVideoPaths);
      const audioDur = await probeDuration(ffmpegPath, item.audioPath);
      const videoDur = videos[0] ? await probeDuration(ffmpegPath, videos[0]) : 0;
      const duration = Math.max(MIN_DURATION, audioDur || videoDur || DEFAULT_DURATION);

      try { if (overlayPath && fs.existsSync(overlayPath)) fs.unlinkSync(overlayPath); } catch (_) {}
      try {
        overlayPath = await captureOverlay(win, item);
      } catch (err) {
        if (cancelled) break;
        failed.push({ label: item.label || item.filename, error: String(err && err.message || err) });
        continue;
      }
      if (cancelled) break;

      const tmpOut = path.join(os.tmpdir(), `muqi_out_${Date.now()}_${i}.mp4`);
      const destPath = path.join(outputDir, item.filename || `track_${i + 1}.mp4`);
      const args = buildFfmpegArgs(item, overlayPath, duration, tmpOut);

      sendProgress(controlWin, {
        current: i + 1,
        total: items.length,
        label: item.label || item.filename,
        ratio: i / items.length,
        phase: 'encode',
      });

      try {
        await runFfmpeg(ffmpegPath, args, duration, (p) => {
          sendProgress(controlWin, {
            current: i + 1,
            total: items.length,
            label: item.label || item.filename,
            ratio: (i + p) / items.length,
            phase: 'encode',
          });
        });
        moveOutput(tmpOut, destPath);
        done.push(destPath);
      } catch (err) {
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (_) {}
        if (err && err.cancelled) break;
        failed.push({ label: item.label || item.filename, error: String(err && err.message || err) });
      }
    }
  } finally {
    try { if (overlayPath && fs.existsSync(overlayPath)) fs.unlinkSync(overlayPath); } catch (_) {}
    destroyExportWindow();
  }

  if (cancelled && !done.length) return { ok: false, cancelled: true };
  sendProgress(controlWin, {
    current: items.length,
    total: items.length,
    label: '完成',
    ratio: 1,
    phase: 'done',
  });
  return { ok: done.length > 0, done, failed, cancelled };
}

function registerExportHandlers({ getControlWindow, webPrefs }) {
  ipcMain.handle('export:chooseDir', async () => {
    const win = getControlWindow();
    const r = await dialog.showOpenDialog(win || undefined, {
      title: '选择 MP4 保存文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('export:cancel', () => {
    cancelExport();
    return true;
  });

  ipcMain.handle('export:mp4', async (_, job) => {
    try {
      return await runExport(job, getControlWindow, webPrefs);
    } catch (err) {
      destroyExportWindow();
      return { ok: false, error: String(err && err.message || err) };
    }
  });
}

module.exports = { registerExportHandlers, cancelExport };
