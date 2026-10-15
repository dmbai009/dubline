// Isolated real-studio Playwright functional and visual checks.
// Driver setup: npm install --prefix audit/fx-tools --no-save --package-lock=false playwright-core
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startServer,launchBrowser,openPlayer,loadFixture,claimAndSelect,waitFor}=require('../e2e/helpers');
const {chromium}=require(require.resolve('playwright-core',{paths:[process.cwd(),path.resolve('audit/fx-tools')]}));
async function main(){
 let server,browser,pw;const out=path.resolve('audit/inspector-workspace');fs.mkdirSync(out,{recursive:true});const shots=[];
 try{
  server=await startServer();browser=await launchBrowser(server.port);const setup=await openPlayer(browser,server.url('inspector-refresh'),'Host',{autoConfirm:false});await loadFixture(setup);await claimAndSelect(setup,1);
  await setup.evaluate(async()=>{
   window.qaMutation=(event,data)=>new Promise(resolve=>socket.emit(event,{...data,sessionId:session.activeSessionId,operationId:newUploadId(),operationEpoch:session.editorProtocol.epoch,operationTime:Date.now()},resolve));
   for(let j=0;j<2;j++){const b=new AudioBuffer({length:48000,sampleRate:48000,numberOfChannels:1});for(let i=0;i<b.length;i++)b.getChannelData(0)[i]=.08*Math.sin(i*.1);await submitTake({uploadId:newUploadId(),room:currentRoom,sessionId:session.activeSessionId,lineId:1,nick:myName,audioStart:0,duration:1,trimStart:.05,trimEnd:.9,blob:new Blob([audioBufferToWav(b)],{type:'audio/wav'}),createdAt:Date.now()});}
   for(const [id,type]of [['qa-radio','radio'],['qa-phone','telephone']]){const r=await qaMutation('voice_preset_update',{action:'create',id,name:id,revision:0,settings:{effects:[{id:id+'-effect',type,enabled:true,amount:.5,parameters:{}}],pitch:4}});if(!r.ok)throw Error(JSON.stringify(r));}
   selectLine(session.lines[0]);
  });await waitFor(setup,()=>session.lines[0].takeHistory.length===1&&!!session.voicePresets['qa-radio']);
  pw=await chromium.connectOverCDP(browser.wsEndpoint());const page=pw.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('inspector-refresh'));assert.ok(page);
  console.log('Studio, own takes and presets prepared.');
  const shot=async name=>{await page.screenshot({path:path.join(out,name+'.png')});shots.push(name);};
  await page.evaluate(()=>DublineVoiceEditor.open(1,'takes'));await page.locator('[data-fx-type=echo]').click();await page.locator('#fxPitchMode').selectOption('override');await page.locator('#fxPitch').evaluate(node=>{node.value='3';node.dispatchEvent(new Event('input',{bubbles:true}));});await page.locator('#fxApply').click();await page.waitForFunction(()=>!fxDialog.open&&session.lines[0].effects?.length===1);
  const original=await page.evaluate(()=>({effects:structuredClone(session.lines[0].effects),pitch:session.lines[0].pitch,trim:session.lines[0].trimStart,raw:session.lines[0].audioUrl,history:JSON.stringify(session.lines[0].takeHistory)}));
  await page.locator('#inspectorPreset').selectOption('qa-radio');await page.locator('[data-preset-apply]').click();await page.waitForFunction(()=>textPrompt.open);await page.locator('#textPromptSave').click();await page.waitForFunction(()=>session.lines[0].voicePresetId==='qa-radio'&&!editorQueue.length&&document.querySelector('[data-preset-apply]').disabled);
  assert.deepEqual(await page.evaluate(()=>session.lines[0].effects),[]);assert.equal(await page.evaluate(()=>session.lines[0].pitch),original.pitch);assert.equal(await page.evaluate(()=>fxDialog.open),false);
  await page.locator('#inspectorPreset').selectOption('qa-phone');await page.locator('[data-preset-apply]').click();await page.waitForFunction(()=>textPrompt.open);await page.locator('#textPromptCancel').click();await page.waitForFunction(()=>!document.querySelector('[data-preset-line] [role=status]'));
  assert.equal(await page.evaluate(()=>session.lines[0].voicePresetId),'qa-radio');
  await page.locator('[data-preset-apply]').click();await page.waitForFunction(()=>textPrompt.open);await page.locator('#textPromptSave').click();await page.waitForFunction(()=>session.lines[0].voicePresetId==='qa-phone'&&!editorQueue.length);
  const effective=await page.evaluate(()=>DublineVoiceChain.resolve(session.lines[0],session));
  await page.locator('#inspectorPreset').selectOption('');await page.locator('[data-preset-apply]').click();await page.waitForFunction(()=>!session.lines[0].voicePresetId&&!editorQueue.length);
  const detached=await page.evaluate(()=>DublineVoiceChain.resolve(session.lines[0],session));assert.deepEqual(detached.effects.map(({id,...x})=>x),effective.effects.map(({id,...x})=>x));assert.equal(detached.pitch,effective.pitch);
  // The existing durable receipt protocol must recover a missing ACK exactly once.
  const revision=await page.evaluate(()=>session.lines[0].takeMixRevision);
  await page.evaluate(()=>{const emit=socket.emit,onack=socket.onack,packets=new Set();window.qaVoiceIds=[];window.qaRestore=()=>{socket.emit=emit;socket.onack=onack;};socket.emit=function(event,...args){if(event==='voice_update'){packets.add(this.ids);qaVoiceIds.push(args[0].operationId);}return emit.call(this,event,...args);};socket.onack=function(packet){if(packets.delete(packet.id))return;return onack.call(this,packet);};});
  await page.locator('#inspectorPreset').selectOption('qa-radio');await page.locator('[data-preset-apply]').click();await page.waitForFunction(()=>textPrompt.open);await page.locator('#textPromptSave').click();await page.waitForFunction(()=>session.lines[0].voicePresetId==='qa-radio'&&!editorQueue.length,{timeout:20000});assert.equal(await page.evaluate(()=>session.lines[0].takeMixRevision),revision+1);assert.equal(await page.evaluate(()=>new Set(qaVoiceIds).size),1);await page.evaluate(()=>qaRestore());
  await page.waitForFunction(()=>!document.querySelector('[data-preset-line] [role=status]')||document.querySelector('[data-preset-line] [role=status]').textContent===t('preset.saved'));
  console.log('Quick link, safe replacement/detach and immutable ACK recovery passed.');
  // An icon is presentation metadata, saved with a real custom preset.
  await page.locator('.fx-inspector .insp-section-title button').click();await page.locator('#fxPresetIcon').selectOption('music');await page.locator('#fxPresetSave').click();await page.waitForFunction(()=>textPrompt.open);await page.locator('#textPromptInput').fill('My custom voice');await page.locator('#textPromptSave').click();await page.waitForFunction(()=>Object.values(session.voicePresets).some(p=>p.name==='My custom voice'&&p.icon==='music'));await page.evaluate(()=>DublineVoiceEditor.close(true));
  assert.ok(await page.locator('#inspectorPreset').textContent().then(text=>text.includes('♫ My custom voice')));
  assert.equal(await page.evaluate(()=>session.lines[0].audioUrl),original.raw);assert.equal(await page.evaluate(()=>JSON.stringify(session.lines[0].takeHistory)),original.history);
  const reader=await openPlayer(browser,server.url('inspector-refresh'),'Reader');await waitFor(reader,()=>session.loaded);const readerPage=pw.contexts().flatMap(c=>c.pages()).find(p=>p!==page&&p.url().includes('inspector-refresh'));
  await readerPage.setViewportSize({width:1920,height:1080});await readerPage.evaluate(()=>{layout.inspector=540;applyLayout();selectLine(session.lines[0]);});assert.equal(await readerPage.locator('#inspectorPreset').isDisabled(),true);await readerPage.screenshot({path:path.join(out,'readonly-540.png')});shots.push('readonly-540');assert.deepEqual(reader.errors,[]);await reader.browserContext().close();
  await claimAndSelect(setup,3);await page.evaluate(()=>{layout.inspector=360;applyLayout();});assert.equal(await page.locator('#recBtn').count(),1);assert.equal(await page.locator('.insp-mic input').count(),1);assert.equal(await page.locator('#inspectorPreset').isDisabled(),true);await shot('unrecorded-360');await page.evaluate(()=>selectLine(session.lines[0]));
  console.log('Custom preset icon creation passed.');
  await page.evaluate(()=>{toastEl.style.display='none';});
  // Container widths, rather than the viewport, select the inspector's columns.
  await page.setViewportSize({width:1920,height:1080});
  for(const mode of ['dub','edit']){
   await page.evaluate(mode=>setStudioMode(mode),mode);await page.waitForFunction(mode=>session.mode===mode,mode);await page.evaluate(()=>selectLine(session.lines[0]));
   for(const width of [280,360,540,900])for(const theme of ['midnight','light','ocean'])for(const language of ['en','ru','uk']){
    await page.evaluate(async({width,theme,language})=>{layout.inspector=width;applyLayout();document.documentElement.dataset.theme=theme;await DublineI18n.setLanguage(language);}, {width,theme,language});
    await page.waitForFunction(width=>Math.abs(inspector.getBoundingClientRect().width-width)<2,width);
    const geometry=await page.evaluate(()=>({width:inspector.clientWidth,overflow:inspector.scrollWidth-inspector.clientWidth,cols:getComputedStyle(inspector.querySelector('.insp-columns')).gridTemplateColumns.split(' ').length,controls:[...inspector.querySelectorAll('button,input,select,textarea')].filter(n=>n.getBoundingClientRect().width&&!n.classList.contains('dub-select-source')).filter(n=>{const b=n.getBoundingClientRect(),i=inspector.getBoundingClientRect();return b.left<i.left-1||b.right>i.right+1;}).map(n=>n.outerHTML.slice(0,180))}));
    assert.ok(geometry.overflow<=1&&!geometry.controls.length,JSON.stringify({mode,width,theme,geometry}));assert.equal(geometry.cols,width<480?1:width<800?2:3);
    if(mode==='dub'){assert.equal(await page.locator('.insp-mic input').count(),1);assert.equal(await page.locator('.take-history').count(),1);assert.equal(await page.locator('[data-clip-field=volume]').count(),1);assert.equal(await page.locator('[data-clip-field=pan]').count(),1);}
    await shot(`${mode}-${width}-${theme}-${language}`);
   }
  }
  for(const width of [280,900]){await page.evaluate(width=>{layout.inspector=width;applyLayout();multiSelection.clear();multiSelection.add(1);multiSelection.add(3);refreshMultiSelection();},width);assert.equal(await page.locator('[data-clip-field=volume]').count(),1);assert.equal(await page.locator('[data-clip-field=pan]').count(),1);assert.ok(await page.evaluate(()=>inspector.scrollWidth<=inspector.clientWidth+1));await shot('bulk-'+width);}await page.evaluate(()=>{clearMultiSelection();selectLine(session.lines[0]);});
  // Multi-role filters and individual overrides replace the removed legacy selector.
  assert.equal(await page.locator('#timelineRoleFilter').count(),0);await page.evaluate(()=>{const key=`dubline_timeline_filter_v1:${encodeURIComponent(currentRoom)}:${session.activeSessionId}`;localStorage.setItem(key,JSON.stringify({mode:'choose',role:'Hero',roles:['Friend'],status:'all',lines:[[3,true]]}));});await page.reload();await page.waitForFunction(()=>session?.loaded&&socket.connected&&DublineTimelineFilters.ids().length===3);assert.deepEqual(await page.evaluate(()=>DublineTimelineFilters.ids()),[2,3,4]);
  await page.locator('#timelineScopeFilter').selectOption('all');await page.evaluate(()=>selectLine(session.lines[0]));
  // Use a clean audible variant for the eight-stage layout fixture; inherited plus individual chains still obey the combined limit.
  await page.evaluate(()=>DublineVoiceEditor.open(1,'takes'));if(await page.locator('#fxLinked').isVisible())await page.locator('#fxDetach').click();await page.evaluate(()=>fxClear.click());await page.locator('#fxApply').click();await page.waitForFunction(()=>!fxDialog.open&&!session.lines[0].voicePresetId&&session.lines[0].effects.length===0);
  for(const scope of ['role','takes'])for(const count of [1,8]){
   console.log('Editor case '+scope+'/'+count);await page.evaluate(scope=>DublineVoiceEditor.open(1,scope),scope);const opened=await page.evaluate(()=>({open:fxDialog.open,dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>({id:n.id,kind:n.dataset.kind,text:n.textContent.slice(0,180)})),recordState,noise:!!DublineNoise.busy?.(),draft:DublineVoiceEditor.draft()?.scope}));assert.ok(opened.open,JSON.stringify(opened));await page.evaluate(()=>{if(!fxDetach.closest('[hidden]')&&!fxLinked.hidden)fxDetach.click();fxClear.click();});
   for(const type of ['robot','radio','telephone','monster','thoughts','cave','behindDoor','echo'].slice(0,count))await page.locator(`[data-fx-type="${type}"]`).click();
   for(const width of [1280,1920]){await page.setViewportSize({width,height:900});const g=await page.evaluate(()=>{const b=fxDialog.getBoundingClientRect(),f=fxApply.getBoundingClientRect();return{width:b.width,height:b.height,overflow:fxDialog.scrollWidth-fxDialog.clientWidth,footer:f.bottom<=b.bottom,viewport:b.right<=innerWidth&&b.bottom<=innerHeight};});assert.ok(g.width<=1161&&g.height<=841&&g.overflow<=1&&g.footer&&g.viewport,JSON.stringify(g));await shot(`effects-${scope}-${count}-${width}`);}
   if(count===8){await page.locator('#fxRows .fx-grip').first().scrollIntoViewIfNeeded();const first=await page.locator('#fxRows .fx-grip').first().boundingBox(),second=await page.locator('#fxRows>.fx-item').nth(1).boundingBox();await page.mouse.move(first.x+7,first.y+7);await page.mouse.down();await page.mouse.move(second.x+second.width*.8,second.y+second.height*.5,{steps:8});assert.equal(await page.locator('.fx-drag-ghost').count(),1);await shot(`effects-${scope}-drag`);await page.keyboard.press('Escape');await page.mouse.up();assert.ok(await page.evaluate(()=>fxDialog.open&&!textPrompt.open&&!document.querySelector('.fx-drag-ghost')));}
   await page.evaluate(()=>DublineVoiceEditor.close(true));
  }
  assert.deepEqual(setup.errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:true,screenshots:shots},null,2));console.log(`PASS: ${shots.length} Playwright screenshots; inspector widths/modes, confirmed chain replacement, preserved pitch/history, linked selection/detach, lost ACK, icon creation, role-filter compatibility, compact editor and drag.`);
 }finally{await pw?.close();await browser?.close();await server?.cleanup();}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
