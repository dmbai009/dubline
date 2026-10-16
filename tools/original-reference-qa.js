// Playwright visual checks against generated scenes, never user media.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startServer,launchBrowser,openPlayer,loadFixture,waitFor,fixtureVideoPath,claimAndSelect}=require('../e2e/helpers');
const {chromium}=process.env.DUBLINE_PLAYWRIGHT_ROOT?require(path.join(process.env.DUBLINE_PLAYWRIGHT_ROOT,'node_modules','playwright-core')):require(require.resolve('playwright-core',{paths:[process.cwd(),path.resolve('audit/fx-tools')]}));
async function main(){
 let server,browser,pw,count=0;const out=path.resolve('audit/original-reference');fs.mkdirSync(out,{recursive:true});
 try{
  server=await startServer();browser=await launchBrowser(server.port);const setup=await openPlayer(browser,server.url('reference-qa'),'Host',{autoConfirm:false});await loadFixture(setup);
  pw=await chromium.connectOverCDP(browser.wsEndpoint());const page=pw.contexts().flatMap(c=>c.pages()).find(p=>p.url()===setup.url());
  await page.setViewportSize({width:1600,height:1000});
  for(const kind of ['pack','custom']){
   if(kind==='custom'){
    await page.evaluate(async encoded=>{
     const form=new FormData();form.append('clientId',clientId);form.append('video',new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))]),'reference.mp4');form.append('subtitles',new Blob(['1\n00:00:03,000 --> 00:00:04,500\n[Hero] Reference line\n']),'reference.srt');const result=await fetch('/api/upload-custom?room='+currentRoom,{method:'POST',body:form});if(!result.ok)throw Error(await result.text());
    },fs.readFileSync(fixtureVideoPath()).toString('base64'));await page.waitForFunction(()=>session.kind==='custom'&&session.audioTracks?.length&&!session.audioTracksPending);
   }
   await claimAndSelect(setup,1);
   await page.evaluate(async()=>{const buffer=new AudioBuffer({length:12000,sampleRate:48000,numberOfChannels:1});for(let i=0;i<buffer.length;i++)buffer.getChannelData(0)[i]=.04*Math.sin(i*.1);await submitTake({uploadId:newUploadId(),room:currentRoom,sessionId:session.activeSessionId,lineId:1,nick:myName,audioStart:3,trimStart:0,trimEnd:.25,blob:new Blob([audioBufferToWav(buffer)],{type:'audio/wav'}),createdAt:Date.now()});});await waitFor(setup,()=>!!session.lines[0].audioUrl);
   for(const owner of ['own','other'])for(const width of [280,360,540])for(const theme of ['graphite','light','ocean'])for(const language of ['en','ru','uk']){
    await page.evaluate(async({owner,width,theme,language})=>{layout.inspector=width;applyLayout();document.documentElement.dataset.theme=theme;await DublineI18n.setLanguage(language);const line=session.lines[0];line.recordedBy=owner==='own'?myName:'A participant with a very long display name';line.claimedBy=owner==='own'?myName:line.recordedBy;delete session.characterClaims[line.character];selectLine(line);},{owner,width,theme,language});
    await page.mouse.move(5,5);await page.waitForTimeout(40);
    const geometry=await page.evaluate(()=>{const row=inspector.querySelector('.insp-actions.primary'),buttons=[...row.querySelectorAll('button')];return{width:inspector.clientWidth,overflow:inspector.scrollWidth>inspector.clientWidth+1,buttons:buttons.map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width,top:n.getBoundingClientRect().top})),rowOverflow:row.scrollWidth>row.clientWidth+1};});
    assert.ok(!geometry.overflow&&!geometry.rowOverflow&&geometry.buttons.every(b=>b.height===28),JSON.stringify({kind,owner,width,theme,language,geometry}));
    if(owner==='other')assert.ok(geometry.buttons.length===4&&geometry.buttons.every(b=>Math.abs(b.top-geometry.buttons[0].top)<1),JSON.stringify({kind,width,theme,language,geometry}));
    await page.locator('#inspector').screenshot({path:path.join(out,`${kind}-${owner}-${width}-${theme}-${language}.png`)});count++;
   }
   if(kind==='custom'){
    await page.evaluate(()=>{layout.inspector=540;applyLayout();selectLine(session.lines[0]);});await page.locator('[data-original-preview]').click();await page.waitForFunction(()=>document.querySelector('[data-original-preview]').getAttribute('aria-pressed')==='true');await page.locator('#inspector').screenshot({path:path.join(out,'playing.png')});count++;await page.evaluate(()=>audio.stopPreview());
   }
  }
  assert.deepEqual(setup.errors,[]);console.log(JSON.stringify({screenshots:count,output:out}));
 }finally{await pw?.close();await browser?.close();await server?.cleanup();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
