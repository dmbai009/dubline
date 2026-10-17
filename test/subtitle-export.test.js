const { test, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-subtitles-'));
for (const [key, folder] of [['DUBLINE_DATA_DIR','data'],['DUBLINE_UPLOAD_DIR','uploads'],['DUBLINE_PACKS_DIR','packs']]) process.env[key] = path.join(directory, folder);
const { serialize } = require('../src/server/subtitle-export'), { parseSubtitles } = require('../src/server/parsers');
after(() => fs.rmSync(directory, { recursive:true, force:true }));
const pick = ({ start, end, character, caption }) => ({ start, end, character, caption });
const cues = [
  { start:1.234, end:3.567, character:'Нагито, [сложная роль] &lt; 🙂', caption:'Первая строка\nВторая строка <i>не тег</i> & "текст"' },
  { start:1.3, end:2.4, character:'Голоса на фоне', caption:'Имя: это часть текста\n\nЕщё абзац {\\p1} и буквальное \\N.' },
  { start:4.001, end:4.004, character:'Нагито, [сложная роль] &lt; 🙂', caption:'Короткая реплика' }
];
for (const format of ['srt', 'ass', 'vtt']) {
  test(`${format}: text, overlapping times, repeated/unicode roles and line breaks round-trip`, () => {
    const source = structuredClone(cues), text = serialize(source, format);
    const restored = parseSubtitles(Buffer.from('\ufeff' + text), 'test.' + format);
    assert.deepEqual(restored.map(pick), cues);
    assert.deepEqual(source, cues, 'export never mutates scene lines');
    assert.ok(restored.every(line => !line.audioUrl && !line.claimedBy));
    if (format === 'ass') assert.match(text, /Dialogue: 0,0:00:04\.00,0:00:04\.01/);
  });
}
test('ASS metadata is ignored when an external editor changes its Dialogue', () => {
  const text = serialize([cues[0]], 'ass').replace('Вторая строка', 'Edited second line');
  assert.match(parseSubtitles(Buffer.from(text), 'edited.ass')[0].caption, /Edited second line/);
});
test('formats are explicit; invalid times and empty captions never produce broken cues', () => {
  for (const format of ['html','__proto__',null]) assert.throws(() => serialize(cues, format));
  for (const patch of [{ start:-1 }, { end:NaN }, { end:1.234 }, { caption:'   ' }]) assert.throws(() => serialize([{ ...cues[0], ...patch }], 'srt'));
});
