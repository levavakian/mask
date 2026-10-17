import { Mask, bluetoothSupported } from './mask.js';
import { WIDTH, HEIGHT, SLOT_COUNT } from './protocol.js';
import { loadLandmarker, detectFace, alignFace } from './face.js';
import { STYLES, prepareMorph, renderFrame, toLed, frameT } from './morph.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_SLOT = SLOT_COUNT; // "Show on mask" uses the last slot; morph frames use 1..33.
const MAX_FRAMES = SLOT_COUNT - 1;

// ---------- settings ----------
const SETTINGS = ['zoom', 'offsetX', 'offsetY', 'isolate', 'expand', 'contrast', 'saturation', 'autoLevels',
  'style', 'frames', 'intensity', 'colorDrift', 'speed', 'mode', 'brightness', 'gamma'];
const styleSel = $('style');
for (const [k, v] of Object.entries(STYLES)) styleSel.add(new Option(v, k));
$('frames').max = MAX_FRAMES;

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('settings') || '{}'); } catch { /* ignore */ }
  for (const k of SETTINGS) {
    if (!(k in saved)) continue;
    const el = $(k);
    if (el.type === 'checkbox') el.checked = saved[k]; else el.value = saved[k];
  }
  state.seed = saved.seed ?? Math.floor(Math.random() * 1000);
}
function saveSettings() {
  const s = { seed: state.seed };
  for (const k of SETTINGS) {
    const el = $(k);
    s[k] = el.type === 'checkbox' ? el.checked : el.value;
  }
  localStorage.setItem('settings', JSON.stringify(s));
}
const num = (id) => parseFloat($(id).value);
const alignOpts = () => ({
  zoom: num('zoom'), offsetX: num('offsetX'), offsetY: num('offsetY'), isolate: $('isolate').checked,
  expand: num('expand'), contrast: num('contrast'), saturation: num('saturation'), autoLevels: $('autoLevels').checked,
});
const morphOpts = () => ({ style: $('style').value, intensity: num('intensity'), colorDrift: num('colorDrift') });
const frameCount = () => Math.min(MAX_FRAMES, parseInt($('frames').value, 10));
const speedSeconds = () => 0.1 * Math.pow(300, num('speed') / 100);

// ---------- state ----------
const state = {
  seed: 0,
  photo: null, // canvas with the original photo
  photoId: 0,
  landmarks: null,
  face: null,
  morph: null,
  frames: [], // ImageData per frame (display colors)
  framesSig: '',
  uploadedSig: null, // signature of the frames currently on the mask
  slotHashes: new Map(), // slot -> hash of LED bytes on the mask (this session)
  uploading: false,
  cancel: false,
  player: { playing: false, index: 0, dir: 1, timer: null },
  scrubbedAt: 0,
};

const mask = new Mask();

// ---------- connection ----------
function setConnUI() {
  const pill = $('connStatus');
  const s = mask.status;
  pill.className = 'pill ' + (s === 'connected' ? 'on' : s === 'connecting' ? 'busy' : 'off');
  pill.textContent = s === 'connected' ? `● ${mask.name}` : s === 'connecting' ? 'Connecting…' : 'Not connected';
  pill.title = mask.statusDetail || '';
  $('connectBtn').textContent = s === 'connected' ? 'Disconnect' : 'Connect';
  updateButtons();
}
mask.addEventListener('status', (e) => {
  mask.statusDetail = e.detail.detail;
  setConnUI();
  if (e.detail.status === 'connected') {
    mask.setBrightness(num('brightness')).catch(() => {});
    if (state.player.playing) showCurrentOnMask();
  }
});

$('connectBtn').onclick = async () => {
  if (mask.connected) return mask.disconnect();
  try {
    await mask.requestAndConnect();
  } catch (e) {
    if (e.name !== 'NotFoundError') setStatus('uploadStatus', `Could not connect: ${e.message}`, true);
  }
};

// ---------- camera / photo ----------
let stream = null;
let facing = 'user';

async function openCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false,
    });
  } catch (e) {
    setStatus('photoStatus', `Camera unavailable: ${e.message}. Use "From gallery" instead.`, true);
    return;
  }
  const v = $('video');
  v.srcObject = stream;
  v.classList.toggle('mirror', facing === 'user');
  await v.play();
  v.hidden = false;
  $('photo').hidden = true;
  $('cameraPlaceholder').hidden = true;
  $('guide').hidden = false;
  $('shootBtn').hidden = false;
  $('flipBtn').hidden = false;
  $('cameraBtn').textContent = 'Retake';
  $('cameraBtn').hidden = true;
  setStatus('photoStatus', 'Fit your face in the oval, then tap Take photo.');
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('video').hidden = true;
  $('guide').hidden = true;
  $('shootBtn').hidden = true;
  $('flipBtn').hidden = true;
  $('cameraBtn').hidden = false;
}

$('cameraBtn').onclick = openCamera;
$('flipBtn').onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; openCamera(); };
$('shootBtn').onclick = () => {
  const v = $('video');
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  // Save the selfie mirrored, the way the user saw it in the viewfinder.
  if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(v, 0, 0);
  stopCamera();
  usePhoto(c, true);
};
$('fileInput').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  stopCamera();
  e.target.value = '';
  usePhoto(c, true);
};

function downscale(src, max) {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * s);
  c.height = Math.round(src.height * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function usePhoto(canvas, remember) {
  const photo = downscale(canvas, 1280);
  const view = $('photo');
  view.width = photo.width;
  view.height = photo.height;
  view.getContext('2d').drawImage(photo, 0, 0);
  view.hidden = false;
  $('cameraPlaceholder').hidden = true;
  setStatus('photoStatus', 'Finding your face…');
  let lm;
  try {
    lm = await detectFace(photo);
  } catch (e) {
    setStatus('photoStatus', `Face detection failed to load: ${e.message}`, true);
    return;
  }
  if (!lm) {
    setStatus('photoStatus', 'No face found. Try again with your face centered and well lit.', true);
    return;
  }
  state.photo = photo;
  state.photoId++;
  state.landmarks = lm;
  setStatus('photoStatus', 'Face found ✓ — check the line-up below.');
  if (remember) {
    try {
      localStorage.setItem('photo', downscale(photo, 720).toDataURL('image/jpeg', 0.85));
    } catch { /* storage full: not important */ }
  }
  realign();
}

async function restorePhoto() {
  const url = localStorage.getItem('photo');
  if (!url) return;
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { return; }
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  usePhoto(c, false);
}

// ---------- align + morph ----------
function drawLeds(canvas, img) {
  const ctx = canvas.getContext('2d');
  const cw = canvas.width / WIDTH;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const k = (y * WIDTH + x) * 4;
      if (d[k] + d[k + 1] + d[k + 2] < 6) continue;
      ctx.fillStyle = `rgb(${d[k]},${d[k + 1]},${d[k + 2]})`;
      ctx.beginPath();
      ctx.arc((x + 0.5) * cw, (y + 0.5) * cw, cw * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

let regenTimer = null;
function realign() {
  if (!state.landmarks) return;
  state.face = alignFace(state.photo, state.landmarks, alignOpts());
  state.morph = prepareMorph(state.face, state.seed);
  drawLeds($('alignPreview'), renderFrame(state.morph, 0, morphOpts()));
  scheduleRegen();
}

function scheduleRegen() {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(regenerate, 60);
}

function regenerate() {
  if (!state.face) return;
  state.morph = prepareMorph(state.face, state.seed);
  const n = frameCount();
  const opts = morphOpts();
  state.frames = Array.from({ length: n }, (_, i) => renderFrame(state.morph, frameT(i, n), opts));
  state.framesSig = JSON.stringify([state.photoId, alignOpts(), opts, n, state.seed, num('gamma')]);
  $('scrub').max = n - 1;
  $('pos').max = n - 1;
  drawStrip();
  updateButtons();
}

function drawStrip() {
  const strip = $('strip');
  strip.replaceChildren(...state.frames.map((f, i) => {
    const c = document.createElement('canvas');
    c.width = WIDTH;
    c.height = HEIGHT;
    c.getContext('2d').putImageData(f, 0, 0);
    c.onclick = () => { $('scrub').value = i; state.scrubbedAt = performance.now(); };
    return c;
  }));
}

// Local preview loop: animates the morph unless the user is scrubbing or the mask is playing.
let previewIdx = 0, previewDir = 1, lastPreview = 0;
function previewLoop(now) {
  requestAnimationFrame(previewLoop);
  const n = state.frames.length;
  if (!n) return;
  let idx;
  if (state.player.playing) {
    idx = Math.min(state.player.index, n - 1);
  } else if (now - state.scrubbedAt < 4000) {
    idx = Math.min(parseInt($('scrub').value, 10), n - 1);
  } else {
    if (now - lastPreview > 160) {
      lastPreview = now;
      previewIdx += previewDir;
      if (previewIdx >= n - 1 || previewIdx <= 0) previewDir *= -1;
      previewIdx = Math.max(0, Math.min(n - 1, previewIdx));
    }
    idx = previewIdx;
    $('scrub').value = idx;
  }
  idx = Math.max(0, Math.min(n - 1, idx | 0));
  if (idx !== previewLoop.drawn || state.frames !== previewLoop.frames) {
    previewLoop.drawn = idx;
    previewLoop.frames = state.frames;
    drawLeds($('morphPreview'), state.frames[idx]);
    [...$('strip').children].forEach((c, i) => c.classList.toggle('current', i === idx));
  }
}

// ---------- upload + playback ----------
function hashBytes(b) {
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619);
  return h >>> 0;
}

function updateButtons() {
  const ready = mask.connected && state.frames.length > 0 && !state.uploading;
  $('uploadBtn').disabled = !ready;
  $('showBtn').disabled = !ready || !state.face;
  const uploaded = state.uploadedSig && state.uploadedSig === state.framesSig;
  $('playBtn').disabled = !uploaded || !mask.connected || state.uploading || state.player.playing;
  $('pauseBtn').disabled = !state.player.playing;
  $('restartBtn').disabled = !uploaded || !mask.connected || state.uploading;
  $('pos').disabled = !uploaded || state.uploading;
  $('uploadBtn').textContent = uploaded ? 'Re-send frames' : 'Send frames to mask';
  if (state.uploadedSig && !uploaded && !state.uploading) {
    setStatus('uploadStatus', 'Settings changed — send the frames again to play the new version.');
  }
}

async function uploadItems(items, label) {
  state.uploading = true;
  state.cancel = false;
  stopPlayer();
  updateButtons();
  await requestWakeLock();
  $('progressWrap').hidden = false;
  $('cancelBtn').hidden = false;
  const started = performance.now();
  let lastDone = 0;
  try {
    await mask.uploadFrames(items, {
      shouldStop: () => state.cancel,
      onFrameDone: (it) => { state.slotHashes.set(it.slot, it.hash); },
      onProgress: (f, frac, total) => {
        const done = f + frac;
        lastDone = done;
        $('progress').style.width = `${(100 * done) / total}%`;
        const per = (performance.now() - started) / 1000 / Math.max(done, 0.05);
        const left = Math.max(0, Math.round(per * (total - done)));
        setStatus('uploadStatus', `${label}: frame ${Math.min(f + 1, total)} of ${total} · about ${left}s left`);
      },
    });
    return true;
  } catch (e) {
    setStatus('uploadStatus', state.cancel ? 'Upload cancelled.' : `Upload failed: ${e.message}`, !state.cancel);
    return false;
  } finally {
    console.log(`upload of ${items.length} frames took ${((performance.now() - started) / 1000).toFixed(1)}s`, lastDone);
    state.uploading = false;
    $('cancelBtn').hidden = true;
    $('progressWrap').hidden = true;
    releaseWakeLockIfIdle();
    updateButtons();
  }
}

$('cancelBtn').onclick = () => { state.cancel = true; };

$('uploadBtn').onclick = async () => {
  regenerate();
  const gamma = num('gamma');
  const sig = state.framesSig;
  const all = state.frames.map((f, i) => {
    const rgba = toLed(f, gamma);
    return { slot: i + 1, rgba, hash: hashBytes(rgba) };
  });
  const todo = all.filter((it) => state.slotHashes.get(it.slot) !== it.hash);
  if (todo.length) {
    const ok = await uploadItems(todo, 'Sending');
    if (!ok) return;
  }
  state.uploadedSig = sig;
  setStatus('uploadStatus', `All ${all.length} frames are on the mask.`);
  state.player.index = 0;
  state.player.dir = 1;
  startPlayer();
};

$('showBtn').onclick = async () => {
  const rgba = toLed(renderFrame(state.morph, 0, morphOpts()), num('gamma'));
  const ok = await uploadItems([{ slot: PREVIEW_SLOT, rgba, hash: hashBytes(rgba) }], 'Sending preview');
  if (ok) {
    await mask.play(PREVIEW_SLOT);
    setStatus('uploadStatus', 'Preview is on the mask.');
  }
};

function showCurrentOnMask() {
  const p = state.player;
  $('pos').value = p.index;
  $('posOut').textContent = `${p.index + 1} / ${state.frames.length}`;
  return mask.play(p.index + 1).catch((e) => console.warn('play failed', e));
}

function startPlayer() {
  if (state.uploadedSig !== state.framesSig) return;
  const p = state.player;
  p.playing = true;
  requestWakeLock();
  clearTimeout(p.timer);
  const n = state.frames.length;
  const step = async () => {
    if (!p.playing) return;
    await showCurrentOnMask();
    const mode = $('mode').value;
    let next = p.index + p.dir;
    if (next >= n || next < 0) {
      if (mode === 'once') { p.playing = false; updateButtons(); releaseWakeLockIfIdle(); return; }
      if (mode === 'loop') next = 0;
      else { p.dir *= -1; next = p.index + p.dir; }
    }
    p.index = Math.max(0, Math.min(n - 1, next));
    p.timer = setTimeout(step, speedSeconds() * 1000);
  };
  if (p.index >= n - 1 && $('mode').value === 'once') p.index = 0;
  step();
  updateButtons();
}

function stopPlayer() {
  state.player.playing = false;
  clearTimeout(state.player.timer);
  releaseWakeLockIfIdle();
  updateButtons();
}

$('playBtn').onclick = startPlayer;
$('pauseBtn').onclick = stopPlayer;
$('restartBtn').onclick = () => {
  stopPlayer();
  state.player.index = 0;
  state.player.dir = 1;
  startPlayer();
};
$('pos').oninput = () => {
  stopPlayer();
  state.player.index = parseInt($('pos').value, 10);
  showCurrentOnMask();
};

// ---------- wake lock ----------
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock ??= await navigator.wakeLock?.request('screen'); } catch { /* not critical */ }
  wakeLock?.addEventListener?.('release', () => { wakeLock = null; });
}
function releaseWakeLockIfIdle() {
  if (!state.uploading && !state.player.playing && wakeLock) { wakeLock.release(); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (state.uploading || state.player.playing)) requestWakeLock();
});

// ---------- misc UI ----------
function setStatus(id, text, error = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', error);
}

function updateOutputs() {
  $('framesOut').textContent = frameCount();
  $('seedOut').textContent = `#${state.seed}`;
  const s = speedSeconds();
  $('speedOut').textContent = s < 1 ? `${s.toFixed(2)} s` : `${s.toFixed(1)} s`;
  $('posOut').textContent = `${state.player.index + 1} / ${state.frames.length || frameCount()}`;
}

for (const id of ['zoom', 'offsetX', 'offsetY', 'isolate', 'expand', 'contrast', 'saturation', 'autoLevels']) {
  $(id).addEventListener('input', () => { realign(); saveSettings(); updateOutputs(); });
}
for (const id of ['style', 'frames', 'intensity', 'colorDrift', 'gamma']) {
  $(id).addEventListener('input', () => { scheduleRegen(); saveSettings(); updateOutputs(); });
}
for (const id of ['speed', 'mode']) $(id).addEventListener('input', () => { saveSettings(); updateOutputs(); });
$('scrub').addEventListener('input', () => { state.scrubbedAt = performance.now(); });
$('seedBtn').onclick = () => {
  state.seed = Math.floor(Math.random() * 1000);
  saveSettings();
  updateOutputs();
  realign();
};
let brightTimer = null;
$('brightness').addEventListener('input', () => {
  saveSettings();
  clearTimeout(brightTimer);
  brightTimer = setTimeout(() => mask.setBrightness(num('brightness')).catch(() => {}), 120);
});

// ---------- start ----------
loadSettings();
updateOutputs();
setConnUI();
requestAnimationFrame(previewLoop);
if (!bluetoothSupported()) {
  $('btWarning').hidden = false;
  $('connectBtn').disabled = true;
} else {
  mask.autoConnect().catch((e) => console.warn('auto-connect failed', e));
}
loadLandmarker().catch((e) => setStatus('photoStatus', `Face detection failed to load: ${e.message}`, true));
restorePhoto();

// Exposed for debugging and automated tests.
window.maskApp = { state, mask, usePhoto, regenerate };
