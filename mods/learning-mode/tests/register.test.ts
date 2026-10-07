import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptComposeInput } from 'claude-code'

import { addedMarkers, instructions, isSecurityCritical, summary } from '../hooks/todos'

/** Answers `$.state` from memory, as the host does: a value and the version it stands at. */
const memoryState = (on: On) => {
  const cells = new Map<string, { value: unknown; version: number }>()
  const keyOf = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('state.get', (_$, e) => ({ value: cells.get(keyOf(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$, e) => {
    const held = cells.get(keyOf(e)) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) return { value: { isSet: false, version: held.version } }
    cells.set(keyOf(e), { value: e.value, version: held.version + 1 })
    return { value: { isSet: true, version: held.version + 1 } }
  })
}

/** The engine beneath the plugin: memory for `$.state`, status and toasts recorded, a bare prompt, files on disk. */
const world = (on: On, files: Record<string, string> = {}) => {
  const seen = { statuses: [] as (string | undefined)[], toasts: [] as string[], reached: 0 }
  memoryState(on)
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('tool.call', () => {
    seen.reached += 1
    return { result: 'ok' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return seen
}

const facts = (traits: PromptComposeInput['traits'] = []): PromptComposeInput => ({
  model: 'claude-test',
  promptModel: 'claude-test',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits,
})

const sections = async ($: Engine, traits: PromptComposeInput['traits'] = []) => (await $.prompt.compose(facts(traits))).sections

const learning = async ($: Engine, args = '') =>
  (
    await $.command.run({
      command: 'learning',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

const startTurn = ($: Engine) => $.turn.start({ text: 'do it', turnId: 't1' })
const endTurn = ($: Engine, agentId?: string) =>
  $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', ...(agentId === undefined ? {} : { agentId }) })
const edit = ($: Engine, file_path: string, new_string: string, old_string = 'x') => $.tool.call({ tool: 'Edit', file_path, old_string, new_string })

test('/learning toggles the instructions and the status line', async ($, on) => {
  const seen = world(on)
  expect((await sections($)).map(s => s.id)).toEqual(['intro'])

  expect(await learning($)).toContain('Learning mode on')
  expect(seen.statuses.at(-1)).toBe('🎓 learning')
  expect((await sections($)).map(s => s.id)).toEqual(['intro', 'learning-mode:instructions'])

  expect(await learning($)).toContain('Learning mode off')
  expect(seen.statuses.at(-1)).toBeUndefined()
  expect((await sections($)).map(s => s.id)).toEqual(['intro'])
})

test('/learning on and /learning off are explicit', async ($, on) => {
  world(on)

  await learning($, 'on')
  await learning($, 'ON')
  expect(await sections($)).toHaveLength(2)

  await learning($, 'off')
  expect(await sections($)).toHaveLength(1)
})

test('the instructions ask for the why, at most two TODO(you) pieces, nothing in security code', async ($, on) => {
  world(on)
  await learning($, 'on')

  const text = (await sections($)).at(-1)?.text ?? ''

  expect(text).toContain('Explain the why behind each change')
  expect(text).toContain('up to 2 small, well-scoped pieces per task')
  expect(text).toContain('`TODO(you): <hint>`')
  expect(text).toContain('Never leave TODO(you) in security-critical code')
})

test('the number of pieces is configurable and a bare prompt is left alone', { options: { maxTodos: 4, startOn: true } }, async ($, on) => {
  world(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect((await sections($)).at(-1)?.text).toContain('up to 4 small')
  expect(await sections($, ['bare'])).toHaveLength(1)
})

test('registers /learning and shows the status when it starts on', { options: { startOn: true } }, async ($, on) => {
  const registered: string[] = []
  const seen = world(on)
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['learning'])
  expect(seen.statuses.at(-1)).toBe('🎓 learning')
})

test('at the end of the turn it toasts how many TODO(you) were left, and where', async ($, on) => {
  const seen = world(on, { '/repo/src/new.ts': 'export {}\n' })
  await learning($, 'on')
  await startTurn($)

  await edit($, '/repo/src/slug.ts', 'export const slug = (s: string) => {\n  // TODO(you): lower-case, trim, and join words with "-"\n}')
  await edit($, '/repo/src/slug.ts', '// TODO(you): handle accents')
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'export {}\n// TODO(you): validate the input\n' })
  await edit($, '/repo/src/plain.ts', 'const a = 1')
  await endTurn($)

  expect(seen.toasts).toEqual(['🎓 3 TODO(you) left for you: slug.ts (2), new.ts · more than the 2 asked for'])
  seen.toasts.length = 0
  await endTurn($)
  expect(seen.toasts).toEqual([])
})

test('only markers a change adds are counted, and failed or subagent turns are not reported', async ($, on) => {
  const seen = world(on, { '/repo/a.ts': '// TODO(you): already here\n' })
  await learning($, 'on')
  await startTurn($)

  await edit($, '/repo/a.ts', '// TODO(you): reworded hint', '// TODO(you): already here')
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: '// TODO(you): already here\nconst x = 1\n' })
  await endTurn($, 'sub-1')
  await endTurn($)

  expect(seen.toasts).toEqual([])
})

test('a new turn starts the tally over', async ($, on) => {
  const seen = world(on)
  await learning($, 'on')
  await startTurn($)
  await edit($, '/repo/a.ts', '// TODO(you): one')
  await startTurn($)
  await endTurn($)

  expect(seen.toasts).toEqual([])
})

test('TODO(you) is refused in security-critical files, with the reason', async ($, on) => {
  const seen = world(on)
  await learning($, 'on')

  for (const path of ['/repo/src/auth/login.ts', '/repo/lib/crypto.py', '/repo/app/password_reset.rb', '/repo/src/jwt.ts']) {
    const result = await edit($, path, '// TODO(you): verify the signature')
    expect(result.deny, path).toContain('security-critical')
  }
  expect(seen.reached).toBe(0)

  // Not a marker, or not a security file: fine.
  expect((await edit($, '/repo/src/auth/login.ts', 'const ok = true')).deny).toBeUndefined()
  expect((await edit($, '/repo/src/author.ts', '// TODO(you): pick a name')).deny).toBeUndefined()
})

test('nothing is tracked or refused while learning mode is off', async ($, on) => {
  const seen = world(on)
  await startTurn($)

  const result = await edit($, '/repo/src/auth.ts', '// TODO(you): whatever')
  await endTurn($)

  expect(result.deny).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('pure helpers: markers added, security paths, wording', () => {
  expect(addedMarkers('', 'a TODO(you) b TODO(you)')).toBe(2)
  expect(addedMarkers('TODO(you)', 'TODO(you)')).toBe(0)
  expect(addedMarkers('TODO(you) TODO(you)', 'TODO(you)')).toBe(0)
  expect(isSecurityCritical('/r/src/oauth-client.ts')).toBe(true)
  expect(isSecurityCritical('/r/src/author.ts')).toBe(false)
  expect(isSecurityCritical('/r/src/tokenizer.ts')).toBe(false)
  expect(summary(new Map([['/a/b/c.ts', 1]]), 2)).toBe('🎓 1 TODO(you) left for you: c.ts')
  expect(summary(new Map([['a', 1], ['b', 1], ['c', 1], ['d', 1]]), 9)).toBe('🎓 4 TODO(you) left for you: a, b, c +1 more')
  expect(instructions(2)).toContain('up to 2 small')
})

test('only the path inside the project counts: a project folder named auth-service is not security code', async ($, on) => {
  const seen = world(on)
  on('session.root', () => ({ value: '/home/ada/auth-service' }))
  await learning($, 'on')
  expect((await edit($, '/home/ada/auth-service/src/slug.ts', '// TODO(you): handle accents')).deny).toBeUndefined()
  expect((await edit($, '/home/ada/auth-service/src/session/store.ts', '// TODO(you): expire it')).deny).toContain('security-critical')
  expect(seen.reached).toBe(1)
})
