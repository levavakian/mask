// Face detection (MediaPipe Face Landmarker) and alignment onto the mask grid.
import { WIDTH, HEIGHT } from './protocol.js';

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Supersampling factor: faces are aligned at SCALE x the LED resolution,
// so morphs can sample detail before averaging down to 46x58.
export const SCALE = 4;
export const SRC_W = WIDTH * SCALE;
export const SRC_H = HEIGHT * SCALE;

// MediaPipe face mesh indices.
export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
export const FEATURES = {
  leftEye: [33, 133, 159, 145, 160, 144, 158, 153],
  rightEye: [362, 263, 386, 374, 385, 380, 387, 373],
  leftBrow: [70, 63, 105, 66, 107],
  rightBrow: [300, 293, 334, 296, 336],
  nose: [1, 4, 5, 195, 98, 327],
  mouth: [13, 14, 61, 291, 0, 17, 78, 308],
};

let landmarkerPromise = null;

export function loadLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
    try {
      return await make('GPU');
    } catch (e) {
      console.warn('GPU face landmarker failed, using CPU', e);
      return make('CPU');
    }
  })();
  landmarkerPromise.catch(() => { landmarkerPromise = null; });
  return landmarkerPromise;
}

/** Returns face landmarks in pixel coordinates of `canvas`, or null if no face. */
export async function detectFace(canvas) {
  const landmarker = await loadLandmarker();
  const result = landmarker.detect(canvas);
  const lm = result.faceLandmarks?.[0];
  if (!lm) return null;
  return lm.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height }));
}

const mean = (pts) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});
export const featureCenter = (lm, idx) => mean(idx.map((i) => lm[i]));

/**
 * Rotate the face upright, scale the face oval to fill the mask and place it in the middle.
 * Returns an RGBA ImageData at SRC_W x SRC_H (alpha = face isolation) plus landmarks
 * mapped into that image.
 *
 * opts: zoom (1 = oval fits), offsetX/offsetY (fraction of frame), isolate (bool),
 *       expand (oval growth, includes hair/ears), contrast, saturation, autoLevels (bool)
 */
export function alignFace(image, lm, opts) {
  const eyeL = featureCenter(lm, FEATURES.leftEye);
  const eyeR = featureCenter(lm, FEATURES.rightEye);
  const mid = { x: (eyeL.x + eyeR.x) / 2, y: (eyeL.y + eyeR.y) / 2 };
  const angle = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  const rot = (p) => {
    const dx = p.x - mid.x, dy = p.y - mid.y;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };

  const oval = FACE_OVAL.map((i) => rot(lm[i]));
  const minX = Math.min(...oval.map((p) => p.x)), maxX = Math.max(...oval.map((p) => p.x));
  const minY = Math.min(...oval.map((p) => p.y)), maxY = Math.max(...oval.map((p) => p.y));
  const box = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  const scale = opts.zoom * Math.min((SRC_H * 0.94) / box.h, (SRC_W * 0.98) / box.w);
  const out = { x: SRC_W / 2 + opts.offsetX * SRC_W, y: SRC_H / 2 + opts.offsetY * SRC_H };
  const map = (p) => {
    const q = rot(p);
    return { x: out.x + scale * (q.x - box.cx), y: out.y + scale * (q.y - box.cy) };
  };

  const canvas = new OffscreenCanvas(SRC_W, SRC_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SRC_W, SRC_H);
  ctx.save();
  ctx.translate(out.x, out.y);
  ctx.scale(scale, scale);
  ctx.translate(-box.cx, -box.cy);
  ctx.rotate(-angle);
  ctx.translate(-mid.x, -mid.y);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0);
  ctx.restore();

  const mapped = lm.map(map);
  if (opts.isolate) {
    const pts = FACE_OVAL.map((i) => mapped[i]);
    const c = mean(pts);
    const maskCanvas = new OffscreenCanvas(SRC_W, SRC_H);
    const m = maskCanvas.getContext('2d');
    m.filter = `blur(${SCALE * 0.8}px)`;
    m.fillStyle = '#fff';
    m.beginPath();
    pts.forEach((p, i) => {
      // Grow the oval upward more than sideways so the forehead/hairline is kept.
      const x = c.x + (p.x - c.x) * opts.expand;
      const y = c.y + (p.y - c.y) * (p.y < c.y ? opts.expand * 1.08 : Math.min(opts.expand, 1.04));
      if (i === 0) m.moveTo(x, y); else m.lineTo(x, y);
    });
    m.closePath();
    m.fill();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  const img = ctx.getImageData(0, 0, SRC_W, SRC_H);
  if (!opts.isolate) for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  tone(img, opts);
  return { image: img, landmarks: mapped };
}

/** Auto-levels on the visible face, then contrast and saturation. Modifies in place. */
function tone(img, { autoLevels, contrast, saturation }) {
  const d = img.data;
  let lo = 0, hi = 255;
  if (autoLevels) {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
      n++;
    }
    if (n > 50) {
      let acc = 0;
      lo = 0;
      while (lo < 255 && (acc += hist[lo]) < n * 0.02) lo++;
      acc = 0;
      hi = 255;
      while (hi > 0 && (acc += hist[hi]) < n * 0.01) hi--;
      if (hi - lo < 40) { lo = 0; hi = 255; }
    }
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let r = (d[i] - lo) / range, g = (d[i + 1] - lo) / range, b = (d[i + 2] - lo) / range;
    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = 255 * (l + (r - l) * saturation);
    d[i + 1] = 255 * (l + (g - l) * saturation);
    d[i + 2] = 255 * (l + (b - l) * saturation);
  }
}
