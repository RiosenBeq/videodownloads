/**
 * Renders the extension icons (16/32/48/128 px PNG) with signed-distance
 * shapes: a rounded square with a blue→violet gradient and a white
 * "play + download" glyph. No image libraries needed — only zlib.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance helpers in a unit square (0..1).
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdSegment = (x, y, ax, ay, bx, by, r) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
};
const sdTriangle = (x, y, p0, p1, p2) => {
  const e0 = [p1[0] - p0[0], p1[1] - p0[1]], e1 = [p2[0] - p1[0], p2[1] - p1[1]], e2 = [p0[0] - p2[0], p0[1] - p2[1]];
  const v0 = [x - p0[0], y - p0[1]], v1 = [x - p1[0], y - p1[1]], v2 = [x - p2[0], y - p2[1]];
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const proj = (v, e) => {
    const t = clamp((v[0] * e[0] + v[1] * e[1]) / (e[0] * e[0] + e[1] * e[1]));
    return [v[0] - e[0] * t, v[1] - e[1] * t];
  };
  const pq0 = proj(v0, e0), pq1 = proj(v1, e1), pq2 = proj(v2, e2);
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const d = Math.min(
    Math.min(pq0[0] ** 2 + pq0[1] ** 2, pq1[0] ** 2 + pq1[1] ** 2),
    pq2[0] ** 2 + pq2[1] ** 2,
  );
  const sgn = Math.min(
    Math.min(s * (v0[0] * e0[1] - v0[1] * e0[0]), s * (v1[0] * e1[1] - v1[1] * e1[0])),
    s * (v2[0] * e2[1] - v2[1] * e2[0]),
  );
  return -Math.sqrt(d) * Math.sign(sgn);
};

function render(size) {
  const ss = 4; // supersampling
  const data = Buffer.alloc(size * size * 4);
  const top = [0x5b, 0x8c, 0xff];
  const bottom = [0x8b, 0x5c, 0xf6];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const inset = size <= 16 ? 0.02 : 0.04;
          const bg = sdRoundRect(x, y, 0.5, 0.5, 0.5 - inset, 0.5 - inset, 0.23);
          if (bg > 0) continue;
          const t = (x + y) / 2;
          let cr = top[0] + (bottom[0] - top[0]) * t;
          let cg = top[1] + (bottom[1] - top[1]) * t;
          let cb = top[2] + (bottom[2] - top[2]) * t;
          // soft top highlight
          const hl = Math.max(0, 0.35 - y) * 0.5;
          cr += (255 - cr) * hl; cg += (255 - cg) * hl; cb += (255 - cb) * hl;
          // glyph: play triangle + download tray
          const stroke = size <= 16 ? 0.075 : 0.055;
          const play = sdTriangle(x, y, [0.39, 0.25], [0.39, 0.57], [0.66, 0.41]);
          const tray = Math.min(
            sdSegment(x, y, 0.27, 0.68, 0.27, 0.75, stroke / 2),
            sdSegment(x, y, 0.27, 0.75, 0.73, 0.75, stroke / 2),
            sdSegment(x, y, 0.73, 0.75, 0.73, 0.68, stroke / 2),
          );
          const glyph = Math.min(play - 0.012, tray);
          if (glyph < 0) { cr = 255; cg = 255; cb = 255; }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const i = (py * size + px) * 4;
      // Color is the mean over covered samples; alpha is the coverage.
      const covered = a / 255;
      data[i] = covered ? Math.round(r / covered) : 0;
      data[i + 1] = covered ? Math.round(g / covered) : 0;
      data[i + 2] = covered ? Math.round(b / covered) : 0;
      data[i + 3] = Math.round(a / (ss * ss));
    }
  }
  return png(size, data);
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), render(size));
}
console.log(`Icons written to ${outDir}`);
