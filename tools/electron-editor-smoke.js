// Test the source renderer in real Electron; no packaged build or user profile needed.
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { startServer } = require('../e2e/helpers');
  (async () => {
    const server = await startServer();
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], {
          windowsHide: true, stdio: 'inherit',
          env: { ...process.env, DUBLINE_EDITOR_SMOKE_URL: server.url('electron-editor'),
            DUBLINE_EDITOR_SMOKE_PROFILE: path.join(server.dirs.data, 'electron-profile') }
        });
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Electron editor smoke timed out')); }, 60000);
        child.once('error', err => { clearTimeout(timeout); reject(err); });
        child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Electron exited with ${code}`)); });
      });
    } finally { await server.cleanup(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.DUBLINE_EDITOR_SMOKE_PROFILE);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1600, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const evaluate = source => win.webContents.executeJavaScript(source, true);
    const waitFor = async source => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await evaluate(source).catch(() => false)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Electron wait timed out: ${source}`);
    };
    win.webContents.debugger.attach('1.3');
    const key = async (keyCode, modifiers = []) => {
      // CDP delivers real Chromium input even while the Electron window is hidden.
      const names = { Return: ['Enter', 13], Escape: ['Escape', 27], Down: ['ArrowDown', 40], Up: ['ArrowUp', 38] };
      const [code, virtualCode] = names[keyCode];
      const event = { key: code, code, windowsVirtualKeyCode: virtualCode, modifiers: modifiers.includes('alt') ? 1 : 0 };
      if (keyCode === 'Return') event.text = '\r';
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyDown' });
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
    };
    const answer = async value => {
      await waitFor("!!document.querySelector('dialog.text-prompt[open]')");
      await win.webContents.debugger.sendCommand('Input.insertText', { text: value });
      await key('Return');
      await waitFor("!document.querySelector('dialog.text-prompt[open]')");
    };
    try {
      await win.loadURL(process.env.DUBLINE_EDITOR_SMOKE_URL);
      await evaluate("localStorage.setItem('dubline_nick', 'Electron host'); localStorage.setItem('dubline_help_seen', '1'); localStorage.setItem('dubline_language', 'en');");
      await win.loadURL(process.env.DUBLINE_EDITOR_SMOKE_URL);
      await waitFor("socket.connected && myName === 'Electron host' && session");
      const unsupported = await evaluate("(() => { try { prompt('test'); return false; } catch (error) { return /not supported/.test(error.message); } })()");
      assert.equal(unsupported, true, 'This test must run in Electron with its actual unsupported prompt');
      await evaluate("loadSavedPack('test-scene.zip'); void 0;");
      await waitFor('session.loaded && session.lines.length === 4');
      await evaluate("document.getElementById('editModeBtn').click();");
      await waitFor("session.mode === 'edit'");
      await evaluate("document.querySelector('.track-add-btn').click();");
      await answer('Electron role');
      await waitFor("session.trackOrder.includes('Electron role')");
      await evaluate("document.querySelector('[data-character=\"Electron role\"] .track-rename').click();");
      await answer('Electron renamed');
      await waitFor("session.trackOrder.includes('Electron renamed')");
      await evaluate("renameSession(session.activeSessionId); void 0;");
      await answer('Electron scene');
      await waitFor("session.title === 'Electron scene'");
      await evaluate("document.getElementById('line-block-1').click(); document.activeElement.blur();");
      await key('Down', ['alt']);
      await waitFor("session.lines.find(line => line.id === 1).character === 'Friend'");
      await key('Up', ['alt']);
      await waitFor("session.lines.find(line => line.id === 1).character === 'Hero'");
      await evaluate("document.querySelector('.track-add-btn').click();"); await key('Escape');
      await waitFor("!document.querySelector('dialog[open]')");
      console.log(JSON.stringify({ electron: process.versions.electron, checks: ['add role', 'rename role', 'rename session', 'Alt+arrows', 'Escape'], passed: true }));
      win.destroy(); app.exit(0);
    } catch (error) { console.error(error); win.destroy(); app.exit(1); }
  }).catch(error => { console.error(error); app.exit(1); });
}
