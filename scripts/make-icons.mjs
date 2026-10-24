// Draws a paw-print icon on a solid background and writes PNGs with a
// minimal built-in PNG encoder (zlib deflate). No external deps.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  // pixels: Uint8Array RGB size*size; add filter byte 0 per row
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function render(size, { fullBleed }) {
  const px = Buffer.alloc(size * size * 3);
  const bg = [16, 185, 129];      // #10b981
  const fg = [6, 40, 28];         // dark green paw
  const pad = fullBleed ? Math.round(size * 0.18) : Math.round(size * 0.10);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2];
      const u = (x - size / 2) / size, v = (y - size / 2) / size;
      let on = false;
      // main pad
      on = on || inEllipse(u, v, 0, 0.16, 0.24, 0.20);
      // four toes
      on = on || inEllipse(u, v, -0.28, -0.10, 0.105, 0.135);
      on = on || inEllipse(u, v, -0.10, -0.24, 0.105, 0.135);
      on = on || inEllipse(u, v, 0.10, -0.24, 0.105, 0.135);
      on = on || inEllipse(u, v, 0.28, -0.10, 0.105, 0.135);
      if (on) { px[i] = fg[0]; px[i + 1] = fg[1]; px[i + 2] = fg[2]; }
      // maskable: keep art inside safe radius
      if (!fullBleed) {
        const r = Math.hypot(x - size / 2, y - size / 2);
        if (r > size / 2 - pad) { px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; }
      }
    }
  }
  return px;
}

mkdirSync(join(root, 'public/icons'), { recursive: true });
writeFileSync(join(root, 'public/icons/icon-192.png'), png(192, render(192, { fullBleed: false })));
writeFileSync(join(root, 'public/icons/icon-512.png'), png(512, render(512, { fullBleed: false })));
writeFileSync(join(root, 'public/icons/icon-maskable-512.png'), png(512, render(512, { fullBleed: true })));
console.log('icons written');
