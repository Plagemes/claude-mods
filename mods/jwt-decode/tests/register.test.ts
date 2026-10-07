import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { decodeBase64Url, describeToken, encodeBase64Url, formatSpan, parseToken, redactTokens, utf8Bytes } from '../hooks/jwt'
import { hmacSha256, sha256 } from '../hooks/sha256'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const SECONDS = (iso: string): number => Date.parse(iso) / 1000
/** The sample token from jwt.io: HS256, signed with "your-256-bit-secret". */
const SAMPLE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
const STRONG_SIGNATURE = 'k3Jx9QpZr2LmN7vB1cD5fGhT8wYsU0aE4iOoXyVbR6A'

const encode = (value: unknown): string => encodeBase64Url(utf8Bytes(JSON.stringify(value)))
const token = (header: Record<string, unknown>, claims: Record<string, unknown>, signature = STRONG_SIGNATURE): string => `${encode(header)}.${encode(claims)}.${signature}`

type Seen = { registered: string[]; selections: string[]; appended: string[] }

const world = (on: On, selection?: string): Seen => {
  mock.clock(on, { now: NOW })
  const seen: Seen = { registered: [], selections: [], appended: [] }
  on('command.register', (_$, e) => {
    seen.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.selection', () => {
    seen.selections.push('asked')
    return { value: selection === undefined ? undefined : { text: selection } }
  })
  // Stands for the engine's store: records what reaches it (the rejection of a bottom that stores nothing is swallowed by the caller).
  on('session.append', (_$, e, next) => {
    seen.appended.push(e.message.content.map(block => String(block.text)).join(''))
    return next(e)
  })
  return seen
}

const jwt = ($: Engine, args: string) => $.command.run({ command: 'jwt', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('the jwt.io sample is decoded: header, claims, issue time, and the guessable secret it was signed with', async ($, on) => {
  world(on)

  const { text } = await jwt($, SAMPLE)

  expect(text).toContain('JWT · alg HS256 · typ JWT')
  expect(text).toContain('"sub": "1234567890"')
  expect(text).toContain('"name": "John Doe"')
  expect(text).toContain('  iat  2018-01-18 01:30:22 UTC  issued 8 years ago')
  expect(text).toContain('⚠ HS256 signed with the guessable secret "your-256-bit-secret": anyone can mint tokens.')
  expect(text).toContain('⚠ no "exp" claim: the token never expires.')
  expect(text).toContain('Signature: 43 characters, not verified here')
  expect(text).not.toContain(SAMPLE)
  expect(text).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
})

test('times are shown as dates with how far away they are', async ($, on) => {
  world(on)
  const expired = token({ alg: 'RS256', typ: 'JWT', kid: 'key-1' }, { iss: 'https://auth.example.com', iat: SECONDS('2026-10-07T08:00:00Z'), nbf: SECONDS('2026-10-07T08:00:00Z'), exp: SECONDS('2026-10-07T09:55:00Z') })
  const valid = token({ alg: 'ES256' }, { iat: SECONDS('2026-10-07T11:50:00Z'), nbf: SECONDS('2026-10-07T12:30:00Z'), exp: SECONDS('2026-10-07T12:14:00Z') })

  const past = (await jwt($, expired)).text
  expect(past).toContain('JWT · alg RS256 · typ JWT · kid key-1')
  expect(past).toContain('  iat  2026-10-07 08:00:00 UTC  issued 4 h ago')
  expect(past).toContain('  nbf  2026-10-07 08:00:00 UTC  valid since 4 h ago')
  expect(past).toContain('  exp  2026-10-07 09:55:00 UTC  expired 2 h 5 min ago')
  expect(past).toContain("ℹ signed with RS256: it is verified with the issuer's public key")

  const future = (await jwt($, valid)).text
  expect(future).toContain('exp  2026-10-07 12:14:00 UTC  valid for 14 min more')
  expect(future).toContain('nbf  2026-10-07 12:30:00 UTC  not valid yet, starts in 30 min')
})

test('warnings: alg none, an empty signature, key locations in the header, long lifetimes, milliseconds', async ($, on) => {
  world(on)

  const none = (await jwt($, `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'admin', exp: SECONDS('2027-01-01T00:00:00Z') })}.`)).text
  expect(none).toContain('⚠ alg "none": the token is unsigned, so anyone can forge it.')

  const emptySignature = (await jwt($, `${encode({ alg: 'HS512' })}.${encode({ exp: 1 })}.`)).text
  expect(emptySignature).toContain('⚠ the signature part is empty.')
  expect(emptySignature).toContain('The weak-secret check covers HS256 only.')

  const jku = (await jwt($, token({ alg: 'RS256', jku: 'https://evil.example/keys.json' }, { exp: SECONDS('2026-10-08T00:00:00Z') }))).text
  expect(jku).toContain('⚠ the header carries jku: a key the token points to itself must never be trusted.')

  const longLived = (await jwt($, token({ alg: 'RS256' }, { iat: SECONDS('2026-01-01T00:00:00Z'), exp: SECONDS('2027-01-01T00:00:00Z') }))).text
  expect(longLived).toContain('⚠ very long-lived: 12 months between iat and exp.')

  const millis = (await jwt($, token({ alg: 'RS256' }, { exp: NOW + 3_600_000 }))).text
  expect(millis).toContain('⚠ a time claim looks like milliseconds')

  const strong = (await jwt($, token({ alg: 'HS256' }, { exp: SECONDS('2026-10-07T13:00:00Z') }))).text
  expect(strong).toContain('ℹ HS256 is symmetric')
  expect(strong).toContain('It is not one of the 45 common sample secrets that were tried.')
})

test('a payload that is not JSON and an encrypted token are described, not decoded', async ($, on) => {
  world(on)

  const plain = (await jwt($, `${encode({ alg: 'HS256' })}.${encodeBase64Url(utf8Bytes('just text'))}.${STRONG_SIGNATURE}`)).text
  expect(plain).toContain('Payload (not a JSON object)')
  expect(plain).toContain('just text')

  const jwe = (await jwt($, `${encode({ alg: 'RSA-OAEP', enc: 'A256GCM' })}.a2V5.aXY.Y2lwaGVy.dGFn`)).text
  expect(jwe).toContain('This is an encrypted token (JWE): its payload cannot be read without the key.')
})

test('the token may come wrapped: Bearer, quotes, a header line, a curl command, or the mouse selection', async ($, on) => {
  const seen = world(on, `Authorization: Bearer ${SAMPLE}`)

  expect((await jwt($, `Bearer ${SAMPLE}`)).text).toContain('"name": "John Doe"')
  expect((await jwt($, `"${SAMPLE}"`)).text).toContain('"name": "John Doe"')
  expect((await jwt($, `curl -H 'Authorization: Bearer ${SAMPLE}' https://x`)).text).toContain('"name": "John Doe"')
  expect(seen.selections).toHaveLength(0)

  expect((await jwt($, '')).text).toContain('"name": "John Doe"')
  expect(seen.selections).toEqual(['asked'])
})

test('nothing selected and nothing typed explains the command; text that is not a token says so', async ($, on) => {
  world(on)

  expect((await jwt($, '')).text).toContain('Usage: /jwt <token>')
  expect((await jwt($, 'hello.world.again')).text).toContain('does not look like a JWT')
  expect((await jwt($, 'eyJ.x.y')).text).toContain('does not look like a JWT')
})

test('the command output holds nothing that could be used as the token', async ($, on) => {
  world(on)
  const secretToken = token({ alg: 'RS256' }, { sub: 'u1', exp: SECONDS('2026-10-07T13:00:00Z') }, 'A'.repeat(342))

  const { text, context } = await jwt($, secretToken)

  expect(text).not.toContain(secretToken)
  expect(text).not.toContain('A'.repeat(20))
  expect(context).toBeUndefined()
})

test('registers /jwt', async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(seen.registered).toEqual(['jwt'])
})

test('the token is taken out of the command record before the conversation keeps it; other rows are not touched', async ($, on) => {
  const seen = world(on)
  const row = (door: 'command' | 'prompt', text: string) =>
    $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text }] }, door, origin: { kind: 'composer' }, uuid: `row-${seen.appended.length}` })
      .catch(() => undefined)

  await row('command', `<command-name>/jwt</command-name><command-args>${SAMPLE}</command-args>`)
  await row('command', `<command-name>/other</command-name><command-args>${SAMPLE}</command-args>`)
  await row('prompt', `what is wrong with ${SAMPLE}?`)

  expect(seen.appended).toEqual([
    '<command-name>/jwt</command-name><command-args>[JWT removed by jwt-decode]</command-args>',
    `<command-name>/other</command-name><command-args>${SAMPLE}</command-args>`,
    `what is wrong with ${SAMPLE}?`,
  ])
})

test('tokens are taken out of command records, other text is not', () => {
  expect(redactTokens(`<command-args>${SAMPLE}</command-args>`)).toBe('<command-args>[JWT removed by jwt-decode]</command-args>')
  expect(redactTokens(`a ${SAMPLE} b ${SAMPLE}`)).toBe('a [JWT removed by jwt-decode] b [JWT removed by jwt-decode]')
  expect(redactTokens('JWT · alg HS256 · typ JWT')).toBe('JWT · alg HS256 · typ JWT')
  expect(redactTokens('eyJ is a prefix')).toBe('eyJ is a prefix')
})

test('base64url, UTF-8 and SHA-256 do what the standards say', () => {
  const name = 'Zoë 日本 😀'
  expect(parseToken(token({ alg: 'HS256' }, { name }))?.claims).toEqual({ name })
  expect(encodeBase64Url(decodeBase64Url('aGVsbG8_Pz8-')!)).toBe('aGVsbG8_Pz8-')
  expect(decodeBase64Url('a')).toBeUndefined()
  expect(decodeBase64Url('a b')).toBeUndefined()
  expect(encodeBase64Url([104, 105])).toBe('aGk')

  const hex = (bytes: number[]): string => bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')
  expect(hex(sha256(utf8Bytes('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(hex(sha256([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(hex(sha256(utf8Bytes('a'.repeat(1000))))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
  expect(hex(hmacSha256(utf8Bytes('key'), utf8Bytes('The quick brown fox jumps over the lazy dog')))).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
  expect(hex(hmacSha256(utf8Bytes('k'.repeat(100)), utf8Bytes('x')))).toHaveLength(64)
})

test('spans are written for people', () => {
  expect([0, 45_000, 14 * 60_000, 2 * 3_600_000 + 5 * 60_000, 3 * 86_400_000 + 4 * 3_600_000, 200 * 86_400_000, 800 * 86_400_000].map(formatSpan)).toEqual(['0 s', '45 s', '14 min', '2 h 5 min', '3 d 4 h', '7 months', '2 years'])
  const parsed = parseToken(SAMPLE)
  expect(parsed === undefined ? '' : describeToken(parsed, NOW)).toContain('John Doe')
})

test('a long text without a token is searched in linear time', () => {
  const startedAt = performance.now()
  expect(parseToken('A'.repeat(200_000))).toBeUndefined()
  expect(parseToken('eyJ'.repeat(60_000))).toBeUndefined()
  expect(performance.now() - startedAt).toBeLessThan(500)
  expect(parseToken(`see ${SAMPLE} here`)?.claims?.sub).toBe('1234567890')
})
