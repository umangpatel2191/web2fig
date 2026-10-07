// Dependency-free PNG icon generator. Draws the same mark as shared/brand.ts (gradient tile, four frame corners,
// two stacked layers) on a 64×64 grid with 4×4 supersampling.
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/* ---- shapes in 64-unit space ---- */
function roundedRect(x, y, x0, y0, w, h, r) {
  const dx = Math.abs(x - (x0 + w / 2)) - (w / 2 - r);
  const dy = Math.abs(y - (y0 + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) <= r;
}

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** A rounded frame corner: arm → quarter arc → arm, as a polyline thick enough to look like a stroke. */
function bracket(corner, arm, r) {
  // corner = [cx, cy, sx, sy]: the sharp corner point and the direction both arms extend towards (-1/+1)
  const [cx, cy, sx, sy] = corner;
  const pts = [[cx, cy + sy * arm]];
  pts.push([cx, cy + sy * r]);
  for (let i = 1; i < 8; i++) {
    const a = (Math.PI / 2) * (i / 8);
    pts.push([cx + sx * (r - r * Math.cos(a)), cy + sy * (r - r * Math.sin(a))]);
  }
  pts.push([cx + sx * r, cy]);
  pts.push([cx + sx * arm, cy]);
  return pts;
}
const BRACKETS = [
  bracket([17, 17, 1, 1], 10, 4),
  bracket([47, 17, -1, 1], 10, 4),
  bracket([47, 47, -1, -1], 10, 4),
  bracket([17, 47, 1, -1], 10, 4),
];
const STROKE = 2.2;

function inBrackets(x, y) {
  for (const pts of BRACKETS) {
    for (let i = 1; i < pts.length; i++) if (segDist(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= STROKE) return true;
  }
  return false;
}

const mix = (a, b, t) => a + (b - a) * t;

export function png(size) {
  const SS = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 64;
          const y = ((py + (sy + 0.5) / SS) / size) * 64;
          if (!roundedRect(x, y, 0, 0, 64, 64, 15)) continue;
          // diagonal brand gradient #5B5CF6 → #9B4DF0 + a soft top highlight
          const t = Math.max(0, Math.min(1, ((x - 6) * 52 + (y - 4) * 56) / (52 * 52 + 56 * 56)));
          let cr = mix(0x5b, 0x9b, t), cg = mix(0x5c, 0x4d, t), cb = mix(0xf6, 0xf0, t);
          const hl = Math.max(0, 1 - y / 40) * 0.28;
          cr = mix(cr, 255, hl); cg = mix(cg, 255, hl); cb = mix(cb, 255, hl);
          let white = 0;
          if (inBrackets(x, y)) white = 1;
          if (roundedRect(x, y, 29.5, 29.5, 14, 14, 3.4)) white = 1;
          else if (roundedRect(x, y, 25.5, 25.5, 14, 14, 3.4)) white = Math.max(white, 0.5);
          cr = mix(cr, 255, white); cg = mix(cg, 255, white); cb = mix(cb, 255, white);
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = SS * SS;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const cov = a / 255;
      raw[o] = cov ? Math.round(r / cov) : 0;
      raw[o + 1] = cov ? Math.round(g / cov) : 0;
      raw[o + 2] = cov ? Math.round(b / cov) : 0;
      raw[o + 3] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
