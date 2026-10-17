// Single-block AES-128-ECB using WebCrypto, which only offers CBC.
// ECB of one block equals the first block of CBC with a zero IV.
// Decryption appends a crafted second block so CBC padding checks pass.

const ZERO_IV = new Uint8Array(16);

export async function createBlockCipher(keyBytes, subtle = globalThis.crypto.subtle) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);

  async function encrypt(block) {
    const out = await subtle.encrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, block);
    return new Uint8Array(out, 0, 16).slice();
  }

  async function decrypt(block) {
    // With C2 = E(pad ^ C1), CBC-decrypting [C1, C2] yields [D(C1), pad],
    // where pad = sixteen 0x10 bytes is valid PKCS#7 padding and gets stripped.
    const x = new Uint8Array(16);
    for (let i = 0; i < 16; i++) x[i] = 0x10 ^ block[i];
    const c2 = await encrypt(x);
    const both = new Uint8Array(32);
    both.set(block, 0);
    both.set(c2, 16);
    const out = await subtle.decrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, both);
    return new Uint8Array(out).slice(0, 16);
  }

  return { encrypt, decrypt };
}
