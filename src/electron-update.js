const https = require('https');
const { parseVersion, isNewerVersion, isAppVersion, isBeta } = require('./update-version');

const RELEASE_API = 'https://api.github.com/repos/dmbai009/dubline/releases/latest';
const RELEASE_BASE = 'https://github.com/dmbai009/dubline/releases/tag/';

function evaluateRelease(release, currentVersion, experimental = false) {
  if (!release || release.draft || (!experimental && (release.prerelease || isBeta(release.tag_name))) || !isNewerVersion(release.tag_name, currentVersion)) return null;
  const tag = String(release.tag_name || '').trim();
  if (!isAppVersion(tag.replace(/^v/, '')) || (release.prerelease && !isBeta(tag))) return null;
  return {
    version: tag.replace(/^v/i, ''),
    url: `${RELEASE_BASE}${encodeURIComponent(tag)}`
  };
}

function selectRelease(releases, currentVersion, experimental = false) {
  if (!Array.isArray(releases)) throw Error('Invalid release list.');
  return releases.filter(release => evaluateRelease(release, currentVersion, experimental))
    .sort((a, b) => isNewerVersion(a.tag_name, b.tag_name) ? -1 : isNewerVersion(b.tag_name, a.tag_name) ? 1 : 0)[0] || null;
}

function checkLatestRelease(currentVersion, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const request = https.get(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Dubline/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, response => {
      if (response.statusCode === 404) { response.resume(); resolve(null); return; }
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`GitHub returned HTTP ${response.statusCode}`)); return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 256 * 1024) request.destroy(new Error('GitHub response is too large.'));
      });
      response.on('end', () => {
        try { resolve(evaluateRelease(JSON.parse(body), currentVersion)); }
        catch (err) { reject(err); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('GitHub update check timed out.')));
    request.once('error', reject);
  });
}

module.exports = { parseVersion, isNewerVersion, evaluateRelease, selectRelease, checkLatestRelease };
