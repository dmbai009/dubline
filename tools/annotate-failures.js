// GitHub only shows a failed step as "Process completed with exit code 1" and
// its raw log is not always reachable (proxy/VPN, retention, tooling). This
// turns the spec reporter output into annotations, which stay visible on the
// run summary and through the API, so a red browser shard names the suites that
// broke instead of leaving the reader with an exit code.
const fs = require('fs');

const LIMIT = 20;

function failingTests(text) {
  // The spec reporter writes one "✖ name (12ms)" line per failing test and
  // repeats the name in a "test at <file>:<line>" reference just below it.
  const failures = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/.exec(lines[i]);
    if (!match) continue;
    const name = match[2].trim();
    // The reporter prints the error block first and the "test at" reference
    // afterwards, so both are collected from the same window in any order.
    let where = '';
    let why = '';
    for (let j = i + 1; j < Math.min(i + 40, lines.length) && !(where && why); j += 1) {
      where = where || (/^\s*test at (\S+?):(\d+):\d+/.exec(lines[j]) || []).slice(1).join(':');
      why = why || (/^\s*(?:AssertionError|Error|TypeError|RangeError|ReferenceError|SyntaxError)\b.*$/.exec(lines[j]) || [])[0];
    }
    const detail = [where, why && why.trim().slice(0, 160)].filter(Boolean).join(' — ');
    failures.push(detail ? `${name} — ${detail}` : name);
  }
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
