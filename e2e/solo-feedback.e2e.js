const {describe,test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {skipReason,startServer,launchBrowser,openPlayer,loadFixture,waitFor,buildMultiTrackVideo}=require('./helpers');

describe('solo feedback: numbering, fixed media controls, loading and QHD waveforms',{skip:skipReason,timeout:90000},()=>{
 let server,browser,page;
 before(async()=>{server=await startServer({DUBLINE_DESKTOP_ROOM:'main',DUBLINE_DESKTOP_HOST_TOKEN:'solo-feedback',DUBLINE_ROOM_PIN:'ABCD',DUBLINE_SINGLE_PLAYER:'1'});browser=await launchBrowser(server.port);page=await openPlayer(browser,server.url('main')+'&desktopHost=solo-feedback&workspace=single','Solo',{audioExpanded:true});await loadFixture(page);});
 after(async()=>{await browser?.close();await server?.cleanup();});
 test('old nonchronological project IDs display chronologically and survive portable save with identity intact',async()=>{
  await page.evaluate(async()=>{
   const response=await fetch('/api/export-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom,clientId,sessionId:session.activeSessionId})});
   if(!response.ok)throw Error(await response.text());
   const zip=await JSZip.loadAsync(await response.arrayBuffer()),manifest=JSON.parse(await zip.file('project.json').async('string'));
   for(const line of manifest.project.lines)line.id=({1:36,4:1})[line.id]||line.id;
   zip.file('project.json',JSON.stringify(manifest));const form=new FormData();form.append('clientId',clientId);form.append('sessionId',session.activeSessionId);form.append('project',await zip.generateAsync({type:'blob'}),'old.dubline');
   const opened=await fetch('/api/import-project?room='+currentRoom,{method:'POST',body:form});if(!opened.ok)throw Error(await opened.text());
  });
  await waitFor(page,()=>session.lines.some(line=>line.id===36));
  assert.equal(await page.$eval('#line-block-36 strong',el=>el.textContent),'#1');
  assert.equal(await page.$eval('#line-block-1 strong',el=>el.textContent),'#4');
  await page.evaluate(()=>selectLine(session.lines.find(line=>line.id===36)));
  assert.equal(await page.$eval('#inspector .insp-title span',el=>el.textContent),'#1');
  await page.evaluate(()=>setStudioMode('edit'));await waitFor(page,()=>session.mode==='edit');
  assert.equal(await page.$eval('#inspector .insp-title span',el=>el.textContent),'#1');
  const ids=await page.evaluate(async()=>{const r=await fetch('/api/export-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom,clientId,sessionId:session.activeSessionId})});const z=await JSZip.loadAsync(await r.arrayBuffer());return JSON.parse(await z.file('project.json').async('string')).project.lines.map(line=>line.id).sort((a,b)=>a-b);});
  assert.deepEqual(ids,[1,2,3,36]);
 });
 test('waveforms cover a 2560px viewport and immediate scrolled viewport without revealing an undrawn edge',async()=>{
  await page.setViewport({width:2560,height:1440,deviceScaleFactor:2});
  await waitFor(page,()=>Array.from(document.querySelectorAll('.studio-audio-row canvas')).every(c=>parseFloat(c.style.width)>=timelineContainer.clientWidth));
  await page.evaluate(()=>setTimelineZoom((timelineContainer.clientWidth-labelWidth-40)/video.duration,0));
  await waitFor(page,()=>{const row=document.querySelector('[data-audio-channel=original]');return row&&row.querySelector('.studio-wave-status').textContent==='';});
  const rightEdgePainted=()=>{const c=document.querySelector('[data-audio-channel=original] canvas'),x=Math.floor((video.duration-0.1)*pxPerSec);return c.getContext('2d').getImageData(x*devicePixelRatio,44*devicePixelRatio,1,1).data[3]>0;};
  await waitFor(page,rightEdgePainted);
  assert.equal(await page.evaluate(rightEdgePainted),true);
  const coverage=()=>Array.from(document.querySelectorAll('.studio-audio-row canvas')).every(canvas=>{const r=canvas.getBoundingClientRect(),t=timelineContainer.getBoundingClientRect();return r.left<=t.left+labelWidth+1&&r.right>=t.right-1&&canvas.width>=parseFloat(canvas.style.width)*devicePixelRatio;});
  await waitFor(page,coverage);
  assert.equal(await page.evaluate(coverage),true);
  await page.evaluate(()=>{timelineContainer.scrollLeft=250;});
  assert.equal(await page.evaluate(coverage),true);
  await page.evaluate(()=>{timelineContainer.scrollLeft=0;});
  await page.setViewport({width:1600,height:900,deviceScaleFactor:1});
 });
 test('fullscreen has one button, enters with its transport, and restores transport after exit',async()=>{
  assert.equal(await page.$$eval('[onclick="toggleVideoFullscreen()"], [data-studio-action=fullscreen]',els=>els.length),1);
  await page.click('[data-studio-action=fullscreen]');await waitFor(page,()=>document.fullscreenElement===videoWrapper && document.querySelector('.studio-transport').parentElement===videoWrapper);
  assert.equal(await page.evaluate(()=>document.querySelector('.studio-transport').parentElement===videoWrapper),true);
  await page.evaluate(()=>document.exitFullscreen());await waitFor(page,()=>!document.fullscreenElement && document.querySelector('.studio-transport').parentElement.classList.contains('video-box'));
  assert.equal(await page.evaluate(()=>document.querySelector('.studio-transport').parentElement.classList.contains('video-box')),true);
 });
 test('multi-track choice stays below video during redraw and horizontal scrolling, and preparation is visible',async()=>{
  await page.evaluate(()=>{window.audioPrepEvents=[];socket.on('session_updated',state=>{if(state.audioTracksPending)audioPrepEvents.push({visible:!document.getElementById('audioLoadingStatus').hidden,text:document.getElementById('audioLoadingStatus').textContent});});openFilesModal();});
  await (await page.$('#customVideoInput')).uploadFile(buildMultiTrackVideo());await page.evaluate(()=>uploadCustomScene());
  await waitFor(page,()=>session.audioTracks?.length===2&&originalTrackAudio.readyState>=3,20000);await page.evaluate(()=>closeFilesModal());
  assert.equal(await page.evaluate(()=>audioPrepEvents.some(event=>event.visible&&event.text.includes('Preparing'))),true);
  const left=await page.$eval('#trackPicker',el=>el.getBoundingClientRect().left);
  await page.evaluate(()=>{timelineContainer.scrollLeft=500;renderTimeline();});
  assert.ok(Math.abs(await page.$eval('#trackPicker',el=>el.getBoundingClientRect().left)-left)<1);
  assert.equal(await page.$eval('#trackPicker',el=>el.parentElement.classList.contains('video-box')),true);
  await page.locator('[data-studio-action=audio]').click();
  assert.equal(await page.$eval('#trackPicker',el=>getComputedStyle(el).display),'flex');
  await waitFor(page,()=>document.getElementById('audioLoadingStatus').hidden);
 });
 test('real delayed audio response shows a buffering indicator until audio can play',async()=>{
  let delayed;await page.setRequestInterception(true);
  const listener=request=>{if(request.url().includes('soloDelay=1'))delayed=request;else request.continue();};page.on('request',listener);
  try {
   await page.evaluate(()=>setMediaSource(originalTrackAudio,originalTrackAudio.getAttribute('src')+'?soloDelay=1'));
   await waitFor(page,()=>!document.getElementById('audioLoadingStatus').hidden&&document.getElementById('audioLoadingStatus').textContent==='Loading audio…');
   while(!delayed)await new Promise(resolve=>setTimeout(resolve,20));await delayed.continue();
   await waitFor(page,()=>originalTrackAudio.readyState>=3&&document.getElementById('audioLoadingStatus').hidden);
  }finally{page.off('request',listener);await page.setRequestInterception(false);}
 });
});
