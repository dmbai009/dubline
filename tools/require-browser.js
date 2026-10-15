// A missing browser turns all 38 browser suites into skips. That is wanted on a
// developer machine without Chrome, but in CI it would report a green run while
// nothing was verified, so CI sets DUBLINE_REQUIRE_BROWSER=1 and runs this check
// before the shards. Keeping the check here rather than in e2e/helpers.js means
// the unit suite never depends on an installed browser.
const { chromePath, NO_BROWSER } = require('../e2e/helpers');

function browserRequired(chrome, env = process.env) {
  return !chrome && env.DUBLINE_REQUIRE_BROWSER === '1';
}

function main() {
  if (!browserRequired(chromePath)) {
    console.log(`[Dubline] Browser: ${chromePath || 'none found (skipping is allowed here)'}`);
    return 0;
  }
  console.error(`[Dubline] ${NO_BROWSER}. Install Chrome/Edge or remove DUBLINE_REQUIRE_BROWSER=1.`);
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { browserRequired, main };
