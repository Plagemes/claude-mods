import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fakeHub } from './hub'
import { cutDiff, parseAction, parseNumstat, writesFiles } from '../hooks/pair'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const BAND = {
  plugin: 'pair-mode',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n'

type World = {
  reached: string[]
  submitted: { text: string }[]
  toasts: string[]
  gitEnv: (string | undefined)[]
  clock: ReturnType<typeof mock.clock>
}

/** A git repository at /repo whose worktree snapshots are tree-1, tree-2, ...; tool calls that reach the engine are recorded. */
const world = (on: On, isRepo = true): World => {
  const state: World = { reached: [], submitted: [], toasts: [], gitEnv: [], clock: (startClock = mock.clock(on)) }
  let trees = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', ($, e) => {
    const line = e.argv.slice(1).join(' ')
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'fatal', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (!isRepo) return answer('', 128)
    if (line === 'rev-parse --show-toplevel') return answer('/repo\n')
    if (line === 'rev-parse --git-path pair-mode.index') return answer('.git/pair-mode.index\n')
    if (line === 'rev-parse --verify -q HEAD') return answer('abc123\n')
    if (line === 'read-tree HEAD' || line === 'add -A') {
      state.gitEnv.push(e.init?.env?.GIT_INDEX_FILE)
      return answer('')
    }
    if (line === 'write-tree') {
      trees += 1
      return answer(`tree-${trees}\n`)
    }
    if (line === 'diff --numstat -M tree-1 tree-2') return answer('2\t1\tsrc/a.ts\n')
    if (line === 'diff --no-color --no-ext-diff -M tree-1 tree-2') return answer(DIFF)
    if (line.startsWith('diff --numstat')) return answer('')
    return answer('')
  })
  on('tool.call', ($, e) => {
    state.reached.push(e.tool === 'Bash' ? e.command : e.tool)
    return { result: 'ok' }
  })
  on('prompt.submit', ($, e) => {
    state.submitted.push({ text: e.text })
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Box', children: [] }))
  return state
}

const pair = ($: Engine, args: string) =>
  $.command.run({ command: 'pair', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const compose = ($: Engine) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

test('while on, file edits and file-writing shell commands are refused with a diff instruction', async ($, on) => {
  const { reached } = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const turnedOn = await pair($, 'on')
  expect(turnedOn.text).toStartWith('Pair mode on:')
  expect(turnedOn.context?.[0]).toContain('unified diff')

  const edit = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  expect(edit.deny).toContain('Do not edit /repo/src/a.ts: show the change as a unified diff')
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/new.ts', content: 'x' })).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', new_source: 'x' })).deny).toBeDefined()
  const sed = await $.tool.call({ tool: 'Bash', command: "sed -i 's/a/b/' src/a.ts" })
  expect(sed.deny).toContain('this command writes files (sed -i)')

  await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -20' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' })
  expect(reached).toEqual(['npm test 2>&1 | tail -20', 'Read'])

  expect((await pair($, 'off')).text).toBe('Pair mode off: Claude edits files again.')
  expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
  expect(reached).toContain('Edit')
})

test('with mods-hub: says hello, and the guard behaves the same', async ($, on) => {
  const { reached } = world(on)
  const hub = fakeHub(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])

  await pair($, 'on')
  expect((await $.tool.call({ tool: 'Bash', command: 'sudo -u web env X=1 rm -rf build' })).deny).toContain('this command writes files (rm)')
  expect((await $.tool.call({ tool: 'Bash', command: `bash -c "echo hi > notes.txt"` })).deny).toContain('(a redirection to notes.txt)')
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -20' })).deny).toBeUndefined()
  expect(reached).toEqual(['npm test 2>&1 | tail -20'])
  expect(hub.published).toEqual([])
})

test('the system prompt explains pair mode only while it is on', async ($, on) => {
  world(on)
  expect((await compose($)).sections.map(section => section.id)).toEqual(['intro'])
  await pair($, '')
  const sections = (await compose($)).sections
  expect(sections.at(-1)?.id).toBe('pair-mode:rules')
  expect(sections.at(-1)?.text).toContain('types every code change themselves')
  await pair($, '')
  expect((await compose($)).sections).toHaveLength(1)
})

test('/pair check snapshots the worktree in its own index and sends the diff since pair mode started for review', async ($, on) => {
  const state = world(on)
  const session = mock.session(on)
  await pair($, 'on')
  const checked = await pair($, 'check')
  expect(checked.text).toBe('Sent your changes (1 file, +2 −1) to Claude for review.')
  expect(state.gitEnv.every(path => path === '/repo/.git/pair-mode.index')).toBe(true)
  await state.clock.advance(1)
  expect(state.submitted).toHaveLength(1)
  // The diff goes in as a note only the model reads (the kit's session stores the plugin's own append); the prompt
  // the person sees stays one line.
  expect(state.submitted[0]?.text).toBe('Review the changes I typed since pair mode started (1 file, +2 −1; the diff is attached).')
  const notes = JSON.stringify(session.appended())
  expect(notes).toContain('pair-mode check: the user applied these changes by hand since pair mode started.')
  expect(notes).toContain('```diff\\ndiff --git a/src/a.ts b/src/a.ts')

  // The next check starts from this one: nothing changed since (tree-3 vs tree-2 has no numstat).
  expect((await pair($, 'check')).text).toBe('No changes since the last check.')
  await state.clock.advance(1)
  expect(state.submitted).toHaveLength(1)
})

test('the band says who drives on every surface, and its buttons check and switch off', async ($, on) => {
  const state = world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount({ ...BAND, surface })
    expect(await idle.find({ key: 'pair' })).toBeUndefined()
    await idle.unmount()
  }
  await pair($, 'on')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ key: 'pair' }))?.text).toContain('Pair mode: you drive')
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'check' })
  expect(state.toasts).toEqual(['Sent your changes (1 file, +2 −1) to Claude for review.'])
  await ui.press({ key: 'off' })
  await ui.unmount()
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/x.ts', content: 'x' })).deny).toBeUndefined()
})

test('outside a git repository pair mode still works but check explains it needs git', async ($, on) => {
  world(on, false)
  expect((await pair($, 'on')).text).toContain('Outside a git repository')
  expect((await pair($, 'check')).text).toBe('/pair check needs a git repository to see what you changed.')
  expect((await pair($, 'sideways')).text).toStartWith('Usage: /pair on | off | check')
})

test('recognises shell commands that write files, and leaves read-only ones alone', () => {
  const writers: Record<string, string> = {
    "sed -i '' 's/x/y/' a.ts": 'sed -i',
    "perl -pi -e 's/a/b/' f": 'perl -i',
    'echo hi > notes.txt': 'a redirection to notes.txt',
    'cat <<EOF > out.md\nhello > world\nEOF': 'a redirection to out.md',
    'npm run build &> build.log': 'a redirection to build.log',
    'git diff | tee review.patch': 'tee',
    'rm -rf dist': 'rm',
    'find . -name "*.orig" -delete': 'find -delete',
    'find src -exec sed -i s/a/b/ {} \\;': 'sed -i',
    'git -C app apply fix.patch': 'git apply',
    'git checkout HEAD -- src/a.ts': 'git checkout --',
    'npx prettier --write src': 'npx --write',
    'npm run lint -- --fix': 'npm --fix',
    'cargo fmt': 'cargo fmt',
    'black src': 'black',
    'FOO=1 sudo mv a b': 'mv',
    'node -e "require(\'fs\').writeFileSync(\'a.txt\', \'x\')"': 'a script that writes files',
    "python3 - <<'PY'\nopen('a.txt', 'w').write('x')\nPY": 'a script that writes files',
  }
  for (const [command, why] of Object.entries(writers)) expect(writesFiles(command)).toBe(why)

  const readers = [
    'npm test 2>&1 | tail -40',
    'ls > /dev/null 2>&1',
    'echo "a > b" && grep -rn "writeFileSync(" src',
    'git status && git diff --stat',
    'black --check src',
    'cargo fmt --check',
    'cat <<EOF | python3 -c "import sys; print(sys.stdin.read())"\nx > y\nEOF',
    'pytest -q tests/test_a.py',
    'echo done >&2',
  ]
  for (const command of readers) expect(writesFiles(command)).toBeUndefined()
})

test('parses actions, numstat totals and cuts long diffs at a file boundary', () => {
  expect(parseAction('')).toBe('toggle')
  expect(parseAction(' ON ')).toBe('on')
  expect(parseAction('review')).toBe('check')
  expect(parseAction('maybe')).toBe('help')
  expect(parseNumstat('3\t1\ta.ts\n-\t-\tlogo.png\n10\t0\tb.ts\n')).toEqual({ files: 3, adds: 13, dels: 1 })
  const long = `${DIFF}${DIFF.replaceAll('a.ts', 'b.ts')}`
  const cut = cutDiff(long, DIFF.length + 10)
  expect(cut).toEqual({ text: DIFF, isCut: true })
  expect(cutDiff(DIFF).isCut).toBe(false)
})

test('a long run of interpreter options is read at once, without exponential backtracking', () => {
  const started = Date.now()
  expect(writesFiles(`node ${'--trace-warnings '.repeat(30)}server.js`)).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(200)
  expect(writesFiles(`node --no-warnings -e "require('fs').writeFileSync('a', 'b')"`)).toBe('a script that writes files')
})

test('regression: writes behind bash -lc, sh -c, eval and wrappers with option values are caught', () => {
  expect(writesFiles(`bash -lc "sed -i 's/a/b/' src/app.ts"`)).toBe('sed -i')
  expect(writesFiles(`sh -ec 'cd src && rm old.ts'`)).toBe('rm')
  expect(writesFiles(`eval "echo hi > notes.txt"`)).toBe('a redirection to notes.txt')
  expect(writesFiles('sudo -u web rm -rf build')).toBe('rm')
  expect(writesFiles('timeout 60 prettier --write src')).toBe('prettier --write')
  expect(writesFiles('nice -n 5 mv a.ts b.ts')).toBe('mv')
  expect(writesFiles(`bash -c "npm test"`)).toBeUndefined()
  expect(writesFiles(`git commit -m "rm the old sed -i hack"`)).toBeUndefined()
})
