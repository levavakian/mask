// Run with: nix run .#test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockCipher } from '../docs/js/aes.js';
import {
  KEY, commands, commandBlock, encodeImage, uploadPackets, parseResponse, hexToBytes, bytesToHex,
} from '../docs/js/protocol.js';

const cipher = await createBlockCipher(KEY);

test('decrypts traffic captured from the official app and from a real mask', async () => {
  // Captured from the official app (mask-go notes): MODE 03 with random padding.
  assert.equal(bytesToHex(await cipher.decrypt(hexToBytes('ccd4c4b5f2f41f617d56ee942ee4189a'))),
    '054d4f444503661a65c58086978c1e6e');
  // Our mask's reply to CHEC.
  assert.equal(bytesToHex(await cipher.decrypt(hexToBytes('4d310a508e301084e1fc0278c7f3bebf'))),
    '05434845430000000000000000000001');
});

test('encrypts commands the same way the official app does', async () => {
  // Official app's DATCP (no timestamp, zero padding).
  const block = commandBlock('DATCP');
  assert.equal(bytesToHex(block), '05444154435000000000000000000000');
  assert.equal(bytesToHex(await cipher.encrypt(block)), 'e799ad01aa48ae0aee0b7203e8ede520');
});

test('command layouts', () => {
  assert.equal(bytesToHex(commands.dats(8004, 7)), '09444154531f44000701' + '00'.repeat(6));
  assert.equal(bytesToHex(commands.play([3, 1, 2])), '08504c4159' + '03' + '030102' + '00'.repeat(7));
  assert.equal(bytesToHex(commands.light(300)), '064c49474854ff' + '00'.repeat(9));
  assert.equal(bytesToHex(commands.datcp(0x6a0b0c0d)), '0944415443506a0b0c0d' + '00'.repeat(6));
});

test('image is encoded column by column, top to bottom', () => {
  // 2 wide x 3 tall, row-major RGBA; pixel (x,y) has R = 10*x + y.
  const w = 2, h = 3;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba.set([10 * x + y, 100 + x, 200 + y, 255], i);
  }
  const out = encodeImage(rgba, w, h);
  assert.deepEqual(Array.from(out), [
    0, 100, 200, 1, 100, 201, 2, 100, 202, // column x=0
    10, 101, 200, 11, 101, 201, 12, 101, 202, // column x=1
  ]);
});

test('upload packets match the known 46x58 framing', () => {
  const data = new Uint8Array(8004).map((_, i) => i & 0xff);
  const packets = uploadPackets(data);
  assert.equal(packets.length, 82);
  assert.ok(packets.every((p) => p.length === 100));
  assert.deepEqual([packets[0][0], packets[0][1], packets[0][2], packets[0][99]], [99, 0, 0, 97]);
  const last = packets[81];
  assert.deepEqual([last[0], last[1]], [67, 81]); // 8004 - 81*98 = 66 data bytes
  assert.equal(last[2], (81 * 98) & 0xff);
  assert.equal(last[2 + 66], 0); // padding
});

test('parses mask responses', () => {
  assert.equal(parseResponse(hexToBytes('06444154534f4b000101000000000001')).name, 'DATSOK');
  assert.equal(parseResponse(hexToBytes('0452454f4b4f4b005000000000000002')).name, 'REOK');
  assert.equal(parseResponse(hexToBytes('0744415443504f4babbd000000000001')).name, 'DATCPOK');
  assert.equal(parseResponse(hexToBytes('06504c41594f4b000000000000000001')).name, 'PLAYOK');
});
