const { describe, test, before, after } = require('node:test'), assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, answerTextPrompt, claimAndSelect } = require('./helpers');
describe('Equalizer, palette dragging and isolated role presets', { skip: skipReason }, () => {
  let server, browser, host, guest;
  const call = (page, event, data) => page.evaluate((event, data) => new Promise(resolve => socket.emit(event, { ...data, sessionId: session.activeSessionId, operationId: newUploadId(), operationEpoch: session.editorProtocol.epoch, operationTime: Date.now() }, resolve)), event, data);
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url('eq-role'), 'Host', { autoConfirm:false, audioExpanded:false }); await loadFixture(host); guest = await openPlayer(browser, server.url('eq-role'), 'Actor', { autoConfirm:false, audioExpanded:false }); await waitFor(guest, () => session.loaded); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('EQ modifies the spectral balance, leaves flat/disabled samples exact and respects stage order', async () => {
    const result = await host.evaluate(async () => {
      const rate = 48000, buffer = new AudioBuffer({ length:rate, sampleRate:rate, numberOfChannels:1 }), data = buffer.getChannelData(0);
      for (let i=0;i<data.length;i++) data[i]=.04*(Math.sin(2*Math.PI*100*i/rate)+Math.sin(2*Math.PI*10000*i/rate));
      const eq = { id:'eq', type:'equalizer', enabled:true, amount:1, parameters:{ gains:[12,0,0,0,-12] } };
      const render = effects => DublineAudioFx.renderChain(buffer,{pitch:0,effects});
      const flat = await render([{...eq,parameters:{gains:[0,0,0,0,0]}}]), off = await render([{...eq,enabled:false}]), wet = await render([eq]);
      const defaultEq = await DublineAudioFx.renderVoice(buffer, 'equalizer');
      const amplitude = (buf,hz) => { let sin=0,cos=0; const values=buf.getChannelData(0); for(let i=4800;i<43200;i++){sin+=values[i]*Math.sin(2*Math.PI*hz*i/rate);cos+=values[i]*Math.cos(2*Math.PI*hz*i/rate);} return Math.hypot(sin,cos); };
      const diff = other => data.reduce((sum,value,index)=>sum+Math.abs(value-other.getChannelData(0)[index]),0);
      const radio = {id:'radio',type:'radio',enabled:true,amount:.5,parameters:{}};
      const first=await render([eq,radio]), second=await render([radio,eq]);
      return {flat:diff(flat),off:diff(off),defaultEq:diff(defaultEq), ratio:amplitude(wet,100)/amplitude(wet,10000), length:wet.length, peak:wet.getChannelData(0).reduce((n,v)=>Math.max(n,Math.abs(v)),0), order:first.getChannelData(0).reduce((n,v,i)=>n+Math.abs(v-second.getChannelData(0)[i]),0)};
    });
    assert.equal(result.flat,0); assert.equal(result.off,0); assert.equal(result.defaultEq,0); assert.equal(result.length,48000); assert.ok(result.ratio>3.5 && result.ratio<5 && result.peak<=1 && result.order>1,JSON.stringify(result));
  });
  test('a refused role-name preset stays local to the take and never appears in the role flow', async () => {
    for (const id of [1,3]) {
      await claimAndSelect(host,id);
      await host.evaluate(async id=>{
        const buffer=new AudioBuffer({length:12000,sampleRate:48000,numberOfChannels:1});
        buffer.getChannelData(0).forEach((_,i,pcm)=>{pcm[i]=.04*Math.sin(2*Math.PI*270*i/48000);});
        await submitTake({uploadId:newUploadId(),room:currentRoom,sessionId:session.activeSessionId,lineId:id,nick:myName,audioStart:0,trimStart:0,trimEnd:.25,blob:new Blob([audioBufferToWav(buffer)],{type:'audio/wav'}),createdAt:Date.now()});
      },id);
      await waitFor(host,id=>!!session.lines.find(line=>line.id===id).audioUrl,15000,id);
    }
    const before = await host.evaluate(()=>JSON.stringify({roles:session.roleEffects,presets:session.voicePresets}));
    await host.evaluate(()=>DublineVoiceEditor.open(1,'takes'));
    await host.click('[data-fx-type=echo]'); await host.click('#fxPresetSave'); await answerTextPrompt(host,'Hero');
    await waitFor(host,()=>fxPresetStatus.textContent===t('preset.roleName'));
    assert.equal(await host.evaluate(()=>JSON.stringify({roles:session.roleEffects,presets:session.voicePresets})),before);
    await host.click('#fxApply'); await waitFor(host,()=>!fxDialog.open);
    await waitFor(guest,()=>session.lines.find(line=>line.id===1).effects?.some(effect=>effect.type==='echo'));
    assert.equal(await host.evaluate(()=>JSON.stringify({roles:session.roleEffects,presets:session.voicePresets})),before);
    await host.evaluate(()=>DublineVoiceEditor.open('Hero','role'));
    assert.equal(await host.$eval('#fxSample',node=>node.value),'1');
    assert.equal(await host.$$eval('#fxRows .fx-item',nodes=>nodes.length),0);
    assert.equal(await host.$eval('#fxCount',node=>node.textContent),'0 / 8');
    assert.equal(await host.$eval('#fxFlow',node=>node.textContent.includes(t('fx.name.echo'))),false);
    await host.select('#fxSample','3');
    assert.equal(await host.$eval('#fxSample',node=>node.value),'3');
    assert.equal(await host.$eval('#fxFlow',node=>node.textContent.includes(t('fx.name.echo'))),false);
    await host.evaluate(()=>DublineVoiceEditor.close(true));
  });
  test('palette click adds one effect, dragging into an empty chain adds once, outside and Escape leave drafts unchanged', async () => {
    await host.evaluate(() => DublineVoiceEditor.open('Hero','role'));
    assert.equal(await host.$$eval('#fxPalette button', nodes=>nodes.length),11);
    await host.click('[data-fx-type=radio]'); assert.equal(await host.$$eval('#fxRows .fx-item',nodes=>nodes.length),1);
    await host.click('#fxClearChain');
    const start=await host.$eval('[data-fx-type=equalizer]',node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    const target=await host.$eval('#fxEmpty',node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await host.mouse.move(start.x,start.y); await host.mouse.down(); await host.mouse.move(target.x,target.y,{steps:15});
    assert.equal(await host.$$eval('.fx-drag-ghost',nodes=>nodes.length),1); assert.equal(await host.evaluate(()=>DublineVoiceEditor.draft().effects.length),0);
    await host.mouse.up(); assert.equal(await host.$$eval('#fxRows .fx-item',nodes=>nodes.length),1); assert.equal(await host.$$eval('[data-action=eqGain]',nodes=>nodes.length),5);
    assert.equal(await host.evaluate(()=>DublineVoiceEditor.draft().effects[0].type),'equalizer');
    for(const cancel of ['outside','escape']) {
      const box=await host.$eval('[data-fx-type=radio]',node=>{const r=node.getBoundingClientRect();return {x:r.x+20,y:r.y+10};});
      await host.mouse.move(box.x,box.y); await host.mouse.down(); await host.mouse.move(target.x,target.y,{steps:10});
      if(cancel==='escape') await host.keyboard.press('Escape'); else await host.mouse.move(2,2,{steps:5}); await host.mouse.up();
      assert.equal(await host.evaluate(()=>DublineVoiceEditor.draft().effects.length),1); assert.equal(await host.$$eval('.fx-drag-ghost',nodes=>nodes.length),0);
    }
  });
  test('role Apply updates the isolated source without private-variant notices or a separate confirmation', async () => {
    assert.equal(await host.$eval('.fx-sidebar',node=>node.hidden),true);
    assert.equal(await host.$eval('#fxPresetIcon',node=>!!node.closest('[hidden]')),true);
    assert.equal(await host.$eval('#fxApply',node=>node.title),await host.evaluate(()=>t('fx.rolePresetHelp')));
    assert.ok(await host.$eval('#fxDialog',node=>node.getBoundingClientRect().width<=860));
    assert.equal(await host.$eval('#fxLinked',node=>node.hidden),true);
    assert.equal(await host.$eval('#fxPresetSave',node=>!!node.closest('[hidden]')),true);
    await host.$eval('[data-action=eqGain][data-band="0"]',node=>{node.value=5;node.dispatchEvent(new Event('input',{bubbles:true}));});
    await host.click('#fxApply'); await waitFor(host,()=>!fxDialog.open); await waitFor(guest,()=>session.roleEffects.Hero?.voicePresetId);
    assert.equal(await host.evaluate(()=>textPrompt.open),false);
    const first=await host.evaluate(()=>structuredClone(session.voicePresets[session.roleEffects.Hero.voicePresetId]));
    assert.equal(first.role,'Hero'); assert.equal(first.effects[0].parameters.gains[0],5);
    await host.evaluate(()=>DublineVoiceEditor.open('Hero','role')); await host.$eval('[data-action=eqGain][data-band="1"]',node=>{node.value=-3;node.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await host.$eval('#fxFlow',node=>node.textContent.includes(t('fx.name.echo'))),false);
    assert.equal(await host.$eval('#fxLinked',node=>node.hidden),true); await host.click('#fxApply'); await waitFor(guest,()=>Object.values(session.voicePresets).some(p=>p.role==='Hero'&&p.revision===2));
    assert.equal(await host.evaluate(id=>session.roleEffects.Hero.voicePresetId===id,first.id),true);
    assert.deepEqual(await guest.evaluate(()=>DublineVoiceChain.resolve(session.lines[0],session).effects[0].parameters.gains),[5,-3,0,0,0]);
  });
  test('role presets are absent in take selectors and forged take links or direct source updates are refused', async () => {
    await waitFor(host,()=>!fxDialog.open); await host.evaluate(()=>{selectLine(session.lines[0]);DublineVoiceEditor.open(1,'takes');});
    assert.equal(await host.$eval('#fxFlow',node=>node.textContent.includes(t('fx.name.echo'))),true);
    assert.equal(await host.$eval('.fx-sidebar',node=>node.hidden),false);
    assert.equal(await host.$eval('#fxApply',node=>node.hasAttribute('title')),false);
    assert.equal(await host.$$eval('#fxPresetSelect option',nodes=>nodes.filter(n=>n.value).length),0);
    assert.equal(await host.$$eval('#inspectorPreset option',nodes=>nodes.filter(n=>n.value).length),0);
    const data=await host.evaluate(()=>{const line=session.lines[0],id=session.roleEffects.Hero.voicePresetId;return {scope:'takes',action:'replace',settings:{...DublineVoiceChain.take(line),effects:[],voicePresetId:id,usePresetPitch:true,presetModified:false},presetRevision:2,takes:[{lineId:line.id,character:line.character,takeId:line.takeId||null,audioUrl:line.audioUrl,takeMixRevision:line.takeMixRevision||0}]};});
    assert.equal((await call(host,'voice_update',data)).reason,'fx.rolePreset');
    assert.equal((await call(host,'voice_preset_update',{action:'update',id:data.settings.voicePresetId,revision:2,settings:{effects:[]}})).reason,'preset.roleOnly');
    await host.evaluate(()=>DublineVoiceEditor.close(true));
  });
  test('a role created after an ordinary preset renames only its label and preserves take links', async () => {
    assert.equal((await call(host,'voice_preset_update',{action:'create',id:'later',name:'Later',revision:0,settings:{effects:[]}})).ok,true);
    await host.evaluate(()=>socket.emit('set_session_mode',{mode:'edit',sessionId:session.activeSessionId})); await waitFor(host,()=>session.mode==='edit');
    assert.equal((await call(host,'editor_add_track',{character:'Later'})).ok,true);
    await waitFor(guest,()=>session.trackOrder.includes('Later')&&session.voicePresets.later.name==='Later (preset)');
    assert.equal(await host.evaluate(()=>session.voicePresets.later.role),undefined);
    assert.equal(await host.evaluate(()=>DublineVoicePresets.rolePreset(session,'Later')),null);
  });
  test('vertical role drag displaces neighbors without horizontal movement, Escape restores and drop synchronizes', async () => {
    await host.bringToFront(); await host.evaluate(()=>{clearMultiSelection();window.trackBefore=JSON.stringify(session.lines);document.querySelector('.track-row[data-character=Hero]').scrollIntoView({block:'center'});});
    const rect=await host.$eval('.track-row[data-character="Hero"]',node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    const dropY=await host.$eval('.track-row[data-character=Friend]',node=>{const r=node.getBoundingClientRect();return r.top+r.height*.75;});
    const handle=await host.$eval('.track-row[data-character="Hero"] .track-drag-handle',node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await host.mouse.move(handle.x,handle.y); await host.mouse.down(); await host.mouse.move(handle.x+230,dropY,{steps:12});
    assert.ok(Math.abs(await host.$eval('.track-reorder-source',node=>node.getBoundingClientRect().x)-rect.x)<1);
    assert.notEqual(await host.$eval('.track-row[data-character="Friend"]',node=>node.style.transform),'translateY(0px)');
    await host.keyboard.press('Escape'); await host.mouse.up(); assert.deepEqual(await host.evaluate(()=>session.trackOrder),['Hero','Friend','Later']);
    const fresh=await host.$eval('.track-row[data-character=Hero] .track-drag-handle',node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    const nextY=await host.$eval('.track-row[data-character=Friend]',node=>{const r=node.getBoundingClientRect();return r.top+r.height*.75;});
    await host.mouse.move(fresh.x,fresh.y); await host.mouse.down(); await host.mouse.move(fresh.x,nextY,{steps:12}); await host.mouse.up();
    try { await waitFor(guest,()=>session.trackOrder[0]==='Friend'); } catch(error) { console.log(await host.evaluate(()=>({order:session.trackOrder,queue:editorQueue.map(op=>({payload:op.payload,status:op.status})),conflicts:editorConflicts,toast:toastEl.textContent,errors:window.activeEditorGesture?.type})));throw error; } assert.equal(await host.evaluate(()=>JSON.stringify(session.lines)===trackBefore),true);
  });
  test('portable v15 and restart retain EQ, isolated role ownership and source revisions', async () => {
    const bytes=await host.evaluate(async()=>{const snapshot=await prepareSafeSnapshot('project');const response=await fetch('/api/export-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:currentRoom,clientId,...snapshot})});if(!response.ok)throw Error(await response.text());return [...new Uint8Array(await response.arrayBuffer())];});
    const projects=require('../src/server/projects'),read=projects.readProject(Buffer.from(bytes));assert.equal(read.manifest.formatVersion,15);
    const role=read.manifest.project.roleEffects.Hero,preset=read.manifest.project.voicePresets[role.voicePresetId];assert.equal(preset.role,'Hero');assert.deepEqual(preset.effects[0].parameters.gains,[5,-3,0,0,0]);
    const old=structuredClone(read.manifest);old.formatVersion=14;assert.throws(()=>projects.validateManifest(old),/version 15/);
    const staged=projects.stageProject(Buffer.from(bytes),server.dirs.uploads);try{assert.deepEqual(staged.commit().voicePresets[preset.id],preset);}finally{staged.rollback();}
    const epoch=await host.evaluate(()=>session.editorProtocol.epoch);
    await server.restart();await waitFor(host,epoch=>socket.connected&&session.editorProtocol.epoch!==epoch&&session.voicePresets[session.roleEffects.Hero?.voicePresetId]?.revision===2,10000,epoch);
    await waitFor(guest,epoch=>socket.connected&&session.editorProtocol.epoch!==epoch,10000,epoch);
    assert.deepEqual(host.errors,[]);assert.deepEqual(guest.errors,[]);
  });
  test('role rename and Undo move its source binding, reserve the new name and deny pre-v5 clients', async()=>{
    assert.equal((await call(host,'voice_preset_update',{action:'create',id:'alias',name:'Alias',revision:0,settings:{effects:[]}})).ok,true);
    const request=await host.evaluate(()=>({from:'Hero',to:'Alias',lines:session.lines.filter(line=>line.character==='Hero').map(line=>({lineId:line.id,revision:line.revision||0})),trackOrder:[...session.trackOrder]}));
    assert.equal((await call(host,'rename_character',request)).ok,true);await waitFor(guest,()=>session.trackOrder.includes('Alias')&&session.voicePresets.alias.name==='Alias (preset)');
    assert.equal(await host.evaluate(()=>session.voicePresets[session.roleEffects.Alias.voicePresetId].role),'Alias');
    assert.equal((await call(host,'editor_undo',{})).ok,true);await waitFor(guest,()=>session.trackOrder.includes('Hero')&&session.roleEffects.Hero?.voicePresetId);
    assert.equal(await guest.evaluate(()=>session.voicePresets[session.roleEffects.Hero.voicePresetId].role),'Hero');
    assert.deepEqual(await guest.evaluate(()=>DublineVoiceChain.resolve(session.lines.find(line=>line.character==='Hero'),session).effects[0].parameters.gains),[5,-3,0,0,0]);
    const old=await openPlayer(browser,server.url('eq-role'),'Old client',{beforeLoad:page=>page.evaluateOnNewDocument(()=>document.addEventListener('DOMContentLoaded',()=>{window.denied=null;socket.on('join_denied',data=>{denied=data;});const emit=socket.emit;socket.emit=function(event,...args){if(event==='join_room')args[0].voiceVersion=4;return emit.call(this,event,...args);};},{once:true}))});
    try{await waitFor(old,()=>denied?.reason==='voiceVersion');assert.equal(await old.evaluate(()=>hasSceneMediaAccess()),false);}finally{await old.browserContext().close();}
  });
});
