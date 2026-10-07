const {describe,test,before,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {spawnSync}=require('node:child_process');
const {skipReason,startServer,launchBrowser,openPlayer,waitFor,waitUntil,recordTake}=require('./helpers');
function ff(args){const result=spawnSync(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-y',...args],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(result.status,0,result.stderr);return result.stdout;}
function videoHash(file){return ff(['-i',file,'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-']).trim();}
describe('optimized video and original-quality export',{skip:skipReason,timeout:180000},()=>{
 let dir,server,browser,host,guest,source,expected;
 before(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-proxy-browser-'));source=path.join(dir,'episode.mp4');
  ff(['-f','lavfi','-i','testsrc2=size=1920x1080:rate=25:duration=12','-f','lavfi','-i','sine=frequency=440:duration=12','-c:v','libx264','-preset','ultrafast','-c:a','aac','-movflags','+faststart',source]);expected=videoHash(source);
  const fd=fs.openSync(source,'r+');try{const before=fs.fstatSync(fd).size,size=301*1024*1024;fs.ftruncateSync(fd,size);const box=Buffer.alloc(8);box.writeUInt32BE(size-before);box.write('free',4);fs.writeSync(fd,box,0,8,before);}finally{fs.closeSync(fd);}
  fs.writeFileSync(path.join(dir,'scene.srt'),'1\n00:00:01,000 --> 00:00:03,000\nDemo phrase\n');
  server=await startServer();browser=await launchBrowser(server.port);host=await openPlayer(browser,server.url('proxy-browser'),'Host');guest=await openPlayer(browser,server.url('proxy-browser'),'Guest');
  const cdp=await host.createCDPSession();await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:dir});
 });
 after(async()=>{await browser?.close();await server?.cleanup();if(dir)fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 test('actual import UI optimizes large video, reports preparation and serves a smaller copy to guests',async()=>{
  await host.evaluate(()=>{openFilesModal();switchFilesTab('import');Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});window.proxyProgress=[];socket.on('video_import_progress',event=>{
    window.proxyProgress.push(event);
    if(event.stage==='compressing' && event.percent>0 && !window.proxyReopened){
      const id=customImportRequest.id;closeFilesModal();openFilesModal();DublineI18n.setLanguage('ru');switchFilesTab('import');
      window.proxyReopened={same:customImportRequest.id===id,percent:customImportStatus.percent,status:document.getElementById('customUploadStatus').textContent,visible:document.getElementById('customUploadStatus').style.display,cancel:document.getElementById('customCancelBtn').style.display,disabled:document.getElementById('customUploadBtn').disabled};
      DublineI18n.setLanguage('en');
    }
  });});
  await(await host.$('#customVideoInput')).uploadFile(source);await(await host.$('#customSubInput')).uploadFile(path.join(dir,'scene.srt'));
  const request=host.waitForRequest(request=>request.url().includes('/api/upload-custom'));
  await host.click('#customUploadBtn');assert.match((await request).url(),/optimize=1/);
  await waitFor(host,()=>session?.hasOriginalVideo && video.readyState>=2,90000);await waitFor(guest,()=>session?.hasOriginalVideo && video.readyState>=2,30000);
  const result=await host.evaluate(()=>({size:session.videoSize,sourceSize:session.originalVideoSize,sourceUrl:session.originalVideoUrl,width:video.videoWidth,height:video.videoHeight,tracks:session.audioTracks.length,progress:proxyProgress}));
  assert.ok(result.size<300*1024*1024);assert.equal(result.sourceSize,301*1024*1024);assert.equal(result.sourceUrl,undefined);assert.equal(result.width,1280);assert.equal(result.height,720);assert.equal(result.tracks,1);assert.ok(result.progress.some(p=>p.stage==='compressing'));
  const reopened=await host.evaluate(()=>proxyReopened);assert.equal(reopened.same,true);assert.ok(reopened.percent>0);assert.equal(reopened.visible,'block');assert.equal(reopened.cancel,'block');assert.equal(reopened.disabled,true);assert.ok(reopened.status.includes(String(reopened.percent)));
  await host.evaluate(()=>{closeFilesModal();openFilesModal();});assert.match(await host.$eval('#customUploadStatus',node=>node.textContent),/uploaded|done|created|ready/i);assert.equal(await host.$eval('#customCancelBtn',node=>node.style.display),'none');
  await guest.evaluate(()=>{openFilesModal();switchFilesTab('export');});assert.equal(await guest.$eval('#startRenderBtn',button=>button.disabled),true);
  assert.match(await guest.$eval('#renderOriginalNotice',notice=>notice.textContent),/on the host/);
 });
 test('recording and final render through UI preserve source video packets and attach the project mix',async()=>{
  const id=await host.evaluate(()=>session.lines[0].id);await host.evaluate(id=>socket.emit('claim_line',{ sessionId: session.activeSessionId, lineId:id}),id);await waitFor(host,()=>session.lines[0].claimedBy===myName);await recordTake(host,id);
  await host.evaluate(()=>{openFilesModal();switchFilesTab('export');});assert.match(await host.$eval('#renderOriginalNotice',notice=>notice.textContent),/original resolution and quality/);
  const response=host.waitForResponse(response=>response.url().includes('/api/export-original-video'),{timeout:60000});await host.click('#startRenderBtn');const rendered=await response;assert.equal(rendered.status(),200,await rendered.text());
  await waitUntil(()=>fs.readdirSync(dir).some(name=>name.endsWith('_export.mp4')),30000);const output=path.join(dir,fs.readdirSync(dir).find(name=>name.endsWith('_export.mp4')));await waitUntil(()=>!fs.readdirSync(dir).some(name=>name.endsWith('.crdownload')),30000);
  assert.equal(videoHash(output),expected);const decoded=ff(['-i',output,'-map','0:a:0','-f','hash','-hash','sha256','-']);assert.match(decoded,/SHA256=/);
  await waitFor(host,()=>!renderInProgress);assert.deepEqual(host.errors,[]);assert.deepEqual(guest.errors,[]);
 });
 test('cancelled large import leaves the existing project active and removes temporary files',async()=>{
  const id=await host.evaluate(()=>session.activeSessionId);
  await host.evaluate(()=>{openFilesModal();switchFilesTab('import');window.cancelStage='';const cancel=event=>{if(event.stage==='compressing'){window.cancelStage=event.stage;socket.off('video_import_progress',cancel);document.getElementById('customCancelBtn').click();}};socket.on('video_import_progress',cancel);});await(await host.$('#customVideoInput')).uploadFile(source);
  await host.click('#customUploadBtn');await waitFor(host,()=>!customImportRequest);
  assert.equal(await host.evaluate(()=>window.cancelStage),'compressing');assert.match(await host.$eval('#customUploadStatus',status=>status.textContent),/cancelled/);assert.equal(await host.evaluate(()=>session.activeSessionId),id);
  await waitUntil(()=>!fs.readdirSync(server.dirs.data).some(name=>name.startsWith('.incoming-')),10000);
 });
});
