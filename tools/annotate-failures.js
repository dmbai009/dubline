// GitHub only shows a failed step as "Process completed with exit code 1" and
// its raw log is not always reachable (proxy/VPN, retention, tooling). This
// turns the spec reporter output into annotations, which stay visible on the
// run summary and through the API, so a red browser shard names the suites that
// broke instead of leaving the reader with an exit code.
const fs = require('fs');
const { stripVTControlCharacters } = require('node:util');

const LIMIT = 20;

function failingTests(text) {
  const failures = [], lines = stripVTControlCharacters(text).split(/\r?\n/);
  // Node repeats failures in a detailed footer, with each location BEFORE its
  // test header. Prefer that footer; never count both copies of a failure.
  const summary = lines.findIndex(line => /^\s*✖ failing tests:\s*$/.test(line));
  let current = null, location = '';
  const finish = () => {
    if (!current) return;
    const detail = [current.where, current.why].filter(Boolean).join(' — ');
    failures.push(detail ? `${current.name} — ${detail}` : current.name);
    current = null;
  };
  for (const line of lines.slice(summary < 0 ? 0 : summary + 1)) {
    const reference = /^\s*test at (.+):(\d+):\d+\s*$/.exec(line);
    if (reference) {
      const where = reference[1] + ':' + reference[2];
      if (summary < 0) { if (current && !current.where) current.where = where; }
      else { finish(); location = where; }
      continue;
    }
    const header = /^\s*✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/.exec(line);
    if (header) {
      finish(); current = { name: header[1].trim(), where: location, why: '' }; location = '';
      continue;
    }
    if (/^\s*[✔▶ℹ]/.test(line)) { finish(); location = ''; continue; }
    if (current && !current.why && /^\s*(?:AssertionError|Error|TypeError|RangeError|ReferenceError|SyntaxError)\b/.test(line)) current.why = line.trim().slice(0, 160);
  }
  finish();
  return failures;
}

function annotations(failures, limit = LIMIT) {
  const shown = failures.slice(0, limit);
  const lines = shown.map(message => `::error::${escapeAnnotation(message)}`);
  if (failures.length > shown.length) {
    lines.push(`::error::${escapeAnnotation(`… and ${failures.length - shown.length} more failing tests`)}`);
  }
  return lines;
}

function escapeAnnotation(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file) {
    console.error('usage: node tools/annotate-failures.js <test-output-file>');
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`[Dubline] cannot read ${file}: ${error.message}`);
    return 2;
  }
  const failures = failingTests(text);
  if (!failures.length) {
    // The step failed for a reason the reporter did not spell out (a crash, a
    // timeout, a missing file): surface the tail so the reason is still visible.
    const tail = text.trim().split(/\r?\n/).slice(-25).join('\n');
    console.log(`::error::${escapeAnnotation(`no failing test lines found; last output:\n${tail}`)}`);
    return 1;
  }
  for (const line of annotations(failures)) console.log(line);
  console.log(`[Dubline] reported ${failures.length} failing test(s)`);
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { failingTests, annotations, escapeAnnotation, main };
