import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

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
