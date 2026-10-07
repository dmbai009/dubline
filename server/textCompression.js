const zlib = require('node:zlib');
function negotiate(header) {
  const qualities = new Map();
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [name, ...parameters] = part.trim().split(';'); if (!name) continue;
    const raw = parameters.find(value => /^\s*q=/.test(value));
    const quality = raw ? Number(raw.trim().slice(2)) : 1;
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const quality = name => qualities.has(name) ? qualities.get(name) : qualities.get('*') || 0;
  return quality('br') > 0 && quality('br') >= quality('gzip') ? 'br' : quality('gzip') > 0 ? 'gzip' : null;
}
function textCompression(req, res, next) {
  if (req.method === 'HEAD' || req.headers.range || /^\/(uploads|packs)(\/|$)/.test(req.path)) return next();
  const encoding = negotiate(req.headers['accept-encoding']);
  const write = res.write.bind(res), end = res.end.bind(res);
  let decided = false, compressor = null;
  function initialize() {
    if (decided) return; decided = true;
    const type = String(res.getHeader('Content-Type') || '').split(';')[0];
    if (!/^(text\/(html|css|plain)|application\/(javascript|json)|image\/svg\+xml)$/.test(type) || res.statusCode < 200 || res.statusCode === 204 || res.statusCode >= 300 || res.headersSent || res.getHeader('Content-Encoding')) return;
    res.vary('Accept-Encoding');
    if (!encoding || /\bno-transform\b/.test(String(res.getHeader('Cache-Control') || ''))) return;
    res.removeHeader('Content-Length'); res.setHeader('Content-Encoding', encoding);
    compressor = encoding === 'br' ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) : zlib.createGzip({ level: 5 });
    compressor.on('data', chunk => { if (!write(chunk)) { compressor.pause(); res.once('drain', () => compressor?.resume()); } });
    compressor.once('end', () => end()); compressor.once('error', error => res.destroy(error));
    res.once('close', () => compressor?.destroy());
    compressor.on('drain', () => res.emit('drain'));
  }
  res.write = (chunk, encodingOrCallback, callback) => {
    initialize(); return compressor ? compressor.write(chunk, encodingOrCallback, callback) : write(chunk, encodingOrCallback, callback);
  };
  res.end = (chunk, encodingOrCallback, callback) => {
    initialize();
    if (!compressor) return end(chunk, encodingOrCallback, callback);
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (done) res.once('finish', done);
    compressor.end(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined); return res;
  };
  next();
}
module.exports = { textCompression, negotiate };
