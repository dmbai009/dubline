const { test } = require('node:test');
const assert = require('node:assert/strict');
// Delayed identity is a test fixture for alignment/state lifetime, never a neural-quality substitute.
function fixture(failure = false) {
  const metrics = { created:0, destroyed:0 };
  return { metrics, frameSize:480, createDenoiseState() {
    const ring=new Float32Array(960);let offset=0;metrics.created++;
    return { processFrame(frame) { if(failure)throw Error('Native failure');for(let i=0;i<frame.length;i++){const value=frame[i];frame[i]=ring[offset];ring[offset]=value;offset=(offset+1)%ring.length;} }, destroy(){metrics.destroyed++;} };
  } };
}
test('RN frame adapter compensates 960 samples, flushes a partial frame and preserves stereo PCM',async()=>{
  const { processPCM }=await import('./public/rnnoise-dsp.mjs');const api=fixture();
  for(const length of [1,99,480,481,48091]){
    const channels=[Float32Array.from({length},(_,i)=>Math.sin(i*.07)*.1),Float32Array.from({length},(_,i)=>Math.cos(i*.13)*.2)];
    const result=await processPCM(channels,48000,{load:async()=>api});assert.deepEqual(result.channels,channels);assert.equal(result.metrics.delay,960);assert.equal(result.metrics.samples,length);
  }
  assert.equal(api.metrics.created,10);assert.equal(api.metrics.destroyed,10);
});
test('native failure and mid-task cancellation destroy every channel state',async()=>{
  const { processPCM }=await import('./public/rnnoise-dsp.mjs');const bad=fixture(true), channels=[new Float32Array(50000),new Float32Array(50000)];
  await assert.rejects(processPCM(channels,48000,{load:async()=>bad}),/Native failure/);assert.equal(bad.metrics.destroyed,2);
  const api=fixture();let blocks=0;
  await assert.rejects(processPCM(channels,44100,{load:async()=>api,cancelled:()=>++blocks>1}),{name:'AbortError'});assert.equal(api.metrics.created,2);assert.equal(api.metrics.destroyed,2);
});
test('invalid PCM/rates/channels never instantiate a denoiser',async()=>{
  const { processPCM }=await import('./public/rnnoise-dsp.mjs');const api=fixture();
  for(const [channels,rate] of [[[new Float32Array([NaN])],48000],[[new Float32Array(1)],0],[[new Float32Array(1),new Float32Array(2)],48000],[[new Float32Array(1),new Float32Array(1),new Float32Array(1)],48000]])
    await assert.rejects(processPCM(channels,rate,{load:async()=>api}),/noise.invalid/);
  assert.equal(api.metrics.created,0);
});
