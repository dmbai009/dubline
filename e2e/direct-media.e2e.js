const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs=require('node:fs'), crypto=require('node:crypto');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, buildFixturePack } = require('./helpers');

describe('verified Voxalike direct media with safe fallback', { skip:skipReason, timeout:30000 },()=>{
  let server,browser,host,guest;
  before(async()=>{server=await startServer();browser=await launchBrowser(server.port);host=await openPlayer(browser,server.url('direct'),'Host');await loadFixture(host);guest=await openPlayer(browser,server.url('direct','127.0.0.2'),'Guest');await waitFor(guest,()=>localMedia?.videoBlob);});
  after(async()=>{await browser?.close();await server?.cleanup();});
  for(const fault of ['success','CORS','changed archive','wrong asset','timeout','cancel']) test(fault + ': exact source verification and fallback preserve current scene',async()=>{
    const pack=fs.readFileSync(buildFixturePack());
    const descriptor={downloadUrl:'https://voxalike.com/workshop/test-scene/download',archiveSize:pack.length,archiveHash:crypto.createHash('sha256').update(pack).digest('hex'),videoEntry:'dub_video.mp4',backingEntry:'_backing_track.wav'};
    const result=await guest.evaluate(async ({encoded,descriptor,fault})=>{
      const before=session.videoUrl; session.workshopSource=descriptor;
      if(fault==='wrong asset') session.workshopSource.videoEntry='missing.mp4';
      const nativeFetch=window.fetch, nativeTimeout=AbortSignal.timeout;
      window.directCalls=0; window.hostMediaCalls=0;
      AbortSignal.timeout=ms=>nativeTimeout(ms===15000 ? 10 : ms);
      window.fetch=async (url,options)=>{
        if(String(url).startsWith('https://voxalike.com/')) {
          directCalls++;
          if(fault==='CORS') throw new TypeError('CORS blocked');
          if(fault==='timeout') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')),{once:true}));
          const data=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)); if(fault==='changed archive') data[data.length-1]^=1;
          if(fault==='cancel') { cancelMediaDownload(); throw new DOMException('cancelled','AbortError'); }
          return new Response(data,{status:200});
        }
        if(String(url)===before) hostMediaCalls++;
        return nativeFetch(url,options);
      };
      try {
        await DublineLocalDatabase.clearMedia();
        revokeLocalMedia(); await loadSceneMedia();
        const media=localMedia?.videoBlob;
        return { directCalls, hostMediaCalls, same:session.videoUrl===before, hash:media ? await sha256Hex(media) : null, expected:session.videoHash, source:localMedia?.source, cancelled:!mediaDownload };
      } finally {window.fetch=nativeFetch;AbortSignal.timeout=nativeTimeout;delete session.workshopSource;}
    },{encoded:pack.toString('base64'),descriptor,fault});
    assert.equal(result.same,true);assert.equal(result.cancelled,true);
    if(fault==='success'){assert.equal(result.directCalls,1);assert.equal(result.hostMediaCalls,0);assert.equal(result.hash,result.expected);}
    else if(fault==='cancel'){assert.equal(result.hostMediaCalls,0);}
    else {assert.equal(result.hash,result.expected);assert.ok(result.hostMediaCalls>0 || result.source==='p2p');}
  });
});
