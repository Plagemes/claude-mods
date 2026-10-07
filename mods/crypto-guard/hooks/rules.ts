export type RuleId = 'weak-hash' | 'predictable-random' | 'ecb-mode' | 'static-iv' | 'weak-cipher' | 'bcrypt-cost' | 'jwt-unsigned' | 'tls-verification'

export type Rule = {
  id: RuleId
  /** What is wrong, in a few words. */
  title: string
  /** What to do instead. */
  advice: string
}

export const RULES: Readonly<Record<RuleId, Rule>> = {
  'weak-hash': {
    id: 'weak-hash',
    title: 'MD5 or SHA-1',
    advice: 'Both are broken for anything security-related: use SHA-256 or better for integrity and signatures, and bcrypt, scrypt or Argon2 for passwords. For a plain non-security checksum it is fine: mark the line.',
  },
  'predictable-random': {
    id: 'predictable-random',
    title: 'a predictable random number for a secret',
    advice: 'Math.random() and the random module are not secure: use crypto.randomBytes / crypto.randomUUID / crypto.getRandomValues (JavaScript), the secrets module (Python), SecureRandom (Java, Ruby), crypto/rand (Go) or random_bytes (PHP).',
  },
  'ecb-mode': {
    id: 'ecb-mode',
    title: 'ECB mode',
    advice: 'ECB encrypts equal blocks to equal ciphertext and leaks the structure of the data: use AES-GCM (or CBC or CTR with a random IV and a MAC).',
  },
  'static-iv': {
    id: 'static-iv',
    title: 'a fixed IV or nonce',
    advice: 'Reusing an IV or nonce breaks CBC, CTR and especially GCM: generate a fresh random one for every encryption and store it next to the ciphertext.',
  },
  'weak-cipher': {
    id: 'weak-cipher',
    title: 'a broken cipher',
    advice: 'DES, 3DES, RC4 and createCipher (no IV, a weak key derivation) are obsolete: use AES-256-GCM or ChaCha20-Poly1305.',
  },
  'bcrypt-cost': {
    id: 'bcrypt-cost',
    title: 'a low bcrypt cost',
    advice: 'Below 10 rounds is cheap to brute-force: use 12 or more, and raise it as hardware gets faster.',
  },
  'jwt-unsigned': {
    id: 'jwt-unsigned',
    title: 'unsigned or unverified JWTs',
    advice: 'alg "none" and skipped signature checks let anyone forge a token: always verify with a fixed algorithm allow-list.',
  },
  'tls-verification': {
    id: 'tls-verification',
    title: 'TLS certificate verification turned off',
    advice: 'This allows man-in-the-middle attacks: trust the right CA (a CA bundle, a pinned certificate) instead of disabling the check.',
  },
}

/** Words of a name or sentence: `apiKey`, `API_KEY` and `api-key` as ['api', 'key']. */
export const wordsOf = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(word => word !== '')
    .map(word => word.toLowerCase())

const SECRET_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'passcode', 'passphrase', 'nonce', 'otp', 'salt', 'csrf', 'xsrf', 'uuid', 'guid', 'apikey', 'sessionid', 'session', 'auth', 'pin'])
const SECRET_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'], ['secret', 'key'], ['private', 'key'], ['access', 'key'], ['encryption', 'key'], ['signing', 'key'], ['hmac', 'key'],
  ['session', 'id'], ['user', 'id'], ['account', 'id'], ['order', 'id'], ['reset', 'id'], ['reset', 'code'], ['verification', 'code'],
  ['confirmation', 'code'], ['invite', 'code'], ['login', 'code'], ['auth', 'code'],
]

/** Does the text name something that must not be guessable: a token, a secret, an OTP, a nonce, a session id ...? */
export const mentionsSecret = (text: string): boolean => {
  const words = wordsOf(text)
  return words.some((word, at) => SECRET_WORDS.has(word) || SECRET_PAIRS.some(([a, b]) => word === a && words[at + 1] === b))
}
