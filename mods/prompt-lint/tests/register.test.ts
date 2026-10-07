import type { On, PromptOrigin } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type Sent = { origin?: PromptOrigin; turnId?: string; attachments?: { type: 'image' }[] }

/** Stands in for the engine: toasts are recorded and the prompt enters as typed. */
const engine = (on: On) => {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return toasts
}

const send = ($: Engine, text: string, sent: Sent = {}) =>
  $.prompt.submit({ text, wait: false, origin: sent.origin ?? { kind: 'composer' }, turnId: sent.turnId, attachments: sent.attachments })

const VAGUE = [
  'fix it',
  'Please fix this.',
  "it doesn't work",
  'login not working',
  'still broken',
  'this',
  'that one',
  'add tests',
  'refactor this',
  'login',
  'help',
]

const SPECIFIC = [
  'Fix the null check in src/auth/login.ts',
  'add a unit test for parseDate that covers leap years',
  'fix the login bug where the session expires after a minute',
  "it doesn't work: TypeError: x is undefined at app.ts:12",
  'yes',
  'Thanks!',
  'continue',
  'go ahead',
  'commit',
  'why does it fail?',
  'fix ABC-123',
  'improve `renderRow`',
  'исправь ошибку',
  '/review',
  '!ls',
]

test('shows a tip for a vague prompt and lets it through', async ($, on) => {
  const toasts = engine(on)

  const result = await send($, 'fix it')

  expect(result.text).toBe('fix it')
  expect(toasts).toEqual(['Say what to change and where: a file, a function or an error message.'])
})

test('flags the usual vague prompts, each with the tip that fits', async ($, on) => {
  const toasts = engine(on)

  for (const text of VAGUE) await send($, text)

  expect(toasts).toHaveLength(VAGUE.length)
  expect(toasts.some(toast => toast.startsWith('prompt-lint'))).toBe(false)
  expect(toasts[2]).toContain('paste the exact error') // it doesn't work
  expect(toasts[5]).toContain('Name what you mean') // this
  expect(toasts[7]).toContain('Name the file, function or ticket') // add tests
  expect(toasts[9]).toContain('Add the goal') // login
})

test('stays quiet for specific prompts, replies, commands and other languages', async ($, on) => {
  const toasts = engine(on)

  for (const text of SPECIFIC) expect((await send($, text)).text).toBe(text)

  expect(toasts).toEqual([])
})

test('ignores prompts typed over a running turn, with attachments, or not typed by a person', async ($, on) => {
  const toasts = engine(on)

  await send($, 'fix it', { turnId: 'turn-1' })
  await send($, 'fix this', { attachments: [{ type: 'image' }] })
  await send($, 'fix it', { origin: { kind: 'task-notification' } })

  expect(toasts).toEqual([])
})

test('in strict mode holds a vague prompt back with a tip, and lets the same prompt through when sent again', {
  options: { strict: true },
}, async ($, on) => {
  const toasts = engine(on)

  const held = await send($, "it doesn't work")
  expect(held.drop).toContain('prompt-lint: this prompt looks vague.')
  expect(held.drop).toContain('paste the exact error')
  expect(held.drop).toContain('Send it again unchanged')

  const again = await send($, "it doesn't work")
  expect(again.text).toBe("it doesn't work")

  const next = await send($, 'fix it')
  expect(next.drop).toContain('what to change and where')
  expect(toasts).toEqual([])
})

test('in strict mode a specific prompt is never held back', { options: { strict: true } }, async ($, on) => {
  engine(on)

  const result = await send($, 'Fix the null check in src/auth/login.ts')

  expect(result.drop).toBeUndefined()
  expect(result.text).toBe('Fix the null check in src/auth/login.ts')
})
