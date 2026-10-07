const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session, shell } = require('electron');
const { execFile, fork, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOM_ID, PORT_MIN, PORT_MAX, normalizeGuestUrl, findFreePort } = require('./electron-network');
const { checkLatestRelease } = require('./electron-update');
const { createWorkshopLinkHandler } = require('./electron-external-links');
const { DesktopStorage, StorageError, FOLDERS } = require('./electron-storage');
const { projectPathsFromArgs, ProjectOpenCoordinator, projectMessages } = require('./electron-project-open');
const { readDistribution } = require('./electron-distribution');
const { InstalledUpdater } = require('./electron-installed-update');
const { PortableUpdater } = require('./electron-portable-update');
const { UpdateLog } = require('./electron-update-log');
const { associationOperation } = require('./electron-project-association');

const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HOSTING_MODES = new Set(['cloudflare', 'porthole', 'vpn']);
const JOIN_ARG = '--dubline-join=';

app.setName('Dubline');

// Used by automated smoke tests; normal builds always use Electron's per-user %APPDATA% folder.
if (process.env.DUBLINE_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.DUBLINE_USER_DATA_DIR));

function guestUrlFromArgs() {
  const argument = process.argv.find(item => item.startsWith(JOIN_ARG));
  if (!argument) return '';
  try { return normalizeGuestUrl(decodeURIComponent(argument.slice(JOIN_ARG.length))); }
  catch (err) { return ''; }
}

const guestTargetUrl = guestUrlFromArgs();
const guestOrigin = guestTargetUrl ? new URL(guestTargetUrl).origin : '';
// Chromium must receive this before app.ready. The guest has only a language preload, no Node access,
// and media permission is still limited to this exact origin below.
if (guestOrigin && guestOrigin.startsWith('http://')) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', guestOrigin);
}

let launcherWindow = null;
let mainWindow = null;
let serverChild = null;
let tunnelChild = null;
let tunnelTimeout = null;
let tunnelGeneration = 0;
let shuttingDown = false;
let shutdownComplete = false;
let hostStarting = false;
let projectSaving = false, projectChoosing = false, projectSaveJob = null, projectSaveTicket = null;
const projectDestinations = new Map();
let localPort = null;
let hostingMode = null;
let hostingModeRequest = 0;
let networkToolProbe = null;
let networkToolCache = null;
let networkToolCheckedAt = 0;
let firstGuestConnected = false;
let serverFailure = '';
let appUpdateStatus = { state: 'idle', currentVersion: app.getVersion(), version: '', url: '' };
let appUpdateDismissed = false;
let distribution = { channel: 'development' }, updateAdapter = null;

// The portable EXE unpacks every launch into its own %TEMP%/nsXXXX.tmp/app and removes it on exit.
// After a crash or a killed process the folder (hundreds of MB) stays. Remove such leftovers:
// only folders older than 10 minutes that contain this app, and only if they can be renamed —
// Windows refuses to rename a folder whose EXE is running, so another open Dubline is never touched.
function cleanupPortableLeftovers() {
  if (!app.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE) return;
  const ownDir = path.resolve(path.dirname(process.execPath), '..');
  const tempDir = path.dirname(ownDir);
  const exeName = path.basename(process.execPath);
  let entries = [];
  try { entries = fs.readdirSync(tempDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^ns[a-z0-9]+\.tmp$/i.test(entry.name)) continue;
    const dir = path.join(tempDir, entry.name);
    if (path.resolve(dir) === ownDir) continue;
    try {
      if (!fs.existsSync(path.join(dir, 'app', exeName)) || !fs.existsSync(path.join(dir, 'app', 'resources', 'app.asar'))) continue;
      if (Date.now() - fs.statSync(dir).mtimeMs < 10 * 60 * 1000) continue;
      const doomed = `${dir}.dubline-old`;
      fs.renameSync(dir, doomed);
      fs.rm(doomed, { recursive: true, force: true }, () => {});
    } catch { /* in use by a running Dubline, or not ours to remove */ }
  }
}

const desktopHostToken = crypto.randomBytes(32).toString('hex');
const languageFile = path.join(app.getPath('userData'), 'language.json');
const projectStorage = new DesktopStorage(app.getPath('userData'), app.isPackaged ? [path.dirname(process.execPath)] : []);
const desktopOriginFile = path.join(app.getPath('userData'), 'desktop-origin.json');
let preferredLocalPort = null;
try { preferredLocalPort = JSON.parse(fs.readFileSync(desktopOriginFile, 'utf8')).port; } catch { /* first launch */ }
const desktopIdentityFile = path.join(app.getPath('userData'), 'device-identity.json');
let desktopClientId = null;
try { const saved = JSON.parse(fs.readFileSync(desktopIdentityFile, 'utf8')); if (/^[a-zA-Z0-9_-]{16,64}$/.test(saved.clientId)) desktopClientId = saved.clientId; } catch { /* first launch or old profile */ }
let storageSelecting = false;
function publishStorageProgress(progress) {
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.webContents.send('app:storage-progress', progress);
}
let interfaceLanguage = null;
try { const saved = JSON.parse(fs.readFileSync(languageFile, 'utf8')); if (['en', 'ru', 'uk'].includes(saved)) interfaceLanguage = saved; } catch { /* first launch */ }
const roomPin = Array.from({ length: 4 }, () => PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)]).join('');
const tunnelStatus = { state: 'idle', publicUrl: '', error: '' };

function resourcePath(...parts) {
  return app.isPackaged ? path.join(process.resourcesPath, ...parts) : path.join(__dirname, 'resources', ...parts);
}

function publishAppUpdateStatus() {
  for (const window of [launcherWindow, mainWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('app:update-status', { ...appUpdateStatus, dismissed: appUpdateDismissed });
  }
}

async function checkForAppUpdate() {
  if (updateAdapter) return updateAdapter.check();
  if (distribution.channel === 'steam' || distribution.channel === 'development') return;
  try {
    const update = await checkLatestRelease(app.getVersion());
    appUpdateStatus = update
      ? { state: 'available', currentVersion: app.getVersion(), ...update }
      : { state: 'current', currentVersion: app.getVersion(), version: '', url: '' };
  } catch (err) {
    // Update checks must never delay startup or bother an offline user.
    appUpdateStatus = { state: 'unavailable', currentVersion: app.getVersion(), version: '', url: '' };
  }
  publishAppUpdateStatus();
}

function windowOptions(preload = null) {
  return {
    show: false,
    center: true,
    backgroundColor: '#0b0b10',
    autoHideMenuBar: true,
    title: 'Dubline',
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, 'build', 'icon.ico') }),
    webPreferences: {
      ...(preload ? { preload } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}

function execFileText(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

async function steamRoots() {
  const roots = new Set([
    path.join(process.env['ProgramFiles(x86)'] || '', 'Steam'),
    path.join(process.env.ProgramFiles || '', 'Steam')
  ].filter(Boolean));
  if (process.platform === 'win32') {
    const registry = await execFileText('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    const match = registry.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (match) roots.add(path.resolve(match[1].trim().replace(/\//g, path.sep)));
  }
  for (const root of [...roots]) {
    const libraries = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(libraries)) continue;
    try {
      const text = fs.readFileSync(libraries, 'utf8');
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(match[1].replace(/\\\\/g, '\\'));
    } catch (err) { /* a locked Steam library is simply treated as unavailable */ }
  }
  return [...roots];
}

function executableExists(paths) {
  return paths.some(file => file && fs.existsSync(file));
}

async function detectNetworkTools() {
  const taskOutput = process.platform === 'win32'
    ? await execFileText('tasklist.exe', ['/fo', 'csv', '/nh'])
    : await execFileText('ps', ['-A', '-o', 'comm=']);
  const processNames = taskOutput.toLowerCase();
  const interfaces = os.networkInterfaces();
  function adapterIp(pattern) {
    for (const [name, addresses] of Object.entries(interfaces)) {
      if (!pattern.test(name)) continue;
      const address = (addresses || []).find(item => item.family === 'IPv4' && !item.internal);
      if (address) return address.address;
    }
    return '';
  }

  const radminIp = adapterIp(/radmin/i);
  const hamachiIp = adapterIp(/hamachi|logmein/i);
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const radminInstalled = executableExists(programFiles.flatMap(root => [
    path.join(root, 'Radmin VPN', 'RvRvpnGui.exe'),
    path.join(root, 'Famatech', 'Radmin VPN', 'RvRvpnGui.exe')
  ]));
  const hamachiInstalled = executableExists(programFiles.flatMap(root => [
    path.join(root, 'LogMeIn Hamachi', 'hamachi-2-ui.exe'),
    path.join(root, 'LogMeIn Hamachi', 'x64', 'hamachi-2.exe')
  ]));
  const roots = await steamRoots();
  const portholeInstalled = roots.some(root => fs.existsSync(path.join(root, 'steamapps', 'appmanifest_4963920.acf')));

  return {
    porthole: { installed: portholeInstalled || processNames.includes('porthole'), running: processNames.includes('porthole') },
    radmin: {
      installed: radminInstalled || !!radminIp || processNames.includes('rvrvpn'),
      running: !!radminIp || processNames.includes('rvrvpn'), ip: radminIp
    },
    hamachi: {
      installed: hamachiInstalled || !!hamachiIp || processNames.includes('hamachi-2'),
      running: !!hamachiIp || processNames.includes('hamachi-2'), ip: hamachiIp
    }
  };
}

async function currentNetworkTools() {
  if (networkToolCache && Date.now() - networkToolCheckedAt < 4000) return networkToolCache;
  if (!networkToolProbe) networkToolProbe = detectNetworkTools().then(tools => {
    networkToolCache = tools; networkToolCheckedAt = Date.now(); return tools;
  }).finally(() => { networkToolProbe = null; });
  return networkToolProbe;
}

async function getHostingStatus() {
  if (hostingMode === 'single') return { isDesktop: true, singlePlayer: true, room: ROOM_ID, pin: '', port: localPort, mode: 'single', state: serverFailure ? 'error' : 'local', error: serverFailure, publicUrl: '' };
  const tools = await currentNetworkTools();
  const activeVpn = [
    { ...tools.radmin, provider: 'radmin' },
    { ...tools.hamachi, provider: 'hamachi' }
  ].find(tool => tool.running && tool.ip) || [
    { ...tools.radmin, provider: 'radmin' },
    { ...tools.hamachi, provider: 'hamachi' }
  ].find(tool => tool.running) || null;
  const vpnTool = {
    installed: tools.radmin.installed || tools.hamachi.installed,
    running: tools.radmin.running || tools.hamachi.running,
    ip: activeVpn?.ip || '',
    provider: activeVpn?.provider || ''
  };
  const base = {
    isDesktop: true, singlePlayer: false, room: ROOM_ID, pin: roomPin, port: localPort,
    portRange: `${PORT_MIN}-${PORT_MAX}`, mode: hostingMode,
    provider: hostingMode === 'vpn' ? vpnTool.provider : '', firstGuestConnected, tools
  };
  if (serverFailure) return { ...base, state: 'error', publicUrl: '', error: serverFailure };
  if (hostingMode === 'cloudflare') return { ...base, ...tunnelStatus };

  const tool = hostingMode === 'vpn' ? vpnTool : tools[hostingMode] || {};
  let publicUrl = '';
  if (hostingMode === 'porthole' && localPort) publicUrl = `http://localhost:${localPort}`;
  if (hostingMode === 'vpn' && tool.ip && localPort) publicUrl = `http://${tool.ip}:${localPort}`;
  let state = 'needsSetup';
  if (!tool.installed) state = 'missing';
  else if (!tool.running) state = 'stopped';
  else if (hostingMode === 'vpn' && !tool.ip) state = 'needsSetup';
  else state = firstGuestConnected ? 'ready' : 'waitingGuest';
  return { ...base, state, publicUrl, error: '' };
}

function publishHostingStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  getHostingStatus().then(status => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:hosting-status', status);
  }).catch(() => {});
}

function setTunnelStatus(state, publicUrl = '', error = '') {
  Object.assign(tunnelStatus, { state, publicUrl, error });
  publishHostingStatus();
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    serverFailure = '';
    const serverEntry = path.join(app.getAppPath(), 'server.js');
    const storageRoot = projectStorage.info().root;
    const ffmpeg = app.isPackaged ? resourcePath('bin', 'ffmpeg.exe') : require('ffmpeg-static');
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', PORT: String(port),
      DUBLINE_DATA_DIR: path.join(storageRoot, 'data'),
      DUBLINE_UPLOAD_DIR: path.join(storageRoot, 'uploads'),
      DUBLINE_PACKS_DIR: path.join(storageRoot, 'packs'),
      DUBLINE_FFMPEG_PATH: ffmpeg,
      DUBLINE_DESKTOP_ROOM: ROOM_ID,
      DUBLINE_DESKTOP_HOST_TOKEN: desktopHostToken,
      DUBLINE_ROOM_PIN: roomPin, DUBLINE_SINGLE_PLAYER: hostingMode === 'single' ? '1' : '0'
    };
    serverChild = fork(serverEntry, [], {
      cwd: app.isPackaged ? storageRoot : app.getAppPath(), env,
      execPath: process.execPath, silent: true, windowsHide: true
    });

    let settled = false;
    const timeout = setTimeout(() => { if (!settled) reject(new Error('The local server did not start in time.')); }, 15000);
    serverChild.stdout.on('data', chunk => { if (process.stdout) process.stdout.write(chunk); });
    serverChild.stderr.on('data', chunk => { if (process.stderr) process.stderr.write(chunk); });
    serverChild.once('error', err => { clearTimeout(timeout); if (!settled) reject(err); });
    serverChild.on('message', message => {
      if (!settled && message && message.type === 'ready') {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
      if (message && message.type === 'desktop-guest-joined') {
        firstGuestConnected = true;
        publishHostingStatus();
      }
    });
    serverChild.once('exit', code => {
      if (!settled) {
        clearTimeout(timeout);
        reject(new Error(`The local server stopped with code ${code}.`));
      } else if (!shuttingDown) {
        serverFailure = 'The local server stopped unexpectedly.';
        publishHostingStatus();
      }
    });
  });
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

function stopTunnel(resetStatus = true) {
  tunnelGeneration++;
  clearTimeout(tunnelTimeout);
  tunnelTimeout = null;
  if (tunnelChild) killProcessTree(tunnelChild);
  tunnelChild = null;
  if (resetStatus) setTunnelStatus('idle');
}

function startTunnel(port) {
  stopTunnel(false);
  const generation = tunnelGeneration;
  const cloudflared = app.isPackaged ? resourcePath('bin', 'cloudflared.exe') : resourcePath('cloudflared.exe');
  if (!fs.existsSync(cloudflared)) {
    setTunnelStatus('error', '', 'cloudflared.exe is missing. Run npm run prepare:cloudflared.');
    return;
  }
  setTunnelStatus('connecting');
  tunnelTimeout = setTimeout(() => {
    if (generation === tunnelGeneration && hostingMode === 'cloudflare' && !tunnelStatus.publicUrl) {
      setTunnelStatus('error', '', 'Cloudflare did not create a public address within 30 seconds.');
    }
  }, 30000);
  tunnelChild = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  let addressFound = false;
  const inspect = chunk => {
    output = (output + chunk.toString()).slice(-16000);
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && !addressFound && generation === tunnelGeneration) {
      addressFound = true;
      clearTimeout(tunnelTimeout);
      // cloudflared prints this URL only after the quick tunnel has been registered.
      // A second HTTPS request from the host creates false negatives on networks that
      // block Cloudflare while the same URL remains usable for guests elsewhere.
      setTunnelStatus('ready', match[0]);
    }
  };
  tunnelChild.stdout.on('data', inspect);
  tunnelChild.stderr.on('data', inspect);
  tunnelChild.once('error', err => { if (generation === tunnelGeneration) setTunnelStatus('error', '', err.message); });
  tunnelChild.once('exit', code => {
    if (!shuttingDown && generation === tunnelGeneration && hostingMode === 'cloudflare') {
      setTunnelStatus('error', '', `Cloudflare tunnel stopped with code ${code}.`);
    }
  });
}

async function setHostingMode(mode) {
  if (!HOSTING_MODES.has(mode)) throw new Error('Unsupported hosting mode.');
  const request = ++hostingModeRequest;
  if (hostingMode === 'single') {
    if (await desktopOperationBusy()) throw new Error(projectMessages(interfaceLanguage).transitionBusy);
    if (request !== hostingModeRequest) return getHostingStatus();
    await requestServer('enable-multiplayer');
  }
  if (request !== hostingModeRequest) return getHostingStatus();
  if (mode !== hostingMode) firstGuestConnected = false;
  hostingMode = mode;
  if (mode === 'cloudflare') startTunnel(localPort);
  else stopTunnel();
  return getHostingStatus();
}

function createLauncherWindow() {
  nativeTheme.themeSource = 'dark';
  launcherWindow = new BrowserWindow({
    ...windowOptions(path.join(__dirname, 'electron-launcher-preload.js')),
    width: 1080, height: 780, minWidth: 900, minHeight: 650
  });
  const launcherFile = path.join(__dirname, 'electron-launcher.html');
  launcherWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcherWindow.webContents.on('will-navigate', event => event.preventDefault());
  launcherWindow.once('ready-to-show', () => { launcherWindow.center(); launcherWindow.show(); });
  launcherWindow.loadFile(launcherFile);
}

function createHostWindow(port) {
  const localOrigin = `http://127.0.0.1:${port}`;
  mainWindow = new BrowserWindow({
    ...windowOptions(path.join(__dirname, 'electron-preload.js')),
    width: 1500, height: 900, minWidth: 1280, minHeight: 720
  });
  mainWindow.webContents.setWindowOpenHandler(createWorkshopLinkHandler(url => shell.openExternal(url)));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(localOrigin)) event.preventDefault(); });
  mainWindow.once('ready-to-show', () => {
    mainWindow.center();
    mainWindow.show();
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.destroy();
    launcherWindow = null;
  });
  mainWindow.loadURL(`${localOrigin}/?room=${encodeURIComponent(ROOM_ID)}&desktopHost=${desktopHostToken}${hostingMode === 'single' ? '&workspace=single' : ''}`);
}

function createGuestWindow(target) {
  const allowedOrigin = new URL(target).origin;
  mainWindow = new BrowserWindow({
    ...windowOptions(path.join(__dirname, 'electron-guest-preload.js')), width: 1500, height: 900, minWidth: 1280, minHeight: 720
  });
  mainWindow.webContents.setWindowOpenHandler(createWorkshopLinkHandler(url => shell.openExternal(url)));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin !== allowedOrigin) event.preventDefault(); }
    catch (err) { event.preventDefault(); }
  });
  let failureDialogOpen = false;
  mainWindow.webContents.on('did-fail-load', async (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || shuttingDown || failureDialogOpen || mainWindow?.isDestroyed()) return;
    failureDialogOpen = true;
    const guestWindow = mainWindow;
    guestWindow.center();
    guestWindow.show();
    const language = interfaceLanguage || 'en';
    const messages = {
      en: {
        title: 'Could not connect to the room',
        message: 'Dubline could not open the host address.',
        detail: `Check that the host is online, the VPN/Porthole connection is active, and the address is correct.\n\n${errorDescription}`,
        buttons: ['Retry', 'Change address', 'Close']
      },
      ru: {
        title: 'Не удалось подключиться к комнате',
        message: 'Dubline не смог открыть адрес хоста.',
        detail: `Проверьте, что хост запущен, соединение VPN/Porthole активно, а адрес указан правильно.\n\n${errorDescription}`,
        buttons: ['Повторить', 'Изменить адрес', 'Закрыть']
      },
      uk: {
        title: 'Не вдалося підключитися до кімнати',
        message: 'Dubline не зміг відкрити адресу хоста.',
        detail: `Перевірте, що хост запущений, з’єднання VPN/Porthole активне, а адресу вказано правильно.\n\n${errorDescription}`,
        buttons: ['Повторити', 'Змінити адресу', 'Закрити']
      }
    }[language];
    const { response } = await dialog.showMessageBox(guestWindow, {
      type: 'error', title: messages.title, message: messages.message,
      detail: messages.detail, buttons: messages.buttons, defaultId: 0, cancelId: 2, noLink: true
    });
    failureDialogOpen = false;
    if (guestWindow.isDestroyed()) return;
    if (response === 0) guestWindow.loadURL(target).catch(() => {});
    else if (response === 1) {
      shutdownComplete = true;
      app.relaunch({ args: process.argv.slice(1).filter(item => !item.startsWith(JOIN_ARG)) });
      app.exit(0);
    } else guestWindow.close();
  });
  mainWindow.once('ready-to-show', () => { mainWindow.center(); mainWindow.show(); });
  mainWindow.loadURL(target).catch(() => {});
}

async function shutdown() {
  if (shutdownComplete) return;
  shuttingDown = true; shellProjects.dispose();
  if (projectSaveJob) await projectSaveJob.catch(() => {});
  if (mainWindow && !mainWindow.isDestroyed() && serverChild) {
    try { await mainWindow.webContents.executeJavaScript("typeof editorPersistence === 'undefined' ? Promise.resolve() : editorPersistence"); } catch (_) { /* Durable records stay in the profile. */ }
  }
  stopTunnel(false);
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

function isLauncherSender(event) {
  return launcherWindow && !launcherWindow.isDestroyed() && event.sender === launcherWindow.webContents;
}

function isHostSender(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && !!serverChild;
}

function isGuestLanguageSender(event) {
  if (!guestOrigin || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === guestOrigin; } catch { return false; }
}

ipcMain.handle('launcher:detect-tools', event => {
  // Only the two trusted local windows can access the app preference.
  if (!isLauncherSender(event)) throw new Error('Untrusted launcher request.');
  return detectNetworkTools();
});
ipcMain.on('desktop:get-client-id', (event, previous) => {
  if (!isHostSender(event) || event.senderFrame !== event.sender.mainFrame) { event.returnValue = null; return; }
  if (!desktopClientId) {
    let legacy = null;
    try { const file = path.join(projectStorage.info().root, 'data', 'rooms.json'); if (fs.statSync(file).size <= 64 * 1024 ** 2) legacy = JSON.parse(fs.readFileSync(file, 'utf8'))?.[ROOM_ID]?.hostClientId; } catch { /* no legacy workspace */ }
    desktopClientId = [previous, legacy].find(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,64}$/.test(value)) || crypto.randomUUID();
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const temporary = desktopIdentityFile + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, clientId: desktopClientId }), { flag: 'wx' });
    fs.renameSync(temporary, desktopIdentityFile);
  }
  event.returnValue = desktopClientId;
});
ipcMain.handle('app:get-build-info', event => {
  if ((!isHostSender(event) && !isLauncherSender(event)) || event.senderFrame !== event.sender.mainFrame) throw Error('Untrusted build information request.');
  return { version:app.getVersion(), commit:distribution.commit || '', channel:distribution.channel, electronVersion:process.versions.electron };
});
ipcMain.on('app:get-language', event => {
  event.returnValue = isHostSender(event) || isLauncherSender(event) || isGuestLanguageSender(event) ? interfaceLanguage : null;
});
ipcMain.handle('app:set-language', (event, language) => {
  if (!isHostSender(event) && !isLauncherSender(event) && !isGuestLanguageSender(event)) throw new Error('Untrusted language request.');
  if (!['en', 'ru', 'uk'].includes(language)) return false;
  fs.mkdirSync(path.dirname(languageFile), { recursive: true });
  fs.writeFileSync(languageFile, JSON.stringify(language));
  interfaceLanguage = language;
  return true;
});
ipcMain.handle('app:get-update-status', event => {
  if (!isHostSender(event) && !isLauncherSender(event)) throw new Error('Untrusted update request.');
  return { ...appUpdateStatus, dismissed: appUpdateDismissed };
});
ipcMain.handle('app:dismiss-update', event => {
  if (!isHostSender(event) && !isLauncherSender(event)) throw new Error('Untrusted update request.');
  appUpdateDismissed = true;
  publishAppUpdateStatus();
  return true;
});
ipcMain.handle('app:open-update', async event => {
  if (!isHostSender(event) && !isLauncherSender(event)) throw new Error('Untrusted update request.');
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted update frame.');
  if (updateAdapter) {
    if (appUpdateStatus.state === 'downloaded') return updateAdapter.installOrRestart();
    if (appUpdateStatus.state === 'error') { await updateAdapter.check(); return { ok: true }; }
    return { ok: false, code: 'not-ready' };
  }
  if (appUpdateStatus.state !== 'available' || !appUpdateStatus.url.startsWith('https://github.com/dmbai009/dubline/releases/tag/')) return false;
  await shell.openExternal(appUpdateStatus.url);
  return true;
});
ipcMain.handle('app:project-association', async (event, operation) => {
  if ((!isHostSender(event) && !isLauncherSender(event)) || event.senderFrame !== event.sender.mainFrame) throw Error('Untrusted association request.');
  if (distribution.channel !== 'github-portable') return { supported: false };
  return { supported: true, ...await associationOperation(operation, process.execPath, resourcePath('project-association.ps1')) };
});
ipcMain.handle('app:open-update-details', async event => {
  if ((!isHostSender(event) && !isLauncherSender(event)) || event.senderFrame !== event.sender.mainFrame) throw Error('Untrusted update request.');
  await shell.openExternal('https://github.com/dmbai009/dubline/releases/latest'); return true;
});
ipcMain.handle('app:open-project', async event => {
  if (!isHostSender(event) && !isLauncherSender(event)) throw new Error('Untrusted project-link request.');
  await shell.openExternal('https://github.com/dmbai009/dubline');
  return true;
});
async function startOriginPreference(port) {
  const temporary = desktopOriginFile + '.' + crypto.randomUUID() + '.tmp';
  await fs.promises.writeFile(temporary, JSON.stringify({ schemaVersion: 1, port }), { flag: 'wx' });
  await fs.promises.rename(temporary, desktopOriginFile); preferredLocalPort = port;
}
async function launchWorkspace(mode, projectPath = '') {
  if (hostStarting || storageSelecting || projectStorage.busy) return { ok: false, error: 'Dubline is already starting or moving storage.' };
  if (mode !== 'single' && !HOSTING_MODES.has(mode)) return { ok: false, error: 'Choose a supported hosting mode.' };
  hostStarting = true;
  try {
    await projectStorage.prepare(publishStorageProgress);
    hostingMode = mode;
    localPort = await findFreePort(preferredLocalPort);
    await startOriginPreference(localPort);
    await startServer(localPort);
    if (projectPath) await requestServer('open-project-file', { path: projectPath });
    else if (mode === 'single') await requestServer('new-single-project');
    createHostWindow(localPort);
    if (mode === 'cloudflare') startTunnel(localPort);
    else setTunnelStatus('idle');
    return { ok: true, port: localPort };
  } catch (err) {
    killProcessTree(serverChild);
    serverChild = null;
    return { ok: false, error: err.message, storageCode: err instanceof StorageError ? err.code : '' };
  } finally {
    hostStarting = false;
  }
}
function requestServer(type, payload = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const child = serverChild, requestId = crypto.randomUUID();
    if (!child?.connected) return reject(new Error('The local server is unavailable.'));
    const finish = (error, value) => { clearTimeout(timer); child.off('message', listener); child.off('exit', exited); error ? reject(error) : resolve(value); };
    const listener = message => {
      if(message?.requestId!==requestId)return;
      if(message.type==='project-save-progress'){onProgress?.(message.progress);return;}
      if(message.canceled)finish(null,message);
      else finish(message.ok ? null : new Error(message.error || 'Project could not be opened.'), message);
    };
    const exited = () => finish(new Error('The local server stopped.'));
    const timer = ['open-project-file', 'save-project-file'].includes(type) ? null : setTimeout(() => finish(new Error('The local server did not respond.')), 120000);
    child.on('message', listener); child.once('exit', exited);
    child.send({ type, requestId, ...payload }, error => { if (error) finish(error); });
  });
}
ipcMain.handle('desktop:choose-project-destination', async (event, data = {}) => {
  if (!isHostSender(event) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted project save request.');
  if (projectSaving || projectChoosing || shuttingDown || storageSelecting || projectStorage.busy) return { ok: false, error: 'Wait for the current operation to finish.' };
  if (typeof data.sessionId !== 'string' || data.sessionId.length > 128) throw new Error('Invalid project scene.');
  projectChoosing = true;
  try {
    const filename = String(data.title || 'DubLine_project').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) + '.dubline';
    const selected = await dialog.showSaveDialog(mainWindow, { title: 'Save Project', defaultPath: filename, filters: [{ name: 'DubLine Project', extensions: ['dubline'] }] });
    if (selected.canceled || !selected.filePath) return { ok: true, canceled: true };
    const destination = path.extname(selected.filePath).toLowerCase() === '.dubline' ? selected.filePath : selected.filePath + '.dubline';
    projectDestinations.clear();
    const ticket = crypto.randomUUID(); projectDestinations.set(ticket, { destination, sessionId: data.sessionId, expires: Date.now() + 15 * 60 * 1000 });
    return { ok: true, ticket };
  } finally { projectChoosing = false; }
});
ipcMain.handle('desktop:save-project', async (event, data = {}) => {
  if (!isHostSender(event) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted project save request.');
  const destination = projectDestinations.get(data.ticket); projectDestinations.delete(data.ticket);
  if (!destination || destination.expires < Date.now() || destination.sessionId !== data.sessionId) return { ok: false, error: 'Choose the project destination again.' };
  if (projectSaving || projectChoosing || shuttingDown || storageSelecting || projectStorage.busy) return { ok: false, error: 'Wait for the current operation to finish.' };
  if (typeof data.clientId !== 'string' || data.clientId.length > 64 || typeof data.barrierToken !== 'string' || data.barrierToken.length > 128) throw new Error('Invalid snapshot request.');
  projectSaving = true;projectSaveTicket=data.ticket;
  try { projectSaveJob = requestServer('save-project-file', { ticket:data.ticket, destination: destination.destination, clientId: data.clientId, sessionId: data.sessionId, barrierToken: data.barrierToken, forceSnapshot: data.forceSnapshot === true }, progress=>{
    if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('desktop:project-save-progress',{ticket:data.ticket,stage:progress.stage,bytes:Math.max(0,Number(progress.bytes)||0)});
  }); return await projectSaveJob; }
  catch (error) { return { ok: false, error: error.message }; }
  finally { projectSaving = false; projectSaveJob = null; projectSaveTicket=null; }
});
ipcMain.handle('desktop:cancel-project-save',async(event,data={})=>{
  if(!isHostSender(event)||event.senderFrame!==event.sender.mainFrame)throw Error('Untrusted project save request.');
  if(typeof data.ticket!=='string'||data.ticket!==projectSaveTicket)return {ok:false,canceled:false};
  return requestServer('cancel-project-save',{ticket:data.ticket});
});
ipcMain.handle('launcher:start-host', (event, mode) => {
  if (!isLauncherSender(event)) throw new Error('Untrusted launcher request.');
  return launchWorkspace(mode);
});
ipcMain.handle('launcher:open-project-file', async (event, mode = 'single') => {
  if (!isLauncherSender(event)) throw new Error('Untrusted project-file request.');
  if (hostStarting) return { ok: false, error: 'Dubline is already starting.' };
  const selection = await dialog.showOpenDialog(launcherWindow, { properties: ['openFile'], filters: [{ name: 'Dubline Project', extensions: ['dubline'] }] });
  if (selection.canceled || !selection.filePaths[0]) return { ok: true, canceled: true };
  return launchWorkspace(mode, selection.filePaths[0]);
});
ipcMain.handle('launcher:join-guest', (event, value) => {
  if (!isLauncherSender(event)) throw new Error('Untrusted launcher request.');
  if (hostStarting || storageSelecting || projectStorage.busy) return { ok: false, error: 'Wait for the current operation to finish.' };
  try {
    const target = normalizeGuestUrl(value);
    const args = process.argv.slice(1).filter(item => !item.startsWith(JOIN_ARG));
    args.push(`${JOIN_ARG}${encodeURIComponent(target)}`);
    shutdownComplete = true;
    app.relaunch({ args });
    app.exit(0);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('desktop:get-status', event => {
  if (!isHostSender(event)) throw new Error('Untrusted host request.');
  return getHostingStatus();
});
ipcMain.handle('desktop:set-hosting-mode', (event, mode) => {
  if (!isHostSender(event)) throw new Error('Untrusted host request.');
  return setHostingMode(mode);
});
ipcMain.handle('desktop:retry-hosting', event => {
  if (!isHostSender(event)) throw new Error('Untrusted host request.');
  return setHostingMode(hostingMode);
});
ipcMain.handle('desktop:open-network-tool', async (event, tool) => {
  if (!isHostSender(event) && !isLauncherSender(event)) throw new Error('Untrusted external-link request.');
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const executable = tool === 'radmin' ? programFiles.flatMap(root => [
    path.join(root, 'Radmin VPN', 'RvRvpnGui.exe'),
    path.join(root, 'Famatech', 'Radmin VPN', 'RvRvpnGui.exe')
  ]).find(fs.existsSync) : tool === 'hamachi' ? programFiles.flatMap(root => [
    path.join(root, 'LogMeIn Hamachi', 'hamachi-2-ui.exe')
  ]).find(fs.existsSync) : '';
  if (executable) {
    const error = await shell.openPath(executable);
    if (!error) return true;
  }
  const targets = { porthole: 'steam://run/4963920', radmin: 'https://www.radmin-vpn.com/', hamachi: 'https://vpn.net/' };
  if (!targets[tool]) throw new Error('Unsupported network tool.');
  await shell.openExternal(targets[tool]);
  return true;
});
ipcMain.handle('desktop:copy-text', (event, value) => {
  if (!isHostSender(event)) throw new Error('Untrusted clipboard request.');
  clipboard.writeText(String(value || ''));
  return true;
});
ipcMain.handle('desktop:clear-all-data', async event => {
  if (!isHostSender(event)) throw new Error('Untrusted data cleanup request.');
  if (storageSelecting || projectStorage.busy) throw new Error('Wait for the storage operation to finish.');
  await shutdown();
  const userData = path.resolve(projectStorage.info().root);
  for (const name of FOLDERS) {
    const target = path.resolve(userData, name);
    const relative = path.relative(userData, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup path.');
    fs.rmSync(target, { recursive: true, force: true });
  }
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  app.relaunch({ args: process.argv.slice(1).filter(item => !item.startsWith(JOIN_ARG)) });
  app.exit(0);
  return true;
});

ipcMain.handle('app:get-storage', event => {
  if ((!isHostSender(event) && !isLauncherSender(event)) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted storage request.');
  return projectStorage.info();
});
ipcMain.handle('app:choose-storage', async event => {
  if ((!isHostSender(event) && !isLauncherSender(event)) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted storage request.');
  if (hostStarting || storageSelecting || projectStorage.busy || shuttingDown) return { ok: false, code: 'busy' };
  storageSelecting = true;
  try {
    const labels = {
      en: 'Choose a parent folder — project data will be stored in its Dubline subfolder',
      ru: 'Выберите папку — данные проектов будут храниться в её подпапке Dubline',
      uk: 'Виберіть папку — дані проєктів зберігатимуться в її підпапці Dubline'
    };
    const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: labels[interfaceLanguage || 'en'], properties: ['openDirectory', 'createDirectory'],
      defaultPath: path.dirname(projectStorage.info().pending || projectStorage.info().root)
    });
    if (selected.canceled || !selected.filePaths[0]) return { ok: true, canceled: true, ...projectStorage.info() };
    const info = await projectStorage.choose(selected.filePaths[0], !!serverChild, publishStorageProgress);
    return { ok: true, ...info };
  } catch (error) {
    return { ok: false, code: error.code || 'io', message: error.message, ...projectStorage.info() };
  } finally { storageSelecting = false; }
});

async function desktopOperationBusy() {
  if (hostStarting || storageSelecting || projectStorage.busy || projectSaving || projectChoosing || shuttingDown) return true;
  if (serverChild) {
    try { if ((await requestServer('desktop-busy')).busy) return true; } catch (_) { return true; }
  }
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    return await mainWindow.webContents.executeJavaScript("typeof recordState === 'undefined' || recordState !== 'idle' || typeof renderInProgress !== 'undefined' && renderInProgress || typeof projectImportBusy !== 'undefined' && projectImportBusy || typeof projectExportBusy !== 'undefined' && projectExportBusy || typeof customImportStatus !== 'undefined' && !!customImportStatus?.active || typeof pendingTakeLines !== 'undefined' && pendingTakeLines.size > 0 || !!window.snapshotFrozen || !!window.activeEditorGesture || typeof editorQueue !== 'undefined' && editorQueue.length > 0 || typeof editorNeedsResync !== 'undefined' && editorNeedsResync");
  } catch { return true; }
}
async function openShellProject(file) {
  const text = projectMessages(interfaceLanguage);
  if (!projectPathsFromArgs([file]).length) throw Error(projectMessages(interfaceLanguage).invalid);
  if (!serverChild) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const choice = await dialog.showMessageBox(mainWindow, { type: 'question', title: text.title, message: text.guest, buttons: [text.cancel, text.local], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) return;
      createLauncherWindow(); mainWindow.destroy(); mainWindow = null;
    }
    if (!launcherWindow || launcherWindow.isDestroyed()) createLauncherWindow();
    const result = await launchWorkspace('single', file); if (!result.ok) throw Error(result.error); return;
  }
  const choice = await dialog.showMessageBox(mainWindow, { type: 'question', title: text.title, message: hostingMode === 'single' ? text.single : text.multi, buttons: [text.cancel, text.open], defaultId: 0, cancelId: 0 });
  if (choice.response !== 1) return;
  if (await desktopOperationBusy()) throw Error(text.busy);
  await requestServer('open-project-file', { path: file });
}
const shellProjects = new ProjectOpenCoordinator({ busy: desktopOperationBusy, open: openShellProject,
  error: error => dialog.showErrorBox(projectMessages(interfaceLanguage).failed, error.message),
  waiting: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:project-open-waiting'); } });
function receiveProjectArgs(args, workingDirectory) {
  for (const file of projectPathsFromArgs(args, workingDirectory, error => dialog.showErrorBox(projectMessages(interfaceLanguage).failed, error.message))) shellProjects.enqueue(file);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    receiveProjectArgs(argv, workingDirectory);
    const target = mainWindow || launcherWindow;
    if (target) {
      if (target.isMinimized()) target.restore();
      target.focus();
    }
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId('io.github.dmbai009.dubline');
    try { distribution = readDistribution(process.resourcesPath, app.isPackaged); }
    catch (_) { appUpdateStatus = { ...appUpdateStatus, state: 'error', error: 'Distribution metadata is invalid. Update manually.' }; }
    const updateLog = new UpdateLog(app.getPath('userData'), { ...distribution, version: app.getVersion() });
    if (distribution.channel === 'github-setup') {
      updateAdapter = new InstalledUpdater({ currentVersion: app.getVersion(), updater: require('electron-updater').autoUpdater, busy: desktopOperationBusy, shutdown });
      updateAdapter.on('status', status => { appUpdateStatus = status; updateLog.record(status); publishAppUpdateStatus(); });
      updateAdapter.on('apply-result', result => updateLog.record(result));
    }
    if (distribution.channel === 'github-portable') {
      updateAdapter = new PortableUpdater({ current: distribution, root: path.dirname(process.execPath), stagingRoot: path.join(app.getPath('userData'), 'update-staging'), helper: resourcePath('updater', 'apply-update.ps1'), busy: desktopOperationBusy, shutdown, exit: () => app.exit(0), getProcesses: () => app.getAppMetrics().map(item => ({ id: item.pid, createdAt: Math.floor(item.creationTime) })) });
      updateAdapter.on('status', status => { appUpdateStatus = status; updateLog.record(status); publishAppUpdateStatus(); });
      updateAdapter.on('apply-result', result => updateLog.record(result));
    }
    if (distribution.channel === 'github-portable' && await updateAdapter.resumeInterrupted()) return;
    if (!guestTargetUrl) setTimeout(checkForAppUpdate, 12000).unref();
    // Not at once: it must not slow down the start
    setTimeout(cleanupPortableLeftovers, 20000).unref?.();
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      let allowed = false;
      try {
        const origin = new URL(webContents.getURL()).origin;
        const expected = serverChild && localPort ? `http://127.0.0.1:${localPort}` : guestOrigin;
        const requester = new URL(details.requestingUrl || webContents.getURL()).origin;
        allowed = ['media', 'fullscreen'].includes(permission) && origin === expected && requester === expected;
      } catch (err) { /* invalid or not loaded yet */ }
      callback(allowed);
    });
    const initialProjects = projectPathsFromArgs(process.argv, process.cwd(), error => dialog.showErrorBox(projectMessages(interfaceLanguage).failed, error.message));
    if (initialProjects.length) { createLauncherWindow(); for (const file of initialProjects) shellProjects.enqueue(file); }
    else if (guestTargetUrl) createGuestWindow(guestTargetUrl);
    else {
      createLauncherWindow();
    }
  }).catch(async err => {
    dialog.showErrorBox(projectMessages(interfaceLanguage).startup, err.message);
    await shutdown();
    app.quit();
  });
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    shutdown().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}
