// Original-quality export: upload only the rendered soundtrack, copy source video on disk.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {app, io} = require('./app');
const {DATA_DIR, HttpError} = require('./config');
const {getRoom} = require('./rooms');
const {isHost} = require('./auth');
const {resolveRoomId, clientIdFromCookie} = require('./desktop');
const {diskPathForUrl} = require('./files');
const {diskUpload} = require('./project-uploads');
const {runFfmpeg, probeAudioDuration} = require('./media');
const {checkSpace} = require('./video-proxy');
const jobs = new Set(), downloads = new Map(), operations = new Map();
function confirmedHost(roomId, identity) {
  const { rooms, roomSockets } = require('./state'), room = rooms[roomId];
  return !!room && isHost(room, identity) && !room.banned?.includes(identity) && Object.values(roomSockets[roomId] || {}).some(member => member.clientId === identity && member.nick);
}
require('./video-export-lease');
app.get('/api/video-export-info', require('./desktop').mediaAccessGate, async (req, res) => {
  const roomId = resolveRoomId(req.query.room), { rooms, roomSockets } = require('./state'), room = rooms[roomId];
  const identity = clientIdFromCookie(req.headers.cookie);
  const admitted = () => identity === req.query.clientId && !room?.banned?.includes(identity) &&
    Object.values(roomSockets[roomId] || {}).some(member => member.clientId === identity && member.nick);
  if (!room || !admitted()) return res.status(403).json({ key: 'exportVideo.authorization' });
  const sceneId = room.activeSessionId, workingUrl = room.videoUrl, originalUrl = room.originalVideoUrl;
  if (!room.loaded || req.query.sessionId !== sceneId) return res.status(409).json({ key: 'render.sceneChanged' });
  const release = require('./files').retainTakeFiles([workingUrl, originalUrl]);
  try {
    const host = isHost(room, identity), inspect = require('./video-export-info').inspect;
    const working = await inspect(diskPathForUrl(workingUrl));
    let original = host && !originalUrl ? working : null, originalError = null;
    if (host && originalUrl) try { original = await inspect(diskPathForUrl(originalUrl)); } catch (error) { originalError = error.message === 'project.busy' || error.key === 'project.busy' ? 'project.busy' : 'exportVideo.sourceMissing'; }
    if (!admitted() || room.activeSessionId !== sceneId || room.videoUrl !== workingUrl || room.originalVideoUrl !== originalUrl || host !== isHost(room, identity)) return res.status(409).json({ key: 'render.sceneChanged' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sessionId: sceneId, working, original, originalError, originalSame: !originalUrl || originalUrl === workingUrl });
  } catch (error) { const busy = error.message === 'project.busy' || error.key === 'project.busy'; if (!res.destroyed) res.status(busy ? 429 : 404).json({ key: busy ? 'project.busy' : 'exportVideo.sourceMissing' }); }
  finally { release(); }
});
const errorResponse = (res,error) => {if (!res.destroyed && !res.headersSent) res.status(error.status || 500).json({key:error.key || 'error.processingFailed',params:error.params || {}});};
app.post('/api/export-original-video', diskUpload(['soundtrack'],req => {
  const roomId = resolveRoomId(req.query.room), room = require('./state').rooms[roomId];
  if (!room || clientIdFromCookie(req.headers.cookie) !== req.body.clientId || !confirmedHost(roomId,req.body.clientId)) throw new HttpError(403,'Only the host can export the original','render.originalHost');
  if (req.body.sessionId !== room.activeSessionId || req.body.videoUrl && req.body.videoUrl !== room.videoUrl) throw new HttpError(409,'Scene changed','render.sceneChanged');
  if (jobs.has(roomId) || jobs.size >= 2) throw new HttpError(409,'Export is already running','project.busy');
}), async(req,res) => {
  let temp, transferred = false, ownsSlot = false, roomId, releaseSource, sceneWatch;
  try {
    roomId=resolveRoomId(req.query.room);const room=getRoom(roomId);
    if (!confirmedHost(roomId,req.body.clientId)) throw new HttpError(403,'Host rights changed','onlyHost');
    if (req.body.progressId != null && (typeof req.body.progressId !== 'string' || !/^[\w-]{1,80}$/.test(req.body.progressId))) throw new HttpError(400,'Invalid progress identity','exportVideo.unsupported');
    if (req.body.sessionId !== room.activeSessionId) throw new HttpError(409,'The scene changed','error.importSceneChanged');
    if (req.body.videoUrl && req.body.videoUrl !== room.videoUrl) throw new HttpError(409,'The video changed','render.sceneChanged');
    const workingUrl = room.videoUrl;
    if (!req.file || !room.videoUrl) throw new HttpError(400,'Original video is unavailable','proxy.originalMissing');
    if (req.body.source && !['working', 'original'].includes(req.body.source)) throw new HttpError(400,'Invalid export source','exportVideo.sourceMissing');
    if (jobs.has(roomId) || jobs.size >= 2) throw new HttpError(409,'Export is already running','project.busy');
    jobs.add(roomId);ownsSlot=true;
    let settled; const done = new Promise(resolve => { settled = resolve; });
    operations.set(roomId, { abort: req.uploadAbort, done, settled });
    const sourceUrl = req.body.source === 'working' ? room.videoUrl : room.originalVideoUrl || room.videoUrl;
    releaseSource = require('./files').retainTakeFiles([sourceUrl]);
    const source=diskPathForUrl(sourceUrl);
    if(!source || !fs.existsSync(source)) throw new HttpError(404,'Original video is unavailable','proxy.originalMissing');
    const info = await require('./video-export-info').inspect(source);
    let options = null;
    if (req.body.options) {
      try { options = JSON.parse(req.body.options); } catch { throw new HttpError(400,'Invalid export parameters','exportVideo.unsupported'); }
      const reason = require('../public/video-export-policy').validate(info, options || {});
      if (reason) throw new HttpError(400,'Invalid export parameters',reason);
    }
    const size = require('../public/video-export-policy').estimate(info, options ? { ...options, mode: 'custom' } : {}) || fs.statSync(source).size;
    checkSpace(DATA_DIR,size + req.file.size + 1024 * 1024);
    temp=fs.mkdtempSync(path.join(DATA_DIR,'.video-export-'));
    const ext = options ? '.' + options.format : '.' + info.extension;
    const output=path.join(temp,'result'+ext);
    const duration=info.duration, soundDuration=probeAudioDuration(req.file.path);
    let backend = null, attempt = 0;
    const progress = (current, done = false) => {
      if (!req.body.progressId || req.body.sessionId !== room.activeSessionId || !confirmedHost(roomId, req.body.clientId)) return;
      for (const [socketId, member] of Object.entries(require('./state').roomSockets[roomId] || {})) if (member.clientId === req.body.clientId && member.nick) {
        io.to(socketId).emit('video_export_progress', { progressId: req.body.progressId, sessionId: req.body.sessionId, current: Math.max(0, Math.min(duration, current)), total: duration, done, ...(backend ? { backend, attempt } : {}) });
      }
    };
    if (!duration || !soundDuration || Math.abs(duration-soundDuration)>0.25) throw new HttpError(400,'Soundtrack duration differs from source','proxy.timing');
    const hardware = require('./video-acceleration');
    const videoArgs = encoder => options ? ['-vf',`scale=${options.width}:${options.height},setsar=1`,
      ...(options.codec === 'avc' ? encoder === 'libx264' ? ['-c:v','libx264','-preset','medium','-pix_fmt','yuv420p'] : hardware.encoderArgs(encoder) : ['-c:v','libvpx-vp9','-deadline','good','-cpu-used','2']), '-b:v',String(options.bitrate),
      ...(options.fps == null ? ['-fps_mode','passthrough'] : ['-r',String(options.fps)])] : ['-c:v','copy'];
    sceneWatch = setInterval(() => { if (req.body.sessionId !== room.activeSessionId || room.videoUrl !== workingUrl || sourceUrl !== (req.body.source === 'working' ? room.videoUrl : room.originalVideoUrl || room.videoUrl) || !confirmedHost(roomId,req.body.clientId)) req.uploadAbort.abort(); }, 250);
    let audioCodec;
    const mb = await import('mediabunny'), soundtrack = new mb.Input({ source: new mb.FilePathSource(req.file.path), formats: mb.ALL_FORMATS });
    try { audioCodec = await (await soundtrack.getPrimaryAudioTrack())?.getCodec(); } catch { /* FFmpeg also accepts legacy inputs outside the demuxer's codec set. */ } finally { soundtrack.dispose(); }
    const targetAudio = ext === '.webm' ? 'opus' : 'aac';
    req.uploadAbort.signal.throwIfAborted();
    const encode = encoder => runFfmpeg(['-copyts','-start_at_zero','-i',source,'-i',req.file.path,'-map','0:v:0','-map','1:a:0', ...videoArgs(encoder),
      ...(audioCodec === targetAudio ? ['-c:a','copy'] : ['-c:a',targetAudio === 'opus' ? 'libopus' : 'aac','-b:a','192k','-af','apad']),'-t',String(duration),...(ext==='.mp4'?['-movflags','+faststart']:[]),output],
      'Could not export original video',{signal:req.uploadAbort.signal,timeoutMs:2*60*60*1000,onProgress: time => progress(time)});
    if (options?.codec === 'avc') await hardware.run({ mode: req.body.acceleration, info: { ...info, ...options }, signal: req.uploadAbort.signal,
      onBackend: (encoder, fallback) => { attempt++; backend = fallback ? 'cpu-fallback' : encoder === 'libx264' ? 'cpu' : 'gpu'; progress(0); }
    }, encode);
    else await encode('libx264');
    if (res.destroyed || req.body.sessionId !== room.activeSessionId || room.videoUrl !== workingUrl || sourceUrl !== (req.body.source === 'working' ? room.videoUrl : room.originalVideoUrl || room.videoUrl) || !confirmedHost(roomId,req.body.clientId)) throw new HttpError(409,'The scene changed','error.importSceneChanged');
    const ticket=crypto.randomUUID(), folder=temp;
    let cleanup;
    const release=()=>cleanup ||= (async()=>{downloads.delete(ticket);jobs.delete(roomId);await fs.promises.rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});})();
    const timer=setTimeout(()=>{void release().catch(console.error);},5*60*1000);timer.unref();
    const filename='Dubline_'+String(room.title || 'scene').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)+'_export'+ext;
    const bytes = fs.statSync(output).size;
    progress(duration, true);
    downloads.set(ticket,{roomId,sessionId: room.activeSessionId,videoUrl: workingUrl,clientId:req.body.clientId,output,filename,bytes,ext,timer,release});
    transferred=true;
    res.json({downloadUrl:'/api/download-original-video?ticket='+ticket,filename,bytes,ext:ext.slice(1)});
  } catch(error) {errorResponse(res,['ENOSPC','EDQUOT'].includes(error.code)?new HttpError(507,'Not enough disk space','project.diskSpace'):error);}
  finally {clearInterval(sceneWatch);releaseSource?.();if(!transferred){if(temp)await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});if(ownsSlot)jobs.delete(roomId);}if(ownsSlot){operations.get(roomId)?.settled();operations.delete(roomId);}}
});
app.get('/api/download-original-video',async(req,res)=>{
  const job=downloads.get(req.query.ticket);
  if(!job || job.consumed)return errorResponse(res,new HttpError(404,'Download expired','project.downloadExpired'));
  if(clientIdFromCookie(req.headers.cookie)!==job.clientId || !confirmedHost(job.roomId,job.clientId)) return errorResponse(res,new HttpError(403,'Only the host can download','onlyHost'));
  if (getRoom(job.roomId).activeSessionId !== job.sessionId || getRoom(job.roomId).videoUrl !== job.videoUrl) { clearTimeout(job.timer); await job.release(); return errorResponse(res,new HttpError(409,'Scene changed','render.sceneChanged')); }
  job.consumed=true;job.response=res;clearTimeout(job.timer);
  try {
    res.setHeader('Content-Type',job.ext==='.mkv'?'video/x-matroska':job.ext==='.webm'?'video/webm':'video/mp4');
    res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(job.filename));
    res.setHeader('Content-Length',job.bytes);
    await pipeline(fs.createReadStream(job.output),res);
  } catch(error) {errorResponse(res,error);}
  finally {await job.release();}
});
module.exports = {
  isBusy: () => jobs.size > 0,
  async close() {
    const pending = [...operations.values()]; pending.forEach(operation => operation.abort.abort());
    await Promise.allSettled(pending.map(operation => operation.done));
    await Promise.allSettled([...downloads.values()].map(job => { clearTimeout(job.timer); job.response?.destroy(); return job.release(); }));
    require('./video-export-lease').close();
  }
};
