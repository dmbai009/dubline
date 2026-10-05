const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');const {Readable}=require('node:stream');const {pipeline}=require('node:stream/promises');
const {io}=require('socket.io-client');const {startServer,waitUntil}=require('./e2e/helpers');
const {stageProjectDisk,exportProjectDisk}=require('./server/project-archive');const {hashFileSync,captureProject,validateManifest}=require('./server/projects');
const audio=require('./public/project-audio');
function ff(args){const result=spawnSync(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-y',...args],{encoding:'utf8',timeout:30000,windowsHide:true});assert.equal(result.status,0,result.stderr);return result.stdout;}
function streamHash(file){return ff(['-i',file,'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-']).trim();}
function padMp4(file,size){const fd=fs.openSync(file,'r+');try{const before=fs.fstatSync(fd).size;fs.ftruncateSync(fd,size);const box=Buffer.alloc(8);box.writeUInt32BE(size-before);box.write('free',4);fs.writeSync(fd,box,0,8,before);}finally{fs.closeSync(fd);}}
async function multipart(url,fields,name,file){const boundary='proxy-'+crypto.randomUUID();let prefix='';for(const [k,v]of Object.entries(fields))prefix+='--'+boundary+'\r\nContent-Disposition: form-data; name="'+k+'"\r\n\r\n'+v+'\r\n';prefix+='--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"; filename="'+path.basename(file)+'"\r\n\r\n';const suffix='\r\n--'+boundary+'--\r\n';const body=Readable.from((async function*(){yield Buffer.from(prefix);yield*fs.createReadStream(file);yield Buffer.from(suffix);})());return fetch(url,{method:'POST',duplex:'half',body,headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':Buffer.byteLength(prefix)+fs.statSync(file).size+Buffer.byteLength(suffix)}});}
test('smooth ducking anticipates speech, bridges short pauses and restores without a gain jump',()=>{
 const points=[];const param={setValueAtTime:(v,t)=>points.push([t,v]),linearRampToValueAtTime:(v,t)=>points.push([t,v])};
 audio.automateDucking(param,1,0.6,[[2,3],[3.2,4],[4.8,5]],7);
 assert.ok(points.every(([time,value],i)=>time>=0 && value>=0.4-1e-8 && value<=1 && (!i||time>=points[i-1][0])));
 const sample=time=>{let i=points.findLastIndex(p=>p[0]<=time);const a=points[i],b=points[i+1];return b?a[1]+(b[1]-a[1])*(time-a[0])/(b[0]-a[0]):a[1];};
 assert.ok(sample(1.85)>0.4 && sample(1.85)<1);assert.ok(Math.abs(sample(2)-0.4)<1e-8);assert.ok(Math.abs(sample(3.1)-0.4)<1e-8);
 assert.ok(sample(4.4)>0.4 && sample(4.4)<1);assert.ok(sample(4.51)<0.7,'new attack resumes from held release level');assert.ok(Math.abs(sample(6.1)-1)<1e-8);
 let maxJump=0;for(let t=1;t<6;t+=0.001)maxJump=Math.max(maxJump,Math.abs(sample(t+0.001)-sample(t)));assert.ok(maxJump<0.004,maxJump);
});
test('1 GiB source imports as a bounded working copy, survives .dubline and exports the unchanged video stream',{timeout:180000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-proxy-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const source=path.join(dir,'episode.mp4');ff(['-f','lavfi','-i','testsrc2=size=1920x1080:rate=6:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-f','lavfi','-i','sine=frequency=660:duration=4','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-preset','ultrafast','-c:a','aac','-metadata:s:a:0','language=jpn','-metadata:s:a:1','language=rus','-movflags','+faststart',source]);
 const videoHash=streamHash(source);padMp4(source,1024*1024*1024+8);const sourceHash=hashFileSync(source);
 const server=await startServer();t.after(()=>server.cleanup());const room='proxy',clientId=crypto.randomUUID();const socket=io('http://localhost:'+server.port,{transports:['websocket']});t.after(()=>socket.disconnect());let current,progress=[];
 socket.on('session_updated',state=>current=state);socket.on('video_import_progress',event=>progress.push(event));await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});socket.emit('join_room',{room,nick:'Host',clientId});await waitUntil(()=>current?.host==='Host');
 const url=(route,extra='')=>'http://localhost:'+server.port+'/api/'+route+'?room='+room+extra;
 const stalled=[];
 for(let i=0;i<3;i++){
  const request=require('node:http').request(url('upload-custom','&optimize=1'),{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=unfinished','Content-Length':1000000}});
  request.on('error',()=>{});request.on('response',response=>response.resume());request.flushHeaders();stalled.push(request);
 }
 t.after(()=>stalled.forEach(request=>request.destroy()));await new Promise(resolve=>setTimeout(resolve,50));
 const imported=await multipart(url('upload-custom','&optimize=1'),{clientId,requestId:'test-progress'},'video',source);
 stalled.forEach(request=>request.destroy());assert.equal(imported.status,200,(await imported.clone().text())+'\n'+server.log);let state=(await imported.json()).session;
 assert.equal(state.hasOriginalVideo,true);assert.equal(state.originalVideoUrl,undefined);assert.equal(state.originalVideoSize,fs.statSync(source).size);assert.ok(state.videoSize<300*1024*1024);assert.equal(state.audioTracks.length,2);assert.equal(state.audioTracks[1].language,'rus');assert.ok(state.audioTracks.every(track=>track.url!==state.videoUrl));assert.ok(progress.some(p=>p.stage==='compressing'&&p.requestId==='test-progress'));assert.ok(progress.some(p=>p.stage==='audio'));
 const proxyFile=path.join(server.dirs.uploads,state.videoUrl.slice('/uploads/'.length));assert.notEqual(streamHash(proxyFile),videoHash);
 const inspect=spawnSync(require('ffmpeg-static'),['-hide_banner','-i',proxyFile],{encoding:'utf8'}).stderr;assert.match(inspect,/1280x720/);
 const privateUrl=state.videoUrl.replace('dub_video.mp4','source_video.mp4');assert.equal((await fetch('http://localhost:'+server.port+privateUrl)).status,403);assert.equal((await fetch('http://localhost:'+server.port+privateUrl.replace('source_video','source%5Fvideo'))).status,403);
 // Archive embeds original bytes and format version 2; v1 continues to be accepted by other suites.
 const saved=await fetch(url('export-project'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,clientId,sessionId:state.activeSessionId,download:true})});assert.equal(saved.status,200,await saved.clone().text());const download='http://localhost:'+server.port+(await saved.json()).downloadUrl;
 const archive=path.join(dir,'episode.dubline'),response=await fetch(download,{headers:{Cookie:'dubline_client='+clientId}});assert.equal(response.status,200);await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(archive));assert.ok(fs.statSync(archive).size>1024*1024*1024);
 const staged=await stageProjectDisk(archive,dir);assert.equal(staged.fields.originalVideoName,'episode.mp4');const stagedOriginal=staged.mediaFiles.find(file=>file.video&&!file.primary);assert.equal(hashFileSync(stagedOriginal.path),sourceHash);staged.rollback();
 const reopened=await multipart(url('import-project'),{clientId,sessionId:state.activeSessionId},'project',archive);assert.equal(reopened.status,200,await reopened.clone().text());state=(await reopened.json()).session;assert.equal(state.hasOriginalVideo,true);await server.restart();await waitUntil(()=>socket.connected);await waitUntil(()=>current?.activeSessionId===state.activeSessionId);
 const soundtrack=path.join(dir,'dub.wav');ff(['-f','lavfi','-i','sine=frequency=880:duration=4','-ar','48000','-ac','2',soundtrack]);
 const fields={clientId,sessionId:state.activeSessionId};const denied=await multipart(url('export-original-video'),{...fields,clientId:'Guest'},'soundtrack',soundtrack);assert.equal(denied.status,403);
 const old=await multipart(url('export-original-video'),{...fields,sessionId:'old'},'soundtrack',soundtrack);assert.equal(old.status,409);
 const exportResponse=await multipart(url('export-original-video'),fields,'soundtrack',soundtrack);assert.equal(exportResponse.status,200,await exportResponse.clone().text());const prepared=await exportResponse.json();
 // A busy attempt must not release the existing slot.
 for(let i=0;i<2;i++){const busy=await multipart(url('export-original-video'),fields,'soundtrack',soundtrack);assert.equal(busy.status,409);}
 const exportUrl='http://localhost:'+server.port+prepared.downloadUrl;assert.equal((await fetch(exportUrl,{headers:{Cookie:'dubline_client=Guest'}})).status,403);
 const result=path.join(dir,'final.mp4');const final=await fetch(exportUrl,{headers:{Cookie:'dubline_client='+clientId}});assert.equal(final.status,200);await pipeline(Readable.fromWeb(final.body),fs.createWriteStream(result));assert.equal(streamHash(result),videoHash,'final video packets match original exactly');
 assert.equal((await fetch(exportUrl,{headers:{Cookie:'dubline_client='+clientId}})).status,404);await waitUntil(()=>!fs.readdirSync(server.dirs.data).some(name=>name.startsWith('.video-export-')||name.startsWith('.incoming-')));
 const short=path.join(dir,'short.wav');ff(['-f','lavfi','-i','sine=duration=1',short]);const invalid=await multipart(url('export-original-video'),fields,'soundtrack',short);assert.equal(invalid.status,400);
 assert.ok(fs.existsSync(source),'user original is preserved');console.log('Proxy: 1 GiB import/archive/restart persistence and original packet identity verified');
});


test('playback state updates keep duck transitions scheduled instead of snapping gain',async()=>{
 const vm=require('node:vm');const parameters=[];
 const param=()=>{const p={value:1,events:[],setValueAtTime(v,t){this.events.push(['set',v,t]);},linearRampToValueAtTime(v,t){this.events.push(['ramp',v,t]);},cancelAndHoldAtTime(t){this.events.push(['hold',t]);}};parameters.push(p);return p;};
 const node=()=>({connect(){return this;},gain:param(),threshold:{},knee:{},ratio:{},attack:{},release:{},start(){},stop(){}});
 class Context{constructor(){this.currentTime=10;this.destination={};this.state='running';}createGain(){return node();}createDynamicsCompressor(){return node();}createMediaElementSource(){return node();}createBufferSource(){return node();}}
 const video={volume:1,paused:false,currentTime:1};let muted=false;
 const window={AudioContext:Context,DublineProjectAudio:audio,DublineAudioFx:{effectTailSeconds:()=>0,fetchAndDecode:async()=>({duration:2}),renderVoice:async buffer=>buffer}};
 vm.runInNewContext(fs.readFileSync('public/audio.js','utf8'),{window,console,setTimeout,clearTimeout});
 const controller=window.DublineAudio.createController({video,backing:{volume:1},projectMix:true,getSession:()=>({lines:[{id:1,audioUrl:'take',start:1,trimStart:0,trimEnd:1,trimEnabled:true}]}),getVolumes:()=>({original:1,backing:1,recorded:1,isMuted:muted}),getSettings:()=>({autoDuckEnabled:true,autoDuckAmount:0.6}),isRenderInProgress:()=>false,getRecordingLineId:()=>null});
 controller.ensurePlayCtx();controller.scheduleTakes(1);await new Promise(resolve=>setTimeout(resolve,10));
 const gains=parameters.filter(p=>p.events.some(event=>event[0]==='ramp'&&Math.abs(event[1]-0.4)<1e-8));assert.equal(gains.length,2);
 const counts=gains.map(p=>p.events.length);controller.applyVolumes();assert.deepEqual(gains.map(p=>p.events.length),counts,'unrelated room update preserves automation');
 for(const gain of gains){const last=gain.events.at(-1);assert.ok(Math.abs(last[2]-10.3)<1e-8);}
 muted=true;controller.applyVolumes();assert.ok(gains.every(p=>p.events.at(-1)[0]==='set'&&p.events.at(-1)[1]===0));controller.stopAllTakes();
});

test('MKV with embedded subtitles and non-AAC audio uses a proxy but exports its original codec',{timeout:45000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-proxy-mkv-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const sub=path.join(dir,'scene.srt');fs.writeFileSync(sub,'1\n00:00:01,000 --> 00:00:02,000\nMKV subtitle\n');
 const input=path.join(dir,'source.mkv'),sound=path.join(dir,'sound.wav');ff(['-f','lavfi','-i','testsrc2=size=640x360:rate=12:duration=4','-f','lavfi','-i','sine=duration=4','-i',sub,'-map','0:v','-map','1:a','-map','2:s','-c:v','mpeg4','-c:a','ac3','-c:s','srt',input]);ff(['-f','lavfi','-i','sine=duration=4',sound]);
 const expected=streamHash(input),server=await startServer();t.after(()=>server.cleanup());const room='mkv',clientId=crypto.randomUUID(),socket=io('http://localhost:'+server.port,{transports:['websocket']});t.after(()=>socket.disconnect());let state;
 socket.on('session_updated',s=>state=s);await new Promise(resolve=>socket.once('connect',resolve));socket.emit('join_room',{room,nick:'Host',clientId});await waitUntil(()=>state?.host==='Host');const url=route=>'http://localhost:'+server.port+'/api/'+route+'?room='+room;
 const imported=await multipart(url('upload-custom')+'&optimize=1',{clientId},'video',input);assert.equal(imported.status,200,(await imported.clone().text())+'\n'+server.log);state=(await imported.json()).session;assert.equal(state.hasOriginalVideo,true);assert.equal(state.lines[0].caption,'MKV subtitle');assert.equal(state.audioTracks[0].codec,'ac3');
 const response=await multipart(url('export-original-video'),{clientId,sessionId:state.activeSessionId},'soundtrack',sound);assert.equal(response.status,200,await response.clone().text());const prepared=await response.json();assert.match(prepared.filename,/\.mkv$/);
 const final=await fetch('http://localhost:'+server.port+prepared.downloadUrl,{headers:{Cookie:'dubline_client='+clientId}}),file=path.join(dir,'final.mkv');await pipeline(Readable.fromWeb(final.body),fs.createWriteStream(file));assert.equal(streamHash(file),expected);
});

test('version 2 requires its original asset and version 1 cannot hide an original reference',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-proxy-schema-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'video.mp4'),'proxy');fs.writeFileSync(path.join(dir,'source.mkv'),'original');
 const snapshot=captureProject({loaded:true,videoUrl:'video.mp4',originalVideoUrl:'source.mkv',originalVideoName:'Episode.mkv',lines:[],trackOrder:[]},url=>path.join(dir,url));assert.equal(snapshot.manifest.formatVersion,2);
 for(const change of [m=>delete m.project.media.originalVideo,m=>m.project.media.originalVideo=m.project.media.video,m=>m.formatVersion=1,m=>m.project.media.originalVideoName='']){const m=structuredClone(snapshot.manifest);change(m);assert.throws(()=>validateManifest(m));}
});
