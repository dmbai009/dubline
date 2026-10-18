const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const yauzl = require('yauzl');
const { timeline, wavHeader, createZip } = require('../src/public/stem-archive');

test('timeline TSV quotes multiline captions, tabs and quotes without losing text or columns', () => {
  const lines = [{ id: 3, character: 'Hero\t"one"', audioStart: -0.125, caption: 'First line\nSecond\tline\r\n"Quote"' },
    { id: 4, character: 'Роль', audioStart: 8, caption: 'Plain caption' }];
  assert.equal(timeline(lines, line => line.audioStart),
    'character\tstart_seconds\tline_id\tcaption\n"Hero\t""one"""\t-0.125\t3\t"First line\nSecond\tline\r\n""Quote"""\nРоль\t8.000\t4\tPlain caption\n');
});

async function readZip(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const files = new Map();
  await new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const parts = [];
      stream.on('data', part => parts.push(part)); stream.on('error', reject);
      stream.on('end', () => { files.set(entry.fileName, Buffer.concat(parts)); zip.readEntry(); });
    }));
    zip.readEntry();
  });
  return files;
}

test('streamed ZIP64 is readable with independent ZIP readers and correct CRCs, UTF-8 names and WAV lengths', async () => {
  const zip = createZip(), pcm = Buffer.from([0, 0, 255, 127, 0, 128, 0, 0]), header = wavHeader(2);
  await zip.add('01_Герой 🙂.wav', (async function* () { yield header; yield pcm.subarray(0, 3); await Promise.resolve(); yield pcm.subarray(3); })());
  await zip.add('timeline.tsv', [new TextEncoder().encode('character\tcaption\nГерой\tHello\n')]);
  await zip.add('empty', []);
  const bytes = Buffer.from(await zip.finish().arrayBuffer()), files = await readZip(bytes);
  assert.equal(new AdmZip(bytes).test(), true);
  assert.deepEqual([...files.keys()], ['01_Герой 🙂.wav', 'timeline.tsv', 'empty']);
  const wav = files.get('01_Герой 🙂.wav');
  assert.deepEqual(wav.subarray(44), pcm); assert.equal(wav.readUInt32LE(4), wav.length - 8); assert.equal(wav.readUInt32LE(40), 8);
  assert.equal(wav.readUInt16LE(22), 2); assert.equal(wav.readUInt32LE(24), 48000); assert.equal(wav.readUInt16LE(34), 16);
  assert.match(files.get('timeline.tsv').toString(), /Герой\tHello/); assert.equal(files.get('empty').length, 0);
  assert.throws(() => zip.finish()); await assert.rejects(zip.add('late', []));
});

test('large silent windows compress without retaining uncompressed role WAVs', async () => {
  const zip = createZip(), window = new Uint8Array(8 * 48000 * 4);
  for (let role = 0; role < 3; role++) await zip.add(`${role}.wav`, (async function* () {
    yield wavHeader(8 * 48000 * 12);
    for (let i = 0; i < 12; i++) yield window;
  })());
  const archive = zip.finish();
  assert.ok(archive.size < 100000, `compressed archive is ${archive.size} bytes for 55 MB of PCM`);
  const files = await readZip(Buffer.from(await archive.arrayBuffer()));
  assert.equal(files.size, 3);
  for (const wav of files.values()) assert.equal(wav.length, 44 + window.length * 12);
});

test('a failed audio producer closes the archive and runs generator cleanup', async () => {
  const zip = createZip(); let cleaned = false;
  await assert.rejects(zip.add('broken.wav', (async function* () {
    try { yield new Uint8Array([1, 2]); throw new Error('Take unavailable'); } finally { cleaned = true; }
  })()), /Take unavailable/);
  assert.equal(cleaned, true); assert.throws(() => zip.finish()); await assert.rejects(zip.add('next', []));
});

test('WAV limits are checked before rendering, so RIFF sizes never wrap silently', () => {
  assert.equal(new DataView(wavHeader(0).buffer).getUint32(40, true), 0);
  assert.throws(() => wavHeader(2 ** 30), /4 GiB/);
  for (const frames of [NaN, Infinity, -1, 0.25]) assert.throws(() => wavHeader(frames));
});
