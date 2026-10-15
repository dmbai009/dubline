const {describe,test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {skipReason,startServer,launchBrowser,openPlayer,loadFixture,claimAndSelect,waitFor,answerTextPrompt}=require('./helpers');
describe('inspector linked presets and icon metadata',{skip:skipReason,timeout:120000},()=>{
 let server,browser,host,guest,original;
 before(async()=>{
  server=await startServer();browser=await launchBrowser(server.port);host=await openPlayer(browser,server.url('quick-presets'),'Host',{autoConfirm:false});await loadFixture(host);await claimAndSelect(host,1);
  await host.evaluate(async()=>{
   window.iconMutation=(event,data)=>new Promise(resolve=>socket.emit(event,{...data,sessionId:session.activeSessionId,operationId:newUploadId(),operationEpoch:session.editorProtocol.epoch,operationTime:Date.now()},resolve));
   const b=new AudioBuffer({length:48000,sampleRate:48000,numberOfChannels:1});for(let i=0;i<b.length;i++)b.getChannelData(0)[i]=.05*Math.sin(i*.1);
   await submitTake({uploadId:newUploadId(),room:currentRoom,sessionId:session.activeSessionId,lineId:1,nick:myName,audioStart:0,duration:1,trimStart:.1,trimEnd:.9,blob:new Blob([audioBufferToWav(b)],{type:'audio/wav'}),createdAt:Date.now()});
   for(const [id,type]of [['radio','radio'],['phone','telephone']]){const r=await iconMutation('voice_preset_update',{action:'create',id,name:id,revision:0,settings:{effects:[{id:id+'-effect',type,enabled:true,amount:.4,parameters:{}}],pitch:5}});if(!r.ok)throw Error(JSON.stringify(r));}
  });await waitFor(host,()=>!!session.lines[0].audioUrl);await host.evaluate(()=>{selectLine(session.lines[0]);DublineVoiceEditor.open(1,'takes');});await host.click('[data-fx-type=echo]');await host.select('#fxPitchMode','override');await host.$eval('#fxPitch',n=>{n.value=3;n.dispatchEvent(new Event('input',{bubbles:true}));});await host.click('#fxApply');await waitFor(host,()=>!fxDialog.open&&session.lines[0].effects?.length===1);
  original=await host.evaluate(()=>({effects:structuredClone(session.lines[0].effects),pitch:session.lines[0].pitch,trim:session.lines[0].trimStart}));guest=await openPlayer(browser,server.url('quick-presets'),'Guest');await waitFor(guest,()=>session.loaded);
 });
 after(async()=>{await browser?.close();await server?.cleanup();});
 const select=async value=>{await host.select('#inspectorPreset',value);await host.click('[data-preset-apply]');};
 test('confirmed assignment replaces the own chain, retains manual pitch and refuses a foreign author',async()=>{
  await select('radio');await waitFor(host,()=>textPrompt.open);await host.click('#textPromptSave');await waitFor(host,()=>session.lines[0].voicePresetId==='radio'&&!editorQueue.length&&document.querySelector('[data-preset-apply]').disabled&&!document.getElementById('inspectorPreset').disabled);
  assert.deepEqual(await host.evaluate(()=>session.lines[0].effects),[]);assert.equal(await host.evaluate(()=>session.lines[0].pitch),original.pitch);assert.equal(await host.evaluate(()=>fxDialog.open),false);
  await guest.evaluate(()=>selectLine(session.lines[0]));assert.equal(await guest.$eval('#inspectorPreset',n=>n.disabled),true);assert.equal(await guest.$eval('[data-preset-apply]',n=>n.disabled),true);
 });
 test('cancelled preset replacement keeps the old link and safe detachment preserves its sound',async()=>{
  await select('phone');await waitFor(host,()=>textPrompt.open);await host.click('#textPromptCancel');await waitFor(host,()=>!document.querySelector('[data-preset-apply]').disabled);assert.equal(await host.evaluate(()=>session.lines[0].voicePresetId),'radio');
  const previous=await host.evaluate(()=>DublineVoiceChain.resolve(session.lines[0],session));await select('');await waitFor(host,()=>!session.lines[0].voicePresetId&&!editorQueue.length);
  const next=await host.evaluate(()=>DublineVoiceChain.resolve(session.lines[0],session));assert.deepEqual(next.effects.map(({id,...x})=>x),previous.effects.map(({id,...x})=>x));assert.equal(next.pitch,previous.pitch);assert.equal(await host.evaluate(()=>session.lines[0].trimStart),original.trim);
 });
 test('an older client is denied a scene containing single-chain settings',async()=>{
  const beforeLoad=page=>page.evaluateOnNewDocument(()=>document.addEventListener('DOMContentLoaded',()=>{window.qaDenied=null;socket.on('join_denied',data=>{qaDenied=data;});const emit=socket.emit;socket.emit=function(event,...args){if(event==='join_room')args[0].voiceVersion=1;return emit.call(this,event,...args);};},{once:true}));
  const old=await openPlayer(browser,server.url('quick-presets'),'Version one',{beforeLoad});try{await waitFor(old,()=>qaDenied?.reason==='voiceVersion');assert.equal(await old.evaluate(()=>hasSceneMediaAccess()),false);}finally{await old.browserContext().close();}
 });
 test('custom preset creation stores an icon and portable version 13; saved views ignore the removed single-role filter',async()=>{
  await select('radio');await waitFor(host,()=>textPrompt.open);await host.click('#textPromptSave');await waitFor(host,()=>session.lines[0].voicePresetId==='radio'&&!editorQueue.length&&!document.getElementById('inspectorPreset').disabled);const sound=await host.evaluate(()=>DublineVoiceChain.resolve(session.lines[0],session).effects);
  await host.evaluate(()=>DublineVoiceEditor.open(1,'takes'));await host.select('#fxPresetIcon','music');await host.click('#fxPresetSave');await answerTextPrompt(host,'My voice');await waitFor(host,()=>Object.values(session.voicePresets).some(p=>p.name==='My voice'&&p.icon==='music'));await host.evaluate(()=>DublineVoiceEditor.close(true));assert.match(await host.$eval('#inspectorPreset',n=>n.textContent),/♫ My voice/);assert.deepEqual(await host.evaluate(()=>Object.values(session.voicePresets).find(p=>p.name==='My voice').effects),sound);
  await guest.browserContext().close();const bytes=await host.evaluate(async()=>{const barrier=await prepareSafeSnapshot('project'),r=await fetch('/api/export-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom,clientId,...barrier})});if(!r.ok)throw Error(await r.text());return Array.from(new Uint8Array(await r.arrayBuffer()));});const read=require('../server/projects').readProject(Buffer.from(bytes));assert.equal(read.manifest.formatVersion,13);assert.equal(Object.values(read.manifest.project.voicePresets).find(p=>p.name==='My voice').icon,'music');
  assert.equal(await host.$('#timelineRoleFilter'),null);await host.evaluate(()=>{localStorage.setItem(`dubline_timeline_filter_v1:${encodeURIComponent(currentRoom)}:${session.activeSessionId}`,JSON.stringify({mode:'choose',role:'Hero',roles:['Friend'],status:'all',lines:[[3,true]]}));});await host.reload();await waitFor(host,()=>session.loaded&&DublineTimelineFilters.ids().length===3);assert.deepEqual(await host.evaluate(()=>DublineTimelineFilters.ids()),[2,3,4]);
 });
 test('panel resize and language changes preserve an unsaved caption, caret and actual localized labels',async()=>{
  await host.select('#timelineScopeFilter','all');await host.evaluate(()=>setStudioMode('edit'));await waitFor(host,()=>session.mode==='edit');await host.evaluate(()=>selectLine(session.lines[0]));
  await host.$eval('#editorCaption',n=>{n.value='Private caption draft';n.dispatchEvent(new Event('input',{bubbles:true}));n.focus();n.setSelectionRange(7,12);});
  await host.evaluate(async()=>{layout.inspector=900;applyLayout();await DublineI18n.setLanguage('uk');});
  assert.deepEqual(await host.$eval('#editorCaption',n=>({text:n.value,start:n.selectionStart,end:n.selectionEnd,focused:n===document.activeElement})),{text:'Private caption draft',start:7,end:12,focused:true});
  assert.equal(await host.$eval('label[for=editorCaption]',n=>n.textContent),await host.evaluate(()=>t('editor.caption')));assert.equal(await host.evaluate(()=>session.lines[0].caption),'Hello there');
 });
 test('no unhandled renderer errors',()=>{assert.deepEqual(host.errors,[]);assert.deepEqual(guest.errors,[]);});
});
