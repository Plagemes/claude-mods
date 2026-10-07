const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const BLOCK = 64

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

/** SHA-256 of bytes, as bytes (FIPS 180-4). */
export const sha256 = (message: readonly number[]): number[] => {
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const bytes = [...message, 0x80]
  while (bytes.length % BLOCK !== 56) bytes.push(0)
  const bitLength = message.length * 8
  for (let shift = 56; shift >= 0; shift -= 8) bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff)

  for (let offset = 0; offset < bytes.length; offset += BLOCK) {
    const w = Array.from({ length: 64 }, (_, index) =>
      index < 16 ? (((bytes[offset + index * 4] ?? 0) << 24) | ((bytes[offset + index * 4 + 1] ?? 0) << 16) | ((bytes[offset + index * 4 + 2] ?? 0) << 8) | (bytes[offset + index * 4 + 3] ?? 0)) >>> 0 : 0,
    )
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] ?? 0
      const b = w[index - 2] ?? 0
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[index] = ((w[index - 16] ?? 0) + s0 + (w[index - 7] ?? 0) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number]
    for (let index = 0; index < 64; index += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[index] ?? 0) + (w[index] ?? 0)) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      ;[h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0]
    }
    ;[a, b, c, d, e, f, g, h].forEach((value, index) => {
      hash[index] = ((hash[index] ?? 0) + value) >>> 0
    })
  }
  return hash.flatMap(word => [word >>> 24, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff])
}

/** HMAC-SHA256 (RFC 2104). */
export const hmacSha256 = (key: readonly number[], message: readonly number[]): number[] => {
  const block = key.length > BLOCK ? sha256(key) : [...key]
  while (block.length < BLOCK) block.push(0)
  const inner = sha256([...block.map(byte => byte ^ 0x36), ...message])
  return sha256([...block.map(byte => byte ^ 0x5c), ...inner])
}
