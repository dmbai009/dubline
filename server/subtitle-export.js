// Plain subtitle exchange. No recordings, processing settings or room metadata.
const { createHash } = require('node:crypto');
const formats = Object.freeze({ srt: 'application/x-subrip', ass: 'text/x-ssa', vtt: 'text/vtt' });
const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function decodeText(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, value) => {
    if (value[0] !== '#') return ({ amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:'\u00a0' })[value.toLowerCase()] ?? match;
    const code = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}
function clock(seconds, format) {
  const units = format === 'ass' ? 100 : 1000, ticks = Math.round(seconds * units);
  return `${format === 'ass' ? Math.floor(ticks / units / 3600) : String(Math.floor(ticks / units / 3600)).padStart(2, '0')}:${String(Math.floor(ticks / units / 60) % 60).padStart(2, '0')}:${String(Math.floor(ticks / units) % 60).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(ticks % units).padStart(format === 'ass' ? 2 : 3, '0')}`;
}
const digest = line => createHash('sha256').update(line).digest('hex');
function serialize(lines, format) {
  if (!Object.hasOwn(formats, format)) throw new Error('Unsupported subtitle format');
  const cues = lines.map((line, index) => ({ start: Math.round(line.start * 1000) / 1000, end: Math.round(line.end * 1000) / 1000,
    character: String(line.character || 'Character'), caption: String(line.caption || '').replace(/\r\n?/g, '\n').trim(), index }))
    .sort((a, b) => a.start - b.start || a.index - b.index);
  if (cues.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end <= c.start || !c.caption)) throw new Error('Invalid subtitle cue');
  if (format === 'ass') {
    const header = '[Script Info]\n; Exported by DubLine\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
    return header + cues.map(c => {
      // ASS uses centiseconds and comma-separated actor fields. The ignored
      // comment retains exact source data only while its Dialogue is unchanged.
      const caption = c.caption.replace(/\\/g, '\\\u2060').replace(/[{}]/g, '\\$&').replace(/\n/g, '\\N');
      const actor = c.character.replace(/,/g, '，').replace(/[\r\n]/g, ' ');
      const end = Math.max(c.end, (Math.round(c.start * 100) + 1) / 100);
      const line = `Dialogue: 0,${clock(c.start, format)},${clock(end, format)},Default,${actor},0,0,0,,${caption}`;
      return `; DubLine-Cue: ${JSON.stringify({ hash:digest(line), start:c.start, end:c.end, character:c.character, caption:c.caption })}\n${line}`;
    }).join('\n') + '\n';
  }
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + cues.map((c, index) => {
    const role = escapeText(c.character).replace(/\]/g, '&#93;').replace(/\[/g, '&#91;').replace(/[\r\n]/g, ' ');
    const caption = escapeText(c.caption).replace(/\n(?=\n)/g, '\n&#8203;');
    const body = format === 'vtt' ? `<v ${role}>${caption}</v>` : `[${role}]: ${caption}`;
    return `${index + 1}\n${clock(c.start, format)} --> ${clock(c.end, format)}\n${body}\n`;
  }).join('\n');
}
function assCueMetadata(text, dialogue) {
  try {
    const cue = JSON.parse(text);
    if (cue.hash !== digest(dialogue) || typeof cue.character !== 'string' || !cue.character.trim() || /[\r\n]/.test(cue.character)
      || typeof cue.caption !== 'string' || !cue.caption.trim() || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
      || cue.start < 0 || Math.round(cue.end * 1000) <= Math.round(cue.start * 1000)) return null;
    return cue;
  } catch { return null; }
}
module.exports = { formats, serialize, decodeText, assCueMetadata };
