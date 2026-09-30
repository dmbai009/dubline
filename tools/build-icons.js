// Build browser PNG icons and a multi-resolution Windows ICO from icon.png.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const root = path.join(__dirname, '..');
const source = path.join(root, 'icon.png');
const buildDir = path.join(root, 'build');
const publicDir = path.join(root, 'public');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

if (!fs.existsSync(source)) {
  throw new Error(`Icon source not found: ${source}`);
}

fs.mkdirSync(buildDir, { recursive: true });
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-icons-'));

function renderPng(size, target) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-vf', `scale=${size}:${size}:flags=lanczos`,
    '-frames:v', '1',
    target
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Could not render ${size}px icon: ${result.stderr || result.error?.message || 'ffmpeg failed'}`);
  }
}

function renderBgra(size) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', source,
    '-vf', `scale=${size}:${size}:flags=lanczos`,
    '-frames:v', '1',
    '-pix_fmt', 'bgra',
    '-f', 'rawvideo',
    'pipe:1'
  ], { maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0 || result.stdout.length !== size * size * 4) {
    throw new Error(`Could not render ${size}px Windows icon: ${String(result.stderr || result.error?.message || 'ffmpeg failed')}`);
  }
  return result.stdout;
}

function createDibFrame(size, pixels) {
  const pixelStride = size * 4;
  const xorBitmap = Buffer.alloc(pixelStride * size);
  const maskStride = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskStride * size);

  // Windows DIB icon rows are stored bottom-up. The AND mask remains useful to
  // older Shell drawing paths even though the 32-bit pixels also carry alpha.
  for (let row = 0; row < size; row++) {
    const sourceRow = size - 1 - row;
    pixels.copy(xorBitmap, row * pixelStride, sourceRow * pixelStride, (sourceRow + 1) * pixelStride);
    for (let x = 0; x < size; x++) {
      const alpha = pixels[sourceRow * pixelStride + x * 4 + 3];
      if (alpha === 0) andMask[row * maskStride + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
    }
  }

  const bitmapInfo = Buffer.alloc(40);
  bitmapInfo.writeUInt32LE(40, 0);
  bitmapInfo.writeInt32LE(size, 4);
  bitmapInfo.writeInt32LE(size * 2, 8);
  bitmapInfo.writeUInt16LE(1, 12);
  bitmapInfo.writeUInt16LE(32, 14);
  bitmapInfo.writeUInt32LE(xorBitmap.length, 20);
  return Buffer.concat([bitmapInfo, xorBitmap, andMask]);
}

try {
  const pngs = new Map(sizes.map(size => {
    const target = path.join(tempDir, `${size}.png`);
    renderPng(size, target);
    return [size, target];
  }));

  const images = sizes.map(size => ({ size, data: createDibFrame(size, renderBgra(size)) }));

  // Classic DIB frames are intentionally used instead of PNG-compressed frames:
  // Explorer's Details view still has drawing paths that ignore tiny PNG frames.
  const headerSize = 6 + images.length * 16;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, ...images.map(image => image.data)]));
  fs.copyFileSync(pngs.get(64), path.join(publicDir, 'icon-64.png'));
  fs.copyFileSync(pngs.get(256), path.join(publicDir, 'icon-256.png'));
  console.log('Built build/icon.ico and browser icons from icon.png');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
