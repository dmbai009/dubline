const https = require('https');

const RELEASE_API = 'https://api.github.com/repos/dmbai009/dubline/releases/latest';
const RELEASE_BASE = 'https://github.com/dmbai009/dubline/releases/tag/';

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/);
  return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

function evaluateRelease(release, currentVersion) {
  if (!release || release.draft || release.prerelease || !isNewerVersion(release.tag_name, currentVersion)) return null;
  const tag = String(release.tag_name || '').trim();
  if (!/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) return null;
  return {
    version: tag.replace(/^v/i, ''),
    url: `${RELEASE_BASE}${encodeURIComponent(tag)}`
  };
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

module.exports = { parseVersion, isNewerVersion, evaluateRelease, checkLatestRelease };
