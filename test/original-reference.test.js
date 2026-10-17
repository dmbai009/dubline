const {test}=require('node:test'),assert=require('node:assert/strict');
const audio=require('../src/public/project-audio');
test('reference prefers the Voxalike line file, then the selected original over separate backing',()=>{
  const scene={videoUrl:'video',externalOriginalUrl:'speech',backingUrl:'music',projectAudio:{original:{muted:true,volume:0},dub:{solo:true}}};
  const line={start:3,end:4};
  assert.deepEqual(audio.reference(scene,{...line,originalAudioUrl:'cut'}),{url:'cut',from:0,to:null,channel:'line',confirmBacking:false});
  assert.deepEqual(audio.reference(scene,line),{url:'speech',from:2.5,to:4.5,channel:'original',confirmBacking:false});
  assert.deepEqual(audio.reference({...scene,externalOriginalUrl:'',audioTracks:[{url:'first'},{url:'chosen'}],originalTrack:1},line),{url:'chosen',from:2.5,to:4.5,channel:'original',confirmBacking:false});
});
test('video audio displayed as Background remains an original, separate backing needs explicit approval',()=>{
  assert.equal(audio.reference({videoUrl:'anime'},{start:1,end:2}).confirmBacking,false);
  const fallback=audio.reference({videoUrl:'silent',videoHasAudio:false,backingUrl:'maybe-music'},{start:1,end:2});
  assert.equal(fallback.channel,'backing');assert.equal(fallback.confirmBacking,true);
  assert.equal(audio.reference({videoUrl:'silent',videoHasAudio:false},{start:1,end:2}),null);
  assert.equal(audio.reference({kind:'pack',videoUrl:'video',backingUrl:'music'},{start:1,end:2}),null,'a missing Voxalike reference must not fall back to scene audio');
});
test('reference padding is clipped at scene bounds and respects positive and negative source offsets',()=>{
  const scene={videoUrl:'video',videoDuration:10,projectAudio:{original:{offset:2}}};
  assert.equal(audio.reference(scene,{start:0,end:1}),null,'no audio exists before the source starts');
  assert.deepEqual(audio.reference(scene,{start:2,end:3}),{url:'video',from:0,to:1.5,channel:'original',confirmBacking:false});
  assert.equal(audio.reference({...scene,projectAudio:{original:{offset:-2}}},{start:9,end:10}).to,12);
  assert.equal(audio.reference({...scene,projectAudio:{}},{start:0,end:1}).from,0);
  assert.equal(audio.reference(scene,{start:4,end:3}),null);
});
