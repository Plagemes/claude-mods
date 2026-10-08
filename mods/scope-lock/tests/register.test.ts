import { expect, mock, test } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { writeTargets } from '../hooks/bash'
import { globToRegExp, isInScope, resolvePath } from '../hooks/glob'
import { fakeHub } from './hub'

const ROOT = '/work/app'
const COMPOSE = { model: 'claude', promptModel: 'claude', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] }
const scope = (args: string, origin: PromptOrigin = { kind: 'composer' }) =>
  ({ command: 'scope', args, origin, presentation: { isFullscreen: false, columns: 100 } }) as const

type World = { ran: string[]; statuses: (string | undefined)[] }

/** Stands for the engine: the project, the session's cwd and home, tools that record what ran. */
const world = (on: On, cwd = ROOT): World => {
  const state: World = { ran: [], statuses: [] }
  mock.env(on, { HOME: '/home/me' })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => {
    state.statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  on('tool.call', ($, e) => {
    state.ran.push(String(e.tool) === 'Bash' && 'command' in e ? String(e.command) : 'file_path' in e ? String(e.file_path) : String(e.tool))
    return { result: 'ok' }
  })
  return state
}

/** Why the call was refused, or undefined when it reached the tool. */
const denial = (result: { deny?: string; isError?: boolean; text?: string }): string | undefined =>
  result.deny ?? (result.isError === true ? result.text : undefined)

test('globs match **, *, ?, [..] and {a,b}; plain folders match what is under them', () => {
  expect(globToRegExp('src/**/*.test.ts').test('src/a/b/c.test.ts')).toBe(true)
  expect(globToRegExp('src/**/*.test.ts').test('src/c.test.ts')).toBe(true)
  expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
  expect(globToRegExp('src/v?.ts').test('src/v2.ts')).toBe(true)
  expect(globToRegExp('src/[ab].ts').test('src/b.ts')).toBe(true)
  expect(globToRegExp('{lib,pkg}/**').test('pkg/x/y.go')).toBe(true)
  const globs = ['src/auth/**', 'tests/auth', '*.md']
  expect(isInScope('/work/app/src/auth/deep/login.ts', ROOT, globs)).toBe(true)
  expect(isInScope('/work/app/tests/auth/login.test.ts', ROOT, globs)).toBe(true)
  expect(isInScope('/work/app/tests/authz/x.ts', ROOT, globs)).toBe(false)
  expect(isInScope('/work/app/README.md', ROOT, globs)).toBe(true)
  expect(isInScope('/work/app/docs/guide.md', ROOT, globs)).toBe(false)
  expect(isInScope('/etc/hosts', ROOT, ['/etc/**'])).toBe(true)
  expect(resolvePath('src/auth/../payments/x.ts', ROOT)).toBe('/work/app/src/payments/x.ts')
})

test('the shell reader finds redirections and file commands, skipping quotes, heredocs and fd duplication', () => {
  const paths = (command: string) => writeTargets(command).map(target => target.path)
  expect(paths('npm test > out.log 2>&1 && echo "a > b" | tee -a logs/x.log')).toEqual(['out.log', 'logs/x.log'])
  expect(paths('mv src/a.ts lib/a.ts && cp -r src dest/ && rm -rf dist')).toEqual(['src/a.ts', 'lib/a.ts', 'dest/', 'dist'])
  expect(paths('sed -i "s/x/y/" src/a.ts src/b.ts')).toEqual(['src/a.ts', 'src/b.ts'])
  expect(paths('cat > gen.ts <<EOF\necho x > /etc/evil\nEOF')).toEqual(['gen.ts'])
  expect(paths('git rm old.ts && git checkout -- cfg.json && git reset --hard')).toEqual(['old.ts', 'cfg.json', '.'])
  expect(paths('bash -c "touch /x/y" && echo $(rm -f z)')).toEqual(['/x/y', 'z'])
  expect(paths('ls -la && git status && grep -r foo src')).toEqual([])
  expect(writeTargets('cd packages/web && touch a')[0]?.cdChain).toEqual(['packages/web'])
})

test('/scope locks writes: edits and shell writes outside the globs are refused, inside ones run', async ($, on) => {
  const state = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const locked = await $.command.run(scope('src/auth/** tests/auth/'))
  expect(locked.text).toBe('🔒 Scope locked: writes allowed only under src/auth/**, tests/auth/**.')
  expect(state.statuses.at(-1)).toBe('🔒 scope: src/auth/** +1')

  expect(denial(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/auth/login.ts`, old_string: 'a', new_string: 'b' }))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/tests/auth/new.test.ts`, content: 'x' }))).toBeUndefined()
  const outside = denial(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/payments/stripe.ts`, content: 'x' }))
  expect(outside).toBe(
    `🔒 scope-lock: blocked Write on "${ROOT}/src/payments/stripe.ts": it is outside the scope (src/auth/**, tests/auth/**). Keep to those files, or ask the user to widen the scope with /scope add <glob>.`,
  )
  expect(denial(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/auth/../payments/x.ts`, old_string: 'a', new_string: 'b' }))).toContain('outside the scope')

  const bash = async (command: string) => denial(await $.tool.call({ tool: 'Bash', command }))
  expect(await bash('npm test 2>&1 | tee /tmp/test.log')).toBeUndefined()
  expect(await bash('sed -i "s/a/b/" src/auth/session.ts')).toBeUndefined()
  expect(await bash('cd src/auth && rm -f old.ts')).toBeUndefined()
  expect(await bash('git diff && ls src')).toBeUndefined()
  expect(await bash('echo x > src/config.ts')).toContain('blocked > on "src/config.ts"')
  expect(await bash('mv src/auth/a.ts src/a.ts')).toContain('blocked mv on "src/a.ts"')
  expect(await bash('cd src/auth && rm ../index.ts')).toContain('outside the scope')
  expect(await bash('rm src/auth/*.bak')).toBeUndefined()
  expect(await bash('rm *.bak')).toContain('blocked rm on "*.bak"')
  expect(await bash('cp x "$OUT/y"')).toContain('uses a shell variable or substitution that cannot be checked')
  expect(await bash('git reset --hard')).toContain('blocked git reset on "."')
  expect(state.ran).toContain(`${ROOT}/src/auth/login.ts`)
  expect(state.ran).not.toContain(`${ROOT}/src/payments/stripe.ts`)
})

test('the model is told the scope; /scope add, remove, show and off manage it', async ($, on) => {
  const state = world(on)
  await $.command.run(scope('src/auth/**'))
  const section = (await $.prompt.compose(COMPOSE)).sections.find(one => one.id === 'scope-lock:scope')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('locked this session\'s writes to these paths (globs relative to the project root): src/auth/**.')
  expect((await $.command.run(scope('add docs/auth.md'))).text).toBe('🔒 Scope locked: writes allowed only under src/auth/**, docs/auth.md.')
  expect(denial(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/auth.md`, content: '#' }))).toBeUndefined()
  expect((await $.command.run(scope('remove src/auth/**'))).text).toBe('🔒 Scope locked: writes allowed only under docs/auth.md.')
  expect((await $.command.run(scope('show'))).text).toBe('Scope: writes allowed only under docs/auth.md.')
  expect((await $.command.run(scope('off'))).text).toBe('Scope off: Claude may write anywhere again.')
  expect(state.statuses.at(-1)).toBeUndefined()
  expect((await $.prompt.compose(COMPOSE)).sections.map(one => one.id)).toEqual(['intro'])
  expect(denial(await $.tool.call({ tool: 'Write', file_path: '/anywhere/x.ts', content: 'x' }))).toBeUndefined()
})

test('only the person can change the scope; a plugin or the model cannot lift it', async ($, on) => {
  world(on)
  await $.command.run(scope('src/**'))
  const lifted = await $.command.run(scope('off', { kind: 'plugin', name: 'other' }))
  expect(lifted.text).toBe('Only the user can change the scope (now: writes allowed only under src/**).')
  expect(denial(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/package.json`, content: '{}' }))).toContain('outside the scope')
})

test('temp folders and uncheckable writes follow the configuration', { options: { allowTemp: false, blockUncheckable: false } }, async ($, on) => {
  world(on)
  await $.command.run(scope('src/**'))
  expect(denial(await $.tool.call({ tool: 'Bash', command: 'echo x > /tmp/log' }))).toContain('outside the scope')
  expect(denial(await $.tool.call({ tool: 'Bash', command: 'cp a "$OUT/b"' }))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${ROOT}/notebooks/a.ipynb`, new_source: 'x' } as never))).toContain('blocked NotebookEdit')
})

test('read-only git stash subcommands pass; git -C and bash -lc writes are still seen', () => {
  const paths = (command: string) => writeTargets(command).map(target => target.path)
  expect(paths('git stash list')).toEqual([])
  expect(paths('git stash show -p')).toEqual([])
  expect(paths('git stash pop')).toEqual(['.'])
  expect(paths('git -C app rm old.ts')).toEqual(['app/old.ts'])
  expect(paths('git -c core.quotepath=off rm old.ts')).toEqual(['old.ts'])
  expect(paths('bash -lc "rm -rf build"')).toEqual(['build'])
})

test('the shared shell reader: eval, su -c, xargs, heredocs and here-strings fed to a shell, with their own cds', () => {
  const paths = (command: string) => writeTargets(command).map(target => target.path)
  expect(paths(`eval "rm src/a.ts"`)).toEqual(['src/a.ts'])
  expect(paths(`su -c 'touch b.ts' me`)).toEqual(['b.ts'])
  expect(paths('ls | xargs -0 rm -f c.ts')).toEqual(['c.ts'])
  expect(paths('sh <<< "rm d.ts"')).toEqual(['d.ts'])
  expect(writeTargets('bash <<EOF\ncd lib\ntouch e.ts\nEOF')).toEqual([{ path: 'e.ts', via: 'touch', cdChain: ['lib'] }])
  expect(writeTargets('cd src && bash -c "cd auth && rm f.ts"')).toEqual([{ path: 'f.ts', via: 'rm', cdChain: ['src', 'auth'] }])
  expect(paths("cat <<'EOF' > notes.md\nrm g.ts\nEOF")).toEqual(['notes.md'])
  expect(paths(`echo '$(rm /etc/h)' > notes.txt`)).toEqual(['notes.txt'])
})

test('with mods-hub: the scope is shared as a fact and each deny is published as risk.blocked', async ($, on) => {
  const state = world(on)
  const hub = fakeHub(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])
  expect(hub.facts.get('scope')).toEqual([])
  await $.command.run(scope('src/auth/**'))
  expect(hub.facts.get('scope')).toEqual(['src/auth/**'])
  expect(denial(await $.tool.call({ tool: 'Bash', command: 'echo x > src/config.ts' }))).toContain('outside the scope')
  expect(denial(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/auth/ok.ts`, content: 'x' }))).toBeUndefined()
  expect(hub.published).toEqual([
    {
      topic: 'risk.blocked',
      data: { guard: 'scope-lock', tool: 'Bash', reason: 'outside-scope: > outside src/auth/**', severity: 'medium', path: 'src/config.ts', command: 'echo x > src/config.ts' },
    },
  ])
  await $.command.run(scope('off'))
  expect(hub.facts.get('scope')).toEqual([])
  expect(state.ran).toEqual([`${ROOT}/src/auth/ok.ts`])
})
