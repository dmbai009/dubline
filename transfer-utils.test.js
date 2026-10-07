const test = require('node:test');
const assert = require('node:assert/strict');
const { rangesFromIndexes, validRanges, contains, UploadLimiter, DownloadScheduler } = require('./public/transfer-utils');
test('verified availability ranges are compact and reject duplicate, oversized and malformed bounds', () => {
  assert.deepEqual(rangesFromIndexes([9, 1, 2, 3, 6, 9, -1]), [[1, 3], [6, 6], [9, 9]]);
  assert.equal(validRanges([[1, 3], [6, 9]], 10), true);
  for (const ranges of [[[3, 1]], [[-1, 2]], [[1, 10]], [[1, 4], [3, 6]], [[0, Infinity]], [[1.2, 2]]]) assert.equal(validRanges(ranges, 10), false);
  assert.equal(contains([[1, 3], [6, 9]], 5), false); assert.equal(contains([[1, 3], [6, 9]], 7), true);
});
test('scheduler prioritizes playback, then rare verified chunks, with bounded hysteretic budgets', () => {
  let now = 0;
  const scheduler = new DownloadScheduler(100, () => now, () => 0.5);
  scheduler.availability('a', [[0, 99]]); scheduler.availability('b', [[0, 65]]);
  const pending = [4, 280, 244, 200];
  // At 60/100 seconds the estimated critical window is chunks 55..90.
  assert.equal(pending[scheduler.pick('a', pending, 60, 100)], 280);
  assert.equal(scheduler.pick('b', [280, 360], 60, 100), -1);
  for (let index = 0; index < 4; index++) scheduler.started('a');
  assert.equal(scheduler.pick('a', pending, 60, 100), -1);
  for (let index = 0; index < 4; index++) scheduler.finished('a', 65536, 10);
  assert.equal(scheduler.totalInflight, 0);
  assert.equal(scheduler.peers.get('a').limit, 4, 'rapid responses do not oscillate the budget');
  now = 1500; scheduler.started('a'); scheduler.finished('a', 65536, 10);
  assert.equal(scheduler.peers.get('a').limit, 6);
  scheduler.started('a'); scheduler.finished('a', 0, 0, true);
  assert.equal(scheduler.peers.get('a').limit, 3);
  scheduler.rankedAt = -Infinity;
  assert.equal([40, 280][scheduler.pick('a', [40, 280], 0, 0)], 280, 'outside initial estimated window rare chunk wins');
});
test('aggregate limiter shares one budget, switches to Unlimited live and cancels pending requests', async () => {
  const limiter = new UploadLimiter(); limiter.setLimit(2);
  await Promise.all([limiter.take(65536), limiter.take(65536)]);
  let sent = false;
  const pending = limiter.take(65536).then(() => { sent = true; });
  assert.equal(sent, false); limiter.setLimit(0); await pending; assert.equal(sent, true);
  limiter.setLimit(2); limiter.tokens = 0;
  const abort = new AbortController(), cancelled = limiter.take(65536, abort.signal);
  abort.abort(); await assert.rejects(cancelled, /cancelled/);
  assert.equal(limiter.queue.length, 0);
  await assert.rejects(limiter.take(256 * 1024), /frame/);
});
