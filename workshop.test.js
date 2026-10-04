const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkshopUrl, downloadVoxalikePack } = require('./server/workshop');

test('Voxalike workshop URLs are reduced to a safe slug and cache filename', () => {
  assert.deepEqual(parseWorkshopUrl('https://voxalike.com/workshop/My-Pack?ref=dubline'), {
    slug: 'my-pack',
    filename: 'voxalike-my-pack.zip',
    downloadUrl: 'https://voxalike.com/workshop/my-pack/download'
  });
  assert.equal(parseWorkshopUrl('https://www.voxalike.com/workshop/demo/download/').slug, 'demo');
});

test('Voxalike packs inside a category keep both path segments', () => {
  assert.deepEqual(parseWorkshopUrl('https://voxalike.com/workshop/judge-mods/bankai'), {
    slug: 'judge-mods/bankai',
    filename: 'voxalike-judge-mods--bankai.zip',
    downloadUrl: 'https://voxalike.com/workshop/judge-mods/bankai/download'
  });
  assert.equal(parseWorkshopUrl('https://voxalike.com/workshop/judge-mods/bankai/download').slug, 'judge-mods/bankai');
  assert.equal(parseWorkshopUrl('https://voxalike.com/workshop/judge-mods/download').slug, 'judge-mods');
  for (const url of [
    'https://voxalike.com/workshop/creators/usr_123',
    'https://voxalike.com/workshop/a/b/c',
    'https://voxalike.com/workshop/download'
  ]) assert.throws(() => parseWorkshopUrl(url), /Voxalike|workshop/i, url);
});

test('workshop import rejects other hosts, credentials, HTTP and unrelated paths', () => {
  for (const url of [
    'https://example.com/workshop/demo',
    'https://voxalike.com.evil.test/workshop/demo',
    'https://user:pass@voxalike.com/workshop/demo',
    'http://voxalike.com/workshop/demo',
    'https://voxalike.com/docs/dub-pack-format'
  ]) assert.throws(() => parseWorkshopUrl(url), /Voxalike|workshop/i, url);
});

test('workshop download follows only safe redirects and enforces the actual byte limit', async () => {
  const calls = [];
  const fetchOk = async url => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: '/workshop/demo/file' } });
    return new Response(Buffer.from('zip-data'), { status: 200 });
  };
  assert.equal((await downloadVoxalikePack('https://voxalike.com/workshop/demo/download', 64, fetchOk)).toString(), 'zip-data');
  assert.equal(calls.length, 2);

  await assert.rejects(
    downloadVoxalikePack('https://voxalike.com/workshop/demo/download', 4, async () => new Response(Buffer.from('too large'))),
    err => err.status === 413
  );
  await assert.rejects(
    downloadVoxalikePack('https://voxalike.com/workshop/demo/download', 64, async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/p.zip' } })),
    err => err.status === 502
  );
});
