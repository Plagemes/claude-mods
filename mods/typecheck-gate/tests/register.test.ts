import { test, expect, mock } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { fakeHub } from './hub'

type Run = { argv: readonly string[]; cwd: string | undefined }

const PROJECT = {
  '/repo/.git/HEAD': '',
  '/repo/tsconfig.json': '{}',
  '/repo/node_modules/.bin/tsc': '',
  '/repo/src/a.ts': '',
  '/repo/py/mypy.ini': '[mypy]',
  '/repo/py/app.py': '',
}

const TSC_ERRORS = {
  exitCode: 2,
  stdout: [
    "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/b.ts(10,1): error TS2304: Cannot find name 'foo'.",
    '',
  ].join('\n'),
}

/**
 * A project on a virtual disk, a checker printing `answer`, and the engine's
 * side of a turn. `notes` collects the context riding on submitted prompts.
 */
const world = (on: On, answer: (argv: readonly string[]) => Partial<ProcessRunResult>, files: Record<string, string> = PROJECT) => {
  const runs: Run[] = []
  const statuses: string[] = []
  const toasts: string[] = []
  const notes: string[] = []
  const prompts: string[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', ($, e) => {
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const names = new Set(Object.keys(files).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0] ?? ''))
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer(e.argv) } }
  })
  on('tool.call', () => ({ result: { type: 'update' } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    notes.push(...(e.context ?? []))
    return { text: e.text }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { runs, statuses, toasts, notes, prompts }
}

const TURN_END = { answer: 'Done.', durationMs: 1200, isAborted: false, turnId: 'turn-1', reason: 'answer' } as const
const NEXT_PROMPT = { text: 'next', wait: false, origin: { kind: 'composer' } } as const

const edit = (file_path: string) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' }) as const

test('type-checks after an editing turn and hands the errors to Claude with the next prompt', async ($, on) => {
  const clock = mock.clock(on)
  const { runs, statuses, toasts, notes } = world(on, () => TSC_ERRORS)

  await $.tool.call(edit('/repo/src/a.ts'))
  await $.turn.complete(TURN_END)
  await clock.settle()
  await $.prompt.submit(NEXT_PROMPT)
  await $.prompt.submit(NEXT_PROMPT)

  expect(runs).toEqual([
    { argv: ['/repo/node_modules/.bin/tsc', '--noEmit', '--pretty', 'false', '-p', '/repo/tsconfig.json'], cwd: '/repo' },
  ])
  expect(statuses).toEqual(['⧗ typecheck: running tsc…', '✗ types: 2 type errors (tsc)'])
  expect(toasts).toEqual(['2 type errors (tsc)'])
  expect(notes).toEqual([
    [
      'typecheck-gate: tsc reports 2 type errors after your last turn. Fix them before moving on, unless the user says otherwise:',
      "  src/a.ts:3:7  TS2322  Type 'string' is not assignable to type 'number'.",
      "  src/b.ts:10:1  TS2304  Cannot find name 'foo'.",
    ].join('\n'),
  ])
})

test('stays quiet when the types check out, when nothing was edited, and on subagent or interrupted turns', async ($, on) => {
  const clock = mock.clock(on)
  const { runs, statuses, notes } = world(on, () => ({}))

  await $.turn.complete(TURN_END)
  await $.tool.call(edit('/repo/README.md'))
  await $.turn.complete(TURN_END)
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.turn.complete({ ...TURN_END, agentId: 'agent-7' })
  await $.turn.complete({ ...TURN_END, isAborted: true, reason: 'aborted' })
  await clock.settle()
  expect(runs).toHaveLength(0)

  await $.turn.complete(TURN_END)
  await clock.settle()
  await $.prompt.submit(NEXT_PROMPT)
  expect(runs).toHaveLength(1)
  expect(statuses.at(-1)).toBe('✓ types: clean (tsc)')
  expect(notes).toHaveLength(0)
})

test('autofix asks Claude to fix the errors, at most maxAutofixRounds times in a row', { options: { mode: 'autofix', maxAutofixRounds: 2 } }, async ($, on) => {
  const clock = mock.clock(on)
  const { prompts, notes, toasts } = world(on, () => TSC_ERRORS)

  for (let round = 0; round < 3; round += 1) {
    await $.tool.call(edit('/repo/src/a.ts'))
    await $.turn.complete(TURN_END)
    await clock.settle()
  }

  expect(prompts).toHaveLength(2)
  expect(prompts[0]).toStartWith('typecheck-gate: tsc reports 2 type errors after your last turn. Fix them, then type-check again to confirm:')
  expect(toasts.at(-1)).toBe('2 type errors still stand after 2 fix rounds; over to you')

  await $.prompt.submit(NEXT_PROMPT)
  expect(notes).toHaveLength(1)
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.turn.complete(TURN_END)
  await clock.settle()
  expect(prompts.filter(text => text.startsWith('typecheck-gate'))).toHaveLength(3)
  expect(toasts.at(-1)).toBe('2 type errors, asking Claude to fix them (round 1 of 2)')
})

test('/typecheck runs the configured Python checker on the files edited so far', async ($, on) => {
  const { runs } = world(on, () => ({
    exitCode: 1,
    stdout: 'app.py:4:12: error: Incompatible return value type (got "str", expected "int")  [return-value]\n',
  }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call(edit('/repo/py/app.py'))
  const shown = await $.command.run({ command: 'typecheck', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  expect(runs).toEqual([
    { argv: ['mypy', '--no-error-summary', '--no-color-output', '--show-column-numbers', '/repo/py/app.py'], cwd: '/repo/py' },
  ])
  expect(shown.text).toBe(
    'mypy reports 1 type error:\n  py/app.py:4:12  return-value  Incompatible return value type (got "str", expected "int")',
  )
})

test('lists the first 20 errors and says how many more there are', async ($, on) => {
  const clock = mock.clock(on)
  const many = Array.from({ length: 26 }, (_, index) => `src/a.ts(${index + 1},1): error TS7006: Parameter 'x' implicitly has an 'any' type.`)
  const { notes } = world(on, () => ({ exitCode: 2, stdout: many.join('\n') }))

  await $.tool.call(edit('/repo/src/a.ts'))
  await $.turn.complete(TURN_END)
  await clock.settle()
  await $.prompt.submit(NEXT_PROMPT)

  const lines = notes[0]?.split('\n') ?? []
  expect(lines).toHaveLength(22)
  expect(lines.at(-1)).toBe('  … and 6 more')
})

test('regression: a solution-style tsconfig (Vite) is checked through the projects it references', async ($, on) => {
  const clock = mock.clock(on)
  const vite = {
    '/repo/.git/HEAD': '',
    '/repo/tsconfig.json': '{\n  // solution\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" },],\n}',
    '/repo/tsconfig.app.json': '{ "include": ["src"] }',
    '/repo/tsconfig.node.json': '{ "include": ["vite.config.ts"] }',
    '/repo/node_modules/.bin/tsc': '',
    '/repo/src/a.ts': '',
  }
  // tsc on the solution file itself checks nothing and passes; the app project has the error.
  const { runs, statuses } = world(on, argv => (argv.at(-1) === '/repo/tsconfig.app.json' ? TSC_ERRORS : {}), vite)

  await $.tool.call(edit('/repo/src/a.ts'))
  await $.turn.complete(TURN_END)
  await clock.settle()

  expect(runs.map(run => run.argv.at(-1))).toEqual(['/repo/tsconfig.app.json', '/repo/tsconfig.node.json'])
  expect(statuses.at(-1)).toBe('✗ types: 2 type errors (tsc)')
})

test('with mods-hub: each check is published as typecheck.result and its errors are an error notice', async ($, on) => {
  const clock = mock.clock(on)
  const { toasts } = world(on, () => TSC_ERRORS)
  const hub = fakeHub(on)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(1_500)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['typecheck.result'], consumes: [] }])
  await $.tool.call(edit('/repo/src/a.ts'))
  await $.turn.complete(TURN_END)
  await clock.settle()

  expect(hub.published).toEqual([{ topic: 'typecheck.result', data: { tool: 'tsc', errors: 2, files: ['src/a.ts', 'src/b.ts'] } }])
  expect(hub.notified).toEqual([{ level: 'error', title: '2 type errors (tsc)', topic: 'typecheck.result' }])
  expect(toasts).toEqual([])
})
