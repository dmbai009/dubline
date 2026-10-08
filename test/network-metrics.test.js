const { test } = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('../public/network-metrics');
test('RTT smoothing uses monotonic samples, expires and resets without a fake zero', () => {
  const value = metrics.latency(); assert.equal(value.get(0), null);
  value.add(100, 50); value.add(200, 60); value.add(NaN, 70); assert.equal(value.get(80), 150);
  assert.equal(value.get(15060), null); value.reset(); assert.equal(value.get(0), null);
  assert.deepEqual([0, 80, 81, 180, 181, 350, 351, 10000, null].map(metrics.category), ['good', 'good', 'fair', 'fair', 'slow', 'slow', 'poor', 'poor', 'unknown']);
});
test('passive counter smooths observed bytes, settles at zero and guards invalid intervals', () => {
  const meter = metrics.meter(); meter.sample(0); meter.add('up', 2048); meter.add('down', 1048576);
  assert.deepEqual(meter.sample(1000), { up: 2048, down: 1048576 });
  meter.add('up', -10); meter.add('down', Infinity); meter.sample(2000); meter.sample(3000);
  assert.deepEqual(meter.sample(4000), { up: 0, down: 0 }); assert.deepEqual(meter.sample(4000), { up: 0, down: 0 });
  assert.deepEqual([null, 0, 50, 2048, 1258291.2].map(metrics.rate), ['—', '0 KB/s', '50 B/s', '2 KB/s', '1.2 MB/s']);
  assert.equal(metrics.bytes('я'), 2); assert.equal(metrics.bytes(new Uint8Array(37)), 37);
});
test('telemetry rejects injected identities, oversized fields and nonfinite or negative values', () => {
  const { valid } = require('../server/networkTelemetry');
  assert.equal(valid({ rtt: 12, up: 0, down: null }), true);
  for (const data of [null, [], {}, { rtt: -1, up: 0, down: 0 }, { rtt: 1, up: Infinity, down: 0 }, { rtt: 1, up: 0, down: 0, nick: 'Host' }, { rtt: '1', up: 0, down: 0 }]) assert.equal(!!valid(data), false);
});
