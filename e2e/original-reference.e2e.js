const {describe,test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {skipReason,startServer,launchBrowser,openPlayer,loadFixture,waitFor,fixtureVideoPath}=require('./helpers');
describe('isolated original reference playback and compact inspector controls',{skip:skipReason,timeout:60000},()=>{
  let server,browser,host,guest;
  const monitor=page=>page.evaluate(()=>{
    const NativeAudio=window.Audio;window.referenceMedia=[];window.referenceStops=[];
    window.Audio=function(...args){const node=new NativeAudio(...args),pause=node.pause;node.pause=function(){if(!node.paused)referenceStops.push(node.currentTime);return pause.call(node);};referenceMedia.push(node);return node;};
    window.Audio.prototype=NativeAudio.prototype;Object.setPrototypeOf(window.Audio,NativeAudio);
  });
  before(async()=>{
    server=await startServer();browser=await launchBrowser(server.port);host=await openPlayer(browser,server.url('reference'),'Host',{autoConfirm:false});
    await loadFixture(host);
    await host.evaluate(async encoded=>{
      const form=new FormData();form.append('clientId',clientId);
      form.append('video',new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))]),'source.mp4');
      form.append('subtitles',new Blob(['1\n00:00:00,500 --> 00:00:00,800\n[Hero] Test\n\n2\n00:00:11,500 --> 00:00:12,000\n[Hero] End\n']),'scene.srt');
      const result=await fetch('/api/upload-custom?room='+currentRoom,{method:'POST',body:form});if(!result.ok)throw Error(await result.text());
    },fs.readFileSync(fixtureVideoPath()).toString('base64'));
    await waitFor(host,()=>session.kind==='custom'&&session.audioTracks?.length&&!session.audioTracksPending);
    guest=await openPlayer(browser,server.url('reference'),'Guest',{autoConfirm:false});await waitFor(guest,()=>session.loaded&&session.audioTracks?.length);
    for(const page of [host,guest])await monitor(page);
  });
  after(async()=>{await browser?.close();await server?.cleanup();});
  test('video+subtitles plays only the source at unity despite muted/soloed mix and stops at the padded end',async()=>{
    const before=await host.evaluate(()=>{
      selectLine(session.lines[0]);session.projectAudio={original:{muted:true,volume:0},backing:{muted:true,volume:0},dub:{solo:true,volume:0}};
      applyVolumes();window.referenceSnapshot=JSON.stringify(session.projectAudio);return referenceSnapshot;
    });
    assert.ok(await host.$('[data-original-preview]'));
    await host.evaluate(()=>previewOriginal(session.lines[0].id));
    await host.evaluate(()=>applyVolumes());
    const state=await host.evaluate(()=>({playing:!referenceMedia.at(-1).paused,volume:referenceMedia.at(-1).volume,rate:referenceMedia.at(-1).playbackRate,time:referenceMedia.at(-1).currentTime,source:referenceMedia.at(-1).getAttribute('src'),expected:mediaUrl(DublineProjectAudio.sources(session).original),others:[video,backing,originalTrackAudio].every(n=>n.paused),pressed:document.querySelector('[data-original-preview]').getAttribute('aria-pressed')}));
    assert.equal(state.playing,true);assert.equal(state.volume,1);assert.equal(state.rate,1);assert.ok(state.time<.5);assert.equal(state.source,state.expected);assert.equal(state.others,true);assert.equal(state.pressed,'true');
    await waitFor(host,()=>referenceMedia.at(-1).paused,4000);
    const end=await host.evaluate(()=>referenceStops.at(-1));assert.ok(end>=1.3&&end<1.5,String(end));
    assert.equal(await host.evaluate(()=>JSON.stringify(session.projectAudio)),before);
    assert.equal(await host.$eval('[data-original-preview]',n=>n.getAttribute('aria-pressed')),'false');
  });
  test('guest can audition; repeated clicks stop and master volume still applies',async()=>{
    await guest.evaluate(()=>{selectLine(session.lines[1]);const slider=document.getElementById('masterVolume');slider.value=50;slider.dispatchEvent(new Event('input',{bubbles:true}));});
    await guest.evaluate(()=>previewOriginal(session.lines[1].id));
    assert.equal(await guest.evaluate(()=>referenceMedia.at(-1).volume),.5);
    assert.ok(await guest.evaluate(()=>referenceMedia.at(-1).currentTime>=11));
    await guest.evaluate(()=>previewOriginal(session.lines[1].id));
    assert.equal(await guest.evaluate(()=>referenceMedia.at(-1).paused),true);
  });
  test('separate backing is never silently treated as speech; declined, approved and remembered choices are private',async()=>{
    await host.evaluate(()=>{audio.stopPreview();window.referenceScene={videoHasAudio:session.videoHasAudio,externalOriginalUrl:session.externalOriginalUrl,audioTracks:session.audioTracks,backingUrl:session.backingUrl};session.videoHasAudio=false;session.externalOriginalUrl='';session.backingUrl=session.audioTracks[0].url;selectLine(session.lines[0]);});
    const count=await host.evaluate(()=>referenceMedia.length);
    await host.click('[data-original-preview]');await waitFor(host,()=>textPrompt.open);await host.click('#textPromptCancel');
    assert.equal(await host.evaluate(()=>referenceMedia.length),count);
    await host.click('[data-original-preview]');await waitFor(host,()=>textPrompt.open);await host.click('#textPromptSave');await waitFor(host,()=>referenceMedia.length>0&&!referenceMedia.at(-1).paused);
    await host.evaluate(()=>audio.stopPreview());
    await host.evaluate(()=>previewOriginal(session.lines[0].id));assert.equal(await host.evaluate(()=>textPrompt.open),false);
    await host.evaluate(()=>{audio.stopPreview();Object.assign(session,referenceScene);showInspector(session.lines[0]);});
  });
  test('switching previews, scene identity and failed media cancel stale playback',async()=>{
    await host.evaluate(async()=>{await previewOriginal(session.lines[0].id);await previewOriginal(session.lines[1].id);});
    assert.equal(await host.evaluate(()=>referenceMedia.slice(0,-1).every(n=>n.paused)),true);
    await loadFixture(host);
    assert.equal(await host.evaluate(()=>referenceMedia.every(n=>n.paused)),true);
    const failed=await host.evaluate(()=>audio.previewReference({url:'/missing-reference.wav',from:0,to:1}).catch(()=>false));assert.equal(failed,false);
  });
  test('a cancelled metadata request cannot start after a newer reference',async()=>{
    let held;
    await host.setRequestInterception(true);
    const intercept=request=>{if(request.url().includes('held-reference.wav'))held=request;else request.continue();};
    host.on('request',intercept);
    try {
      await host.evaluate(()=>{window.pendingReference=audio.previewReference({url:'/held-reference.wav',from:0,to:1});});
      const until=Date.now()+3000;while(!held&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(held);
      await host.evaluate(()=>audio.stopPreview());assert.equal(await host.evaluate(()=>pendingReference),false);
      await held.abort();held=null;
      await host.evaluate(()=>audio.playAudio(session.lines[0].originalAudioUrl));
      assert.equal(await host.evaluate(()=>referenceMedia.slice(0,-1).every(n=>n.paused)),true);
      assert.equal(await host.evaluate(()=>referenceMedia.at(-1).paused),false);
      await host.evaluate(()=>audio.stopPreview());
    } finally {if(held)await held.abort();host.off('request',intercept);await host.setRequestInterception(false);}
  });
  test('Voxalike keeps the per-line reference and uses the same compact button height as video scenes',async()=>{
    await loadFixture(host);await waitFor(host,()=>session.audioTracks?.length&&!session.audioTracksPending);
    await host.evaluate(()=>{selectLine(session.lines[0]);});await host.click('[data-original-file]');await waitFor(host,()=>referenceMedia.length>0&&!referenceMedia.at(-1).paused);
    assert.equal(await host.evaluate(()=>referenceMedia.at(-1).getAttribute('src')),await host.evaluate(()=>mediaUrl(session.lines[0].originalAudioUrl)));
    const sizes=await host.$$eval('.insp-actions.primary button',nodes=>nodes.map(n=>n.getBoundingClientRect().height));assert.ok(sizes.length>1&&sizes.every(h=>h===28),JSON.stringify(sizes));
    await host.evaluate(()=>audio.stopPreview());
    assert.deepEqual(host.errors.filter(e=>!e.includes('404')&&!e.includes('ERR_ABORTED')),[]);assert.deepEqual(guest.errors,[]);
  });
});
