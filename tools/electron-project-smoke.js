// Exercise the real main-process IPC and preloads with hidden Electron windows.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.join(__dirname,'..');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { fixtureVideoPath, buildVoiceFile } = require('../e2e/helpers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dubline-native-project-'));
  const project = path.join(dir,'Проект.dubline');
  if (process.env.DUBLINE_NATIVE_STORAGE_TEST) {
    fs.mkdirSync(path.join(dir, 'Storage A')); fs.mkdirSync(path.join(dir, 'Storage B'));
    fs.mkdirSync(path.join(dir, 'Occupied', 'Dubline'), {recursive:true});
    fs.writeFileSync(path.join(dir, 'Occupied', 'Dubline', 'keep'), 'unrelated');
  }
  async function run(mode) {
    return new Promise((resolve,reject) => {
      const childEnv={...process.env,DUBLINE_USER_DATA_DIR:path.join(dir,'profile'),DUBLINE_NATIVE_PROJECT_MODE:mode,DUBLINE_NATIVE_PROJECT_FILE:project,DUBLINE_NATIVE_VIDEO:fixtureVideoPath()}; delete childEnv.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [__filename,'--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--disable-gpu'], { cwd:root, windowsHide:true, stdio:['ignore','pipe','pipe'], env:childEnv });
      let log=''; child.stdout.on('data', chunk=>{log+=chunk; process.stdout.write(chunk);}); child.stderr.on('data',chunk=>{log+=chunk;});
      const timer=setTimeout(()=>{child.kill();reject(Error('Native project smoke timed out: '+log));},100000);
      child.once('error',reject); child.once('exit',code=>{clearTimeout(timer); code===0 ? resolve() : reject(Error('Native project smoke failed: '+log));});
    });
  }
  (async()=>{ try { await run('new'); assert.ok(fs.statSync(project).size>1000); await run('bad'); await run('open'); await run('multi'); console.log('Native Electron Single Player / save / close / launcher open / Multiplayer smoke passed.'); } finally { fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200}); } })().catch(error=>{console.error(error);process.exitCode=1;});
} else {
  const { app, BrowserWindow, dialog, session:electronSession } = require('electron');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: process.env.DUBLINE_NATIVE_PROJECT_FILE });
  // Mock only the OS picker response. IPC sender validation and project import are real.
  let storagePicker = 'Storage A';
  dialog.showOpenDialog = async (_window, options) => options.properties.includes('openDirectory')
    ? storagePicker === 'cancel' ? {canceled:true,filePaths:[]} : {canceled:false,filePaths:[path.join(path.dirname(process.env.DUBLINE_NATIVE_PROJECT_FILE),storagePicker)]}
    : { canceled:false, filePaths:[process.env.DUBLINE_NATIVE_PROJECT_FILE+(process.env.DUBLINE_NATIVE_PROJECT_MODE==='bad'?'.invalid':'')] };
  BrowserWindow.prototype.show = function() {};
  app.setAppPath(root);
  require('../electron-main');
  const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
  async function until(fn,timeout=20000) { const end=Date.now()+timeout; while(Date.now()<end){ const value=await fn().catch(()=>false); if(value)return value; await wait(50); } throw Error('Native smoke condition timed out'); }
  app.whenReady().then(async()=>{
    try {
      const launcher=await until(async()=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes('electron-launcher.html')));
      await until(()=>launcher.webContents.executeJavaScript('!!window.dublineLauncher?.startSingle'));
      const mode=process.env.DUBLINE_NATIVE_PROJECT_MODE;
      if (process.env.DUBLINE_NATIVE_STORAGE_TEST) {
        const launcherEval = script => launcher.webContents.executeJavaScript(script, true);
        await until(()=>launcherEval("!!document.getElementById('storagePath').textContent"));
        const info = await launcherEval('window.dublineLauncher.getStorage()');
        if (mode === 'bad') {
          assert.equal(info.root, app.getPath('userData'));
          assert.ok(info.pending.endsWith(path.join('Storage A','Dubline')));
        }
        if (mode === 'open') {
          assert.ok(info.root.endsWith(path.join('Storage A','Dubline'))); assert.equal(info.pending,'');
          storagePicker='cancel'; const canceled=await launcherEval('window.dublineLauncher.chooseStorage()'); assert.equal(canceled.canceled,true); assert.equal(canceled.root,info.root);
          storagePicker='Occupied'; await launcherEval("document.getElementById('storageChange').click()");
          await until(()=>launcherEval("document.getElementById('storageStatus').textContent.includes('empty')"));
          assert.equal(await launcherEval("document.getElementById('startSingle').disabled"),false);
          assert.equal(fs.readFileSync(path.join(path.dirname(process.env.DUBLINE_NATIVE_PROJECT_FILE),'Occupied','Dubline','keep'),'utf8'),'unrelated');
          storagePicker='Storage B'; await launcherEval("document.getElementById('storageChange').click()");
          await until(()=>launcherEval("document.getElementById('storagePath').textContent.includes('Storage B') && !document.getElementById('storageChange').disabled"));
          assert.equal(fs.existsSync(path.join(info.root,'uploads')),false);
          console.log('Native launcher cancel/error/immediate migration passed.');
        }
      }
      if(mode==='bad') fs.writeFileSync(process.env.DUBLINE_NATIVE_PROJECT_FILE+'.invalid', 'Not a project');
      const action=mode==='new' ? 'window.dublineLauncher.startSingle()' : "window.dublineLauncher.openProjectFile('"+(mode==='multi'?'porthole':'single')+"')";
      const result=await launcher.webContents.executeJavaScript(action,true); if(mode==='bad') {
        assert.equal(result.ok,false); assert.ok(result.error); assert.equal(launcher.isDestroyed(),false);
        const storageRoot=(await launcher.webContents.executeJavaScript('window.dublineLauncher.getStorage()')).root;
        const persisted=JSON.parse(fs.readFileSync(path.join(storageRoot,'data','rooms.json'),'utf8'));
        assert.ok(persisted.main.lines[0].audioUrl); assert.equal(persisted.main.trackOrder[0],'Native role');
        console.log('Native corrupt project preserves existing scene and launcher.'); launcher.close(); return;
      }
      assert.equal(result.ok,true,result.error);
      const host=await until(async()=>BrowserWindow.getAllWindows().find(win=>/^http:\/\/127.0.0.1/.test(win.webContents.getURL())));
      const evaluate=s=>host.webContents.executeJavaScript(s,true);
      await until(()=>evaluate('!!session && socket.connected'));
      if(mode==='multi') await evaluate("modalNickInput.value='Native host';handleNickSubmit({preventDefault(){}});");
      await until(()=>evaluate('amHost()'));
      assert.equal(await evaluate('session.singlePlayer'),mode!=='multi');
      assert.equal(await evaluate("getComputedStyle(document.getElementById('lobbyPanel')).display === 'none'"),mode!=='multi');
      if(mode==='new') {
        const encoded=fs.readFileSync(process.env.DUBLINE_NATIVE_VIDEO).toString('base64');
        assert.equal(await evaluate(`(async()=>{ const form=new FormData();form.append('clientId',clientId);form.append('video',new Blob([Uint8Array.from(atob('${encoded}'),c=>c.charCodeAt(0))]),'scene.mp4');return (await fetch('/api/upload-custom?room='+currentRoom+'&optimize=1',{method:'POST',body:form})).status;})()`),200);
        await until(()=>evaluate("session.loaded && session.mode === 'edit' && video.readyState >= 3"));
        await evaluate("addEditorTrack(); void 0;"); await until(()=>evaluate("!!document.querySelector('dialog[open]')"));
        await evaluate("document.getElementById('textPromptInput').value='Native role';document.getElementById('textPromptSave').click();");
        await until(()=>evaluate("session.trackOrder.includes('Native role')"));
        await evaluate("createEditorLineAt('Native role',1); void 0;");await until(()=>evaluate('session.lines.length===1'));
        await evaluate("setStudioMode('dub');");await until(()=>evaluate("session.mode==='dub'"));
        await evaluate("localStorage.setItem('dubline_help_seen','1');preRollSeconds=0;selectLine(session.lines[0]);recordSelectedLine(); void 0;");
        await until(()=>evaluate("session.lines[0].audioUrl && recordState==='idle' && pendingTakeLines.size===0"),30000);
        if (process.env.DUBLINE_NATIVE_CLIP_MIX_TEST) {
          await evaluate('selectLine(session.lines[0]);');
          assert.equal(await evaluate("!document.querySelector('[data-clip-field=effectAmount]')"), true);
          await evaluate("(()=>{const select=document.querySelector('[data-clip-field=effect]');select.value='behindDoor';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
          await until(()=>evaluate("session.lines[0].effect==='behindDoor' && !!document.querySelector('[data-clip-field=effectAmount]')"));
          for (const [field,value] of [['volume',67],['pan',-35],['effectAmount',45]]) {
            await evaluate("(()=>{const input=document.querySelector('[data-clip-field="+field+"]');input.value='"+value+"';input.dispatchEvent(new Event('change',{bubbles:true}));})()");
            await until(()=>evaluate('session.lines[0].'+field+'==='+value/100));
          }
          const stereo = await evaluate("(async()=>{const line=session.lines[0],buffer=await renderCharacterStem([line],12);const rms=channel=>{const data=buffer.getChannelData(channel);return Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length);};return {channels:buffer.numberOfChannels,left:rms(0),right:rms(1)};})()");
          assert.equal(stereo.channels,2);assert.ok(stereo.left>stereo.right && stereo.right>0,JSON.stringify(stereo));
          console.log('Native clip controls and stereo stem render passed.');
        }
        fs.writeFileSync(process.env.DUBLINE_NATIVE_PROJECT_FILE,'previous destination');
        await evaluate("window.nativeSavePhases=[];window.nativeSaveCancelSent=false;window.removeNativeProgress=window.dublineDesktop.onProjectSaveProgress(progress=>{window.nativeSavePhases.push(progress);if(progress.stage==='writing'&&!window.nativeSaveCancelSent){window.nativeSaveCancelSent=true;void window.dublineDesktop.cancelProjectSave({ticket:progress.ticket});}});saveDublineProject();void 0;");
        await until(()=>evaluate("!projectExportBusy && document.getElementById('projectExportStatus').textContent===t('project.cancelled')"));
        assert.equal(fs.readFileSync(process.env.DUBLINE_NATIVE_PROJECT_FILE,'utf8'),'previous destination');
        assert.ok(await evaluate("nativeSavePhases.some(progress=>progress.stage==='writing') && nativeSavePhases.every(progress=>Object.keys(progress).sort().join(',')==='bytes,stage,ticket')"));
        await evaluate('removeNativeProgress();saveDublineProject(); void 0;');
        await until(()=>evaluate("!projectExportBusy && document.getElementById('projectExportStatus').textContent==='Project saved.'"));
        assert.ok(fs.statSync(process.env.DUBLINE_NATIVE_PROJECT_FILE).size>1000);
        console.log('Native save progress, narrow IPC cancellation and preservation of the existing destination passed.');
        assert.equal(await evaluate('session.hasOriginalVideo'),true);
        const renderFile=path.join(path.dirname(process.env.DUBLINE_NATIVE_PROJECT_FILE),'Native-export.mp4');
        const rendered=new Promise((resolve,reject)=>{
          electronSession.defaultSession.once('will-download',(event,item)=>{item.setSavePath(renderFile);item.once('done',(event,state)=>state==='completed'?resolve():reject(Error('Render download '+state)));});
        });
        await evaluate('startVideoRender(); void 0;');await rendered;
        const packetHash=file=>{const result=require('node:child_process').spawnSync(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-i',file,'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
        assert.equal(packetHash(renderFile),packetHash(process.env.DUBLINE_NATIVE_VIDEO));
        console.log('Native original-quality render preserves source video packets.');

      } else {
        await until(()=>evaluate('session.loaded && session.lines[0]?.audioUrl'));
        assert.equal(await evaluate('session.hasOriginalVideo'),true);
        assert.equal(await evaluate('session.trackOrder[0]'),'Native role');
        if (process.env.DUBLINE_NATIVE_CLIP_MIX_TEST) {
          const clip = await evaluate('({...session.lines[0]})');
          assert.equal(clip.volume,0.67);assert.equal(clip.pan,-0.35);assert.equal(clip.effectAmount,0.45);assert.equal(clip.effect,'behindDoor');
          await evaluate('selectLine(session.lines[0]);');
          assert.equal(await evaluate("document.querySelector('[data-clip-field=volume]').value"),'67');
          console.log('Native clip mix survives launcher project open in '+mode+'.');
        }
        assert.ok(await evaluate("session.lines[0].audioUrl.includes('line_project_')"));
        if(mode==='open') {
          assert.equal(await evaluate('getLineOwner(session.lines[0])===myName'),true);
          await evaluate('toggleVideoFullscreen()');
          await until(()=>evaluate('document.fullscreenElement===videoWrapper && document.querySelector(".studio-transport").parentElement===videoWrapper'));
          await evaluate('document.exitFullscreen()');
          await until(()=>evaluate('!document.fullscreenElement'));
          const modes=await evaluate("Promise.all(['vpn','porthole','vpn','porthole'].map(mode=>window.dublineDesktop.setHostingMode(mode)))");
          assert.equal(modes.at(-1).mode,'porthole'); assert.equal(modes.at(-1).singlePlayer,false);
          assert.equal(await evaluate("(async()=> (await window.dublineDesktop.getStatus()).mode)()"),'porthole');
          await until(()=>evaluate('!session.singlePlayer && session.hasPassword'));
          assert.ok(await evaluate("session.lines[0].audioUrl.includes('line_project_')"));
        }
      }
      if (process.env.DUBLINE_NATIVE_STORAGE_TEST && mode==='new') {
        await evaluate('openSettingsModal()');
        await until(()=>evaluate("!!document.getElementById('desktopStoragePath').textContent"));
        assert.equal(await evaluate("document.getElementById('desktopStoragePath').textContent"),app.getPath('userData'));
        await evaluate('changeDesktopStorage(); void 0;');
        await until(()=>evaluate("document.getElementById('desktopStoragePending').textContent.includes('Storage A')"));
        const info=await evaluate('window.dublineDesktop.getStorage()');
        assert.equal(info.root,app.getPath('userData')); assert.equal(fs.existsSync(info.pending),false);
        assert.ok(await evaluate('session.lines[0].audioUrl && session.hasOriginalVideo'));
        assert.ok(fs.existsSync(path.join(info.root,'uploads')));
        console.log('Native host deferred migration preserves the active scene.');
      }
      if (process.env.DUBLINE_NATIVE_STORAGE_TEST && mode==='multi') {
        const info=await evaluate('window.dublineDesktop.getStorage()'); assert.ok(info.root.endsWith(path.join('Storage B','Dubline')));
        const renderFile=path.join(path.dirname(process.env.DUBLINE_NATIVE_PROJECT_FILE),'Storage-final.mp4');
        const rendered=new Promise((resolve,reject)=>electronSession.defaultSession.once('will-download',(_event,item)=>{
          item.setSavePath(renderFile);item.once('done',(_event,state)=>state==='completed'?resolve():reject(Error('Moved-source render '+state)));
        }));
        await evaluate('startVideoRender(); void 0;'); await rendered;
        const packetHash=file=>{const result=require('node:child_process').spawnSync(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-i',file,'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-'],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;};
        assert.equal(packetHash(renderFile),packetHash(process.env.DUBLINE_NATIVE_VIDEO));
        console.log('Final video after both migrations preserves original video packets.');
        const untrusted=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'electron-launcher-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
        await untrusted.loadFile(path.join(root,'electron-launcher.html'));
        assert.equal(await untrusted.webContents.executeJavaScript("window.dublineLauncher.getStorage().then(()=>false,error=>error.message.includes('Untrusted'))"),true);
        assert.equal(await untrusted.webContents.executeJavaScript("window.dublineLauncher.chooseStorage().then(()=>false,error=>error.message.includes('Untrusted'))"),true);
        untrusted.destroy(); console.log('Untrusted native window cannot read/change storage.');
      }
      console.log('Native project mode '+mode+' passed.');
      host.close();
    } catch(error) { console.error(error); app.exit(1); }
  });
}
