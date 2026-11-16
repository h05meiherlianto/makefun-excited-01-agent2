// SKYWHALE: the ocean learned to fly
// A program that draws, pixel by pixel, a colossal blue whale flying
// diagonally across a burning sunset sky above a tiny city at dusk.
// Pure Node 22 standard library only. Fully deterministic: fixed-seed
// PRNG, fixed iteration order, no Date, no Math.random, no network.
// Renders at 2x supersampling, downsamples for clean anti-aliased edges,
// and encodes the PNG by hand (zlib deflate + a CRC32 implementation).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const W = 1024;
const H = 1024;
const SS = 2; // supersampling factor
const SW = W * SS;
const SH = H * SS;

// ---- fixed-seed PRNG (mulberry32) ---------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261116);

// ---- helpers --------------------------------------------------------------
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function mix3(c1: number[], c2: number[], t: number): number[] {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
// Deterministic hash of integers -> [0,1), for windows / stars / droplets.
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- palette --------------------------------------------------------------
const SKY_TOP: number[] = [16, 14, 58]; // deep indigo
const SKY_MID: number[] = [122, 32, 96]; // magenta
const SKY_LOW: number[] = [238, 110, 52]; // burning orange
const SKY_HOR: number[] = [255, 196, 92]; // gold at the horizon
const SUN_CORE: number[] = [255, 244, 200];
const SUN_EDGE: number[] = [255, 158, 64];
const CITY_COL: number[] = [18, 13, 42];
const BAND_COL: number[] = [13, 10, 36];
const WHALE_TOP: number[] = [18, 52, 96];
const WHALE_MID: number[] = [34, 84, 138];
const BELLY_COL: number[] = [186, 214, 232];
const RIBBON_COL: number[] = [150, 225, 255];
const TEXT_COL: number[] = [255, 217, 122];

// ---- precomputed sky rows (supersampled) ----------------------------------
const skyRows: number[][] = [];
for (let y = 0; y < SH; y++) {
  const t = y / (SH - 1);
  let c: number[];
  if (t < 0.38) c = mix3(SKY_TOP, SKY_MID, smoothstep(0, 0.38, t));
  else if (t < 0.72) c = mix3(SKY_MID, SKY_LOW, smoothstep(0.38, 0.72, t));
  else c = mix3(SKY_LOW, SKY_HOR, smoothstep(0.72, 1, t));
  skyRows.push(c);
}

// ---- sun ------------------------------------------------------------------
const SUN_X = 872 * SS;
const SUN_Y = 238 * SS;
const SUN_R = 118 * SS;
const GLOW_R = 460 * SS;

// ---- clouds: soft ellipses (x, y, rx, ry, alpha, tint) in SS coords -------
interface Cloud { x: number; y: number; rx: number; ry: number; a: number; c: number[]; }
const clouds: Cloud[] = [];
{
  const defs: number[][] = [
    [300, 210, 130, 22, 0.22], [760, 150, 150, 18, 0.2], [1150, 280, 160, 20, 0.2],
    [1560, 170, 140, 18, 0.18], [1900, 300, 120, 20, 0.18], [120, 560, 150, 20, 0.15],
    [1850, 640, 160, 20, 0.14], [620, 700, 130, 16, 0.12],
  ];
  for (const d of defs) {
    clouds.push({
      x: d[0] * SS, y: d[1] * SS, rx: d[2] * SS, ry: d[3] * SS, a: d[4],
      c: d[1] < 420 ? [255, 170, 150] : [255, 205, 160],
    });
  }
}

// ---- city: deterministic skyline ------------------------------------------
interface Building { x0: number; x1: number; top: number; }
const buildings: Building[] = [];
{
  let x = -10;
  const base = 952 * SS;
  while (x < SW + 10) {
    const w = (16 + rand() * 26) * SS;
    const h = (26 + rand() * 96) * SS;
    buildings.push({ x0: x, x1: x + w, top: base - h });
    x += w + (2 + rand() * 6) * SS;
  }
}
const CITY_BASE = 952 * SS;

// ---- whale geometry ---------------------------------------------------------
const WH_CX = 498 * SS;
const WH_CY = 462 * SS;
const WH_ANG = -26 * Math.PI / 180; // head up-right
const WH_COS = Math.cos(WH_ANG);
const WH_SIN = Math.sin(WH_ANG);
const WH_HALF_LEN = 372 * SS;
const WH_HALF_W = 132 * SS;

// Tapered half-width at local u in [-1, 1] (u=1 is the head).
function whaleHalfWidth(u: number): number {
  const q = (u - 0.08) / 1.06;
  const s = 1 - q * q;
  if (s <= 0) return 0;
  return WH_HALF_W * Math.sqrt(s);
}

// Pectoral fin: elongated ellipse below the body (local coords, local units).
const FIN_CX = 0.22; // local u
const FIN_CY = 0.58; // local v in units of half-width (belly side, lv > 0)
const FIN_LEN = 0.38;
const FIN_WID = 0.10;
// Fluke lobes at the tail tip.
const FLUKE_U = -0.98;

// Water ribbons: luminous streams trailing the whale, as y = f(x) bands.
interface Ribbon { x0: number; x1: number; y0: number; amp: number; per: number; ph: number; th: number; a: number; }
const ribbons: Ribbon[] = [
  { x0: 60 * SS, x1: 330 * SS, y0: 640 * SS, amp: 46 * SS, per: 420 * SS, ph: 0.0, th: 15 * SS, a: 0.85 },
  { x0: 40 * SS, x1: 300 * SS, y0: 700 * SS, amp: 55 * SS, per: 380 * SS, ph: 1.7, th: 11 * SS, a: 0.7 },
  { x0: 90 * SS, x1: 360 * SS, y0: 590 * SS, amp: 38 * SS, per: 460 * SS, ph: 3.1, th: 9 * SS, a: 0.6 },
  { x0: 150 * SS, x1: 420 * SS, y0: 760 * SS, amp: 42 * SS, per: 340 * SS, ph: 4.4, th: 7 * SS, a: 0.5 },
];

// Birds: small arcs (cx, cy, r, wing sweep) in SS coords.
interface Bird { x: number; y: number; r: number; }
const birds: Bird[] = [
  { x: 180 * SS, y: 300 * SS, r: 16 * SS },
  { x: 250 * SS, y: 250 * SS, r: 12 * SS },
  { x: 120 * SS, y: 210 * SS, r: 10 * SS },
  { x: 960 * SS, y: 120 * SS, r: 13 * SS },
  { x: 700 * SS, y: 130 * SS, r: 11 * SS },
];

// Droplets along the ribbons (deterministic, from the fixed PRNG).
interface Drop { x: number; y: number; r: number; }
const drops: Drop[] = [];
for (let i = 0; i < 46; i++) {
  const rb = ribbons[i % ribbons.length];
  const x = rb.x0 + rand() * (rb.x1 - rb.x0);
  const y = rb.y0 + Math.sin((x / rb.per + rb.ph) * Math.PI * 2) * rb.amp + (rand() - 0.5) * 90 * SS;
  drops.push({ x, y, r: (2.5 + rand() * 5) * SS });
}

// ---- render at supersampled resolution --------------------------------------
const buf = new Float32Array(SW * SH * 3);

function paint(): void {
  for (let y = 0; y < SH; y++) {
    const sky = skyRows[y];
    const rowOff = y * SW * 3;
    for (let x = 0; x < SW; x++) {
      const i = rowOff + x * 3;
      let r = sky[0];
      let g = sky[1];
      let b = sky[2];

      // Sun glow (radial, warm).
      const dxs = x - SUN_X;
      const dys = y - SUN_Y;
      const ds2 = dxs * dxs + dys * dys;
      if (ds2 < GLOW_R * GLOW_R) {
        const d = Math.sqrt(ds2) / GLOW_R;
        const glow = Math.pow(1 - d, 2.2) * 0.85;
        r = lerp(r, 255, glow * 0.9);
        g = lerp(g, 170, glow * 0.85);
        b = lerp(b, 90, glow * 0.7);
      }
      // Sun disc.
      if (ds2 < SUN_R * SUN_R) {
        const d = Math.sqrt(ds2) / SUN_R;
        const edge = smoothstep(1, 0.96, d);
        const core = mix3(SUN_EDGE, SUN_CORE, smoothstep(0.55, 0, d));
        r = lerp(r, core[0], edge);
        g = lerp(g, core[1], edge);
        b = lerp(b, core[2], edge);
      }

      // Stars in the deep indigo top (sparse, tiny).
      if (y < 220 * SS) {
        const h = hash2(Math.floor(x / (9 * SS)), Math.floor(y / (9 * SS)));
        if (h > 0.9975) {
          const s = (h - 0.9975) / 0.0025;
          r = lerp(r, 255, s * 0.7);
          g = lerp(g, 255, s * 0.7);
          b = lerp(b, 255, s * 0.7);
        }
      }

      // Wispy clouds (soft ellipses).
      for (let ci = 0; ci < clouds.length; ci++) {
        const cl = clouds[ci];
        if (x < cl.x - cl.rx || x > cl.x + cl.rx || y < cl.y - cl.ry * 2.2 || y > cl.y + cl.ry * 2.2) continue;
        const ex = (x - cl.x) / cl.rx;
        const ey = (y - cl.y) / cl.ry;
        const e = ex * ex + ey * ey;
        if (e < 1) {
          const a = cl.a * smoothstep(1, 0.25, e);
          r = lerp(r, cl.c[0], a);
          g = lerp(g, cl.c[1], a);
          b = lerp(b, cl.c[2], a);
        }
      }

      // Water ribbons (luminous, trailing off the whale).
      for (let ri = 0; ri < ribbons.length; ri++) {
        const rb = ribbons[ri];
        if (x < rb.x0 || x > rb.x1) continue;
        const cy = rb.y0 + Math.sin((x / rb.per + rb.ph) * Math.PI * 2) * rb.amp;
        const dy = Math.abs(y - cy);
        if (dy < rb.th) {
          const a = rb.a * smoothstep(rb.th, rb.th * 0.25, dy);
          r = lerp(r, RIBBON_COL[0], a);
          g = lerp(g, RIBBON_COL[1], a);
          b = lerp(b, RIBBON_COL[2], a);
        }
      }
      // Droplets.
      for (let di = 0; di < drops.length; di++) {
        const dr = drops[di];
        if (x < dr.x - dr.r || x > dr.x + dr.r || y < dr.y - dr.r || y > dr.y + dr.r) continue;
        const ddx = x - dr.x;
        const ddy = y - dr.y;
        if (ddx * ddx + ddy * ddy < dr.r * dr.r) {
          r = lerp(r, 200, 0.75);
          g = lerp(g, 235, 0.75);
          b = lerp(b, 255, 0.75);
        }
      }

      // City silhouette (thin dark strip along the bottom).
      if (y >= CITY_BASE - 200 * SS) {
        for (let bi = 0; bi < buildings.length; bi++) {
          const bd = buildings[bi];
          if (x < bd.x0 || x >= bd.x1) continue;
          if (y >= bd.top && y < CITY_BASE) {
            // Lit windows: tiny warm rectangles on a grid.
            const wx = Math.floor((x - bd.x0) / (7 * SS));
            const wy = Math.floor((y - bd.top) / (11 * SS));
            const lx = (x - bd.x0) % (7 * SS);
            const ly = (y - bd.top) % (11 * SS);
            if (lx < 3 * SS && ly < 5 * SS && hash2(bi * 31 + wx, wy * 7 + 3) > 0.55) {
              r = 255; g = 196; b = 110;
            } else {
              const shade = 0.85 + 0.3 * hash2(bi, 1);
              r = CITY_COL[0] * shade; g = CITY_COL[1] * shade; b = CITY_COL[2] * shade;
            }
          } else if (y >= CITY_BASE) {
            r = CITY_COL[0]; g = CITY_COL[1]; b = CITY_COL[2];
          }
          break;
        }
      }

      // Whale: transform into whale-local coordinates.
      {
        const px = x - WH_CX;
        const py = y - WH_CY;
        const lu = (px * WH_COS + py * WH_SIN) / WH_HALF_LEN; // -1..1 along body
        const lv = (-px * WH_SIN + py * WH_COS) / WH_HALF_LEN; // across body
        if (lu > -1.15 && lu < 1.15 && lv > -0.55 && lv < 0.55) {
          const hw = whaleHalfWidth(lu) / WH_HALF_LEN; // half-width in local units
          // Body.
          if (hw > 0) {
            const edge = smoothstep(1, 0.94, Math.abs(lv) / hw);
            if (edge > 0) {
              // Deep blue on top, paler belly underneath (lv > 0 is the
              // downward-facing side of the tilted body).
              const belly = smoothstep(0.05, 0.55, lv / hw);
              let wc = mix3(WHALE_TOP, WHALE_MID, smoothstep(-0.6, 0.4, lv / hw));
              wc = mix3(wc, BELLY_COL, belly * 0.9);
              // Sunlit rim on the upper edge.
              const rim = smoothstep(-0.55, -0.95, lv / hw) * 0.55;
              wc = mix3(wc, [255, 190, 120], rim);
              r = lerp(r, wc[0], edge);
              g = lerp(g, wc[1], edge);
              b = lerp(b, wc[2], edge);
            }
          }
          // Pectoral fin (below the body, sweeping back).
          {
            const fu = lu - FIN_CX;
            const fv = lv - FIN_CY * (WH_HALF_W / WH_HALF_LEN);
            const fa = -0.7; // fin sweep angle
            const fca = Math.cos(fa);
            const fsa = Math.sin(fa);
            const ru = fu * fca + fv * fsa;
            const rv = -fu * fsa + fv * fca;
            const fe = (ru * ru) / (FIN_LEN * FIN_LEN) + (rv * rv) / (FIN_WID * FIN_WID);
            if (fe < 1) {
              const a = smoothstep(1, 0.85, fe);
              r = lerp(r, WHALE_TOP[0] * 0.85, a);
              g = lerp(g, WHALE_TOP[1] * 0.85, a);
              b = lerp(b, WHALE_TOP[2] * 0.9, a);
            }
          }
          // Fluke: two lobes fanning from the tail tip.
          for (let lobe = 0; lobe < 2; lobe++) {
            const la = lobe === 0 ? 0.62 : -0.62;
            const lca = Math.cos(la);
            const lsa = Math.sin(la);
            const tu = lu - FLUKE_U;
            const tv = lv - (lobe === 0 ? 0.10 : -0.10);
            const ru = tu * lca + tv * lsa;
            const rv = -tu * lsa + tv * lca;
            const ll = 0.30;
            const lw = 0.085;
            const fe = (ru * ru) / (ll * ll) + (rv * rv) / (lw * lw);
            if (fe < 1 && ru > -0.05) {
              const a = smoothstep(1, 0.85, fe);
              r = lerp(r, WHALE_TOP[0], a);
              g = lerp(g, WHALE_TOP[1], a);
              b = lerp(b, WHALE_TOP[2], a);
            }
          }
          // Eye: dark with a bright catchlight, near the head.
          {
            const ex = (lu - 0.74) * WH_HALF_LEN;
            const ey = (lv - 0.10 * (WH_HALF_W / WH_HALF_LEN)) * WH_HALF_LEN;
            const er2 = ex * ex + ey * ey;
            const er = 9 * SS;
            if (er2 < er * er) {
              r = 8; g = 10; b = 18;
              const hx = ex + 3 * SS;
              const hy = ey - 3 * SS;
              if (hx * hx + hy * hy < (3.2 * SS) * (3.2 * SS)) { r = 255; g = 255; b = 255; }
            }
          }
        }
      }

      // Birds: small dark arcs scattering away from the whale.
      for (let bi = 0; bi < birds.length; bi++) {
        const bd = birds[bi];
        if (x < bd.x - bd.r || x > bd.x + bd.r || y < bd.y - bd.r || y > bd.y + bd.r) continue;
        const bdx = (x - bd.x) / bd.r;
        const bdy = (y - bd.y) / bd.r;
        const wing = Math.abs(bdx) * 0.55 + 0.12;
        if (Math.abs(bdy + wing * (1 - Math.abs(bdx))) < 0.16 && Math.abs(bdx) < 1) {
          r = 24; g = 18; b = 40;
        }
      }

      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
}

// ---- downsample 2x2 -> final 1024x1024 RGB -------------------------------
function downsample(): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const oi = (y * W + x) * 3;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const si = ((y * SS + dy) * SW + (x * SS + dx)) * 3;
          r += buf[si];
          g += buf[si + 1];
          b += buf[si + 2];
        }
      }
      out[oi] = Math.round(r / 4);
      out[oi + 1] = Math.round(g / 4);
      out[oi + 2] = Math.round(b / 4);
    }
  }
  return out;
}

// ---- hand-built 5x7 pixel font --------------------------------------------
const FONT: Record<string, string[]> = {
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'C': ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'Y': ['#...#', '#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

function drawCaption(img: Uint8Array, text: string): void {
  const scale = 4;
  const cw = 5 * scale + scale; // char cell width incl. spacing
  const ch = 7 * scale;
  const totalW = text.length * cw - scale;
  const x0 = Math.floor((W - totalW) / 2);
  const y0 = 968;
  // Dusk band behind the caption.
  for (let y = 956; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const t = (y - 956) / (H - 956);
      img[i] = Math.round(lerp(BAND_COL[0], 8, t));
      img[i + 1] = Math.round(lerp(BAND_COL[1], 7, t));
      img[i + 2] = Math.round(lerp(BAND_COL[2], 24, t));
    }
  }
  for (let ci = 0; ci < text.length; ci++) {
    const glyph = FONT[text[ci]];
    if (!glyph) continue;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '#') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x0 + ci * cw + gx * scale + sx;
            const py = y0 + gy * scale + sy;
            if (px < 0 || px >= W || py < 0 || py >= H) continue;
            const i = (py * W + px) * 3;
            img[i] = TEXT_COL[0];
            img[i + 1] = TEXT_COL[1];
            img[i + 2] = TEXT_COL[2];
          }
        }
      }
    }
  }
}

// ---- PNG encoding (hand-rolled, zlib deflate + CRC32) ----------------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function encodePng(img: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    raw.set(img.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  let total = 0;
  for (const p of parts) total += p.length;
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { png.set(p, off); off += p.length; }
  return png;
}

// ---- main -------------------------------------------------------------------
function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  fs.mkdirSync(outDir, { recursive: true });
  paint();
  const img = downsample();
  drawCaption(img, 'THE OCEAN LEARNED TO FLY');
  const png = encodePng(img);
  fs.writeFileSync(path.join(outDir, 'entry.png'), png);
}

main();
