const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const AdmZip = require('adm-zip');

// Isolate parser extraction from the host's real uploads, packs and rooms.
const timingTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-timing-'));
for (const [variable, directory] of [
  ['DUBLINE_UPLOAD_DIR', 'uploads'], ['DUBLINE_PACKS_DIR', 'packs'], ['DUBLINE_DATA_DIR', 'data']
]) process.env[variable] = path.join(timingTestDir, directory);
const { parseSubtitles, readPack } = require('./server/parsers');
after(() => {
  assert.ok(path.resolve(timingTestDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(timingTestDir).startsWith('dubline-timing-'));
  fs.rmSync(timingTestDir, { recursive: true, force: true });
});

test('subtitle import preserves millisecond timestamps', () => {
  for (const [filename, text] of [
    ['sample.srt', '1\n00:00:01,234 --> 00:00:02,345\nPrecise line\n'],
    ['sample.vtt', 'WEBVTT\n\n00:01.234 --> 00:02.345\nPrecise line\n'],
    ['sample.ass', '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.234,0:00:02.345,Default,Alice,0,0,0,,Precise line\n']
  ]) {
    const lines = parseSubtitles(Buffer.from(text), filename);
    assert.equal(lines.length, 1, filename);
    assert.equal(lines[0].start, 1.234, filename);
    assert.equal(lines[0].end, 2.345, filename);
  }
});

test('Voxalike import keeps explicit milliseconds and audio-derived end times', () => {
  const zip = new AdmZip();
  zip.addFile('001.ini', Buffer.from('caption=Precise line\ndub_timestamps=[1.234, 2.345]\n'));
  zip.addFile('002.ini', Buffer.from('caption=Start-only line\ndub_timestamps=[9.876]\n'));
  // 1.234 seconds of valid mono 16-bit PCM at 1 kHz.
  const wav = Buffer.alloc(44 + 1234 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(1000, 24); wav.writeUInt32LE(2000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  zip.addFile('002.wav', wav);
  const { lines } = readPack(zip.toBuffer(), 'precision.zip');
  assert.deepEqual(lines.map(line => [line.start, line.end]), [[1.234, 2.345], [9.876, 11.11]]);
});

test('short subtitle cues keep their duration; reversed and zero-length cues are skipped', () => {
  for (const [filename, text] of [
    ['short.srt', '1\n00:00:01,234 --> 00:00:01,434\nShort\n\n2\n00:00:02,000 --> 00:00:02,050\nVery short\n\n3\n00:00:03,000 --> 00:00:02,000\nReversed\n\n4\n00:00:04,000 --> 00:00:04,000\nEmpty\n'],
    ['short.vtt', 'WEBVTT\n\n00:01.234 --> 00:01.434\nShort\n\n00:02.000 --> 00:02.050\nVery short\n\n00:03.000 --> 00:02.000\nReversed\n\n00:04.000 --> 00:04.000\nEmpty\n'],
    ['short.ass', '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.234,0:00:01.434,Default,Alice,0,0,0,,Short\nDialogue: 0,0:00:02.000,0:00:02.050,Default,Alice,0,0,0,,Very short\nDialogue: 0,0:00:03.000,0:00:02.000,Default,Alice,0,0,0,,Reversed\nDialogue: 0,0:00:04.000,0:00:04.000,Default,Alice,0,0,0,,Empty\n']
  ]) assert.deepEqual(parseSubtitles(Buffer.from(text), filename).map(line => [line.start, line.end]), [[1.234, 1.434], [2, 2.05]], filename);
});

test('preparation time restores tenth-second settings consistently', () => {
  const script = fs.readFileSync('public/state.js', 'utf8');
  for (const [stored, expected] of [[null, 1], ['1.3', 1.3], ['1.26', 1.3], ['-1', 0], ['8', 5], ['invalid', 1]]) {
    const context = {
      localStorage: { getItem: key => key === 'dubline_pre_roll' ? stored : null, setItem() {} },
      crypto: { randomUUID: () => 'timing-test-client' }
    };
    context.window = context;
    vm.runInNewContext(script, context);
    assert.equal(context.DublineState.data.preRollSeconds, expected, String(stored));
  }
});
