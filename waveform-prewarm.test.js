const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
function fixture(t){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-prewarm-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const timers=[];let busy=false;
  for(const name of ['one','two','three']){
    const rendered=spawnSync(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2','-ar','48000',path.join(folder,name+'.wav')],{windowsHide:true});
    assert.equal(rendered.status,0,String(rendered.stderr));
  }
  const c={module:{exports:{}},Buffer,process,
    setTimeout:(fn,ms)=>ms===1500 ? (timers.push(fn),{unref(){}}):setTimeout(fn,ms),clearTimeout,
    require:name=>name==='./media'?{ffmpegPath:require('ffmpeg-static')}:
      name==='./files'?{diskPathForUrl:url=>path.join(folder,path.basename(url))}:
      name==='./routes'||name==='./project-save'?{isMediaBusy:()=>busy,isBusy:()=>busy}:
      name==='./state'?{recordingNow:{}}:
      name==='../public/project-audio'?require('./public/project-audio'):require(name)};
  vm.runInNewContext(fs.readFileSync('server/waveform.js','utf8'),c);
  return {folder,timers,api:c.module.exports,setBusy:value=>{busy=value;},room:{loaded:true,activeSessionId:'A',videoUrl:'/uploads/one.wav',backingUrl:'/uploads/two.wav'}};
}
test('waveform prewarm returns before processing, shares real interactive jobs and reuses persistent peaks',async t=>{
  const f=fixture(t);assert.equal(f.api.prewarm(f.room),undefined);
  assert.deepEqual(fs.readdirSync(f.folder).filter(name=>name.startsWith('.waveform-')),[]);
  const warming=f.timers.shift()();
  const results=await Promise.all([f.api.waveform('/uploads/one.wav'),f.api.waveform('/uploads/one.wav'),f.api.waveform('/uploads/two.wav')]);
  await warming;
  assert.deepEqual(results[0],results[1]);assert.ok(results[0].duration>1.9);assert.ok(results[0].peaks.some(value=>value>0));
  const names=fs.readdirSync(f.folder).filter(name=>name.startsWith('.waveform-'));assert.equal(names.length,2);
  const mtimes=names.map(name=>fs.statSync(path.join(f.folder,name)).mtimeMs);
  await f.api.waveform('/uploads/one.wav');
  assert.deepEqual(names.map(name=>fs.statSync(path.join(f.folder,name)).mtimeMs),mtimes,'opening Audio inherits saved peaks');
});
test('prewarm skips busy/stale scenes and decode failures never change scene readiness',async t=>{
  const f=fixture(t);f.setBusy(true);f.api.prewarm(f.room);await f.timers.shift()();
  assert.equal(f.api.stats().jobs,0);
  f.setBusy(false);f.room.activeSessionId='B';f.api.prewarm(f.room);
  f.room.activeSessionId='C';f.room.videoUrl='/uploads/three.wav';f.api.prewarm(f.room);
  await f.timers.shift()();assert.equal(f.api.stats().jobs,0,'stale queued source is skipped');
  fs.writeFileSync(path.join(f.folder,'bad.wav'),'invalid media');
  const bad={...f.room,activeSessionId:'D',videoUrl:'/uploads/bad.wav',backingUrl:''};f.api.prewarm(bad);
  await f.timers.pop()();assert.equal(bad.loaded,true);assert.equal(f.api.stats().active,0);
});
test('waveform prewarm and interactive requests stay within the two-process bound',async t=>{
  const f=fixture(t);let maximum=0;
  const sample=setInterval(()=>{maximum=Math.max(maximum,f.api.stats().active);},1);t.after(()=>clearInterval(sample));
  f.api.prewarm(f.room);const warm=f.timers.shift()();
  await Promise.all(['one','two','three'].map(name=>f.api.waveform('/uploads/'+name+'.wav')));await warm;
  assert.ok(maximum>0&&maximum<=2);assert.equal(f.api.stats().active,0);assert.equal(f.api.stats().waiting,0);
});
