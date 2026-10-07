import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandInfo, On } from 'claude-code'

const BIN = '/opt/claude-code/bin/claude'
const VALID = JSON.stringify({ success: true, manifest: { errors: [], warnings: [] }, contents: [{ errors: [], warnings: [] }] })

type WorldOptions = {
  cwd?: string
  dirs?: string[]
  existing?: string[]
  commands?: CommandInfo[]
  gitName?: string
  remote?: string
  validation?: string
  testOutput?: string
  failWrite?: string
  marketplace?: string
}

/** Stands for the disk, git and the claude CLI beneath the plugin. */
function world(on: On, options: WorldOptions = {}) {
  const cwd = options.cwd ?? '/work/claude-mods'
  const dirs = new Set(options.dirs ?? [`${cwd}/mods`])
  const existing = new Set(options.existing ?? [])
  const written = new Map<string, string>()
  const ran: string[] = []
  mock.env(on, { CLAUDE_CODE_EXECPATH: BIN })
  const out = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: cwd }))
  on('command.list', () => ({ value: options.commands ?? [{ name: 'help', description: 'Help', source: 'builtin' }] }))
  on('fs.stat', ($, e) =>
    dirs.has(e.path) ? { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } } : { deny: `ENOENT: ${e.path}` },
  )
  on('fs.exists', ($, e) => ({ value: existing.has(e.path) || dirs.has(e.path) }))
  on('fs.read', ($, e) =>
    options.marketplace !== undefined && e.path === `${cwd}/.claude-plugin/marketplace.json`
      ? { value: options.marketplace }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('fs.write', ($, e) => {
    if (options.failWrite !== undefined && e.path.endsWith(options.failWrite)) return { deny: 'EACCES: permission denied' }
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const [bin = '', ...args] = e.argv
    const line = args.join(' ')
    ran.push(`${bin === 'git' ? 'git' : bin === BIN ? 'claude' : bin} ${line}`)
    if (line === 'config user.name') return options.gitName === undefined ? out('', 1) : out(`${options.gitName}\n`)
    if (line === 'remote get-url origin') return options.remote === undefined ? out('', 2) : out(`${options.remote}\n`)
    if (args[1] === 'validate') return out(options.validation ?? VALID, options.validation === undefined ? 0 : 1)
    if (args[1] === 'test') return out(options.testOutput ?? '(pass) one\n(pass) two\n\n 2 pass\n 0 fail\n')
    return out('', 127)
  })

  return { cwd, written, ran }
}

const newMod = ($: Engine, args: string) =>
  $.command.run({ command: 'new-mod', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

test('in a collection it writes mods/<name>, then validates and tests the new mod', async ($, on) => {
  const w = world(on, { gitName: 'Ada Lovelace', remote: 'git@github.com:ada/claude-mods.git' })
  await $.session.start({ cwd: w.cwd, surface: 'terminal', isInteractive: true })
  const result = await newMod($, 'file-pane "Lists the files Claude touched" --kind pane')
  const dir = `${w.cwd}/mods/file-pane`

  expect([...w.written.keys()]).toEqual([
    `${dir}/.claude-plugin/plugin.json`,
    `${dir}/hooks/hooks.json`,
    `${dir}/hooks/register.tsx`,
    `${dir}/types/index.d.ts`,
    `${dir}/tests/register.test.ts`,
    `${dir}/README.md`,
  ])
  expect(JSON.parse(w.written.get(`${dir}/.claude-plugin/plugin.json`) ?? '')).toMatchObject({
    name: 'file-pane',
    description: 'Lists the files Claude touched',
    author: { name: 'Ada Lovelace' },
    repository: 'https://github.com/ada/claude-mods',
  })
  expect(w.written.get(`${dir}/README.md`)).toContain('/plugin marketplace add ada/claude-mods\n/plugin install file-pane@claude-mods\n')
  expect(w.written.get(`${dir}/README.md`)).not.toContain('--marketplace')
  expect(w.ran).toEqual([
    'git config user.name',
    'git remote get-url origin',
    `claude plugin validate ${dir} --json`,
    `claude plugin test ${dir}`,
  ])
  expect(result.text).toBe(
    [
      '✓ Created mods/file-pane, a pane mod: .claude-plugin/plugin.json · hooks/hooks.json · hooks/register.tsx · types/index.d.ts · tests/register.test.ts · README.md',
      '✓ claude plugin validate: passed',
      '✓ claude plugin test: 2 passed',
      'Next:',
      '  1. Fill in hooks/register.tsx and the TODOs in README.md.',
      '  2. Try it: claude --plugin-dir mods/file-pane',
      '  3. Test it: claude plugin test mods/file-pane',
      '  4. List it in .claude-plugin/marketplace.json to publish it.',
    ].join('\n'),
  )
})

test('outside a collection it writes ./<name> with the configured author and the default kind', { options: { author: 'Grace', defaultKind: 'guard', runTests: false } }, async ($, on) => {
  const w = world(on, { cwd: '/home/me/play', dirs: [] })
  const result = await newMod($, 'no-force')
  const dir = '/home/me/play/no-force'

  expect(w.written.get(`${dir}/hooks/register.ts`)).toContain("on('tool.call', { tool: 'Bash' }")
  expect(JSON.parse(w.written.get(`${dir}/.claude-plugin/plugin.json`) ?? '')).toMatchObject({
    author: { name: 'Grace' },
    description: 'Blocks risky Bash commands before they run.',
    keywords: ['claude-mods', 'guard'],
  })
  expect(w.ran).toEqual(['git remote get-url origin', `claude plugin validate ${dir} --json`])
  expect(result.text).toStartWith('✓ Created no-force, a guard mod:')
  expect(result.text).toContain('  2. Try it: claude --plugin-dir no-force')
  expect(result.text).not.toContain('marketplace.json')
})

test('refuses bad names, existing folders and command names already taken', async ($, on) => {
  const w = world(on, {
    existing: ['/work/claude-mods/mods/taken'],
    commands: [
      { name: 'review', description: 'Review a PR', source: 'builtin' },
      { name: 'mods', description: 'Mod store', source: 'plugin', plugin: 'mod-store' },
    ],
  })

  expect((await newMod($, '')).text).toStartWith('Usage: /new-mod <name> [description] [--kind guard|status|pane|command]\nKinds:')
  expect((await newMod($, 'My_Mod')).text).toStartWith('✗ "My_Mod" is not kebab-case')
  expect((await newMod($, 'ok --kind widget')).text).toStartWith('✗ --kind takes guard, status, pane, command, not "widget".')
  expect((await newMod($, 'taken')).text).toBe('✗ mods/taken already exists. Pick another name, or remove that folder first.')
  expect((await newMod($, 'review')).text).toBe('✗ /review is already a builtin command. Pane and command mods register /<name>: pick another name, or use --kind guard or status.')
  expect((await newMod($, 'mods --kind pane')).text).toContain("/mods is already the mod-store plugin's.")
  expect((await newMod($, 'mods --kind status')).text).toStartWith('✓ Created mods/mods, a status mod')
  expect(w.written.size).toBe(5)
})

test('a write that fails part-way says what was written and stops', async ($, on) => {
  const failing = JSON.stringify({ success: false, manifest: { errors: [], warnings: [] }, contents: [{ errors: [{ message: 'does not parse' }] }] })
  const w = world(on, { validation: failing, failWrite: 'README.md' })

  const broken = await newMod($, 'half-done')
  expect(broken.text).toBe(
    '✗ Could not write mods/half-done/README.md: EACCES: permission denied. Already written: .claude-plugin/plugin.json, hooks/hooks.json, hooks/register.ts, tests/register.test.ts.',
  )
  expect(w.ran.some(line => line.includes('validate'))).toBe(false)
})

test('a validation failure is shown with its errors and skips the tests', async ($, on) => {
  const failing = JSON.stringify({ success: false, manifest: { errors: [{ message: 'name: required' }] }, contents: [{ errors: [{ message: 'does not parse' }] }] })
  const w = world(on, { validation: failing })
  const result = await newMod($, 'shaky --kind status')
  expect(result.text).toContain('✗ claude plugin validate: failed\n  name: required\n  does not parse\nNext:')
  expect(w.ran.some(line => line.startsWith('claude plugin test'))).toBe(false)
})

test('the README install line names the collection marketplace, never a --marketplace flag', async ($, on) => {
  const w = world(on, { remote: 'https://github.com/ada/tools.git', marketplace: '{"name":"ada-mods","plugins":[]}' })
  await $.session.start({ cwd: w.cwd, surface: 'terminal', isInteractive: true })
  await newMod($, 'tidy-bot --kind command')
  const readme = w.written.get(`${w.cwd}/mods/tidy-bot/README.md`) ?? ''
  expect(readme).toContain('/plugin marketplace add ada/tools\n/plugin install tidy-bot@ada-mods\n')
  expect(readme).not.toContain('--marketplace')
})
