// Supported release identifiers: stable versions and numbered public betas.
const VERSION_PATTERN = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-beta\\.(?:0|[1-9]\\d*))?';
function parseVersion(value) {
  const text = String(value || '').trim().replace(/^v/, '');
  const match = text.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const parts = match.slice(1, match[4] === undefined ? 4 : 5).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function isAppVersion(value) {
  return typeof value === 'string' && new RegExp('^' + VERSION_PATTERN + '$').test(value) && !!parseVersion(value);
}
function isBeta(value) { return parseVersion(value)?.length === 4; }
function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate), previous = parseVersion(current);
  if (!next || !previous) return false;
  for (let i = 0; i < 3; i++) if (next[i] !== previous[i]) return next[i] > previous[i];
  if (next.length !== previous.length) return next.length === 3;
  return next.length === 4 && next[3] > previous[3];
}
function nextTestVersion(value) {
  const parts = parseVersion(value);
  if (!parts) throw Error('Invalid test base version.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}-beta.${parts[3] + 1}` : `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}
module.exports = { VERSION_PATTERN, parseVersion, isAppVersion, isBeta, isNewerVersion, nextTestVersion };
