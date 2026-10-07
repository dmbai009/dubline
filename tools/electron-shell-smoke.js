// Real cold shell-open and second-instance dispatch. Only OS confirmation is mocked.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { fixtureVideoPath } = require('../e2e/helpers');
  const { exportProject } = require('../server/projects');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-shell-native-'));
  const file = path.join(dir, 'Проєкт із пробілами.dubline');
  const scene = { loaded: true, title: 'Shell project', kind: 'custom', mode: 'edit', videoUrl: 'video', trackOrder: ['Role'], lines: [{ id: 1, character: 'Role', caption: 'Native shell', start: 1, end: 2 }], audioTracks: [] };
  let remote, remoteHost;
  async function run(target = '') {
    const env = { ...process.env, DUBLINE_USER_DATA_DIR:path.join(dir,target ? 'guest-profile':'profile'),DUBLINE_SHELL_PROJECT_FILE:file,DUBLINE_SHELL_GUEST_TARGET:target }; delete env.ELECTRON_RUN_AS_NODE;
    const args = [__filename,target ? '--dubline-join='+encodeURIComponent(target):file,'--disable-gpu','--use-fake-ui-for-media-stream'];
    const child = spawn(require('electron'),args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let log='';child.stdout.on('data',data=>{log+=data;process.stdout.write(data);});child.stderr.on('data',data=>{log+=data;});
    const timer=setTimeout(()=>child.kill(),90000);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
    assert.equal(code,0,log);
  }
  (async () => {
    try {
      fs.writeFileSync(file,(await exportProject(scene,()=>fixtureVideoPath())).buffer);
      await run();
      remote=await require('../e2e/helpers').startServer();
      remoteHost=require('socket.io-client').io(remote.url('shell-remote','127.0.0.1'),{transports:['websocket']});
      remoteHost.on('connect',()=>remoteHost.emit('join_room',{room:'shell-remote',nick:'Remote host',clientId:'shell-remote-host-client'}));
      await new Promise(resolve=>remoteHost.once('session_updated',resolve));
      await run(remote.url('shell-remote','127.0.0.1'));
      await require('../e2e/helpers').wait(1300);
      const stored=JSON.parse(fs.readFileSync(path.join(remote.dirs.data,'rooms.json'),'utf8'));
      assert.ok(!JSON.stringify(stored).includes('Shell project'),'local project never reaches remote workspace');
    } finally {remoteHost?.disconnect();await remote?.cleanup();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
  })().catch(error=>{console.error(error);process.exitCode=1;});
} else {
  const { app, BrowserWindow, dialog } = require('electron');
  BrowserWindow.prototype.show = function() {};
  let confirms = 0, accepted = false, messages=[];
  dialog.showMessageBox = async (_window,options) => { confirms++;messages.push(options.message);return { response: accepted ? 1 : 0 }; };
  app.setAppPath(root); require('../electron-main');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn) { const end = Date.now() + 30000; while (Date.now() < end) { const result = await fn().catch(() => false); if (result) return result; await wait(50); } throw Error('Shell smoke timed out'); }
  async function secondInstance() {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [__filename, process.env.DUBLINE_SHELL_PROJECT_FILE, '--disable-gpu'], { cwd:root,env:process.env,windowsHide:true,stdio:'ignore' });
    assert.equal(await new Promise(resolve => child.once('exit',resolve)),0);
  }
  app.whenReady().then(async () => {
    try {
      if(process.env.DUBLINE_SHELL_GUEST_TARGET) {
        const target=process.env.DUBLINE_SHELL_GUEST_TARGET;
        const guest=await until(async()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===target));
        const evaluate=code=>guest.webContents.executeJavaScript(code,true);
        await until(()=>evaluate("typeof socket!=='undefined' && socket.connected && !!session"));
        await evaluate("modalNickInput.value='Shell guest';handleNickSubmit({preventDefault(){}});void 0");
        await until(()=>evaluate("myName==='Shell guest'"));
        assert.equal(await evaluate('!!window.dublineDesktop'),false);
        const before=await evaluate('session.activeSessionId');
        await secondInstance();await until(async()=>confirms===1);
        assert.equal(await evaluate('session.activeSessionId'),before);
        accepted=true;await secondInstance();
        const local=await until(async()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().startsWith('http://127.0.0.1:')&&!window.webContents.getURL().startsWith(new URL(target).origin)));
        await until(()=>local.webContents.executeJavaScript("session?.loaded && session.title==='Shell project' && session.singlePlayer"));
        assert.equal(guest.isDestroyed(),true);
        console.log('Native remote guest shell-open: cancel preserves remote room; acceptance leaves guest and imports locally in Single Player; no host preload.');
        app.quit();return;
      }
      const host = await until(async () => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1:')));
      const evaluate = code => host.webContents.executeJavaScript(code, true);
      await until(() => evaluate("session?.loaded && session.title==='Shell project' && !!myName"));
      assert.equal(await evaluate('session.singlePlayer'), true);
      const before = await evaluate('({ id: session.activeSessionId, count: session.sessionList.length })');
      await secondInstance();
      await until(async () => confirms === 1);
      assert.equal(await evaluate('session.activeSessionId'), before.id, 'cancel leaves active scene intact');
      await evaluate("recordState='preparing'"); accepted = true;
      await secondInstance();
      await wait(400); assert.equal(confirms, 1, 'critical operation defers confirmation/import');
      await evaluate("recordState='idle'");
      await until(() => evaluate(`session.activeSessionId!==${JSON.stringify(before.id)}`));
      assert.equal(await evaluate('session.sessionList.length'), before.count + 1);
      assert.equal(await evaluate('session.lines[0].caption'), 'Native shell');
      assert.equal(await evaluate('session.singlePlayer'), true);
      await evaluate("window.dublineDesktop.setHostingMode('vpn')");
      await until(()=>evaluate('!session.singlePlayer'));
      const status=await evaluate('window.dublineDesktop.getStatus()');
      const peer=require('socket.io-client').io(`http://127.0.0.1:${status.port}`,{transports:['websocket']});
      let peerScene;
      peer.on('session_updated',scene=>{peerScene=scene;});
      peer.on('connect',()=>peer.emit('join_room',{room:status.room,password:status.pin,nick:'Shell peer',clientId:'native-shell-peer-client'}));
      await until(async()=>peerScene?.activeSessionId);
      const sharedBefore=peerScene.activeSessionId;
      await secondInstance();
      await until(async()=>peerScene.activeSessionId!==sharedBefore);
      assert.equal(peerScene.activeSessionId,await evaluate('session.activeSessionId'));
      assert.equal(peer.connected,true);
      assert.ok(messages.at(-1).includes('everyone'),'multiplayer confirmation states shared scene switch');
      peer.disconnect();
      console.log('Native Unicode cold shell-open, real two-process single-instance dispatch, canceled import, deferred critical work and preserved scene history passed.');
      app.quit();
    } catch (error) { console.error(error.stack); app.exit(1); }
  });
}
