// The browser suite is defined once, in package.json ("test:e2e"). CI runs that
// same list as parallel shards so one slow suite can no longer cancel the whole
// pipeline by exhausting the job timeout.
//
//   node tools/e2e-shard.js --list <shard> <total>   print the suites of one shard
//   node tools/e2e-shard.js <shard> <total>          run that shard through node --test
//
// The split is deterministic and balanced by the number of tests in each file,
// so every suite runs in exactly one shard and adding a suite to package.json
// automatically schedules it.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function suiteFiles() {
  const script = require(path.join(ROOT, 'package.json')).scripts['test:e2e'] || '';
  return script.split(/\s+/).filter(name => name.endsWith('.e2e.js'));
}

function weightOf(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return 1 + (source.match(/^\s{2}test\(/gm) || []).length;
}

function shardsOf(files, total) {
  const buckets = Array.from({ length: total }, () => ({ weight: 0, files: [] }));
  const heaviestFirst = files.map(file => ({ file, weight: weightOf(file) }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
  for (const entry of heaviestFirst) {
    const lightest = buckets.reduce((best, bucket) => bucket.weight < best.weight ? bucket : best);
    lightest.files.push(entry.file);
    lightest.weight += entry.weight;
  }
  return buckets.map(bucket => bucket.files.sort());
}

const args = process.argv.slice(2);
const list = args.includes('--list');
const numbers = args.filter(value => !value.startsWith('--')).map(Number);
const [shard, total] = numbers;
if (![shard, total].every(Number.isInteger) || shard < 1 || total < 1 || shard > total) {
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
