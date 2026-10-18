// Streaming ZIP64 packaging for stems. Only compressed bytes survive between
// audio windows; neither scene-length PCM nor complete WAV files are retained.
(function(root) {
  const encoder = new TextEncoder();
  const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  function field(value) {
    const text = String(value ?? '');
    return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }
  function timeline(lines, startOf) {
    return 'character\tstart_seconds\tline_id\tcaption\n' + lines.map(line =>
      [line.character, startOf(line).toFixed(3), line.id, line.caption].map(field).join('\t')).join('\n') + '\n';
  }
  function wavHeader(frames, rate = 48000, channels = 2) {
    const size = frames * channels * 2;
    if (!Number.isSafeInteger(frames) || !Number.isSafeInteger(size) || size < 0 || size > 0xffffffff - 36) throw new RangeError('WAV exceeds the RIFF 4 GiB limit');
    const bytes = new Uint8Array(44), view = new DataView(bytes.buffer);
    const text = (at, value) => bytes.set(encoder.encode(value), at);
    text(0, 'RIFF'); view.setUint32(4, 36 + size, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, size, true);
    return bytes;
  }
  const record = size => new DataView(new ArrayBuffer(size));
  const u64 = (view, at, value) => view.setBigUint64(at, BigInt(value), true);

  function createZip() {
    let parts = [], entries = [], offset = 0, busy = false, closed = false;
    // Blob storage can spill to disk; do not keep all compressed typed arrays
    // on the JavaScript heap while the remaining roles are rendered.
    const append = bytes => { parts.push(new Blob([bytes])); offset += bytes.byteLength; };
    return {
      async add(name, chunks) {
        if (closed || busy) throw new Error('Archive is closed or an entry is still being written');
        busy = true;
        const encoded = encoder.encode(name);
        let iterator;
        try {
          if (encoded.length > 65535) throw new RangeError('ZIP filename is too long');
          const compressor = new CompressionStream('deflate-raw');
          const headerOffset = offset;
          // UTF-8 names, data descriptor and ZIP64 sizes (unknown until the
          // producer finishes). The directory carries the final checked sizes.
          const header = record(30 + encoded.length + 20);
          header.setUint32(0, 0x04034b50, true); header.setUint16(4, 45, true);
          header.setUint16(6, 0x808, true); header.setUint16(8, 8, true);
          header.setUint16(12, 33, true); // 1980-01-01
          header.setUint32(18, 0xffffffff, true); header.setUint32(22, 0xffffffff, true);
          header.setUint16(26, encoded.length, true); header.setUint16(28, 20, true);
          new Uint8Array(header.buffer).set(encoded, 30);
          header.setUint16(30 + encoded.length, 1, true); header.setUint16(32 + encoded.length, 16, true);
          append(new Uint8Array(header.buffer));
          let crc = 0xffffffff, size = 0;
          iterator = chunks[Symbol.asyncIterator]?.() || chunks[Symbol.iterator]();
          const source = new ReadableStream({
            async pull(controller) {
              try {
                const next = await iterator.next();
                if (next.done) return controller.close();
                const bytes = next.value;
                for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
                size += bytes.byteLength;
                controller.enqueue(bytes);
              } catch (error) { controller.error(error); }
            },
            cancel() { return iterator.return?.(); }
          });
          const begin = offset;
          for await (const bytes of source.pipeThrough(compressor)) append(bytes);
          const compressed = offset - begin;
          crc = (crc ^ 0xffffffff) >>> 0;
          const descriptor = record(24);
          descriptor.setUint32(0, 0x08074b50, true); descriptor.setUint32(4, crc, true);
          u64(descriptor, 8, compressed); u64(descriptor, 16, size);
          append(new Uint8Array(descriptor.buffer));
          entries.push({ encoded, headerOffset, size, compressed, crc });
        } catch (error) {
          parts = []; entries = []; closed = true;
          await iterator?.return?.();
          throw error;
        } finally { busy = false; }
      },
      finish() {
        if (closed || busy) throw new Error('Archive is closed or an entry is still being written');
        closed = true;
        const start = offset;
        for (const entry of entries) {
          const { encoded, size, compressed, crc, headerOffset } = entry;
          const header = record(46 + encoded.length + 28);
          header.setUint32(0, 0x02014b50, true); header.setUint16(4, 45, true); header.setUint16(6, 45, true);
          header.setUint16(8, 0x808, true); header.setUint16(10, 8, true); header.setUint16(14, 33, true);
          header.setUint32(16, crc, true); header.setUint32(20, 0xffffffff, true); header.setUint32(24, 0xffffffff, true);
          header.setUint16(28, encoded.length, true); header.setUint16(30, 28, true); header.setUint32(42, 0xffffffff, true);
          new Uint8Array(header.buffer).set(encoded, 46);
          const extra = 46 + encoded.length;
          header.setUint16(extra, 1, true); header.setUint16(extra + 2, 24, true);
          u64(header, extra + 4, size); u64(header, extra + 12, compressed); u64(header, extra + 20, headerOffset);
          append(new Uint8Array(header.buffer));
        }
        const directorySize = offset - start, zip64Offset = offset, end = record(98);
        end.setUint32(0, 0x06064b50, true); u64(end, 4, 44); end.setUint16(12, 45, true); end.setUint16(14, 45, true);
        u64(end, 24, entries.length); u64(end, 32, entries.length); u64(end, 40, directorySize); u64(end, 48, start);
        end.setUint32(56, 0x07064b50, true); u64(end, 64, zip64Offset); end.setUint32(72, 1, true);
        end.setUint32(76, 0x06054b50, true); end.setUint16(84, 65535, true); end.setUint16(86, 65535, true);
        end.setUint32(88, 0xffffffff, true); end.setUint32(92, 0xffffffff, true);
        append(new Uint8Array(end.buffer));
        const blob = new Blob(parts, { type: 'application/zip' });
        parts = []; entries = [];
        return blob;
      }
    };
  }
  const api = { timeline, wavHeader, createZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineStemArchive = api;
})(typeof window === 'undefined' ? globalThis : window);
