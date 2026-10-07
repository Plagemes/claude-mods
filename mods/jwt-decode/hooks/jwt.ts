import { hmacSha256 } from './sha256'

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const MAX_JSON_CHARS = 4000
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const LONG_LIVED_MS = 30 * DAY
/** Anything past this as a NumericDate is milliseconds by mistake (year 5138 in seconds). */
const MILLISECONDS_THRESHOLD = 1e11

/** Secrets that show up in tutorials and sample code; a token signed with one of them is not protected. */
const WEAK_SECRETS = [
  'secret', 'password', '123456', '12345678', 'changeme', 'change-me', 'jwt', 'jwt_secret', 'jwtsecret', 'jwt-secret', 'jwt_secret_key', 'secretkey', 'secret_key', 'secret-key',
  'supersecret', 'super-secret', 'super_secret', 'mysecret', 'my-secret', 'my_secret', 'mysecretkey', 'your-256-bit-secret', 'your-secret', 'your_secret_key', 'your-secret-key',
  'key', 'test', 'testing', 'admin', 'qwerty', 'letmein', 'default', 'development', 'dev', 'token', 'hmac', 'shhhhh', 'shh', 'topsecret', 's3cr3t', 'abc123', '0123456789',
  'secret123', 'password123', 'keyboard cat',
]

type Json = Record<string, unknown>

export const decodeBase64Url = (text: string): number[] | undefined => {
  const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (/[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) return undefined
  const bytes: number[] = []
  for (let index = 0; index < clean.length; index += 4) {
    const chunk = [...clean.slice(index, index + 4)].map(char => BASE64.indexOf(char))
    const [a = 0, b = 0, c, d] = chunk
    bytes.push((a << 2) | (b >> 4))
    if (c !== undefined) bytes.push(((b & 15) << 4) | (c >> 2))
    if (d !== undefined) bytes.push((((c ?? 0) & 3) << 6) | d)
  }
  return bytes
}

export const encodeBase64Url = (bytes: readonly number[]): string => {
  let text = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const [a = 0, b, c] = bytes.slice(index, index + 3)
    text += BASE64[a >> 2] ?? ''
    text += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)] ?? ''
    if (b !== undefined) text += BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)] ?? ''
    if (c !== undefined) text += BASE64[c & 63] ?? ''
  }
  return text.replace(/\+/g, '-').replace(/\//g, '_')
}

export const utf8Bytes = (text: string): number[] =>
  [...text].flatMap(char => {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) return [code]
    if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 63)]
    if (code < 0x10000) return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)]
    return [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)]
  })

const utf8Text = (bytes: readonly number[]): string | undefined => {
  try {
    return decodeURIComponent(bytes.map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''))
  } catch {
    return undefined
  }
}

const parseObject = (text: string | undefined): Json | undefined => {
  try {
    const value: unknown = JSON.parse(text ?? '')
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
  } catch {
    return undefined
  }
}

export type Token = {
  header: Json
  /** The claims, when the payload is a JSON object. */
  claims: Json | undefined
  /** The payload as text, when it is not JSON (or an encrypted token's missing one). */
  payloadText: string | undefined
  signature: string
  signingInput: string
  /** 3 for a signed token (JWS), 5 for an encrypted one (JWE). */
  partCount: number
}

/** Reads a token out of text: the first piece that looks like `header.payload.signature` and whose header is JSON. */
export const parseToken = (text: string): Token | undefined => {
  // Each match starts where a run of token characters starts, so a long text without dots is read once, not once per character.
  const pieces = text.match(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){1,4}/g) ?? text.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){2}/g) ?? []
  for (const piece of pieces) {
    const parts = piece.split('.')
    const header = parseObject(utf8Text(decodeBase64Url(parts[0] ?? '') ?? []))
    if (header === undefined || (parts.length !== 3 && parts.length !== 5)) continue
    if (parts.length === 5) return { header, claims: undefined, payloadText: undefined, signature: '', signingInput: '', partCount: 5 }

    const payload = utf8Text(decodeBase64Url(parts[1] ?? '') ?? [])
    return { header, claims: parseObject(payload), payloadText: payload, signature: parts[2] ?? '', signingInput: `${parts[0]}.${parts[1]}`, partCount: 3 }
  }
  return undefined
}

// ── Time ────────────────────────────────────────────────────────────────────

export const formatSpan = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / SECOND))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
  const days = Math.floor(hours / 24)
  if (days < 90) return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`
  return days < 730 ? `${Math.round(days / 30)} months` : `${Math.floor(days / 365)} years`
}

const formatDate = (seconds: number): string => `${new Date(seconds * SECOND).toISOString().slice(0, 19).replace('T', ' ')} UTC`

type Instant = { name: 'iat' | 'nbf' | 'exp'; seconds: number }

const instantsOf = (claims: Json): Instant[] =>
  (['iat', 'nbf', 'exp'] as const).flatMap(name => {
    const seconds = claims[name]
    return typeof seconds === 'number' && Number.isFinite(seconds) ? [{ name, seconds }] : []
  })

const relativeTo = ({ name, seconds }: Instant, now: number): string => {
  const delta = seconds * SECOND - now
  const span = formatSpan(Math.abs(delta))
  if (name === 'exp') return delta <= 0 ? `expired ${span} ago` : `valid for ${span} more`
  if (name === 'nbf') return delta > 0 ? `not valid yet, starts in ${span}` : `valid since ${span} ago`
  return delta > 0 ? `issued ${span} from now (in the future)` : `issued ${span} ago`
}

// ── Warnings ────────────────────────────────────────────────────────────────

/** The guessable secret an HS256 token was signed with, if it was signed with one. */
const weakSecretOf = (token: Token): string | undefined => {
  const expected = decodeBase64Url(token.signature)
  if (expected === undefined || expected.length === 0) return undefined
  return WEAK_SECRETS.find(secret => encodeBase64Url(hmacSha256(utf8Bytes(secret), utf8Bytes(token.signingInput))) === encodeBase64Url(expected))
}

const notesOf = (token: Token, instants: readonly Instant[]): string[] => {
  const notes: string[] = []
  const alg = typeof token.header.alg === 'string' ? token.header.alg : undefined
  if (alg === undefined) notes.push('⚠ the header has no "alg": the signature method is unknown.')
  else if (alg.toLowerCase() === 'none') notes.push('⚠ alg "none": the token is unsigned, so anyone can forge it. A server must reject it.')
  else if (/^HS/i.test(alg)) {
    const isHs256 = alg.toUpperCase() === 'HS256'
    const weak = isHs256 ? weakSecretOf(token) : undefined
    notes.push(
      weak === undefined
        ? `ℹ ${alg} is symmetric: one shared secret signs and verifies, so it has to be long and random.${isHs256 ? ` It is not one of the ${WEAK_SECRETS.length} common sample secrets that were tried.` : ' (The weak-secret check covers HS256 only.)'}`
        : `⚠ ${alg} signed with the guessable secret "${weak}": anyone can mint tokens. Change the secret.`,
    )
  } else notes.push(`ℹ signed with ${alg}: it is verified with the issuer's public key, which is not checked here.`)
  if (token.partCount === 3 && token.signature === '' && alg?.toLowerCase() !== 'none') notes.push('⚠ the signature part is empty.')

  const keyLocations = ['jku', 'x5u', 'jwk', 'x5c'].filter(name => name in token.header)
  if (keyLocations.length > 0) notes.push(`⚠ the header carries ${keyLocations.join(', ')}: a key the token points to itself must never be trusted.`)

  const exp = instants.find(instant => instant.name === 'exp')
  const iat = instants.find(instant => instant.name === 'iat')
  if (token.claims !== undefined && exp === undefined) notes.push('⚠ no "exp" claim: the token never expires.')
  if (instants.some(instant => instant.seconds > MILLISECONDS_THRESHOLD)) notes.push('⚠ a time claim looks like milliseconds; NumericDate is seconds.')
  if (exp !== undefined && iat !== undefined && (exp.seconds - iat.seconds) * SECOND > LONG_LIVED_MS) notes.push(`⚠ very long-lived: ${formatSpan((exp.seconds - iat.seconds) * SECOND)} between iat and exp.`)
  return notes
}

// ── The report ──────────────────────────────────────────────────────────────

const pretty = (value: unknown): string => {
  const text = JSON.stringify(value, null, 2)
  return text.length > MAX_JSON_CHARS ? `${text.slice(0, MAX_JSON_CHARS)}\n… (${text.length - MAX_JSON_CHARS} more characters)` : text
}

/** The decoded token as text: header, claims, times against `now` (ms), and notes. The token itself is not part of it. */
export const describeToken = (token: Token, now: number): string => {
  const alg = typeof token.header.alg === 'string' ? token.header.alg : 'unknown'
  const headline = ['JWT', `alg ${alg}`, ...(typeof token.header.typ === 'string' ? [`typ ${token.header.typ}`] : []), ...(typeof token.header.kid === 'string' ? [`kid ${token.header.kid}`] : [])].join(' · ')

  if (token.partCount === 5) {
    return [headline, '', 'Header', pretty(token.header), '', 'This is an encrypted token (JWE): its payload cannot be read without the key.'].join('\n')
  }
  const instants = token.claims === undefined ? [] : instantsOf(token.claims)
  const times = instants.map(instant => `  ${instant.name}  ${formatDate(instant.seconds)}  ${relativeTo(instant, now)}`)
  const notes = notesOf(token, instants)

  return [
    headline,
    '',
    'Header',
    pretty(token.header),
    '',
    token.claims === undefined ? 'Payload (not a JSON object)' : 'Claims',
    token.claims === undefined ? (token.payloadText ?? '(unreadable)') : pretty(token.claims),
    ...(times.length > 0 ? ['', 'Times', ...times] : []),
    ...(notes.length > 0 ? ['', 'Notes', ...notes.map(note => `  ${note}`)] : []),
    '',
    `Signature: ${token.signature.length} characters, not verified here (that needs the issuer's key). Decoded locally; nothing was sent anywhere.`,
  ].join('\n')
}

/** Replaces every JWT-shaped string with a marker. */
export const redactTokens = (text: string): string => text.replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){1,3}/g, '[JWT removed by jwt-decode]')
