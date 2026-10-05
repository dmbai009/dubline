// Disk-backed production ZIP IO. The version-1 manifest remains unchanged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Transform,Writable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const yauzl=require('yauzl'),yazl=require('yazl');
const {UPLOAD_DIR,DATA_DIR,HttpError}=require('./config');
const {captureProject,validateManifest,safeArchivePath,stageProjectFiles,MAX_MANIFEST_BYTES,MAX_ENTRIES}=require('./projects');
const invalid=message=>new HttpError(400,message,'project.invalid');
const diskError=error=>['ENOSPC','EDQUOT'].includes(error.code)?new HttpError(507,'Not enough free disk space','project.diskSpace'):error;
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crcFallback(bytes,previous=0){let crc=previous^0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
const crc32=require('node:zlib').crc32||crcFallback;
function requireSpace(folder,bytes){
  if(!Number.isSafeInteger(bytes)||bytes<0)throw invalid('Invalid total project size');
  const stat=fs.statfsSync(folder);
  if(bytes>Number(stat.bavail)*Number(stat.bsize))throw new HttpError(507,'Not enough free disk space','project.diskSpace');
}
const remove=folder=>fs.promises.rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});
function checkRequest(signal,authorize){
  signal?.throwIfAborted();
  if(authorize&&!authorize())throw new HttpError(409,'The scene changed','error.importSceneChanged');
}
async function exportProjectDisk(session,resolveAsset,{folder=DATA_DIR,signal,forceZip64=false}={}){
  const dir=fs.mkdtempSync(path.join(folder,'.project-export-'));
  const streams=new Set();
  try{
    checkRequest(signal);
    // This synchronous immutable copy also freezes take deletion/replacement before the first await.
    const snapshot=captureProject(session,resolveAsset,dir);
    requireSpace(folder,snapshot.totalBytes+MAX_MANIFEST_BYTES);
    const zip=new yazl.ZipFile(),archive=path.join(dir,'project.dubline');
    zip.on('error',error=>zip.outputStream.destroy(error));
    zip.addBuffer(snapshot.manifestBytes,'project.json',{compress:false});
    for(const asset of snapshot.manifest.assets){
      zip.addReadStreamLazy(asset.path,{compress:false,size:asset.size},callback=>{
        const input=fs.createReadStream(snapshot.files.get(asset.path));
        streams.add(input);input.once('close',()=>streams.delete(input));callback(null,input);
      });
    }
    zip.end({forceZip64Format:forceZip64});
    await pipeline(zip.outputStream,fs.createWriteStream(archive,{flags:'wx'}),{signal});
    return {path:archive,title:snapshot.manifest.project.title,bytes:fs.statSync(archive).size,cleanup:()=>remove(dir)};
  }catch(error){
    for(const stream of streams)stream.destroy();
    await remove(dir);throw diskError(error);
  }
}
function openZip(file){return new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true,autoClose:false,strictFileNames:true,validateEntrySizes:true},(error,zip)=>error?reject(error):resolve(zip)));}
function nextEntry(zip){return new Promise((resolve,reject)=>{
  const clean=()=>{zip.off('entry',entry);zip.off('end',end);zip.off('error',error);};
  const entry=value=>{clean();resolve(value);},end=()=>{clean();resolve(null);},error=err=>{clean();reject(err);};
  zip.once('entry',entry);zip.once('end',end);zip.once('error',error);zip.readEntry();
});}
function openEntry(zip,entry){return new Promise((resolve,reject)=>zip.openReadStream(entry,(error,input)=>error?reject(error):resolve(input)));}
async function readEntry(zip,entry,destination,{limit=entry.uncompressedSize,sha256,signal}={}){
  const input=await openEntry(zip,entry);let size=0,crc=0;const hash=crypto.createHash('sha256');
  const check=new Transform({transform(chunk,encoding,done){
    size+=chunk.length;if(size>limit)return done(invalid('Project entry exceeds declared size'));
    crc=crc32(chunk,crc);hash.update(chunk);done(null,chunk);
  },flush(done){
    if(size!==entry.uncompressedSize||crc!==entry.crc32||sha256&&hash.digest('hex')!==sha256)return done(invalid('Damaged project entry'));
    done();
  }});
  const fatal=error=>input.destroy(error);zip.on('error',fatal);
  try{await pipeline(input,check,destination,{signal});}finally{zip.off('error',fatal);}
}
async function stageProjectDisk(file,uploadDir=UPLOAD_DIR,{signal,authorize}={}){
  let zip,dir;let fatal;
  try{
    checkRequest(signal,authorize);zip=await openZip(file);zip.on('error',error=>{fatal=error;});
    const entries=new Map();let total=0;
    for(;;){
      checkRequest(signal,authorize);if(fatal)throw fatal;
      const entry=await nextEntry(zip);if(!entry)break;
      const name=entry.fileName,isDir=name.endsWith('/'),mode=(entry.externalFileAttributes>>>16)&0xf000;
      if(!safeArchivePath(isDir?name.slice(0,-1):name)||entries.has(name)||entries.size>=MAX_ENTRIES||
        mode&&mode!==0x8000&&mode!==0x4000||isDir&&entry.uncompressedSize||entry.generalPurposeBitFlag&1)throw invalid('Unsafe project archive entry');
      total+=entry.uncompressedSize;if(!Number.isSafeInteger(total))throw invalid('Invalid project size');
      entries.set(name,entry);
    }
    const manifestEntry=entries.get('project.json');
    if(!manifestEntry||manifestEntry.fileName.endsWith('/')||manifestEntry.uncompressedSize>MAX_MANIFEST_BYTES)throw invalid('Missing or oversized project manifest');
    const chunks=[];
    await readEntry(zip,manifestEntry,new Writable({write(chunk,encoding,done){chunks.push(chunk);done();}}),{limit:MAX_MANIFEST_BYTES,signal});
    const manifest=validateManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const declared=new Set(['project.json',...manifest.assets.map(asset=>asset.path)]);
    for(const entry of entries.values())if(!entry.fileName.endsWith('/')&&!declared.has(entry.fileName))throw invalid('Unexpected project file');
    for(const asset of manifest.assets){const entry=entries.get(asset.path);if(!entry||entry.fileName.endsWith('/')||entry.uncompressedSize!==asset.size)throw invalid('Missing or inconsistent project asset');}
    requireSpace(uploadDir,total);dir=fs.mkdtempSync(path.join(uploadDir,'.project-reading-'));
    const files=new Map();
    for(const asset of manifest.assets){
      checkRequest(signal,authorize);if(fatal)throw fatal;
      const target=path.join(dir,'checked_'+files.size);
      await readEntry(zip,entries.get(asset.path),fs.createWriteStream(target,{flags:'wx'}),{sha256:asset.sha256,signal});
      files.set(asset.path,target);
    }
    checkRequest(signal,authorize);if(fatal)throw fatal;
    return stageProjectFiles({manifest,files},uploadDir,true);
  }catch(error){
    if(error instanceof HttpError||error.name==='AbortError')throw error;
    if(['ENOSPC','EDQUOT'].includes(error.code))throw diskError(error);
    throw invalid('Damaged project archive');
  }finally{zip?.close();if(dir)await remove(dir);}
}
module.exports={exportProjectDisk,stageProjectDisk};
