const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { releaseList } = require('../tools/prepare-previous-release');

test('CI release lookup uses authenticated gh with a fixed endpoint and bounded output', async () => {
  const env = { GITHUB_ACTIONS: 'true', GH_TOKEN: 'test-token' };
  let calls = 0;
  const result = await releaseList({ env, execute: (file, args, options, done) => {
    calls++;
    assert.equal(file, 'gh');
    assert.deepEqual(args, ['api', 'repos/dmbai009/dubline/releases?per_page=100']);
    assert.equal(args.some(value => value.includes(env.GH_TOKEN)), false);
    assert.equal(options.env, env);
    assert.equal(options.maxBuffer, 4 * 1024 ** 2);
    assert.equal(options.timeout, 60000);
    assert.equal(options.windowsHide, true);
    done(null, '[{"tag_name":"v1.4.0-beta.1"}]');
  }, json: () => { throw Error('Unexpected anonymous fallback'); } });
  assert.equal(calls, 1);
  assert.deepEqual(result, [{ tag_name: 'v1.4.0-beta.1' }]);
});

test('local and unauthenticated lookups retain the bounded public metadata reader', async () => {
  for (const env of [{}, { GH_TOKEN: 'local-token' }, { GITHUB_ACTIONS: 'true' }]) {
    const expected = [{ tag_name: 'v1.3.1' }];
    assert.equal(await releaseList({ env,
      execute: () => { throw Error('Unexpected gh call'); },
      json: async (url, limit) => {
        assert.equal(url, 'https://api.github.com/repos/dmbai009/dubline/releases?per_page=100');
        assert.equal(limit, 4 * 1024 ** 2);
        return expected;
      }
    }), expected);
  }
});

test('authenticated lookup failures and malformed metadata stop release preparation', async () => {
  const env = { GITHUB_ACTIONS: 'true', GH_TOKEN: 'test-token' };
  await assert.rejects(releaseList({ env, execute: (_file, _args, _options, done) => done(Error('failed')) }), /Authenticated previous-release lookup failed/);
  await assert.rejects(releaseList({ env, execute: (_file, _args, _options, done) => done(null, 'invalid JSON') }), SyntaxError);
});

test('release packaging supplies only its own read token to the previous-release step', () => {
  const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/release.yml'), 'utf8'));
  const step = workflow.jobs.windows.steps.find(step => step.run === 'node tools/prepare-previous-release.js');
  assert.equal(workflow.permissions.contents, 'read');
  assert.deepEqual(step.env, { GH_TOKEN: '${{ github.token }}' });
});
