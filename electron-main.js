const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session } = require('electron');
const { fork, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOM_ID = 'main';
const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Used by automated smoke tests; normal builds always use Electron's per-user %APPDATA% folder.
if (process.env.DUBLINE_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.DUBLINE_USER_DATA_DIR));

let mainWindow = null;
let serverChild = null;
let tunnelChild = null;
let shuttingDown = false;
let shutdownComplete = false;
let localPort = null;

const desktopHostToken = crypto.randomBytes(32).toString('hex');
const roomPin = Array.from({ length: 4 }, () => PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)]).join('');
const tunnelStatus = { state: 'connecting', publicUrl: '', error: '' };

function resourcePath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, 'resources', ...parts);
}

function publishTunnelStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:tunnel-status', { ...tunnelStatus });
}

function setTunnelStatus(state, publicUrl = '', error = '') {
  Object.assign(tunnelStatus, { state, publicUrl, error });
  publishTunnelStatus();
}

function findFreePort(preferred = 3000) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', err => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      const fallback = net.createServer();
      fallback.unref();
      fallback.once('error', reject);
      fallback.listen(0, '127.0.0.1', () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferred, '127.0.0.1', () => probe.close(() => resolve(preferred)));
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const serverEntry = path.join(app.getAppPath(), 'server.js');
    const storageRoot = app.getPath('userData');
    const ffmpeg = app.isPackaged ? resourcePath('bin', 'ffmpeg.exe') : require('ffmpeg-static');
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      DUBLINE_DATA_DIR: path.join(storageRoot, 'data'),
      DUBLINE_UPLOAD_DIR: path.join(storageRoot, 'uploads'),
      DUBLINE_PACKS_DIR: path.join(storageRoot, 'packs'),
      DUBLINE_FFMPEG_PATH: ffmpeg,
      DUBLINE_DESKTOP_ROOM: ROOM_ID,
      DUBLINE_DESKTOP_HOST_TOKEN: desktopHostToken,
      DUBLINE_ROOM_PIN: roomPin
    };

    serverChild = fork(serverEntry, [], {
      // An ASAR path is a virtual file, not a valid Windows working directory.
      cwd: app.isPackaged ? storageRoot : app.getAppPath(),
      env,
      execPath: process.execPath,
      silent: true,
      windowsHide: true
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error('The local server did not start in time.'));
    }, 15000);

    serverChild.stdout.on('data', chunk => { if (process.stdout) process.stdout.write(chunk); });
    serverChild.stderr.on('data', chunk => { if (process.stderr) process.stderr.write(chunk); });
    serverChild.once('error', err => {
      clearTimeout(timeout);
      if (!settled) reject(err);
    });
    serverChild.on('message', message => {
      if (!settled && message && message.type === 'ready') {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    });
    serverChild.once('exit', code => {
      if (!settled) {
        clearTimeout(timeout);
        reject(new Error(`The local server stopped with code ${code}.`));
      } else if (!shuttingDown) {
        setTunnelStatus('error', '', 'The local server stopped unexpectedly.');
      }
    });
  });
}

function startTunnel(port) {
  const executable = resourcePath('bin', 'cloudflared.exe');
  const devExecutable = resourcePath('cloudflared.exe');
  const cloudflared = app.isPackaged ? executable : devExecutable;
  if (!fs.existsSync(cloudflared)) {
    setTunnelStatus('error', '', 'cloudflared.exe is missing. Run npm run prepare:cloudflared.');
    return;
  }

  setTunnelStatus('connecting');
  tunnelChild = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  const inspect = chunk => {
    const text = chunk.toString();
    output = (output + text).slice(-16000);
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && tunnelStatus.publicUrl !== match[0]) setTunnelStatus('ready', match[0]);
  };
  tunnelChild.stdout.on('data', inspect);
  tunnelChild.stderr.on('data', inspect);
  tunnelChild.once('error', err => setTunnelStatus('error', '', err.message));
  tunnelChild.once('exit', code => {
    if (!shuttingDown && !tunnelStatus.publicUrl) setTunnelStatus('error', '', `Cloudflare tunnel stopped with code ${code}.`);
  });
}

function createWindow(port) {
  nativeTheme.themeSource = 'dark';
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#0b0b10',
    autoHideMenuBar: true,
    title: 'Dubline',
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, 'build', 'icon.ico') }),
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const localOrigin = `http://127.0.0.1:${port}`;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(localOrigin)) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`${localOrigin}/?room=${encodeURIComponent(ROOM_ID)}&desktopHost=${desktopHostToken}`);
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  const pid = child.pid;
  try { child.kill(); } catch (err) { /* already stopped */ }
  if (process.platform === 'win32') {
    setTimeout(() => {
      if (child.exitCode === null) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }, 1200).unref();
  }
}

async function shutdown() {
  if (shutdownComplete) return;
  shuttingDown = true;
  killProcessTree(tunnelChild);
  if (serverChild && serverChild.connected) {
    try { serverChild.send({ type: 'shutdown' }); } catch (err) { /* process already stopped */ }
    await Promise.race([
      new Promise(resolve => serverChild.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2200))
    ]);
  }
  killProcessTree(serverChild);
  shutdownComplete = true;
}

ipcMain.handle('desktop:get-status', () => ({
  isDesktop: true,
  room: ROOM_ID,
  pin: roomPin,
  ...tunnelStatus
}));
ipcMain.handle('desktop:copy-text', (_event, value) => {
  clipboard.writeText(String(value || ''));
  return true;
});
ipcMain.handle('desktop:clear-all-data', async event => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted data cleanup request.');
  await shutdown();

  const userData = path.resolve(app.getPath('userData'));
  for (const name of ['data', 'uploads', 'packs']) {
    const target = path.resolve(userData, name);
    const relative = path.relative(userData, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup path.');
    fs.rmSync(target, { recursive: true, force: true });
  }
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();

  app.relaunch();
  app.exit(0);
  return true;
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('io.github.dmbai009.dubline');
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowedOrigin = localPort && webContents.getURL().startsWith(`http://127.0.0.1:${localPort}`);
      callback(!!allowedOrigin && permission === 'media');
    });
    try {
      localPort = await findFreePort(3000);
      await startServer(localPort);
      createWindow(localPort);
      startTunnel(localPort);
    } catch (err) {
      dialog.showErrorBox('Dubline could not start', err.message);
      await shutdown();
      app.quit();
    }
  });

  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    shutdown().finally(() => app.quit());
  });

  app.on('window-all-closed', () => app.quit());
}
