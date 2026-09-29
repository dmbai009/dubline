const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { parseSubtitles, findEmbeddedSubtitleMap, sanitizeRoomId, sanitizeNick } = require('../server');

test('ASS parser extracts timing, actor and cleaned text', () => {
  const ass = `[Script Info]\nTitle: Test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.40,Default,Alice,0,0,0,,{\\i1}Hello\\Nworld\n`;
  const lines = parseSubtitles(Buffer.from(ass), 'sample.ass');
  assert.equal(lines.length, 1);
  assert.deepEqual({ start: lines[0].start, end: lines[0].end, character: lines[0].character, caption: lines[0].caption }, {
    start: 1.2, end: 3.4, character: 'Alice', caption: 'Hello world'
  });
});

test('ASS parser skips typesetting drawings and cleans \\h / \\N', () => {
  const ass = [
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\p1\\pos(10,10)}m 0 0 l 157 0 157 26 0 26',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,m 0 0 l 490 0 490 271 0 271',
    'Dialogue: 0,0:00:03.00,0:00:04.00,Sign,,0,0,0,,{\\an8}1\\hName:\\hAnonymous',
    'Dialogue: 0,0:00:05.00,0:00:06.00,Default,Makoto,0,0,0,,School\\Nof hope',
    'Comment: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,commented out'
  ].join('\n');
  const lines = parseSubtitles(Buffer.from(ass), 'sample.ass');
  assert.deepEqual(lines.map(l => l.caption), ['1 Name: Anonymous', 'School of hope']);
  assert.equal(lines[1].character, 'Makoto');
});

test('SRT parser supports plain and bracketed character prefixes', () => {
  const srt = `1\n00:00:01,000 --> 00:00:02,500\nBob: First line\n\n2\n00:00:03,000 --> 00:00:04,000\n[Alice]: Second line\n`;
  const lines = parseSubtitles(Buffer.from(srt), 'sample.srt');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].character, 'Bob');
  assert.equal(lines[0].caption, 'First line');
  assert.equal(lines[1].character, 'Alice');
  assert.equal(lines[1].caption, 'Second line');
});

test('SRT prefix accepts non-Latin character names', () => {
  // Unicode test data on purpose: speaker names are not limited to Latin letters
  const srt = `1\n00:00:01,000 --> 00:00:02,000\nАлиса: Hi\n\n2\n00:00:03,000 --> 00:00:04,000\n春香: Hello\n`;
  const lines = parseSubtitles(Buffer.from(srt), 'sample.srt');
  assert.deepEqual(lines.map(l => [l.character, l.caption]), [['Алиса', 'Hi'], ['春香', 'Hello']]);
});

test('input sanitizers keep identifiers bounded and path-safe', () => {
  assert.equal(sanitizeRoomId('../../party room'), '______party_room');
  assert.equal(sanitizeNick('<Admin>\u0000'), 'Admin');
  assert.equal(sanitizeNick('12345678901234567890').length, 16);
});

test('ffmpeg-static detects and extracts an embedded ASS track from MKV', { timeout: 30000 }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-mkv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const assPath = path.join(dir, 'captions.ass');
  const mkvPath = path.join(dir, 'scene.mkv');
  const extractedPath = path.join(dir, 'extracted.ass');
  const mp4Path = path.join(dir, 'scene.mp4');
  fs.writeFileSync(assPath, `[Script Info]\nScriptType: v4.00+\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:00.80,Default,Tester,0,0,0,,Embedded line\n`);
  const make = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-i', assPath, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:0', '-shortest',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-c:s', 'ass', mkvPath
  ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(make.status, 0, make.stderr);
  const map = findEmbeddedSubtitleMap(mkvPath);
  assert.match(map, /^0:\d+$/);
  const extract = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mkvPath, '-map', map, '-c:s', 'ass', extractedPath], {
    encoding: 'utf8', windowsHide: true, timeout: 20000
  });
  assert.equal(extract.status, 0, extract.stderr);
  const lines = parseSubtitles(fs.readFileSync(extractedPath), 'embedded.ass');
  assert.equal(lines[0].character, 'Tester');
  assert.equal(lines[0].caption, 'Embedded line');
  const remux = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', mkvPath,
    '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', mp4Path
  ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(remux.status, 0, remux.stderr);
  assert.ok(fs.statSync(mp4Path).size > 0);
});
