/**
 * Everything about getting one email out, with no I/O: addresses, the MIME message, and the three providers' request
 * shapes (Resend and SendGrid over HTTPS, SMTP through `curl`). Pure, so every shape is unit-tested.
 */

export type Mail = {
  /** `Name <name@example.com>` or a bare address. */
  from: string
  to: string[]
  replyTo?: string
  subject: string
  text: string
  html: string
}

const ADDRESS = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/

export const isEmail = (text: string): boolean => text.length <= 254 && ADDRESS.test(text)

/** `Ada <ada@x.io>` into its parts; undefined when there is no valid address in it. */
export function parseAddress(text: string): { name: string; email: string } | undefined {
  const named = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(text)
  const email = (named?.[2] ?? text).trim()
  if (!isEmail(email)) return undefined
  return { name: (named?.[1] ?? '').trim(), email }
}

export type Recipients = { valid: string[]; invalid: string[] }

/** Splits "a@x.com, b@y.com; c@z.com" and sorts the good from the bad; duplicates are dropped, order kept. */
export function parseRecipients(text: string): Recipients {
  const valid: string[] = []
  const invalid: string[] = []
  for (const piece of text.split(/[\s,;]+/).map(item => item.trim()).filter(item => item !== '')) {
    const email = parseAddress(piece)?.email
    if (email === undefined) invalid.push(piece)
    else if (!valid.some(known => known.toLowerCase() === email.toLowerCase())) valid.push(email)
  }
  return { valid, invalid }
}

/** A header value on one line: a line break in it would let a title add headers of its own. */
export const headerSafe = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim()

// ── MIME ─────────────────────────────────────────────────────────────────────────────────────────────

/** UTF-8 bytes of a string (a module has no TextEncoder to lean on). */
export function utf8(text: string): number[] {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return bytes
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: readonly number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64[a >> 2] ?? ''
    out += B64[((a & 3) << 4) | (b >> 4)] ?? ''
    out += i + 1 < bytes.length ? (B64[((b & 15) << 2) | (c >> 6)] ?? '') : '='
    out += i + 2 < bytes.length ? (B64[c & 63] ?? '') : '='
  }
  return out
}

/** Base64 folded at 76 characters per line, CRLF between. */
const folded = (encoded: string): string => (encoded.match(/.{1,76}/g) ?? []).join('\r\n')

const isAscii = (text: string): boolean => /^[\x20-\x7e]*$/.test(text)

/** RFC 2047 encoded-word for a header value that is not plain ASCII (one word per ~40 characters so none passes 75). */
export function encodeWord(text: string): string {
  const value = headerSafe(text)
  if (isAscii(value)) return value
  const words: string[] = []
  let current = ''
  for (const char of value) {
    if (utf8(current + char).length > 42) {
      words.push(current)
      current = ''
    }
    current += char
  }
  if (current !== '') words.push(current)
  return words.map(word => `=?UTF-8?B?${base64(utf8(word))}?=`).join('\r\n ')
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number): string => String(n).padStart(2, '0')

/** RFC 5322 date in UTC. */
export function mailDate(at: number): string {
  const d = new Date(at)
  return `${WEEKDAYS[d.getUTCDay()]}, ${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`
}

/** The address part of a `Name <a@b.c>` value, name encoded when it needs it. */
function addressHeader(value: string): string {
  const parsed = parseAddress(value)
  if (parsed === undefined) return headerSafe(value)
  if (parsed.name === '') return parsed.email
  const name = encodeWord(parsed.name)
  return `${isAscii(parsed.name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name} <${parsed.email}>`
}

/** A complete RFC 5322 message, multipart/alternative with a text and an HTML part, both base64 UTF-8. CRLF lines. */
export function buildMime(mail: Mail, now: number, id: string): string {
  const boundary = `=_digest_${id}`
  const lines = [
    `From: ${addressHeader(mail.from)}`,
    `To: ${mail.to.map(address => addressHeader(address)).join(', ')}`,
    ...(mail.replyTo === undefined || mail.replyTo === '' ? [] : [`Reply-To: ${addressHeader(mail.replyTo)}`]),
    `Subject: ${encodeWord(mail.subject)}`,
    `Date: ${mailDate(now)}`,
    `Message-ID: <${id}@email-digest.local>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    folded(base64(utf8(mail.text))),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    folded(base64(utf8(mail.html))),
    `--${boundary}--`,
    '',
  ]
  return lines.join('\r\n')
}

// ── Providers ────────────────────────────────────────────────────────────────────────────────────────

export type HttpRequest = { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string } }

export const RESEND_URL = 'https://api.resend.com/emails'
export const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send'

export function resendRequest(mail: Mail, apiKey: string): HttpRequest {
  return {
    url: RESEND_URL,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: mail.from, to: mail.to, ...(mail.replyTo === undefined || mail.replyTo === '' ? {} : { reply_to: mail.replyTo }), subject: headerSafe(mail.subject), html: mail.html, text: mail.text }),
    },
  }
}

export function sendgridRequest(mail: Mail, apiKey: string): HttpRequest {
  const from = parseAddress(mail.from)
  const replyTo = mail.replyTo === undefined ? undefined : parseAddress(mail.replyTo)
  return {
    url: SENDGRID_URL,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: mail.to.map(email => ({ email })) }],
        from: { email: from?.email ?? mail.from, ...(from === undefined || from.name === '' ? {} : { name: from.name }) },
        ...(replyTo === undefined ? {} : { reply_to: { email: replyTo.email } }),
        subject: headerSafe(mail.subject),
        // SendGrid wants text/plain first.
        content: [
          { type: 'text/plain', value: mail.text },
          { type: 'text/html', value: mail.html },
        ],
      }),
    },
  }
}

export type SendResult = { isSent: boolean; detail: string }

/** Takes the secret out of a message (providers sometimes echo what they were sent). */
export const without = (message: string, secrets: readonly string[]): string =>
  secrets.filter(secret => secret.length >= 4).reduce((text, secret) => text.split(secret).join('[key]'), message)

const oneLine = (text: string, max = 200): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Resend answers 200 with `{ id }`, or `{ name, message }` with a 4xx. */
export function readResend(status: number, body: string): SendResult {
  let parsed: { id?: unknown; message?: unknown; name?: unknown } = {}
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    parsed = {}
  }
  if (status >= 200 && status < 300) return { isSent: true, detail: typeof parsed.id === 'string' ? parsed.id : '' }
  if (status === 401 || status === 403) return { isSent: false, detail: `Resend refused the API key (${status}). ${typeof parsed.message === 'string' ? oneLine(parsed.message) : ''}`.trim() }
  return { isSent: false, detail: `Resend answered ${status}${typeof parsed.message === 'string' ? `: ${oneLine(parsed.message)}` : ''}` }
}

/** SendGrid answers 202 with an empty body, or `{ errors: [{ message }] }`. */
export function readSendgrid(status: number, body: string): SendResult {
  if (status >= 200 && status < 300) return { isSent: true, detail: '' }
  let message = ''
  try {
    const errors = (JSON.parse(body) as { errors?: { message?: unknown }[] }).errors
    message = errors?.map(error => (typeof error.message === 'string' ? error.message : '')).filter(Boolean).join('; ') ?? ''
  } catch {
    message = ''
  }
  if (status === 401 || status === 403) return { isSent: false, detail: `SendGrid refused the API key (${status}). ${oneLine(message)}`.trim() }
  return { isSent: false, detail: `SendGrid answered ${status}${message === '' ? '' : `: ${oneLine(message)}`}` }
}

export type SmtpConfig = { url: string; username: string; password: string }

export type SmtpPlan = {
  argv: string[]
  /** What goes to curl's standard input: its config (the credentials), so they never appear in a process list. */
  stdin: string
}

/** A value inside a curl config file's double quotes. */
const curlQuoted = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&').replace(/\r?\n/g, ' ')}"`

/**
 * `curl --url smtps://… --mail-from … --mail-rcpt … --upload-file <message>`. The credentials ride on `--config -`
 * (stdin), never on the command line. `--ssl-reqd` refuses a server that will not encrypt (STARTTLS on `smtp://`,
 * implicit TLS on `smtps://`).
 */
export function smtpPlan(mail: Mail, smtp: SmtpConfig, messagePath: string): SmtpPlan {
  const from = parseAddress(mail.from)?.email ?? mail.from
  const argv = ['curl', '--silent', '--show-error', '--ssl-reqd', '--connect-timeout', '20', '--max-time', '90', '--url', smtp.url, '--mail-from', from]
  for (const recipient of mail.to) argv.push('--mail-rcpt', recipient)
  argv.push('--upload-file', messagePath)
  if (smtp.username === '') return { argv, stdin: '' }
  argv.push('--config', '-')
  return { argv, stdin: `user = ${curlQuoted(`${smtp.username}:${smtp.password}`)}\n` }
}

/** What a curl exit code means for an SMTP send. */
export function readSmtp(exitCode: number, stderr: string): SendResult {
  if (exitCode === 0) return { isSent: true, detail: '' }
  const known: Record<number, string> = {
    6: 'could not resolve the SMTP host',
    7: 'could not connect to the SMTP server',
    28: 'the SMTP server took too long',
    35: 'the TLS handshake with the SMTP server failed',
    55: 'sending failed: the connection broke',
    56: 'the SMTP server closed the connection or refused a command (sender or recipient)',
    67: 'the SMTP server refused the user name or password',
  }
  const text = oneLine(stderr, 160)
  return { isSent: false, detail: `${known[exitCode] ?? `curl exited with ${exitCode}`}${text === '' ? '' : ` (${text})`}` }
}
