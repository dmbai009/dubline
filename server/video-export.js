// Original-quality export: upload only the rendered soundtrack, copy source video on disk.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {app} = require('./app');
const {DATA_DIR, HttpError} = require('./config');
const {getRoom} = require('./rooms');
const {isHost} = require('./auth');
const {resolveRoomId, clientIdFromCookie} = require('./desktop');
const {diskPathForUrl} = require('./files');
const {diskUpload} = require('./project-uploads');
const {runFfmpeg, probeAudioDuration} = require('./media');
const {checkSpace} = require('./video-proxy');
const jobs = new Set(), downloads = new Map();
const errorResponse = (res,error) => {if (!res.destroyed && !res.headersSent) res.status(error.status || 500).json({error:error.message,key:error.key || 'error.processingFailed',params:error.params || {}});};
app.post('/api/export-original-video', diskUpload(['soundtrack'],req => {
  if (!isHost(getRoom(resolveRoomId(req.query.room)),req.body.clientId)) throw new HttpError(403,'Only the host can export the original','render.originalHost');
}), async(req,res) => {
  let temp, transferred = false, ownsSlot = false, roomId;
  try {
    roomId=resolveRoomId(req.query.room);const room=getRoom(roomId);
    if (!isHost(room,req.body.clientId)) throw new HttpError(403,'Host rights changed','onlyHost');
    if (req.body.sessionId !== room.activeSessionId) throw new HttpError(409,'The scene changed','error.importSceneChanged');
    if (!req.file || !room.originalVideoUrl) throw new HttpError(400,'Original video is unavailable','proxy.originalMissing');
    if (jobs.has(roomId) || jobs.size >= 2) throw new HttpError(409,'Export is already running','project.busy');
    jobs.add(roomId);ownsSlot=true;
    const source=diskPathForUrl(room.originalVideoUrl);
    if(!source || !fs.existsSync(source)) throw new HttpError(404,'Original video is unavailable','proxy.originalMissing');
    const size=fs.statSync(source).size;
    checkSpace(DATA_DIR,size * 2 + req.file.size + 1024 * 1024);
    temp=fs.mkdtempSync(path.join(DATA_DIR,'.video-export-'));
    const ext=path.extname(source).toLowerCase()==='.mkv'?'.mkv':'.mp4';
    const input=path.join(temp,'source'+ext), output=path.join(temp,'result'+ext);
    fs.copyFileSync(source,input);
    const duration=probeAudioDuration(input), soundDuration=probeAudioDuration(req.file.path);
    if (!duration || !soundDuration || Math.abs(duration-soundDuration)>0.25) throw new HttpError(400,'Soundtrack duration differs from source','proxy.timing');
    await runFfmpeg(['-copyts','-start_at_zero','-i',input,'-i',req.file.path,'-map','0:v:0','-map','1:a:0','-c:v','copy',
      '-c:a','aac','-b:a','192k','-af','apad','-t',String(duration),...(ext==='.mp4'?['-movflags','+faststart']:[]),output],
      'Could not export original video',{signal:req.uploadAbort.signal,timeoutMs:2*60*60*1000});
    if (res.destroyed || req.body.sessionId !== room.activeSessionId || !isHost(room,req.body.clientId)) throw new HttpError(409,'The scene changed','error.importSceneChanged');
    fs.rmSync(input,{force:true});
    const ticket=crypto.randomUUID(), folder=temp;
    const release=async()=>{downloads.delete(ticket);jobs.delete(roomId);await fs.promises.rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});};
    const timer=setTimeout(()=>{void release().catch(console.error);},5*60*1000);timer.unref();
    const filename='Dubline_'+String(room.title || 'scene').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)+'_export'+ext;
    downloads.set(ticket,{roomId,clientId:req.body.clientId,output,filename,bytes:fs.statSync(output).size,ext,timer,release});
    transferred=true;
    res.json({downloadUrl:'/api/download-original-video?ticket='+ticket,filename});
  } catch(error) {errorResponse(res,['ENOSPC','EDQUOT'].includes(error.code)?new HttpError(507,'Not enough disk space','project.diskSpace'):error);}
  finally {if(!transferred){if(temp)await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});if(ownsSlot)jobs.delete(roomId);}}
});
app.get('/api/download-original-video',async(req,res)=>{
  const job=downloads.get(req.query.ticket);
  if(!job)return errorResponse(res,new HttpError(404,'Download expired','project.downloadExpired'));
  if(clientIdFromCookie(req.headers.cookie)!==job.clientId || !isHost(getRoom(job.roomId),job.clientId)) return errorResponse(res,new HttpError(403,'Only the host can download','onlyHost'));
  downloads.delete(req.query.ticket);clearTimeout(job.timer);
  try {
    res.setHeader('Content-Type',job.ext==='.mkv'?'video/x-matroska':'video/mp4');
    res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(job.filename));
    res.setHeader('Content-Length',job.bytes);
    await pipeline(fs.createReadStream(job.output),res);
  } catch(error) {errorResponse(res,error);}
  finally {await job.release();}
});
