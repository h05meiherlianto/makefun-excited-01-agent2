// SKYWHALE: the ocean learned to fly
// Procedural 1024x1024 PNG renderer. Node 22 stdlib only (fs, path, zlib).
// Fully deterministic: fixed-seed PRNG, fixed iteration order, no clock, no network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;
const SS = 2; // supersample factor
const SW = W * SS;
const SH = H * SS;

// ---- fixed-seed PRNG (mulberry32) ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261116);

// ---- pixel buffer (supersampled RGB) ----
const buf = new Uint8Array(SW * SH * 3);

function clamp255(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : v; }

function px(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= SW || y >= SH) return;
  const i = (y * SW + x) * 3;
  buf[i] = clamp255(r); buf[i + 1] = clamp255(g); buf[i + 2] = clamp255(b);
}

function blendPx(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= SW || y >= SH) return;
  const i = (y * SW + x) * 3;
  if (a >= 1) { buf[i] = clamp255(r); buf[i + 1] = clamp255(g); buf[i + 2] = clamp255(b); return; }
  buf[i] = clamp255(buf[i] * (1 - a) + r * a);
  buf[i + 1] = clamp255(buf[i + 1] * (1 - a) + g * a);
  buf[i + 2] = clamp255(buf[i + 2] * (1 - a) + b * a);
}

type RGB = [number, number, number];
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

// ---- filled ellipse (axis-aligned), with optional rotation via rx/ry swap trick ----
function ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(SW - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(SH - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y - cy) / ry;
    const dx = Math.sqrt(Math.max(0, 1 - dy * dy));
    const xa = Math.max(x0, Math.ceil(cx - dx * rx));
    const xb = Math.min(x1, Math.floor(cx + dx * rx));
    for (let x = xa; x <= xb; x++) blendPx(x, y, c[0], c[1], c[2], a);
  }
}

// Rotated ellipse: draw by sampling the rotated frame.
function ellipseRot(cx: number, cy: number, rx: number, ry: number, ang: number, c: RGB, a = 1): void {
  const ca = Math.cos(ang); const sa = Math.sin(ang);
  const R = Math.max(rx, ry);
  const x0 = Math.max(0, Math.floor(cx - R));
  const x1 = Math.min(SW - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R));
  const y1 = Math.min(SH - 1, Math.ceil(cy + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx; const dy = y - cy;
      const u = (dx * ca + dy * sa) / rx;
      const v = (-dx * sa + dy * ca) / ry;
      if (u * u + v * v <= 1) blendPx(x, y, c[0], c[1], c[2], a);
    }
  }
}

function disc(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  ellipse(cx, cy, r, r, c, a);
}

// Thick line as a chain of discs.
function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a = 1): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, w * 0.5)) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    disc(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, c, a);
  }
}

// Quadratic bezier ribbon with tapering width (overlapping discs: no beading).
function ribbon(p0: [number, number], p1: [number, number], p2: [number, number], w0: number, w1: number, c: RGB, a: number): void {
  const len = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) + Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const steps = Math.max(60, Math.ceil(len / 3));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    const w = lerp(w0, w1, t);
    disc(x, y, Math.max(0.6, w / 2), c, a * (1 - t * 0.55));
  }
}

// ---------------- SKY ----------------
const SKY_TOP: RGB = [26, 16, 74];      // deep indigo
const SKY_MID: RGB = [122, 38, 120];    // magenta
const SKY_LOW: RGB = [232, 96, 64];     // burning orange
const SKY_HOR: RGB = [255, 196, 92];    // gold at horizon

for (let y = 0; y < SH; y++) {
  const t = y / SH;
  let c: RGB;
  if (t < 0.42) c = lerpColor(SKY_TOP, SKY_MID, t / 0.42);
  else if (t < 0.72) c = lerpColor(SKY_MID, SKY_LOW, (t - 0.42) / 0.30);
  else c = lerpColor(SKY_LOW, SKY_HOR, (t - 0.72) / 0.28);
  for (let x = 0; x < SW; x++) px(x, y, c[0], c[1], c[2]);
}

// Stars in the deep indigo top.
for (let i = 0; i < 90; i++) {
  const x = rnd() * SW;
  const y = rnd() * SH * 0.30;
  const b = 150 + rnd() * 105;
  const s = rnd() < 0.2 ? 2 : 1;
  disc(x, y, s, [b, b, 255], 0.55 + rnd() * 0.4);
}

// ---------------- SUN (behind whale head) ----------------
const SUN: [number, number] = [1280, 1050]; // supersampled coords (640, 525)
for (let r = 560; r > 0; r -= 8) {
  const t = 1 - r / 560;
  const glow: RGB = lerpColor([255, 214, 130], [255, 120, 60], t);
  disc(SUN[0], SUN[1], r, glow, 0.10);
}
disc(SUN[0], SUN[1], 250, [255, 226, 150], 1);
disc(SUN[0], SUN[1], 228, [255, 240, 196], 1);

// ---------------- CLOUDS (wispy, lit by sunset) ----------------
const cloudCols: RGB[] = [[255, 170, 150], [255, 200, 180], [200, 120, 170]];
for (let i = 0; i < 14; i++) {
  const cx = rnd() * SW;
  const cy = SH * (0.08 + rnd() * 0.55);
  const len = 120 + rnd() * 260;
  const col = cloudCols[i % 3];
  const a = 0.16 + rnd() * 0.16;
  for (let k = 0; k < 5; k++) {
    ellipse(cx + (rnd() - 0.5) * len, cy + (rnd() - 0.5) * 26, len * (0.28 + rnd() * 0.2), 12 + rnd() * 16, col, a);
  }
}

// ---------------- WHALE ----------------
// Spine from tail (lower-left) to head (upper-right), gentle S-curve.
type Pt = [number, number];
function spinePoint(t: number): Pt {
  // cubic-ish curve via two quadratic segments blended
  const x = lerp(300, 1560, t);
  const y = lerp(1520, 760, t) + Math.sin(t * Math.PI) * -60 + (1 - t) * (1 - t) * 60;
  return [x, y];
}
function spineTangent(t: number): number {
  const [x0, y0] = spinePoint(Math.max(0, t - 0.02));
  const [x1, y1] = spinePoint(Math.min(1, t + 0.02));
  return Math.atan2(y1 - y0, x1 - x0);
}
function bodyRadius(t: number): number {
  // taper: thin tail, fat mid-body, rounded head
  if (t < 0.12) return lerp(28, 90, t / 0.12);
  if (t < 0.62) return lerp(90, 210, (t - 0.12) / 0.5);
  return lerp(210, 150, (t - 0.62) / 0.38);
}

const WHALE: RGB = [38, 84, 158];       // deep blue
const WHALE_DARK: RGB = [22, 52, 110];
const BELLY: RGB = [196, 214, 232];     // pale belly
const BELLY_SH: RGB = [150, 178, 208];

// Tail fluke: two tapered lobes fanning out behind the tail tip, anchored at the tip.
const [tx, ty] = spinePoint(0);
const ta = spineTangent(0);
{
  const bx = -Math.cos(ta); const by = -Math.sin(ta); // backward along spine
  const pxn = -Math.sin(ta); const pyn = Math.cos(ta); // perpendicular
  // Each lobe: a tapered ribbon from the tail tip out to a lobe tip.
  // The downward lobe is shorter so it clears the skyline.
  const lobe = (side: number, backLen: number, perpLen: number) => {
    const ex = tx + bx * backLen + pxn * side * perpLen;
    const ey = ty + by * backLen + pyn * side * perpLen;
    const cx = tx + bx * 60 + pxn * side * 130;
    const cy = ty + by * 60 + pyn * side * 130;
    ribbon([tx, ty], [cx, cy], [ex, ey], 74, 10, WHALE_DARK, 1);
    ribbon([tx, ty], [cx, cy], [ex, ey], 56, 8, WHALE, 1);
  };
  lobe(1, 150, 150);
  lobe(-1, 230, 230);
  // tail stock narrows into the fluke
  disc(tx, ty, 34, WHALE, 1);
}

// Body: chain of overlapping discs along the spine.
for (let i = 0; i <= 120; i++) {
  const t = i / 120;
  const [x, y] = spinePoint(t);
  disc(x, y, bodyRadius(t), WHALE, 1);
}
// Back shading: darker ridge along the top of the body.
for (let i = 0; i <= 80; i++) {
  const t = 0.1 + (i / 80) * 0.85;
  const [x, y] = spinePoint(t);
  const r = bodyRadius(t);
  disc(x, y - r * 0.52, r * 0.55, WHALE_DARK, 0.32);
}
// Belly: paler chain offset downward (perpendicular to spine), kept slim.
for (let i = 0; i <= 100; i++) {
  const t = 0.25 + (i / 100) * 0.68;
  const [x, y] = spinePoint(t);
  const r = bodyRadius(t);
  const ang = spineTangent(t);
  const nx = -Math.sin(ang); const ny = Math.cos(ang); // downward-ish normal
  disc(x + nx * r * 0.38, y + ny * r * 0.38, r * 0.46, BELLY, 1);
}
// Belly pleat lines.
for (let k = 0; k < 5; k++) {
  const t = 0.55 + k * 0.07;
  const [x, y] = spinePoint(t);
  const r = bodyRadius(t);
  const ang = spineTangent(t);
  const nx = -Math.sin(ang); const ny = Math.cos(ang);
  thickLine(x + nx * r * 0.28, y + ny * r * 0.28, x + nx * r * 0.72, y + ny * r * 0.72, 5, BELLY_SH, 0.7);
}

// Pectoral fin (below mid-body, swept back, overlapping the body so it reads attached).
{
  const [x, y] = spinePoint(0.52);
  const ang = spineTangent(0.52);
  const r = bodyRadius(0.52);
  ellipseRot(x + 60, y + r * 0.72, 190, 56, ang + 0.8, WHALE_DARK, 1);
  ellipseRot(x + 50, y + r * 0.62, 168, 46, ang + 0.8, WHALE, 1);
}

// Head: rostrum taper + eye + mouth.
{
  const [hx, hy] = spinePoint(0.97);
  const ang = spineTangent(0.97);
  // eye
  const ex = hx + Math.cos(ang) * 30 - Math.sin(ang) * 55;
  const ey = hy + Math.sin(ang) * 30 + Math.cos(ang) * 55;
  disc(ex, ey, 26, [255, 255, 255], 1);
  disc(ex + 4, ey + 2, 15, [10, 14, 30], 1);
  disc(ex + 9, ey - 3, 5, [255, 255, 255], 1);
  // mouth line: one smooth short arc under the front of the head
  let prevMx = 0; let prevMy = 0;
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const mx = hx + Math.cos(ang) * (120 - t * 220) - Math.sin(ang) * (88 - t * 18);
    const my = hy + Math.sin(ang) * (120 - t * 220) + Math.cos(ang) * (88 - t * 18);
    if (i > 0) thickLine(prevMx, prevMy, mx, my, 7, WHALE_DARK, 0.85);
    prevMx = mx; prevMy = my;
  }
}

// ---------------- WATER RIBBONS streaming off the body ----------------
const RIBBON: RGB = [150, 220, 255];
const RIBBON2: RGB = [210, 240, 255];
const ribbonStarts: [number, number, number, number, number][] = [
  // [t along spine, ctrl dx, ctrl dy, end dx, end dy]
  [0.25, -260, -420, -520, -700],
  [0.35, -180, -460, -380, -780],
  [0.45, -120, -480, -180, -820],
  [0.55, -60, -470, 40, -800],
  [0.65, 40, -440, 260, -720],
  [0.72, 120, -400, 420, -640],
  [0.18, -320, -300, -640, -480],
];
for (const [t, cdx, cdy, edx, edy] of ribbonStarts) {
  const [x, y] = spinePoint(t);
  const r = bodyRadius(t);
  const ang = spineTangent(t);
  const nx = -Math.sin(ang); const ny = Math.cos(ang);
  const sx = x + nx * r * 0.55;
  const sy = y + ny * r * 0.55;
  ribbon([sx, sy], [sx + cdx, sy + cdy], [sx + edx, sy + edy], 26, 4, RIBBON, 0.85);
  ribbon([sx, sy], [sx + cdx * 0.8, sy + cdy * 0.8], [sx + edx * 0.9, sy + edy * 0.9], 12, 2, RIBBON2, 0.9);
}
// Droplets flung off the ribbons, kept close to the whale.
for (let i = 0; i < 36; i++) {
  const t = 0.2 + rnd() * 0.55;
  const [x, y] = spinePoint(t);
  const dx = (rnd() - 0.7) * 420;
  const dy = -rnd() * 420;
  disc(x + dx, y + dy, 2 + rnd() * 3.5, RIBBON2, 0.85);
}

// ---------------- BIRDS scattering ----------------
const BIRD: RGB = [30, 20, 50];
function bird(cx: number, cy: number, s: number): void {
  thickLine(cx - s, cy, cx, cy - s * 0.55, 4, BIRD, 1);
  thickLine(cx, cy - s * 0.55, cx + s, cy, 4, BIRD, 1);
}
bird(1500, 420, 34);
bird(1620, 500, 26);
bird(1420, 300, 24);
bird(1740, 620, 30);
bird(1290, 260, 20);

// ---------------- CITY SKYLINE (thin dark strip, lit windows) ----------------
const CITY_TOP = SH - 300;
const CITY: RGB = [18, 12, 40];
{
  let x = 0;
  while (x < SW) {
    const bw = 60 + rnd() * 150;
    const bh = 90 + rnd() * 190;
    const by = CITY_TOP + (300 - bh);
    for (let yy = Math.floor(by); yy < SH; yy++) {
      for (let xx = Math.floor(x); xx < Math.min(SW, Math.floor(x + bw)); xx++) {
        px(xx, yy, CITY[0], CITY[1], CITY[2]);
      }
    }
    // antenna on some towers
    if (rnd() < 0.35) thickLine(x + bw / 2, by, x + bw / 2, by - 46, 4, CITY, 1);
    // lit windows
    const cols = Math.floor(bw / 22);
    const rows = Math.floor(bh / 30);
    for (let cxi = 0; cxi < cols; cxi++) {
      for (let ryi = 0; ryi < rows; ryi++) {
        if (rnd() < 0.28) {
          const wx = x + 8 + cxi * 22;
          const wy = by + 12 + ryi * 30;
          const warm: RGB = rnd() < 0.7 ? [255, 196, 110] : [150, 220, 255];
          for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 7; dx++) px(Math.floor(wx) + dx, Math.floor(wy) + dy, warm[0], warm[1], warm[2]);
        }
      }
    }
    x += bw + rnd() * 14;
  }
}
// Warm haze glow just above the city.
for (let y = CITY_TOP - 60; y < CITY_TOP; y++) {
  const a = 0.16 * (1 - (CITY_TOP - y) / 60);
  for (let x = 0; x < SW; x += 2) blendPx(x, y, 255, 170, 90, a);
}

// ---------------- CAPTION ----------------
// Hand-built 5x7 font. Rows are 5-bit values, top bit = leftmost pixel.
const FONT: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  'A': [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'C': [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  'D': [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  'E': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  'F': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  'H': [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  'O': [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'R': [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  'T': [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'Y': [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
};
const CAPTION = 'THE OCEAN LEARNED TO FLY';
{
  const scale = 4; // supersampled pixels per font pixel (== 2 output px)
  const cw = 6 * scale;
  const totalW = CAPTION.length * cw - scale;
  const bandY0 = SH - 96;
  const bandY1 = SH - 8;
  // dusk band behind the caption
  for (let y = bandY0; y < bandY1; y++) {
    for (let x = 0; x < SW; x++) blendPx(x, y, 16, 10, 44, 0.62);
  }
  const startX = Math.floor((SW - totalW) / 2);
  const startY = bandY0 + Math.floor((bandY1 - bandY0 - 7 * scale) / 2);
  const INK: RGB = [255, 236, 190];
  for (let ci = 0; ci < CAPTION.length; ci++) {
    const g = FONT[CAPTION[ci]] ?? FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if ((g[row] >> (4 - col)) & 1) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              px(startX + ci * cw + col * scale + dx, startY + row * scale + dy, INK[0], INK[1], INK[2]);
            }
          }
        }
      }
    }
  }
}

// ---------------- DOWNSAMPLE 2x -> 1024x1024 ----------------
const out = new Uint8Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const oi = (y * W + x) * 3;
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const si = ((y * SS + dy) * SW + x * SS + dx) * 3;
        r += buf[si]; g += buf[si + 1]; b += buf[si + 2];
      }
    }
    out[oi] = Math.round(r / 4); out[oi + 1] = Math.round(g / 4); out[oi + 2] = Math.round(b / 4);
  }
}

// ---------------- PNG ENCODE (zlib + CRC32, no deps) ----------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out2 = new Uint8Array(12 + data.length);
  const dv = new DataView(out2.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out2[4 + i] = type.charCodeAt(i);
  out2.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out2.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc32(crcData));
  return out2;
}
function u32be(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v);
  return b;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const r = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { r.set(p, o); o += p.length; }
  return r;
}

// Raw scanlines, filter 0.
const raw = new Uint8Array(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0;
  raw.set(out.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
}
const ihdr = concat([u32be(W), u32be(H), new Uint8Array([8, 2, 0, 0, 0])]);
const png = concat([
  new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', new Uint8Array(0)),
]);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
