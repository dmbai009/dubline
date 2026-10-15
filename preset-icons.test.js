const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-icons-'));
for(const area of ['data','uploads','packs']){const dir=path.join(root,area);fs.mkdirSync(dir);process.env['DUBLINE_'+(area==='uploads'?'UPLOAD':area.toUpperCase())+'_DIR']=dir;}
after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'dubline-icons-')));fs.rmSync(root,{recursive:true,force:true});});
const model=require('./public/voice-preset-model'),server=require('./server/voicePresets'),projects=require('./server/projects'),chain=require('./server/voiceChains');
const entry=()=>({id:'p1',name:'Radio',createdBy:'Actor',revision:1,icon:'radio',effects:[{id:'a',type:'radio',enabled:true,amount:.5,parameters:{}}]});
test('preset icons are bounded presentation metadata, authorized and preserved by sound-only edits',()=>{
 assert.equal(model.validEntry(entry()),true);
 for(const icon of ['<svg onload=alert(1)>','https://example.org/icon.png','__proto__',{},null])assert.equal(model.validEntry({...entry(),icon}),false);
 const room={voicePresets:{p1:entry()}},sound={action:'update',id:'p1',revision:1,settings:{effects:[]}};
 assert.throws(()=>server.plan(room,{nick:'Other'},{...sound,icon:'music'},false),/preset.owner/);
 assert.equal(server.plan(room,{nick:'Actor'},sound,false).p1.icon,'radio');
 assert.equal(server.plan(room,{nick:'Actor'},{...sound,icon:'music'},false).p1.icon,'music');
 assert.equal(server.plan(room,{nick:'Actor'},{...sound,icon:'voice'},false).p1.icon,undefined);
 assert.equal(server.plan(room,{nick:'Actor'},{action:'rename',id:'p1',revision:1,name:'New'},false).p1.icon,'radio');
 assert.throws(()=>server.plan(room,{nick:'Actor'},{...sound,icon:'arbitrary'},false),/preset.invalid/);
 assert.deepEqual(room.voicePresets.p1,entry());
});
test('icon archives explicitly use format 12, preserve metadata through staging and reject older-version smuggling',async()=>{
 fs.writeFileSync(path.join(root,'uploads','scene.mp4'),'generated video placeholder');
 const scene={loaded:true,title:'Icons',kind:'custom',mode:'dub',trackOrder:['Role'],lines:[],characterClaims:{},roleEffects:{},voicePresets:{p1:entry()},videoUrl:'/uploads/scene.mp4',videoHasAudio:false};
 const archive=await projects.exportProject(scene),read=projects.readProject(archive.buffer);assert.equal(read.manifest.formatVersion,12);assert.equal(read.manifest.project.voicePresets.p1.icon,'radio');
 const staged=projects.stageProject(archive.buffer,path.join(root,'uploads'));try{assert.equal(staged.commit().voicePresets.p1.icon,'radio');}finally{staged.rollback();}
 const older=structuredClone(read.manifest);older.formatVersion=11;assert.throws(()=>projects.validateManifest(older),/icons require version 12/);delete older.project.voicePresets.p1.icon;projects.validateManifest(older);
 const legacy=structuredClone(scene);delete legacy.voicePresets.p1.icon;assert.equal(projects.readProject((await projects.exportProject(legacy)).buffer).manifest.formatVersion,10);
});
test('client capability distinguishes ordinary live presets from icon-bearing catalogues',()=>{
 assert.equal(chain.minimumVersion({voicePresets:{},roleEffects:{},lines:[]}),0);
 assert.equal(chain.minimumVersion({voicePresets:{},roleEffects:{},lines:[{voicePresetId:'p1'}]}),1);
 assert.equal(chain.minimumVersion({voicePresets:{p1:entry()},roleEffects:{},lines:[]}),2);
});
