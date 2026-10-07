const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Readable}=require('node:stream');const {pipeline}=require('node:stream/promises');const AdmZip=require('adm-zip');const {io}=require('socket.io-client');
const {captureProject,hashFileSync}=require('./server/projects');const {exportProjectDisk,stageProjectDisk}=require('./server/project-archive');
const {startServer,waitUntil,fixtureVideoPath,buildFixturePack}=require('./e2e/helpers');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-project-stream-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 fs.copyFileSync(fixtureVideoPath(),path.join(dir,'video.mp4'));fs.writeFileSync(path.join(dir,'source.wav'),new AdmZip(buildFixturePack()).readFile('_backing_track.wav'));
 const session={loaded:true,title:'Streamed project',kind:'custom',mode:'edit',videoUrl:'video.mp4',externalOriginalUrl:'source.wav',trackOrder:['Role'],lines:[{id:1,character:'Role',caption:'frozen',start:1,end:2}],videoHasAudio:true,audioTracks:[]};
 return {dir,session,resolve:url=>path.join(dir,url)};
}
function padded(file,size){const fd=fs.openSync(file,'r+');try{const before=fs.fstatSync(fd).size,header=Buffer.alloc(4);fs.readSync(fd,header,0,4,0);fs.ftruncateSync(fd,size);if(header.toString()==='RIFF'){header.writeUInt32LE(size-8);fs.writeSync(fd,header,0,4,4);const junk=Buffer.alloc(8);junk.write('JUNK');junk.writeUInt32LE((size-before-8)&~1,4);fs.writeSync(fd,junk,0,8,before);}}finally{fs.closeSync(fd);}}
function alteredArchive(f,change){const snapshot=captureProject(f.session,f.resolve);change(snapshot);const zip=new AdmZip();zip.addFile('project.json',Buffer.from(JSON.stringify(snapshot.manifest)));for(const [name,bytes]of snapshot.files)zip.addFile(name,bytes);return zip.toBuffer();}
async function multipart(url,fields,name,file){
 const boundary='dubline-'+crypto.randomUUID();let prefix='';for(const [key,value]of Object.entries(fields))prefix+='--'+boundary+'\r\nContent-Disposition: form-data; name="'+key+'"\r\n\r\n'+value+'\r\n';
 prefix+='--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"; filename="'+path.basename(file)+'"\r\nContent-Type: application/octet-stream\r\n\r\n';
 const first=Buffer.from(prefix),last=Buffer.from('\r\n--'+boundary+'--\r\n');
 const body=Readable.from((async function*(){yield first;yield*fs.createReadStream(file);yield last;})());
 return fetch(url,{method:'POST',duplex:'half',body,headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':first.length+fs.statSync(file).size+last.length}});
}
test('disk-backed archive above 384 MiB keeps an immutable snapshot and uses bounded memory',{timeout:90000},async t=>{
 const f=fixture(t);padded(f.resolve('source.wav'),400*1024*1024+17);const expected=hashFileSync(f.resolve('source.wav'));
 const baseline=process.memoryUsage().rss;let peak=baseline;const meter=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),10);let saved,staged;
 try{
  const saving=exportProjectDisk(f.session,f.resolve,{folder:f.dir});f.session.lines[0].caption='replacement';fs.writeFileSync(f.resolve('source.wav'),'replacement');
  saved=await saving;assert.ok(saved.bytes>384*1024*1024);
  staged=await stageProjectDisk(saved.path,f.dir);assert.equal(staged.fields.lines[0].caption,'frozen');
  const original=staged.mediaFiles.find(file=>file.path.endsWith('.wav'));assert.equal(fs.statSync(original.path).size,400*1024*1024+17);assert.equal(hashFileSync(original.path),expected);
  peak=Math.max(peak,process.memoryUsage().rss);assert.ok(peak-baseline<256*1024*1024,'Peak RSS delta '+(peak-baseline));
  console.log('400 MiB round-trip; observed peak RSS delta: '+Math.round((peak-baseline)/1024/1024)+' MiB');
 }finally{clearInterval(meter);staged?.rollback();await saved?.cleanup();}
 assert.equal(fs.readdirSync(f.dir).some(name=>name.startsWith('.project-')),false);
});
test('ZIP64 version-1 projects open through the production disk reader',async t=>{
 const f=fixture(t);const saved=await exportProjectDisk(f.session,f.resolve,{folder:f.dir,forceZip64:true});let staged;
 try{assert.ok(fs.readFileSync(saved.path).includes(Buffer.from([0x50,0x4b,0x06,0x06])));staged=await stageProjectDisk(saved.path,f.dir);assert.equal(staged.fields.title,f.session.title);}finally{staged?.rollback();await saved.cleanup();}
});
for(const [name,change]of [
 ['hash mismatch',snapshot=>snapshot.manifest.assets[0].sha256='0'.repeat(64)],
 ['size mismatch',snapshot=>snapshot.manifest.assets[1].size++],
 ['unexpected file',snapshot=>snapshot.files.set('media/extra.wav',Buffer.from('extra'))],
 ['unsafe path',snapshot=>snapshot.files.set('../escape.wav',Buffer.from('extra'))],
 ['oversized video',snapshot=>snapshot.manifest.assets[0].size=300*1024*1024+1]
])test('production disk reader rejects '+name+' and removes all staging',async t=>{
 const f=fixture(t),file=path.join(f.dir,'bad.dubline');fs.writeFileSync(file,alteredArchive(f,change));
 await assert.rejects(stageProjectDisk(file,f.dir),error=>[400,413].includes(error.status));assert.equal(fs.readdirSync(f.dir).some(name=>name.startsWith('.project-')),false);assert.ok(fs.existsSync(f.resolve('video.mp4')));
});
test('production disk reader verifies manifest CRC independently of asset hashes',async t=>{
 const f=fixture(t),file=path.join(f.dir,'crc.dubline'),bytes=alteredArchive(f,()=>{});
 let offset=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));assert.ok(offset>=0);bytes[offset+16]^=1;fs.writeFileSync(file,bytes);
 await assert.rejects(stageProjectDisk(file,f.dir),error=>error.status===400);
});

test('production ZIP reader rejects actual unsafe names, duplicates and symlinks',async t=>{
 const f=fixture(t),valid=alteredArchive(f,()=>{}),file=path.join(f.dir,'unsafe.dubline');
 for(const name of ['../escape.wav','/absolute.wav','C:/escape.wav','media\\escape.wav','media/%2e%2e.wav']){
  const zip=new AdmZip(valid);zip.addFile('bad-entry.wav',Buffer.from('bad'));zip.getEntry('bad-entry.wav').entryName=name;fs.writeFileSync(file,zip.toBuffer());await assert.rejects(stageProjectDisk(file,f.dir),error=>error.status===400);
 }
 const link=new AdmZip(valid);link.getEntry('project.json').header.attr=(0xa000<<16)>>>0;fs.writeFileSync(file,link.toBuffer());await assert.rejects(stageProjectDisk(file,f.dir),error=>error.status===400);
 const zip=new AdmZip(valid);zip.addFile('otherxx.json',Buffer.from('{}'));const duplicate=zip.toBuffer();let at=duplicate.indexOf(Buffer.from('otherxx.json'));while(at>=0){Buffer.from('project.json').copy(duplicate,at);at=duplicate.indexOf(Buffer.from('otherxx.json'),at+1);}fs.writeFileSync(file,duplicate);await assert.rejects(stageProjectDisk(file,f.dir),error=>error.status===400);
 assert.equal(fs.readdirSync(f.dir).some(name=>name.startsWith('.project-')),false);
});

test('abort and insufficient disk space release export snapshots',async t=>{
 const f=fixture(t),abort=new AbortController(),saving=exportProjectDisk(f.session,f.resolve,{folder:f.dir,signal:abort.signal});abort.abort();await assert.rejects(saving,error=>error.name==='AbortError');
 const statfs=fs.statfsSync;try{fs.statfsSync=()=>({bavail:0,bsize:4096});await assert.rejects(exportProjectDisk(f.session,f.resolve,{folder:f.dir}),error=>error.status===507);}finally{fs.statfsSync=statfs;}
 assert.equal(fs.readdirSync(f.dir).some(name=>name.startsWith('.project-')),false);
});
test('disk import rechecks authorization before publishing any files',async t=>{
 const f=fixture(t),saved=await exportProjectDisk(f.session,f.resolve,{folder:f.dir});let calls=0;
 try{await assert.rejects(stageProjectDisk(saved.path,f.dir,{authorize:()=>++calls<3}),error=>error.status===409);}finally{await saved.cleanup();}
 assert.equal(fs.readdirSync(f.dir).some(name=>name.startsWith('.project-')),false);
});
test('large HTTP/native file imports, protected streamed download, video-only budget and cleanup',{timeout:180000},async t=>{
 const f=fixture(t);padded(f.resolve('source.wav'),400*1024*1024+17);const saved=await exportProjectDisk(f.session,f.resolve,{folder:f.dir});t.after(()=>saved.cleanup());
 const server=await startServer();t.after(()=>server.cleanup());const clientId=crypto.randomUUID(),room='large',socket=io('http://localhost:'+server.port,{transports:['websocket']});t.after(()=>socket.disconnect());
 await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});socket.emit('join_room',{room,nick:'Host',clientId});let current;
 socket.on('session_updated',state=>{current=state;});await waitUntil(()=>current?.host==='Host');console.log('Large HTTP: host joined');
 const endpoint=route=>'http://localhost:'+server.port+'/api/'+route+'?room='+room;
 const opened=await multipart(endpoint('import-project'),{clientId,sessionId:current.activeSessionId||''},'project',saved.path);assert.equal(opened.status,200,await opened.clone().text());console.log("Large HTTP: archive uploaded");const state=(await opened.json()).session;assert.equal(state.title,f.session.title);
 await waitUntil(()=>!fs.readdirSync(server.dirs.data).some(name=>name.startsWith('.incoming-')));
 // The same native IPC file path supports an archive above the old ceiling without a Buffer.
 const native=await new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>reject(Error('Native import timeout')),30000);const listener=message=>{if(message.requestId===id){clearTimeout(timer);server.proc.off('message',listener);resolve(message);}};server.proc.on('message',listener);server.proc.send({type:'open-project-file',requestId:id,path:saved.path});});assert.equal(native.ok,true,native.error);console.log("Large HTTP: native path imported");
 const snapshot=()=>new Promise((resolve,reject)=>socket.timeout(5000).emit('snapshot_request',{purpose:'project',sessionId:current.activeSessionId},(error,result)=>error?reject(error):resolve({barrierToken:result.token,forceSnapshot:true})));
 const response=await fetch(endpoint('export-project'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,clientId,sessionId:current.activeSessionId,download:true,...await snapshot()})});assert.equal(response.status,200,await response.clone().text());console.log("Large HTTP: download prepared");const prepared=await response.json();assert.ok(prepared.bytes>384*1024*1024);
 const url='http://localhost:'+server.port+prepared.downloadUrl;
 assert.equal((await fetch(url,{headers:{Cookie:'dubline_client=wrong'}})).status,403);
 const download=await fetch(url,{headers:{Cookie:'dubline_client='+clientId}});assert.equal(download.status,200);const downloaded=path.join(f.dir,'downloaded.dubline');await pipeline(Readable.fromWeb(download.body),fs.createWriteStream(downloaded));assert.equal(fs.statSync(downloaded).size,prepared.bytes);console.log("Large HTTP: download completed");
 assert.equal((await fetch(url,{headers:{Cookie:'dubline_client='+clientId}})).status,404);await waitUntil(()=>!fs.readdirSync(server.dirs.data).some(name=>name.startsWith('.project-export-')));
 // A cancelled browser download releases the prepared archive and its export slot.
 const again=await fetch(endpoint('export-project'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,clientId,sessionId:current.activeSessionId,download:true,...await snapshot()})});assert.equal(again.status,200);const abortUrl='http://localhost:'+server.port+(await again.json()).downloadUrl;
 const abort=new AbortController();const pending=await fetch(abortUrl,{signal:abort.signal,headers:{Cookie:'dubline_client='+clientId}});assert.equal(pending.status,200);abort.abort();await waitUntil(()=>!fs.readdirSync(server.dirs.data).some(name=>name.startsWith('.project-export-')));
 // Separate 400 MiB audio is accepted alongside a small video.
 const boundary='multi-'+crypto.randomUUID(),header=name=>'--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"\r\n\r\n';
 const parts=[Buffer.from(header('clientId')+clientId+'\r\n'),Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="video"; filename="video.mp4"\r\n\r\n'),f.resolve('video.mp4'),Buffer.from('\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="original"; filename="source.wav"\r\n\r\n'),f.resolve('source.wav'),Buffer.from('\r\n--'+boundary+'--\r\n')];
 const length=parts.reduce((sum,part)=>sum+(Buffer.isBuffer(part)?part.length:fs.statSync(part).size),0),body=Readable.from((async function*(){for(const part of parts){if(Buffer.isBuffer(part))yield part;else yield*fs.createReadStream(part);}})());
 const custom=await fetch(endpoint('upload-custom'),{method:'POST',duplex:'half',body,headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':length}});assert.equal(custom.status,200,await custom.clone().text());console.log("Large HTTP: separate audio imported");
 await waitUntil(()=>!fs.readdirSync(server.dirs.data).some(name=>name.startsWith('.incoming-')));const before=current.activeSessionId;
 padded(f.resolve('video.mp4'),300*1024*1024+1);const tooBig=await multipart(endpoint('upload-custom'),{clientId},'video',f.resolve('video.mp4'));assert.equal(tooBig.status,413);assert.equal((await tooBig.json()).key,'error.videoTooBig');assert.equal(current.activeSessionId,before);
 await waitUntil(()=>!fs.readdirSync(server.dirs.data).some(name=>name.startsWith('.incoming-')));
});
