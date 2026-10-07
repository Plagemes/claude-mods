// A hooks module has no Node and no DOM, so no `crypto`: SHA-256 is written out here (FIPS 180-4).

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const INITIAL_HASH = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const BLOCK_BYTES = 64

const rotateRight = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

/** The UTF-8 bytes of `text`; a lone surrogate becomes U+FFFD, as a TextEncoder would. */
export const utf8Bytes = (text: string): number[] => {
  const bytes: number[] = []
  for (const char of text) {
    let code = char.codePointAt(0) ?? 0
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

/** Pads the message to whole blocks: a 1 bit, zeros, then its length in bits as 64 bits. */
const padded = (message: readonly number[]): number[] => {
  const bytes = [...message, 0x80]
  while (bytes.length % BLOCK_BYTES !== BLOCK_BYTES - 8) bytes.push(0)
  const bitLength = message.length * 8
  const high = Math.floor(bitLength / 2 ** 32)
  const low = bitLength >>> 0
  for (const word of [high, low]) bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff)
  return bytes
}

const compress = (hash: number[], block: readonly number[]): number[] => {
  const schedule: number[] = []
  for (let i = 0; i < 16; i++) {
    schedule.push(((block[i * 4] ?? 0) << 24) | ((block[i * 4 + 1] ?? 0) << 16) | ((block[i * 4 + 2] ?? 0) << 8) | (block[i * 4 + 3] ?? 0))
  }
  for (let i = 16; i < 64; i++) {
    const w15 = schedule[i - 15] ?? 0
    const w2 = schedule[i - 2] ?? 0
    const small0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3)
    const small1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10)
    schedule.push(((schedule[i - 16] ?? 0) + small0 + (schedule[i - 7] ?? 0) + small1) | 0)
  }

  let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = hash
  for (let i = 0; i < 64; i++) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
    const choice = (e & f) ^ (~e & g)
    const temp1 = (h + sum1 + choice + (ROUND_CONSTANTS[i] ?? 0) + (schedule[i] ?? 0)) | 0
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
    const majority = (a & b) ^ (a & c) ^ (b & c)
    const temp2 = (sum0 + majority) | 0
    h = g
    g = f
    f = e
    e = (d + temp1) | 0
    d = c
    c = b
    b = a
    a = (temp1 + temp2) | 0
  }
  const working = [a, b, c, d, e, f, g, h]
  return hash.map((word, i) => (word + (working[i] ?? 0)) | 0)
}

/** The SHA-256 of the UTF-8 text, as 64 lowercase hex digits. */
export const sha256Hex = (text: string): string => {
  const bytes = padded(utf8Bytes(text))
  let hash = INITIAL_HASH
  for (let offset = 0; offset < bytes.length; offset += BLOCK_BYTES) {
    hash = compress(hash, bytes.slice(offset, offset + BLOCK_BYTES))
  }
  return hash.map(word => (word >>> 0).toString(16).padStart(8, '0')).join('')
}
