import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'

type AppendInput = Parameters<Engine['session']['append']>[0]

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const VISA = '4111 1111 1111 1111'
const NOT_A_CARD = '4111 1111 1111 1112'
const IBAN = 'DE89 3704 0044 0532 0130 00'

/**
 * Records the content of each row as it reaches the bottom of the chain. The kit
 * has no store beneath `session.append` (a test hook may not answer it without
 * `next`), so the call rejects after the row was seen; `append` swallows that.
 */
const recordRows = (on: On): unknown[] => {
  const rows: unknown[] = []
  on('session.append', ($, e, next) => {
    rows.push(e.message.content)
    return next(e)
  })
  return rows
}

const append = ($: Engine, row: AppendInput): Promise<unknown> => $.session.append(row).catch(() => undefined)

const toolResult = (content: string | { type: 'text'; text: string }[]): AppendInput => ({
  door: 'tool-result',
  origin: { kind: 'tool', tool: 'Bash' },
  uuid: 'row-1',
  message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
})

const lastRow = (rows: unknown[]): string => JSON.stringify(rows.at(-1))

const quietStatus = (on: On): void => {
  on('ui.status', () => ({ value: undefined }))
}

test('masks secrets, emails, IBANs and Luhn-valid cards in a tool result', async ($, on) => {
  const rows = recordRows(on)
  quietStatus(on)

  await append(
    $,
    toolResult(`AWS_ACCESS_KEY_ID=${AWS_KEY}\nowner: jane.doe@acme.io\ncard ${VISA}\norder ${NOT_A_CARD}\nIBAN ${IBAN}`),
  )

  const text = lastRow(rows)
  expect(text).toContain('[REDACTED:aws-key]')
  expect(text).toContain('[REDACTED:email]')
  expect(text).toContain('[REDACTED:card]')
  expect(text).toContain('[REDACTED:iban]')
  expect(text).not.toContain(AWS_KEY)
  expect(text).not.toContain('jane.doe@acme.io')
  expect(text).toContain(NOT_A_CARD)
})

test('masks a high-entropy secret assignment but keeps code references and plain values', async ($, on) => {
  const rows = recordRows(on)
  quietStatus(on)

  await append($, toolResult('DB_PASSWORD="k8Zq2Lr9Vx4Tn7Wp"\nconst apiKey = config.apiKey\nPORT=8080'))

  const text = lastRow(rows)
  expect(text).toContain('DB_PASSWORD=\\"[REDACTED:secret]')
  expect(text).not.toContain('k8Zq2Lr9Vx4Tn7Wp')
  expect(text).toContain('config.apiKey')
  expect(text).toContain('PORT=8080')
})

test('keeps allowlisted matches and private IPs (off by default) visible', async ($, on) => {
  const rows = recordRows(on)
  quietStatus(on)

  await append($, toolResult('remote git@github.com:acme/app.git, ops on +1 415 555 0134, host 10.0.0.12'))

  const text = lastRow(rows)
  expect(text).toContain('git@github.com')
  expect(text).toContain('[REDACTED:phone]')
  expect(text).toContain('10.0.0.12')
})

test('honours the per-kind toggles', { options: { emails: false, privateIps: true } }, async ($, on) => {
  const rows = recordRows(on)
  quietStatus(on)

  await append($, toolResult('mail jane@acme.io from 192.168.1.20'))

  const text = lastRow(rows)
  expect(text).toContain('jane@acme.io')
  expect(text).toContain('[REDACTED:private-ip]')
})

test('masks text blocks nested in a tool result, private keys included', async ($, on) => {
  const rows = recordRows(on)
  quietStatus(on)

  await append($, toolResult([{ type: 'text', text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----' }]))

  const text = lastRow(rows)
  expect(text).toContain('[REDACTED:private-key]')
  expect(text).not.toContain('MIIEow')
})

test('only rewrites tool results, and counts what it masked in the status line', async ($, on) => {
  const rows = recordRows(on)
  const lines: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })

  await append($, {
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'row-0',
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'mail me at jane@acme.io' }] },
  })
  expect(lastRow(rows)).toContain('jane@acme.io')
  expect(lines).toHaveLength(0)

  await append($, toolResult('a@acme.io b@acme.io'))
  await append($, toolResult(`key ${AWS_KEY}`))
  expect(lines.at(-1)).toBe('redactor: 3 masked (email ×2, aws-key)')
})

test('refuses a write that would put masks over real values on disk, once something was masked', async ($, on) => {
  recordRows(on)
  quietStatus(on)
  const written: string[] = []
  on('fs.read', () => ({ value: `REGION=eu\nAWS_KEY=${AWS_KEY}\n` }))
  on('tool.call', ($, e) => {
    written.push(String(e.tool))
    return { result: 'ok' }
  })

  // Nothing masked yet: a marker the model types on purpose goes through.
  const before = await $.tool.call({ tool: 'Write', file_path: '/repo/notes.md', content: 'shows [REDACTED:email]' })
  expect(before.deny).toBeUndefined()

  await append($, toolResult(`REGION=eu\nAWS_KEY=${AWS_KEY}`))
  const rewrite = await $.tool.call({ tool: 'Write', file_path: '/repo/.env', content: 'REGION=us\nAWS_KEY=[REDACTED:aws-key]\n' })
  expect(rewrite.deny).toContain('[REDACTED:…] markers into /repo/.env')
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/repo/.env', old_string: 'REGION=eu', new_string: 'REGION=us' })
  expect(edit.deny).toBeUndefined()
  expect(written).toEqual(['Write', 'Edit'])
})

test('keeps dates on diff lines and digit-free sk- class names visible', async ($, on) => {
  const rows = recordRows(on)
  quietStatus(on)
  await append($, toolResult('+2024-01-15 10:30:00 deploy\n.sk-button-hover-variant-large-size {}'))
  expect(lastRow(rows)).toContain('+2024-01-15 10:30:00')
  expect(lastRow(rows)).toContain('sk-button-hover-variant-large-size')
})

test('with mods-hub: each kind masked in a tool result is published as secret.detected, never the value', async ($, on) => {
  const rows = recordRows(on)
  quietStatus(on)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['secret.detected', 'risk.blocked'], consumes: [] }])
  await append($, toolResult(`key ${AWS_KEY}, a@acme.io and b@acme.io`))
  await append($, toolResult('nothing to hide'))
  expect(lastRow(rows)).toContain('nothing to hide')
  expect(hub.published).toEqual([
    { topic: 'secret.detected', data: { kind: 'aws-key', where: 'result', action: 'redacted' } },
    { topic: 'secret.detected', data: { kind: 'email', where: 'result', action: 'redacted' } },
  ])
  expect(JSON.stringify(hub.published)).not.toContain(AWS_KEY)
})

test('with mods-hub: a broken allowlist is reported through the hub', { options: { allowlist: '([' } }, async ($, on) => {
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.notified.map(notice => notice.level)).toEqual(['warning'])
  expect(hub.notified[0]?.title).toContain('Allowlist ignored')
})

test('with mods-hub: a refused masks-to-disk write is published as risk.blocked', async ($, on) => {
  recordRows(on)
  quietStatus(on)
  on('fs.read', () => ({ value: `AWS_KEY=${AWS_KEY}\n` }))
  on('tool.call', () => ({ result: 'ok' }))
  const hub = fakeHub(on)
  await append($, toolResult(`AWS_KEY=${AWS_KEY}`))
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/.env', content: 'AWS_KEY=[REDACTED:aws-key]\nX=[REDACTED:aws-key]\n' })).deny).toContain('redactor')
  expect(hub.published.filter(event => event.topic === 'risk.blocked')).toEqual([
    {
      topic: 'risk.blocked',
      data: { guard: 'redactor', tool: 'Write', reason: 'masks-to-disk: the write would put [REDACTED:…] markers over real values', severity: 'medium', path: '/repo/.env' },
    },
  ])
})
