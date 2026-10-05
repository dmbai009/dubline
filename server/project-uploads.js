// Multipart project/custom media uploads go straight to private temporary files.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Transform}=require('node:stream');const {pipeline}=require('node:stream/promises');const multer=require('multer');
const {DATA_DIR,MAX_VIDEO_MB,MAX_SUBTITLE_MB,HttpError}=require('./config');
function diskUpload(fields,authorize){
  const storage={
    _handleFile(req,file,callback){
      let target;
      try{
        req.uploadDirectory ||= fs.mkdtempSync(path.join(DATA_DIR,'.incoming-'));
        target=path.join(req.uploadDirectory,crypto.randomUUID());
      }catch(error){return callback(error);}
      let size=0;
      const max=file.fieldname==='video'&&req.query.optimize!=='1'?MAX_VIDEO_MB*1024*1024:file.fieldname==='subtitles'?MAX_SUBTITLE_MB*1024*1024:Infinity;
      const limit=new Transform({transform(chunk,encoding,done){
        size+=chunk.length;
        if(size>max)return done(new HttpError(413,'Uploaded file exceeds its limit',file.fieldname==='video'?'error.videoTooBig':'error.subtitlesTooBig',{max:file.fieldname==='video'?MAX_VIDEO_MB:MAX_SUBTITLE_MB}));
        done(null,chunk);
      }});
      pipeline(file.stream,limit,fs.createWriteStream(target,{flags:'wx'}),{signal:req.uploadAbort.signal})
        .then(()=>callback(null,{path:target,size}),error=>callback(error));
    },
    _removeFile(req,file,callback){fs.unlink(file.path,error=>callback(error?.code==='ENOENT'?null:error));}
  };
  const handler=multer({storage,limits:{files:fields.length,fields:8,fieldSize:4096},fileFilter(req,file,callback){
    try{authorize(req);callback(null,true);}catch(error){callback(error);}
  }}).fields(fields.map(name=>({name,maxCount:1})));
  return (req,res,next)=>{
    req.uploadAbort=new AbortController();let cleanup;
    const remove=()=>{
      if(cleanup)return cleanup;
      if(!req.uploadDirectory)return Promise.resolve();
      cleanup=fs.promises.rm(req.uploadDirectory,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(error=>console.error('[Dubline] Temporary upload cleanup:',error.message));
      return cleanup;
    };
    req.once('aborted',()=>req.uploadAbort.abort());
    res.once('close',()=>{if(!res.writableFinished)req.uploadAbort.abort();void remove();});
    res.once('finish',()=>{void remove();});
    handler(req,res,error=>{
      if(!error){if(fields.length===1)req.file=req.files?.[fields[0]]?.[0];return next();}
      void remove().then(()=>{
        if(res.destroyed)return;
        const resource=['ENOSPC','EDQUOT'].includes(error.code);
        const status=error instanceof HttpError?error.status:resource?507:400;
        res.status(status).json({error:error.message,key:error.key||(resource?'project.diskSpace':'error.uploadFailed'),params:error.params||{message:error.message}});
      });
    });
  };
}
module.exports={diskUpload};
