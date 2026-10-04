const { HttpError } = require('./config');

const WORKSHOP_HOSTS = new Set(['voxalike.com', 'www.voxalike.com']);

function parseWorkshopUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new HttpError(400, 'Enter a valid Voxalike workshop URL', 'error.workshopUrl');
  }
  if (url.protocol !== 'https:' || !WORKSHOP_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
    throw new HttpError(400, 'Only HTTPS links from voxalike.com/workshop are allowed', 'error.workshopUrl');
  }
  // Packs live at /workshop/<pack> or, inside a category, /workshop/<category>/<pack>
  const SEGMENT = '[a-z0-9][a-z0-9_-]{0,79}';
  const match = url.pathname.match(new RegExp(`^/workshop/(${SEGMENT}(?:/${SEGMENT})?)(?:/download)?/?$`, 'i'));
  if (!match) throw new HttpError(400, 'Enter a Voxalike workshop pack link', 'error.workshopUrl');
  const slug = match[1].toLowerCase().replace(/\/download$/, '');
  if (slug === 'download' || slug.startsWith('creators/')) throw new HttpError(400, 'Enter a Voxalike workshop pack link', 'error.workshopUrl');
  return {
    slug,
    filename: `voxalike-${slug.replace('/', '--')}.zip`,
    downloadUrl: `https://voxalike.com/workshop/${slug}/download`
  };
}

function assertAllowedDownloadUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !WORKSHOP_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
    throw new HttpError(502, 'Voxalike redirected the download to an unsupported address', 'error.workshopDownload');
  }
  return url;
}

async function downloadVoxalikePack(downloadUrl, maxBytes, fetchImpl = global.fetch) {
  let current = assertAllowedDownloadUrl(downloadUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(45_000) });
    } catch (err) {
      throw new HttpError(502, `Could not download the Voxalike pack: ${err.message}`, 'error.workshopDownload');
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new HttpError(502, 'Too many Voxalike download redirects', 'error.workshopDownload');
      current = assertAllowedDownloadUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok || !response.body) throw new HttpError(502, `Voxalike returned HTTP ${response.status}`, 'error.workshopDownload');

    const advertised = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertised) && advertised > maxBytes) {
      throw new HttpError(413, 'The workshop pack is too large', 'error.fileTooBig', { max: Math.floor(maxBytes / 1024 / 1024) });
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) {
          if (typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {});
          throw new HttpError(413, 'The workshop pack is too large', 'error.fileTooBig', { max: Math.floor(maxBytes / 1024 / 1024) });
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `The Voxalike download was interrupted: ${err.message}`, 'error.workshopDownload');
    }
    return Buffer.concat(chunks, total);
  }
  throw new HttpError(502, 'Could not follow the Voxalike download', 'error.workshopDownload');
}

module.exports = { parseWorkshopUrl, downloadVoxalikePack };
