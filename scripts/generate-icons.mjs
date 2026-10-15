// Generates simple PNG app icons without external dependencies.
// Draws a dark rounded square with three ascending accent bars.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [15, 17, 21];
const ACCENT = [74, 222, 128];
const PANEL = [30, 34, 42];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function render(size, { rounded }) {
  const r = rounded ? size * 0.18 : 0;
  const pixel = (x, y) => {
    // Rounded-corner mask
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    if (rounded && (x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];
    // Inner panel (safe zone for maskable icons)
    const m = size * 0.2;
    if (x < m || x > size - m || y < m || y > size - m) return [...BG, 255];
    const inner = size - 2 * m;
    const barW = inner / 5;
    const heights = [0.4, 0.65, 0.9];
    for (let i = 0; i < 3; i++) {
      const left = m + barW * 0.5 + i * barW * 1.5;
      if (x >= left && x < left + barW) {
        const top = size - m - inner * heights[i];
        if (y >= top) return [...ACCENT, 255];
      }
    }
    return [...PANEL, 255];
  };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const p = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = p[0];
      raw[o + 1] = p[1];
      raw[o + 2] = p[2];
      raw[o + 3] = p[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync('public/pwa-192x192.png', render(192, { rounded: false }));
writeFileSync('public/pwa-512x512.png', render(512, { rounded: false }));
writeFileSync('public/apple-touch-icon.png', render(180, { rounded: false }));
console.log('Icons written to public/');
