import { expect, test } from 'claude-code/testing'

import { base64, buildMime, encodeWord, headerSafe, isEmail, mailDate, parseAddress, parseRecipients, readResend, readSendgrid, readSmtp, resendRequest, sendgridRequest, smtpPlan, utf8, without } from '../hooks/mail'
import type { Mail } from '../hooks/mail'

const MAIL: Mail = {
  from: 'Acme Studio <digest@acme.com>',
  to: ['ana@client.com', 'boss@acme.com'],
  replyTo: 'ada@acme.com',
  subject: 'Shop · Daily update · 7 Oct 2026',
  text: 'Hello,\n\nCaffè è pronto ✓\n',
  html: '<p>Hello</p>',
}

/** Decodes standard base64 (what a mail client does) back to a UTF-8 string. */
function decode(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  const clean = text.replace(/[\r\n=]/g, '')
  for (let i = 0; i < clean.length; i += 4) {
    const chunk = [0, 1, 2, 3].map(k => (i + k < clean.length ? alphabet.indexOf(clean.charAt(i + k)) : 0))
    const n = ((chunk[0] ?? 0) << 18) | ((chunk[1] ?? 0) << 12) | ((chunk[2] ?? 0) << 6) | (chunk[3] ?? 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const length = Math.floor((clean.length * 3) / 4)
  return decodeURIComponent(bytes.slice(0, length).map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''))
}

test('addresses and recipients: valid ones kept once in order, bad ones reported, names parsed', () => {
  expect(isEmail('ana@client.com')).toBe(true)
  expect(isEmail('ana@client')).toBe(false)
  expect(isEmail('a b@c.com')).toBe(false)
  expect(parseAddress('Acme Studio <digest@acme.com>')).toEqual({ name: 'Acme Studio', email: 'digest@acme.com' })
  expect(parseAddress('"Doe, John" <j@x.io>')).toEqual({ name: 'Doe, John', email: 'j@x.io' })
  expect(parseAddress('digest@acme.com')).toEqual({ name: '', email: 'digest@acme.com' })
  expect(parseAddress('nobody')).toBeUndefined()
  expect(parseRecipients('ana@client.com, boss@acme.com; ANA@client.com  nope, x@y')).toEqual({ valid: ['ana@client.com', 'boss@acme.com'], invalid: ['nope', 'x@y'] })
  expect(parseRecipients('')).toEqual({ valid: [], invalid: [] })
  expect(headerSafe('a\r\nBcc: evil@x.com')).toBe('a Bcc: evil@x.com')
})

test('MIME: UTF-8 text and HTML as base64 parts, encoded subject and names, CRLF lines, a header cannot be injected', () => {
  expect(base64(utf8('Man'))).toBe('TWFu')
  expect(base64(utf8('Ma'))).toBe('TWE=')
  expect(base64(utf8('M'))).toBe('TQ==')
  expect(decode(base64(utf8('Caffè ✓ 😀')))).toBe('Caffè ✓ 😀')
  expect(encodeWord('Plain subject')).toBe('Plain subject')
  expect(encodeWord('Riepilogo è pronto')).toBe('=?UTF-8?B?UmllcGlsb2dvIMOoIHByb250bw==?=')
  expect(mailDate(Date.UTC(2026, 9, 7, 16, 5, 9))).toBe('Wed, 07 Oct 2026 16:05:09 +0000')
  const mime = buildMime({ ...MAIL, subject: 'Aggiornamento è pronto\r\nBcc: evil@x.com' }, Date.UTC(2026, 9, 7, 16, 0, 0), 'id1')
  const [head = '', textPart = '', htmlPart = ''] = mime.split('--=_digest_id1')
  expect(mime.includes('\n') && !mime.replace(/\r\n/g, '').includes('\n')).toBe(true)
  expect(head).toContain('From: "Acme Studio" <digest@acme.com>')
  expect(head).toContain('To: ana@client.com, boss@acme.com')
  expect(head).toContain('Reply-To: ada@acme.com')
  expect(head).toContain('Date: Wed, 07 Oct 2026 16:00:00 +0000')
  expect(head).toContain('Message-ID: <id1@email-digest.local>')
  expect(head).toContain('MIME-Version: 1.0')
  expect(head).toContain('Content-Type: multipart/alternative; boundary="=_digest_id1"')
  expect(head).toMatch(/Subject: =\?UTF-8\?B\?/)
  expect(head).not.toMatch(/^Bcc:/m)
  expect(textPart).toContain('Content-Type: text/plain; charset=UTF-8')
  expect(decode(textPart.split('\r\n\r\n')[1] ?? '')).toBe(MAIL.text)
  expect(htmlPart).toContain('Content-Type: text/html; charset=UTF-8')
  expect(decode(htmlPart.split('\r\n\r\n')[1] ?? '')).toBe(MAIL.html)
  expect(mime.endsWith('--=_digest_id1--\r\n')).toBe(true)
  // Base64 lines never pass 76 characters.
  expect(buildMime({ ...MAIL, text: 'x'.repeat(500) }, 0, 'id2').split('\r\n').every(line => line.length <= 76 || line.startsWith('Content-') || line.startsWith('Message-ID'))).toBe(true)
})

test('Resend: one POST with the key as a bearer token and the message as JSON; answers read, the key never echoed', () => {
  const request = resendRequest(MAIL, 're_secretKey123')
  expect(request.url).toBe('https://api.resend.com/emails')
  expect(request.init.method).toBe('POST')
  expect(request.init.headers).toEqual({ Authorization: 'Bearer re_secretKey123', 'Content-Type': 'application/json' })
  expect(JSON.parse(request.init.body)).toEqual({ from: MAIL.from, to: MAIL.to, reply_to: 'ada@acme.com', subject: MAIL.subject, html: MAIL.html, text: MAIL.text })
  expect(JSON.parse(resendRequest({ ...MAIL, replyTo: undefined }, 'k').init.body)).not.toHaveProperty('reply_to')
  expect(readResend(200, '{"id":"49a3999c"}')).toEqual({ isSent: true, detail: '49a3999c' })
  expect(readResend(403, '{"name":"validation_error","message":"The domain acme.com is not verified."}')).toEqual({ isSent: false, detail: 'Resend refused the API key (403). The domain acme.com is not verified.' })
  expect(readResend(422, '{"message":"Invalid `to` field"}')).toEqual({ isSent: false, detail: 'Resend answered 422: Invalid `to` field' })
  expect(readResend(500, '<html>').detail).toBe('Resend answered 500')
  expect(without('Authorization: Bearer re_secretKey123 failed', ['re_secretKey123', ''])).toBe('Authorization: Bearer [key] failed')
})

test('SendGrid: personalizations, from, subject and both content types (plain first); 202 is sent, errors are read', () => {
  const request = sendgridRequest(MAIL, 'SG.secret')
  expect(request.url).toBe('https://api.sendgrid.com/v3/mail/send')
  expect(request.init.headers).toEqual({ Authorization: 'Bearer SG.secret', 'Content-Type': 'application/json' })
  expect(JSON.parse(request.init.body)).toEqual({
    personalizations: [{ to: [{ email: 'ana@client.com' }, { email: 'boss@acme.com' }] }],
    from: { email: 'digest@acme.com', name: 'Acme Studio' },
    reply_to: { email: 'ada@acme.com' },
    subject: MAIL.subject,
    content: [
      { type: 'text/plain', value: MAIL.text },
      { type: 'text/html', value: MAIL.html },
    ],
  })
  expect(readSendgrid(202, '')).toEqual({ isSent: true, detail: '' })
  expect(readSendgrid(401, '{"errors":[{"message":"The provided authorization grant is invalid"}]}').detail).toBe('SendGrid refused the API key (401). The provided authorization grant is invalid')
  expect(readSendgrid(400, '{"errors":[{"message":"bad from"},{"message":"bad to"}]}').detail).toBe('SendGrid answered 400: bad from; bad to')
  expect(readSendgrid(503, 'oops').detail).toBe('SendGrid answered 503')
})

test('SMTP: curl --url --mail-from --mail-rcpt --upload-file, TLS required, the password only on stdin', () => {
  const plan = smtpPlan(MAIL, { url: 'smtps://smtp.acme.com:465', username: 'digest@acme.com', password: 'p"a\\ss' }, '/home/me/.claude/claude-mods/email-digest/outbox/message.eml')
  expect(plan.argv).toEqual([
    'curl',
    '--silent',
    '--show-error',
    '--ssl-reqd',
    '--connect-timeout',
    '20',
    '--max-time',
    '90',
    '--url',
    'smtps://smtp.acme.com:465',
    '--mail-from',
    'digest@acme.com',
    '--mail-rcpt',
    'ana@client.com',
    '--mail-rcpt',
    'boss@acme.com',
    '--upload-file',
    '/home/me/.claude/claude-mods/email-digest/outbox/message.eml',
    '--config',
    '-',
  ])
  expect(plan.stdin).toBe('user = "digest@acme.com:p\\"a\\\\ss"\n')
  expect(plan.argv.join(' ')).not.toContain('p"a')
  const open = smtpPlan(MAIL, { url: 'smtp://relay.local:25', username: '', password: '' }, '/tmp/m.eml')
  expect(open.argv).not.toContain('--config')
  expect(open.stdin).toBe('')
})

test('SMTP: curl exit codes become sentences', () => {
  expect(readSmtp(0, '')).toEqual({ isSent: true, detail: '' })
  expect(readSmtp(67, 'curl: (67) Login denied').detail).toBe('the SMTP server refused the user name or password (curl: (67) Login denied)')
  expect(readSmtp(7, '').detail).toBe('could not connect to the SMTP server')
  expect(readSmtp(6, '').detail).toBe('could not resolve the SMTP host')
  expect(readSmtp(99, 'weird').detail).toBe('curl exited with 99 (weird)')
})
