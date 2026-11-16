// SKYWHALE — "the ocean learned to fly" (ai-excited-01)
// A colossal blue whale flying diagonally across a burning sunset sky above a
// tiny city skyline. Drawn procedurally, pixel by pixel, with no assets.
// Deterministic: fixed-seed PRNG, fixed iteration order, no Date, no Math.random,
// no network. Both runs write byte-identical PNGs.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;
const SS = 2; // supersample factor; downsampled for clean anti-aliased edges
const SW = W * SS;
const SH = H * SS;

// ---------------------------------------------------------------- PRNG (mulberry32, fixed seed)
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261116);

// ---------------------------------------------------------------- pixel buffer (RGB, supersampled)
const buf = new Uint8Array(SW * SH * 3);

function setPx(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= SW || y >= SH) return;
  const i = (y * SW + x) * 3;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
}

function blendPx(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || y < 0 || x >= SW || y >= SH || a <= 0) return;
  if (a >= 1) {
    setPx(x, y, r, g, b);
    return;
  }
  const i = (y * SW + x) * 3;
  buf[i] = Math.round(buf[i] * (1 - a) + r * a);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + g * a);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + b * a);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

type RGB = [number, number, number];

function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return [
    clamp255(a[0] + (b[0] - a[0]) * t),
    clamp255(a[1] + (b[1] - a[1]) * t),
    clamp255(a[2] + (b[2] - a[2]) * t),
  ];
}

// ---------------------------------------------------------------- filled shapes
// Soft-edged filled circle in 1024-space coords (scaled by SS internally).
function disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  const x0 = Math.max(0, Math.floor((cx - r) * SS));
  const x1 = Math.min(SW - 1, Math.ceil((cx + r) * SS));
  const y0 = Math.max(0, Math.floor((cy - r) * SS));
  const y1 = Math.min(SH - 1, Math.ceil((cy + r) * SS));
  const rr = r * SS;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5) / SS - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) / SS - cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= rr / SS) {
        // 1px soft edge in 1024-space
        const edge = Math.min(1, (r - d) / 1.2 + 0.25);
        blendPx(x, y, c[0], c[1], c[2], a * Math.max(0, Math.min(1, edge)));
      }
    }
  }
}

// Filled ellipse, rotated by angle (radians), soft edge.
function ellipse(cx: number, cy: number, rx: number, ry: number, angle: number, c: RGB, a = 1): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rad = Math.max(rx, ry) + 2;
  const x0 = Math.max(0, Math.floor((cx - rad) * SS));
  const x1 = Math.min(SW - 1, Math.ceil((cx + rad) * SS));
  const y0 = Math.max(0, Math.floor((cy - rad) * SS));
  const y1 = Math.min(SH - 1, Math.ceil((cy + rad) * SS));
  for (let y = y0; y <= y1; y++) {
    const py = (y + 0.5) / SS - cy;
    for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) / SS - cx;
      const u = (px * cos + py * sin) / rx;
      const v = (-px * sin + py * cos) / ry;
      const d = u * u + v * v;
      if (d <= 1) {
        const edge = Math.min(1, (1 - Math.sqrt(d)) * 14 + 0.3);
        blendPx(x, y, c[0], c[1], c[2], a * Math.max(0, Math.min(1, edge)));
      }
    }
  }
}

// Thick line (round caps) through two points, 1024-space coords.
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a = 1): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len * SS / 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, c, a);
  }
}

// Quadratic bezier point.
function qbez(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

// Tapered ribbon along a quadratic bezier: circles of shrinking radius.
function ribbon(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number,
  w0: number, w1: number, c: RGB, a: number): void {
  const steps = 90;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const w = w0 + (w1 - w0) * t;
    disc(qbez(x0, cx, x1, t), qbez(y0, cy, y1, t), w / 2, c, a * (1 - t * 0.35));
  }
}

// ---------------------------------------------------------------- sky gradient
const SKY_STOPS: Array<[number, RGB]> = [
  [0.0, [16, 14, 46]], // deep indigo
  [0.3, [52, 24, 88]],
  [0.5, [138, 30, 96]], // magenta
  [0.66, [224, 74, 54]], // burning orange-red
  [0.8, [255, 150, 44]], // gold
  [1.0, [255, 205, 66]], // bright gold horizon
];

function skyColor(y01: number): RGB {
  for (let i = 1; i < SKY_STOPS.length; i++) {
    if (y01 <= SKY_STOPS[i][0]) {
      const [t0, c0] = SKY_STOPS[i - 1];
      const [t1, c1] = SKY_STOPS[i];
      return lerpColor(c0, c1, (y01 - t0) / (t1 - t0));
    }
  }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}

for (let y = 0; y < SH; y++) {
  const c = skyColor(y / SH);
  const row = y * SW * 3;
  for (let x = 0; x < SW; x++) {
    const i = row + x * 3;
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
  }
}

// ---------------------------------------------------------------- sun + glow
const SUN: { x: number; y: number; r: number } = { x: 690, y: 445, r: 152 };
// Warm glow around the sun (per-pixel falloff, bounded box).
{
  const R = 460;
  const x0 = Math.max(0, Math.floor((SUN.x - R) * SS));
  const x1 = Math.min(SW - 1, Math.ceil((SUN.x + R) * SS));
  const y0 = Math.max(0, Math.floor((SUN.y - R) * SS));
  const y1 = Math.min(SH - 1, Math.ceil((SUN.y + R) * SS));
  for (let y = y0; y <= y1; y++) {
    const py = (y + 0.5) / SS - SUN.y;
    for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) / SS - SUN.x;
      const d = Math.sqrt(px * px + py * py);
      if (d < R) {
        const f = Math.pow(1 - d / R, 2.2) * 0.85;
        const i = (y * SW + x) * 3;
        buf[i] = clamp255(buf[i] + (255 - buf[i]) * f * 0.75);
        buf[i + 1] = clamp255(buf[i + 1] + (176 - buf[i + 1]) * f * 0.6);
        buf[i + 2] = clamp255(buf[i + 2] + (70 - buf[i + 2]) * f * 0.35);
      }
    }
  }
}
// Sun disc: bright core, warm rim.
disc(SUN.x, SUN.y, SUN.r, [255, 196, 92]);
disc(SUN.x, SUN.y, SUN.r * 0.72, [255, 226, 150]);
disc(SUN.x, SUN.y, SUN.r * 0.45, [255, 246, 214]);

// ---------------------------------------------------------------- clouds (soft warm ellipses, behind the whale)
const CLOUDS: Array<[number, number, number, number, number, RGB, number]> = [
  // [cx, cy, rx, ry, tilt, color, alpha] — thin wispy streak clouds, two puffs each
  [230, 250, 170, 10, 0.05, [255, 150, 120], 0.22],
  [300, 282, 120, 8, -0.04, [255, 120, 110], 0.2],
  [760, 150, 200, 11, 0.03, [255, 140, 130], 0.22],
  [880, 600, 150, 9, -0.05, [255, 170, 110], 0.2],
  [120, 560, 130, 8, 0.04, [230, 110, 130], 0.18],
  [520, 115, 130, 8, 0.02, [255, 160, 140], 0.2],
];
for (const [cx, cy, rx, ry, tilt, c, a] of CLOUDS) {
  ellipse(cx, cy, rx, ry, tilt, c, a);
  ellipse(cx + rx * 0.35, cy - ry * 0.55, rx * 0.55, ry * 0.8, tilt, c, a * 0.8);
}

// ---------------------------------------------------------------- city skyline (thin dark strip, tiny lit windows)
const CITY_TOP = 872;
{
  let x = -10;
  while (x < W + 10) {
    const bw = 26 + rand() * 54;
    const bh = 40 + rand() * 118;
    const top = CITY_TOP + (118 - bh);
    const shade = 8 + Math.floor(rand() * 10);
    const c: RGB = [shade + 4, shade, shade + 14];
    // building body
    const bx0 = Math.floor(x * SS);
    const bx1 = Math.min(SW, Math.ceil((x + bw) * SS));
    const by0 = Math.floor(top * SS);
    for (let yy = by0; yy < SH; yy++) {
      for (let xx = bx0; xx < bx1; xx++) {
        const i = (yy * SW + xx) * 3;
        buf[i] = c[0];
        buf[i + 1] = c[1];
        buf[i + 2] = c[2];
      }
    }
    // antenna on some towers
    if (rand() < 0.3) {
      thickLine(x + bw / 2, top, x + bw / 2, top - 22, 2, c);
      disc(x + bw / 2, top - 24, 2.5, [255, 70, 60]);
    }
    // lit windows
    const cols = Math.floor(bw / 12);
    const rows = Math.floor(bh / 16);
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        if (rand() < 0.42) {
          const wx = x + 5 + col * 12;
          const wy = top + 7 + r * 16;
          const warm: RGB = rand() < 0.75 ? [255, 205, 110] : [150, 220, 255];
          for (let yy = Math.floor(wy * SS); yy < Math.floor((wy + 5) * SS); yy++) {
            for (let xx = Math.floor(wx * SS); xx < Math.floor((wx + 4) * SS); xx++) {
              if (xx >= 0 && xx < SW && yy >= 0 && yy < SH) {
                const i = (yy * SW + xx) * 3;
                buf[i] = warm[0];
                buf[i + 1] = warm[1];
                buf[i + 2] = warm[2];
              }
            }
          }
        }
      }
    }
    x += bw + 2 + rand() * 8;
  }
}

// ---------------------------------------------------------------- the whale
// Spine: quadratic bezier from tail (lower left) to head (upper right).
const SPINE: { x0: number; y0: number; cx: number; cy: number; x1: number; y1: number } =
  { x0: 120, y0: 790, cx: 430, cy: 730, x1: 860, y1: 340 };
const BODY: RGB = [26, 84, 158]; // deep ocean blue
const BODY_DARK: RGB = [16, 58, 118];
const BELLY: RGB = [158, 206, 242]; // pale belly
const FIN: RGB = [18, 66, 128];

// Tail fluke first (behind the body, sticking out past the tail tip).
ellipse(88, 742, 82, 26, -0.85, FIN);
ellipse(84, 828, 78, 24, 0.8, FIN);

// Body: overlapping discs along the spine, radius tapering to both ends.
const SPINE_STEPS = 140;
function spinePoint(t: number): [number, number] {
  return [qbez(SPINE.x0, SPINE.cx, SPINE.x1, t), qbez(SPINE.y0, SPINE.cy, SPINE.y1, t)];
}
function spineRadius(t: number): number {
  return 132 * Math.sin(Math.PI * (0.08 + 0.84 * t));
}
for (let i = 0; i <= SPINE_STEPS; i++) {
  const t = i / SPINE_STEPS;
  const [px, py] = spinePoint(t);
  const r = spineRadius(t);
  // shade: darker toward the tail, brighter toward the sunlit head
  const c = lerpColor(BODY_DARK, BODY, Math.min(1, t * 1.15));
  disc(px, py, Math.max(6, r), c);
}
// Pale belly: smaller discs hugging the lower edge only.
for (let i = 0; i <= SPINE_STEPS; i++) {
  const t = i / SPINE_STEPS;
  const [px, py] = spinePoint(t);
  const r = spineRadius(t);
  // local spine direction -> downward normal
  const dx = 2 * (1 - t) * (SPINE.cx - SPINE.x0) + 2 * t * (SPINE.x1 - SPINE.cx);
  const dy = 2 * (1 - t) * (SPINE.cy - SPINE.y0) + 2 * t * (SPINE.y1 - SPINE.cy);
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  // ny is positive (downward) for this spine direction; keep the belly below
  const off = 0.5 * r;
  disc(px + nx * off, py + Math.abs(ny) * off, 0.45 * r, BELLY, 0.95);
}
// Back highlight along the top edge (sunlit rim).
for (let i = 0; i <= SPINE_STEPS; i += 2) {
  const t = i / SPINE_STEPS;
  const [px, py] = spinePoint(t);
  const r = spineRadius(t);
  disc(px, py - 0.55 * r, 0.42 * r, [64, 140, 214], 0.25);
}
// Pectoral fin, sweeping down from mid-body and jutting below the belly line.
{
  const [fx, fy] = spinePoint(0.58);
  const fr = spineRadius(0.58);
  ellipse(fx + 18, fy + fr * 0.62, 98, 24, 0.58, FIN);
}
// Eye: bright, clear, looking forward.
disc(812, 352, 15, [255, 255, 255]);
disc(816, 352, 8, [10, 16, 30]);
disc(819, 349, 3, [255, 255, 255]);
// Smile line under the head.
thickLine(830, 384, 882, 370, 4, [12, 48, 100], 0.9);

// ---------------------------------------------------------------- water ribbons streaming off the whale
const RIBBON: RGB = [127, 227, 255];
// Curved streams peeling off the belly and trailing back down toward the sea.
ribbon(400, 830, 300, 890, 235, 905, 15, 4, RIBBON, 0.8);
ribbon(520, 800, 430, 885, 375, 905, 12, 3, RIBBON, 0.75);
ribbon(280, 830, 195, 885, 150, 895, 11, 3, RIBBON, 0.75);
ribbon(620, 700, 565, 800, 530, 880, 10, 3, RIBBON, 0.7);
// Droplets flung from the ribbons (fixed positions, deterministic).
const DROPS: Array<[number, number, number]> = [
  [228, 908, 4], [252, 880, 3.5], [368, 908, 4], [388, 880, 3],
  [146, 898, 3.5], [168, 872, 3], [526, 888, 3.5], [516, 862, 2.5],
  [300, 860, 3], [560, 810, 2.5],
];
for (const [dx, dy, dr] of DROPS) disc(dx, dy, dr, [190, 240, 255], 0.9);

// ---------------------------------------------------------------- birds scattering
function bird(x: number, y: number, s: number): void {
  thickLine(x - 11 * s, y, x, y - 7 * s, 3.5 * s, [20, 14, 40]);
  thickLine(x, y - 7 * s, x + 11 * s, y, 3.5 * s, [20, 14, 40]);
}
bird(920, 210, 1.2);
bird(965, 290, 1.0);
bird(860, 150, 0.9);
bird(985, 380, 1.1);
bird(895, 320, 0.8);

// ---------------------------------------------------------------- caption: hand-built 5x7 pixel font
const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '10001', '01110', '00100', '00100', '00100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function drawText(text: string, x0: number, y0: number, scale: number, c: RGB): void {
  let x = x0;
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) {
      x += 6 * scale;
      continue;
    }
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row][col] === '1') {
          const px0 = Math.floor((x + col * scale) * SS);
          const py0 = Math.floor((y0 + row * scale) * SS);
          for (let yy = py0; yy < py0 + scale * SS; yy++) {
            for (let xx = px0; xx < px0 + scale * SS; xx++) {
              setPx(xx, yy, c[0], c[1], c[2]);
            }
          }
        }
      }
    }
    x += 6 * scale;
  }
}

const CAPTION = 'THE OCEAN LEARNED TO FLY';
const CAP_SCALE = 5;
const CAP_W = CAPTION.length * 6 * CAP_SCALE - CAP_SCALE;
const CAP_X = Math.floor((W - CAP_W) / 2);
const CAP_Y = 940;
// A dusk-dark band behind the caption so it reads over the lit city.
for (let yy = 918 * SS; yy < SH; yy++) {
  const a = 0.55 * Math.min(1, (yy / SS - 918) / 30 + 0.25);
  for (let xx = 0; xx < SW; xx++) {
    blendPx(xx, yy, 12, 8, 32, a);
  }
}
// Dark shadow first (offset), then bright gold-white on top.
drawText(CAPTION, CAP_X + 4, CAP_Y + 4, CAP_SCALE, [10, 6, 28]);
drawText(CAPTION, CAP_X, CAP_Y, CAP_SCALE, [255, 236, 170]);

// ---------------------------------------------------------------- downsample 2x -> 1024x1024 RGB
const out = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * SW + x * SS + dx) * 3;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
      }
    }
    const o = (y * W + x) * 3;
    out[o] = Math.round(r / (SS * SS));
    out[o + 1] = Math.round(g / (SS * SS));
    out[o + 2] = Math.round(b / (SS * SS));
  }
}

// ---------------------------------------------------------------- PNG encode (zlib deflate + CRC32, stdlib only)
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0; // filter: none
  out.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
}
const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
