// Web Bluetooth connection to a Shining Mask.
import { createBlockCipher } from './aes.js';
import {
  SERVICE, CMD_CHAR, NOTIFY_CHAR, UPLOAD_CHAR, KEY, commands, encodeImage, uploadPackets, parseResponse, bytesToHex,
} from './protocol.js';

const FILTERS = [{ namePrefix: 'MASK' }, { services: [SERVICE] }];
const log = (...a) => console.log('[mask]', ...a);

export function bluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export class Mask extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.cmdChar = null;
    this.uploadChar = null;
    this.cipher = null;
    this.responses = [];
    this.waiter = null;
    this.queue = Promise.resolve(); // serializes GATT writes
    this.busy = false; // true while uploading: other commands would break the upload
    this.wantConnected = false;
  }

  get connected() {
    return !!(this.device && this.device.gatt.connected && this.cmdChar);
  }

  get name() {
    return this.device?.name || 'mask';
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, detail } }));
  }

  /** Reconnect to a previously approved mask without a tap, where the browser allows it. */
  async autoConnect() {
    if (!navigator.bluetooth?.getDevices) return false;
    let devices = [];
    try {
      devices = await navigator.bluetooth.getDevices();
    } catch (e) {
      log('getDevices failed', e);
      return false;
    }
    const known = devices.filter((d) => (d.name || '').startsWith('MASK'));
    if (!known.length) return false;
    const device = known[0];
    this.useDevice(device);
    this.setStatus('connecting', `Looking for ${device.name}…`);
    try {
      await this.connectGatt();
      return true;
    } catch (e) {
      log('direct reconnect failed, waiting for advertisement', e);
    }
    return this.waitForAdvertisement(device);
  }

  async waitForAdvertisement(device) {
    if (!device.watchAdvertisements) {
      this.setStatus('disconnected', 'Tap Connect');
      return false;
    }
    const ctrl = new AbortController();
    return new Promise((resolve) => {
      const onAdv = async () => {
        device.removeEventListener('advertisementreceived', onAdv);
        ctrl.abort();
        try {
          await this.connectGatt();
          resolve(true);
        } catch (e) {
          this.setStatus('disconnected', `Connect failed: ${e.message}`);
          resolve(false);
        }
      };
      device.addEventListener('advertisementreceived', onAdv);
      device.watchAdvertisements({ signal: ctrl.signal }).catch((e) => {
        log('watchAdvertisements failed', e);
        this.setStatus('disconnected', 'Tap Connect');
        resolve(false);
      });
      this.setStatus('connecting', `Waiting for ${device.name} — is it on?`);
    });
  }

  /** Show the browser's device picker. Must be called from a tap. */
  async requestAndConnect() {
    const device = await navigator.bluetooth.requestDevice({ filters: FILTERS, optionalServices: [SERVICE] });
    this.useDevice(device);
    await this.connectGatt();
  }

  useDevice(device) {
    if (this.device === device) return;
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
  }

  async connectGatt() {
    this.wantConnected = true;
    this.setStatus('connecting', `Connecting to ${this.device.name}…`);
    this.cipher ??= await createBlockCipher(KEY);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const server = await this.device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE);
        this.cmdChar = await service.getCharacteristic(CMD_CHAR);
        this.uploadChar = await service.getCharacteristic(UPLOAD_CHAR);
        const notify = await service.getCharacteristic(NOTIFY_CHAR);
        notify.addEventListener('characteristicvaluechanged', (e) => this.onNotify(e.target.value));
        await notify.startNotifications();
        this.setStatus('connected', this.device.name);
        return;
      } catch (e) {
        lastErr = e;
        log('connect attempt failed', attempt, e);
        await sleep(500);
      }
    }
    this.setStatus('disconnected', `Connect failed: ${lastErr?.message}`);
    throw lastErr;
  }

  disconnect() {
    this.wantConnected = false;
    this.device?.gatt.disconnect();
  }

  onDisconnected() {
    this.cmdChar = null;
    this.uploadChar = null;
    this.rejectWaiter(new Error('Mask disconnected'));
    this.setStatus('disconnected', 'Disconnected');
    if (this.wantConnected) this.reconnectLoop();
  }

  async reconnectLoop() {
    for (let i = 0; i < 20 && this.wantConnected && !this.connected; i++) {
      await sleep(1500);
      if (this.connected || !this.wantConnected) return;
      try {
        await this.connectGatt();
        return;
      } catch {
        /* keep trying */
      }
    }
  }

  async onNotify(dataView) {
    const raw = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength).slice();
    if (raw.length !== 16) return log('notify (unexpected length)', bytesToHex(raw));
    const plain = await this.cipher.decrypt(raw);
    const resp = parseResponse(plain);
    this.responses.push(resp);
    this.flushWaiter();
  }

  flushWaiter() {
    if (!this.waiter) return;
    while (this.responses.length) {
      const r = this.responses.shift();
      if (r.name.startsWith(this.waiter.prefix)) {
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(r);
        return;
      }
    }
  }

  rejectWaiter(err) {
    if (!this.waiter) return;
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    w.reject(err);
  }

  expect(prefix, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`Timed out waiting for ${prefix}`));
      }, timeoutMs);
      this.waiter = { prefix, resolve, reject, timer };
      this.flushWaiter();
    });
  }

  write(char, bytes) {
    const op = this.queue.then(async () => {
      if (!this.connected) throw new Error('Mask not connected');
      if (char.writeValueWithoutResponse) await char.writeValueWithoutResponse(bytes);
      else await char.writeValue(bytes);
    });
    this.queue = op.catch(() => {});
    return op;
  }

  async send(block) {
    return this.write(this.cmdChar, await this.cipher.encrypt(block));
  }

  /** Send a command unless an upload is running (any command mid-upload corrupts it). */
  async sendIfIdle(block) {
    if (this.busy || !this.connected) return false;
    await this.send(block);
    return true;
  }

  setBrightness(level) {
    return this.sendIfIdle(commands.light(level));
  }

  play(slots) {
    return this.sendIfIdle(commands.play(Array.isArray(slots) ? slots : [slots]));
  }

  /**
   * Upload one 46x58 RGBA frame into a slot (1-34).
   * The mask shows its download animation while this runs.
   */
  async uploadFrame(slot, rgba, onPacket) {
    const data = encodeImage(rgba);
    const packets = uploadPackets(data);
    this.responses = [];
    await this.send(commands.dats(data.length, slot));
    await this.expect('DATSOK');
    for (let i = 0; i < packets.length; i++) {
      await this.write(this.uploadChar, packets[i]);
      await this.expect('REOK');
      onPacket?.(i + 1, packets.length);
    }
    await this.send(commands.datcp(Math.floor(Date.now() / 1000)));
    await this.expect('DATCPOK');
  }

  /** Upload frames ([{ slot, rgba }]) one after another, retrying each a few times. */
  async uploadFrames(items, { onProgress, onFrameDone, shouldStop } = {}) {
    this.busy = true;
    try {
      for (let f = 0; f < items.length; f++) {
        if (shouldStop?.()) throw new Error('Upload cancelled');
        for (let attempt = 0; ; attempt++) {
          try {
            if (!this.connected) await this.waitConnected(15000);
            await this.uploadFrame(items[f].slot, items[f].rgba, (p, total) => onProgress?.(f, p / total, items.length));
            onFrameDone?.(items[f]);
            break;
          } catch (e) {
            log(`frame ${f + 1} attempt ${attempt + 1} failed`, e);
            if (attempt >= 3 || shouldStop?.()) throw e;
            await sleep(800);
            this.responses = [];
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  waitConnected(timeoutMs) {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.removeEventListener('status', on);
        reject(new Error('Mask not connected'));
      }, timeoutMs);
      const on = () => {
        if (this.connected) {
          clearTimeout(t);
          this.removeEventListener('status', on);
          resolve();
        }
      };
      this.addEventListener('status', on);
    });
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
