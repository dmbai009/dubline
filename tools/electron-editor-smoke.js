// Test the source renderer in real Electron; no packaged build or user profile needed.
const path = require('node:path');
const assert = require('node:assert/strict');
const { WORKSHOP_URL, createWorkshopLinkHandler } = require('../electron-external-links');

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
    const openedLinks = [];
    // Intercept only the OS browser launch; exercise Electron's actual popup policy.
    win.webContents.setWindowOpenHandler(createWorkshopLinkHandler(async url => { openedLinks.push(url); }));
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
      await waitFor("session.lines.find(line => line.id === 1).character === 'Hero' && editorQueue.length === 0");
      const recovery = await evaluate(`(async () => {
        const emit = socket.emit, before = session.lines.find(line => line.id === 1).revision || 0;
        let lose = true;
        socket.emit = function(event, ...args) {
          if (event === 'editor_update_line' && lose) { lose = false; const ack = args.pop(); args.push(() => ack(new Error('Native lost ACK'))); }
          return emit.call(this, event, ...args);
        };
        try {
          const results = await Promise.all(['Native A', 'Native B'].map(caption => updateEditorLine(session.lines.find(line => line.id === 1), { caption })));
          return { ok: results.every(result => result.ok), caption: session.lines.find(line => line.id === 1).caption, revisions: session.lines.find(line => line.id === 1).revision - before };
        } finally { socket.emit = emit; }
      })()`);
      assert.deepEqual(recovery, { ok: true, caption: 'Native B', revisions: 2 });
      assert.equal(await evaluate("(() => { const slider=document.getElementById('settingsMicGain'); slider.value='150'; slider.dispatchEvent(new Event('input',{bubbles:true})); slider.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return userMicGain===1 && slider.value==='100'; })()"), true);
      await evaluate("document.querySelector('[data-character=\"Friend\"] .track-drag-handle').focus();");
      await key('Up', ['alt']); await waitFor("session.trackOrder[0] === 'Friend' && editorQueue.length === 0");
      await evaluate("editorUndo(); void 0;"); await waitFor("session.trackOrder[0] === 'Hero' && editorQueue.length === 0");
      await evaluate("document.getElementById('protectTimingsBtn').click();"); await waitFor('session.protectTimings');
      assert.equal(await evaluate("document.getElementById('addEditorLineBtn').disabled && [...document.querySelectorAll('[data-editor-field=\"start\"], [data-editor-field=\"end\"]')].every(input => input.disabled)"), true);
      const protectedTiming = await evaluate("[session.lines[0].start, session.lines[0].end]");
      await evaluate("updateEditorLine(session.lines[0], {character:'Friend'}); void 0;"); await waitFor("session.lines[0].character === 'Friend' && editorQueue.length === 0");
      assert.deepEqual(await evaluate("[session.lines[0].start, session.lines[0].end]"), protectedTiming);
      await evaluate("editorUndo(); void 0;"); await waitFor("session.lines[0].character === 'Hero' && editorQueue.length === 0");
      await evaluate("document.querySelector('[data-character=\"Hero\"] .track-delete-button').click();"); await waitFor("document.querySelector('.track-delete-dialog').open");
      await evaluate("document.querySelector('[data-track-decision=transfer]').click();"); await waitFor("!session.trackOrder.includes('Hero') && editorQueue.length === 0");
      assert.equal(await evaluate('session.lines.length'), 4);
      await evaluate("editorUndo(); void 0;"); await waitFor("session.trackOrder.includes('Hero') && editorQueue.length === 0");
      await evaluate("document.getElementById('protectTimingsBtn').click();"); await waitFor('!session.protectTimings');
      assert.deepEqual(await evaluate("(() => {openFilesModal(); switchFilesTab('projects'); const result = {tabs:[...document.querySelectorAll('#filesModal [role=tab]')].map(tab=>tab.dataset.filesTab), project:document.getElementById('projectExportBtn').closest('[role=tabpanel]').id, local:document.getElementById('localMediaInput').closest('[role=tabpanel]').id};closeFilesModal();return result;})()"), {tabs:['packs','video','projects','export'],project:'tabContentProjects',local:'tabContentVideo'});
      await evaluate("document.querySelector('.track-add-btn').click();"); await key('Escape');
      await waitFor("!document.querySelector('dialog[open]')");
      const roomUrl = win.webContents.getURL();
      const point = await evaluate(`(() => {
        openFilesModal();
        const link = document.querySelector('[data-i18n="workshopImport.browse"]');
        link.scrollIntoView({ block: 'center' });
        const box = link.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 });
      }
      for (let attempt = 0; attempt < 100 && !openedLinks.length; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(openedLinks, [WORKSHOP_URL], 'Workshop click did not reach the external browser');
      assert.equal(win.webContents.getURL(), roomUrl, 'Workshop navigated away from the room');
      assert.equal(BrowserWindow.getAllWindows().length, 1, 'Workshop opened an Electron popup');
      await evaluate("window.open('https://voxalike.com.evil.test/workshop', '_blank'); void 0;");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(openedLinks, [WORKSHOP_URL], 'An unrelated URL reached the external browser');
      assert.equal(BrowserWindow.getAllWindows().length, 1, 'An unrelated popup was allowed');
      console.log(JSON.stringify({ electron: process.versions.electron, checks: ['add role', 'rename role', 'rename session', 'Alt+arrows', 'lost ACK/pending queue', 'slider reset', 'track reorder/Undo', 'protected timing/vertical move', 'track transfer/Undo', 'Files tabs', 'Escape', 'Workshop external link'], passed: true }));
      win.destroy(); app.exit(0);
    } catch (error) { console.error(error); win.destroy(); app.exit(1); }
  }).catch(error => { console.error(error); app.exit(1); });
}
