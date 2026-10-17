// Morph effects: render the aligned face at morph amount t (0 = original, 1 = fully morphed)
// down to the 46x58 LED grid. Every effect is a smooth function of t with a fixed random
// seed, so consecutive frames flow into each other.
import { WIDTH, HEIGHT } from './protocol.js';
import { SCALE, FEATURES, FACE_OVAL, featureCenter } from './face.js';

export const STYLES = {
  dream: 'Dream (mix of everything)',
  features: 'Drifting features',
  melt: 'Melt',
  swirl: 'Swirl',
  shatter: 'Shatter',
  glitch: 'Glitch',
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed) {
  const r = rng(seed);
  const grid = new Float32Array(64 * 64).map(() => r() * 2 - 1);
  const at = (x, y) => grid[(y & 63) * 64 + (x & 63)];
  const s = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = s(x - x0), fy = s(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return a + (b - a) * fy;
  };
  return (x, y) => noise(x, y) * 0.6 + noise(x * 2.1 + 17, y * 2.1 + 5) * 0.3 + noise(x * 4.3 + 3, y * 4.3 + 29) * 0.1;
}

/**
 * Precompute the random parameters for a face + seed, so frames are cheap to render.
 * face: { image: ImageData (SRC_W x SRC_H), landmarks }
 */
export function prepareMorph(face, seed) {
  const r = rng(seed * 7919 + 13);
  const size = face.image.height;
  const lm = face.landmarks;
  const oval = FACE_OVAL.map((i) => lm[i]);
  const center = {
    x: oval.reduce((s, p) => s + p.x, 0) / oval.length,
    y: oval.reduce((s, p) => s + p.y, 0) / oval.length,
  };
  const radii = { leftEye: 0.11, rightEye: 0.11, leftBrow: 0.09, rightBrow: 0.09, nose: 0.12, mouth: 0.15 };
  const features = Object.entries(FEATURES).map(([name, idx]) => {
    const a = r() * Math.PI * 2;
    const dist = (0.12 + r() * 0.22) * size;
    return {
      c: featureCenter(lm, idx),
      off: { x: Math.cos(a) * dist, y: Math.sin(a) * dist },
      grow: r() < 0.5 ? 0.45 + r() * 0.3 : 1.5 + r() * 0.9,
      spin: (r() - 0.5) * 2.4,
      rad: radii[name] * size,
    };
  });
  const cells = Array.from({ length: 22 }, () => ({
    p: { x: center.x + (r() - 0.5) * size * 0.85, y: center.y + (r() - 0.5) * size * 1.0 },
    off: { x: (r() - 0.5) * size * 0.5, y: (r() - 0.5) * size * 0.5 },
    rot: (r() - 0.5) * 2.2,
  }));
  const bands = Array.from({ length: HEIGHT }, () => ({ on: r(), shift: (r() - 0.5) * 2 }));
  return {
    face, size, center, features, cells, bands,
    noiseA: makeNoise(seed * 3 + 1), noiseB: makeNoise(seed * 3 + 2), noiseC: makeNoise(seed * 3 + 3),
    hueDir: r() < 0.5 ? -1 : 1,
  };
}

// ---- warps: map an output position back to a source position (both in source pixels) ----

function warpFeatures(m, p, t) {
  let sx = 0, sy = 0, wsum = 0;
  for (const f of m.features) {
    const k = 1 + t * (f.grow - 1);
    const cx = f.c.x + t * f.off.x, cy = f.c.y + t * f.off.y;
    const dx = p.x - cx, dy = p.y - cy;
    const rr = f.rad * Math.max(k, 1);
    const w = Math.exp(-(dx * dx + dy * dy) / (2 * rr * rr)) * Math.min(1, t * 6);
    if (w < 1e-3) continue;
    const a = -t * f.spin, ca = Math.cos(a), sa = Math.sin(a);
    const qx = (dx * ca - dy * sa) / k, qy = (dx * sa + dy * ca) / k;
    sx += w * (f.c.x + qx);
    sy += w * (f.c.y + qy);
    wsum += w;
  }
  if (wsum === 0) return p;
  const keep = Math.max(0, 1 - wsum);
  const norm = wsum > 1 ? wsum : 1;
  return { x: p.x * keep + sx / norm, y: p.y * keep + sy / norm };
}

function warpMelt(m, p, t) {
  const f = 2.2 / m.size;
  const amp = t * 0.16 * m.size;
  const dx = amp * m.noiseA(p.x * f, p.y * f + t * 0.8);
  const dy = amp * m.noiseB(p.x * f + t * 0.8, p.y * f);
  const drip = Math.pow(t, 1.3) * 0.32 * m.size * (0.55 + 0.45 * m.noiseC(p.x * f * 1.7, 0.5))
    * Math.min(1, Math.max(0, (p.y / m.size) * 1.4));
  return { x: p.x + dx, y: p.y + dy - drip };
}

function warpSwirl(m, p, t) {
  const R = m.size * 0.62;
  const dx = p.x - m.center.x, dy = p.y - m.center.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const fall = Math.max(0, 1 - d / R);
  const a = t * Math.PI * 2.6 * fall * fall;
  const ca = Math.cos(a), sa = Math.sin(a);
  return { x: m.center.x + dx * ca - dy * sa, y: m.center.y + dx * sa + dy * ca };
}

function warpShatter(m, p, t) {
  // Find which (moved) cell this output point belongs to.
  let best = null, bd = Infinity, second = Infinity;
  for (const c of m.cells) {
    const cx = c.p.x + t * c.off.x, cy = c.p.y + t * c.off.y;
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d < bd) { second = bd; bd = d; best = c; } else if (d < second) second = d;
  }
  const gap = Math.sqrt(second) - Math.sqrt(bd);
  if (gap < t * m.size * 0.035) return null; // dark crack between shards
  const cx = best.p.x + t * best.off.x, cy = best.p.y + t * best.off.y;
  const a = -t * best.rot, ca = Math.cos(a), sa = Math.sin(a);
  const dx = p.x - cx, dy = p.y - cy;
  return { x: best.p.x + dx * ca - dy * sa, y: best.p.y + dx * sa + dy * ca };
}

function warpGlitch(m, p, t, row) {
  const b = m.bands[Math.floor(row / 2) * 2] ?? m.bands[0];
  if (b.on < t * 0.85) return { x: p.x + b.shift * t * m.size * 0.35, y: p.y };
  return p;
}

// ---- sampling ----

function sample(img, x, y, out) {
  const w = img.width, h = img.height, d = img.data;
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  out[0] = out[1] = out[2] = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const xi = x0 + i, yi = y0 + j;
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
      const wgt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const k = (yi * w + xi) * 4;
      const a = d[k + 3] / 255 * wgt;
      out[0] += d[k] * a;
      out[1] += d[k + 1] * a;
      out[2] += d[k + 2] * a;
    }
  }
}

function hueRotate(rgb, deg) {
  if (!deg) return;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const [r, g, b] = rgb;
  rgb[0] = r * (0.213 + c * 0.787 - s * 0.213) + g * (0.715 - c * 0.715 - s * 0.715) + b * (0.072 - c * 0.072 + s * 0.928);
  rgb[1] = r * (0.213 - c * 0.213 + s * 0.143) + g * (0.715 + c * 0.285 + s * 0.14) + b * (0.072 - c * 0.072 - s * 0.283);
  rgb[2] = r * (0.213 - c * 0.213 - s * 0.787) + g * (0.715 - c * 0.715 + s * 0.715) + b * (0.072 + c * 0.928 + s * 0.072);
}

/**
 * Render one 46x58 frame. Returns ImageData in display colors (before LED gamma).
 * opts: style, intensity (scales t), colorDrift (0..1)
 */
export function renderFrame(m, t, { style, intensity, colorDrift }) {
  const img = m.face.image;
  const out = new ImageData(WIDTH, HEIGHT);
  const ti = Math.max(0, t * intensity);
  const SS = 3;
  const tmp = [0, 0, 0];
  const acc = [0, 0, 0];
  const split = style === 'glitch' ? ti * m.size * 0.035 : style === 'dream' ? ti * m.size * 0.012 : 0;

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      acc[0] = acc[1] = acc[2] = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          let p = { x: (x + (sx + 0.5) / SS) * SCALE, y: (y + (sy + 0.5) / SS) * SCALE };
          switch (style) {
            case 'features': p = warpFeatures(m, p, ti); break;
            case 'melt': p = warpMelt(m, p, ti); break;
            case 'swirl': p = warpMelt(m, warpSwirl(m, p, ti), ti * 0.25); break;
            case 'shatter': p = warpShatter(m, p, ti); break;
            case 'glitch': p = warpGlitch(m, p, ti, y); break;
            default: // dream
              p = warpSwirl(m, warpMelt(m, warpFeatures(m, p, ti), ti * 0.75), ti * 0.35);
          }
          if (!p) continue;
          if (split) {
            sample(img, p.x + split, p.y, tmp); acc[0] += tmp[0];
            sample(img, p.x, p.y, tmp); acc[1] += tmp[1];
            sample(img, p.x - split, p.y, tmp); acc[2] += tmp[2];
          } else {
            sample(img, p.x, p.y, tmp);
            acc[0] += tmp[0]; acc[1] += tmp[1]; acc[2] += tmp[2];
          }
        }
      }
      const n = SS * SS;
      const rgb = [acc[0] / n, acc[1] / n, acc[2] / n];
      hueRotate(rgb, m.hueDir * colorDrift * ti * 200);
      if (style === 'glitch' && ti > 0.15) {
        const levels = Math.max(3, Math.round(10 - ti * 6));
        for (let c = 0; c < 3; c++) rgb[c] = Math.round((rgb[c] / 255) * (levels - 1)) / (levels - 1) * 255;
      }
      const k = (y * WIDTH + x) * 4;
      out.data[k] = rgb[0];
      out.data[k + 1] = rgb[1];
      out.data[k + 2] = rgb[2];
      out.data[k + 3] = 255;
    }
  }
  return out;
}

/** Convert display colors to LED drive values. LEDs are linear, so dark tones need a gamma curve. */
export function toLed(imageData, gamma) {
  const d = new Uint8ClampedArray(imageData.data);
  const lut = new Uint8ClampedArray(256).map((_, i) => 255 * Math.pow(i / 255, gamma));
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  return d;
}

/** Morph amount for frame i of n, eased so the change starts gently. */
export function frameT(i, n) {
  if (n <= 1) return 0;
  const u = i / (n - 1);
  return u * u * (3 - 2 * u) * 0.35 + u * 0.65;
}
