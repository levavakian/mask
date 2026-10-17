// Shining Mask BLE protocol: pure helpers with no browser dependencies.
//
// Commands go to CMD_CHAR as one AES-128-ECB encrypted 16-byte block:
//   [len, ...ascii name, ...args, zero padding]   (len = name + args length)
// Images go to UPLOAD_CHAR unencrypted, in 100-byte packets:
//   [chunkLen + 1, packetIndex, ...chunk (<= 98 bytes), zero padding]
// The mask answers on NOTIFY_CHAR with encrypted 16-byte blocks.

export const SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
export const CMD_CHAR = 'd44bc439-abfd-45a2-b575-925416129600';
export const NOTIFY_CHAR = 'd44bc439-abfd-45a2-b575-925416129601';
export const UPLOAD_CHAR = 'd44bc439-abfd-45a2-b575-92541612960a';

export const KEY = hexToBytes('32672f7974ad43451d9c6c894a0e8764');

// Display size in LEDs. Some LED positions (corners) are not physically present.
export const WIDTH = 46;
export const HEIGHT = 58;
// Custom image slots available on the mask (1-based).
export const SLOT_COUNT = 34;

const CHUNK = 98;
const PACKET = 100;

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Plaintext 16-byte command block, before encryption. */
export function commandBlock(name, args = []) {
  const body = [...new TextEncoder().encode(name), ...args];
  if (body.length > 15) throw new Error(`command ${name} too long`);
  const out = new Uint8Array(16);
  out[0] = body.length;
  out.set(body, 1);
  return out;
}

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

export const commands = {
  light: (level) => commandBlock('LIGHT', [clampByte(level)]),
  /** Show stored custom images, cycling through them if more than one. */
  play: (slots) => commandBlock('PLAY', [slots.length, ...slots]),
  /** Start an image upload of `size` bytes into `slot`. */
  dats: (size, slot) => commandBlock('DATS', [...u16(size), ...u16(slot), 1]),
  /** Finish an upload. The app sends the current unix time. */
  datcp: (unixSeconds) => commandBlock('DATCP', u32(unixSeconds)),
  check: () => commandBlock('CHEC'),
};

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Convert row-major RGBA pixels (as from canvas ImageData) to the mask's
 * image format: column by column, top to bottom, 3 bytes RGB per LED.
 */
export function encodeImage(rgba, width = WIDTH, height = HEIGHT) {
  const out = new Uint8Array(width * height * 3);
  let o = 0;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      out[o++] = rgba[i];
      out[o++] = rgba[i + 1];
      out[o++] = rgba[i + 2];
    }
  }
  return out;
}

/** Split image bytes into upload packets. */
export function uploadPackets(data) {
  const packets = [];
  for (let off = 0, idx = 0; off < data.length; off += CHUNK, idx++) {
    const chunk = data.subarray(off, off + CHUNK);
    const p = new Uint8Array(PACKET);
    p[0] = chunk.length + 1;
    p[1] = idx & 0xff;
    p.set(chunk, 2);
    packets.push(p);
  }
  return packets;
}

/** Parse a decrypted notification block into its ASCII name, e.g. "DATSOK", "REOKOK". */
export function parseResponse(plain) {
  const len = Math.min(plain[0], 15);
  let name = '';
  for (let i = 1; i <= len; i++) {
    const c = plain[i];
    if (c < 0x41 || c > 0x5a) break; // A-Z only
    name += String.fromCharCode(c);
  }
  return { name, bytes: plain };
}
