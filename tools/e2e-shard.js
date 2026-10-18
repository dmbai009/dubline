// The browser suite is defined once, in package.json ("test:e2e"). CI runs that
// same list as parallel shards so one slow suite can no longer cancel the whole
// pipeline by exhausting the job timeout.
//
//   node tools/e2e-shard.js --list <shard> <total>   print the suites of one shard
//   node tools/e2e-shard.js <shard> <total>          run that shard through node --test
//
// Recorded Windows CI durations balance slow setup/media suites as well as
// individual tests. New files fall back to test count and are never omitted.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const durations = require('./e2e-durations.json').milliseconds;

function suiteFiles() {
  const script = require(path.join(ROOT, 'package.json')).scripts['test:e2e'] || '';
  return script.split(/\s+/).filter(name => name.endsWith('.e2e.js'));
}

function weightOf(file) {
  const measured = durations[file];
  if (Number.isFinite(measured) && measured > 0) return measured + 5000;
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return 5000 + 2500 * (1 + (source.match(/^\s{2}test\(/gm) || []).length);
}

function shardsOf(files, total, weight = weightOf) {
  if (!Number.isInteger(total) || total < 1 || total > files.length) throw new Error('Invalid shard count.');
  if (new Set(files).size !== files.length) throw new Error('Duplicate browser suites.');
  const buckets = Array.from({ length: total }, () => ({ weight: 0, files: [] }));
  const heaviestFirst = files.map(file => ({ file, weight: weight(file) }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
  for (const entry of heaviestFirst) {
    const lightest = buckets.reduce((best, bucket) => bucket.weight < best.weight ? bucket : best);
    lightest.files.push(entry.file);
    lightest.weight += entry.weight;
  }
  return buckets.map(bucket => bucket.files.sort());
}

function main(args = process.argv.slice(2)) {
  const list = args.includes('--list');
  const numbers = args.filter(value => !value.startsWith('--')).map(Number);
  const [shard, total] = numbers;
  if (numbers.length !== 2 || args.some(value => value.startsWith('--') && value !== '--list') ||
      ![shard, total].every(Number.isInteger) || shard < 1 || total < 1 || shard > total) {
    console.error('Usage: node tools/e2e-shard.js [--list] <shard> <total>');
    process.exit(2);
  }

  const files = suiteFiles();
  if (!files.length) {
    console.error('No browser suites found in package.json "test:e2e".');
    process.exit(2);
  }
  if (total > files.length) {
    console.error(`Only ${files.length} browser suites exist, so ${total} shards would leave empty jobs.`);
    process.exit(2);
  }

  const shardFiles = shardsOf(files, total)[shard - 1];
  console.log(`[Dubline] Browser shard ${shard}/${total}: ${shardFiles.length} of ${files.length} suites`);
  for (const file of shardFiles) console.log('  ' + file);
  if (list) process.exit(0);

  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...shardFiles],
    { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (run.error) {
    console.error(`[Dubline] Could not start the test runner: ${run.error.message}`);
    process.exit(1);
  }
  process.exit(run.status === null ? 1 : run.status);
}

if (require.main === module) main();
module.exports = { suiteFiles, weightOf, shardsOf };
