const { test } = require('node:test'), assert = require('node:assert/strict'), { create } = require('./public/export-progress');
test('UI heartbeats and repeated unchanged reports never impersonate real progress', () => {
  let now = 0; const tracker = create(() => now); tracker.update('takes', { current: 1, total: 100, unit: 'count' });
  now = 15001; tracker.snapshot(); tracker.update('takes', { current: 1, total: 100, unit: 'count' });
  assert.equal(tracker.snapshot().stalled, true); assert.equal(tracker.snapshot().quiet, 15001);
  tracker.update('takes', { current: 2 }); assert.equal(tracker.snapshot().quiet, 0); assert.equal(tracker.snapshot().stalled, false);
});
test('interleaved audio/video/write counters stay monotonic and preserve independent units', () => {
  const tracker = create(() => 0); tracker.update('audio', { current: 8, total: 20 }); tracker.update('video', { current: 4, total: 20 }); tracker.update('saving', { current: 1024, unit: 'bytes' }); tracker.update('audio', { current: 4 });
  assert.deepEqual(tracker.snapshot().rows.map(r => [r.phase, r.current, r.unit]), [['audio', 8, 'seconds'], ['video', 4, 'seconds'], ['saving', 1024, 'bytes']]);
  const view = tracker.snapshot(); view.rows[0].current = 999; assert.equal(tracker.snapshot().rows[0].current, 8);
});
test('waiting in the native picker does not trigger a processing-stall warning', () => {
  let now = 0; const tracker = create(() => now); tracker.waiting(true); now = 60000; assert.equal(tracker.snapshot().stalled, false); tracker.waiting(false); assert.equal(tracker.snapshot().quiet, 0);
});
test('zero recordings and completed phases are explicit, with no invented counts', () => {
  const tracker = create(() => 10); tracker.update('takes', { current: 0, total: 0, unit: 'count', state: 'done' }); tracker.update('finalizing', {});
  assert.equal(tracker.snapshot().rows[0].total, 0); assert.equal(tracker.snapshot().rows[1].current, undefined);
});
function audioFixture(process) {
  const fs = require('node:fs'), vm = require('node:vm'), context = { window: {}, t: key => key, lineNumber: line => line.id,
    requireExportTake: process, takeBounds: (_line, duration) => ({ from: 0, to: duration }), exportTakeStart: line => line.start,
    DublineTakeMix: { normalize: line => ({ volume: line.volume ?? 1 }) }, DublineProjectAudio: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./public/video-export-audio.js'), 'utf8'), context);
  return context.window.DublineVideoExportAudio;
}
const scene = () => ({ takes: Array.from({ length: 6 }, (_, id) => ({ id, start: id, volume: id === 2 ? 0 : 1 })), gains: { dub: 1, original: 1, backing: 0, mix: { autoDuckEnabled: false } } });
test('a CPU retry resets work counters but retains total elapsed time', () => {
  let now = 0; const tracker = create(() => now); tracker.update('video', { current: 9, total: 10 }); now = 5000;
  tracker.restart(); tracker.update('video', { current: 0, total: 10 });
  assert.equal(tracker.snapshot().elapsed, 5000); assert.equal(tracker.snapshot().rows[0].current, 0); assert.equal(tracker.snapshot().quiet, 0);
  tracker.update('audio', { current: 10, total: 10, state:'done' }); tracker.resetPhase('video'); tracker.update('video', { current: 0, total: 10 });
  assert.equal(tracker.snapshot().rows.find(row=>row.phase==='audio').current,10); assert.equal(tracker.snapshot().rows.find(row=>row.phase==='video').current,0);
});
test('preparation is bounded to two jobs, preserves chronological order and counts only audible takes', async () => {
  let active = 0, peak = 0; const reports = [];
  const audio = audioFixture(async line => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, line.id % 2 ? 1 : 6)); active--; return { duration: 1 }; });
  const snapshot = scene(); snapshot.exportReport = (phase, data) => reports.push({ phase, ...data });
  const result = await audio.prepare(snapshot, 8, () => {}, () => {}, { concurrency: 100 });
  assert.equal(peak, 2); assert.equal(active, 0); assert.deepEqual(Array.from(result.takes, t => t.line.id), [0, 1, 3, 4, 5]);
  assert.equal(reports.at(-1).total, 5); assert.equal(reports.at(-1).current, 5); assert.equal(reports.at(-1).state, 'done');
});
test('preparation drains its bounded current batch and starts no new jobs after failure', async () => {
  const started = []; let active = 0;
  const audio = audioFixture(async line => { started.push(line.id); active++; try { await new Promise(resolve => setImmediate(resolve)); if (!line.id) throw Error('decode failed'); return { duration: 1 }; } finally { active--; } });
  await assert.rejects(audio.prepare(scene(), 8, () => {}, () => {}), /decode failed/); assert.deepEqual(started, [0, 1]); assert.equal(active, 0);
});
test('cancellation stops preparation before the next batch and muted mixes perform no processing', async () => {
  let aborted = false, calls = 0; const audio = audioFixture(async () => { calls++; aborted = true; return { duration: 1 }; });
  await assert.rejects(audio.prepare(scene(), 8, () => {}, () => { if (aborted) throw Error('cancelled'); }), /cancelled/); assert.ok(calls <= 2);
  calls = 0; const muted = scene(); muted.gains.dub = 0; const result = await audio.prepare(muted, 8, () => {}, () => {}); assert.equal(calls, 0); assert.equal(result.takes.length, 0);
});
