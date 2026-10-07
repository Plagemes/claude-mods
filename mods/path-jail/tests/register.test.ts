import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fromGitBash, writeTargets } from '../hooks/bash'

type Entry = { kind: 'dir' | 'file'; link?: string }

/** A tiny file system: /proj is the project, /proj/out links to /etc. */
const FILES: Record<string, Entry> = {
  '/': { kind: 'dir' },
  '/proj': { kind: 'dir' },
  '/proj/src': { kind: 'dir' },
  '/proj/src/app.ts': { kind: 'file' },
  '/proj/out': { kind: 'dir', link: '/etc' },
  '/etc': { kind: 'dir' },
  '/etc/hosts': { kind: 'file' },
  '/tmp': { kind: 'dir' },
  '/home': { kind: 'dir' },
  '/home/me': { kind: 'dir' },
}

/** Follows links and folds `..` the way realpath does; undefined when a part is missing. */
const realPathOf = (path: string, depth = 0): string | undefined => {
  let current = ''
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      current = current.slice(0, current.lastIndexOf('/'))
      continue
    }
    const candidate = `${current}/${part}`
    const entry = FILES[candidate]
    if (entry === undefined) return undefined
    if (entry.link === undefined) {
      current = candidate
      continue
    }
    const target = depth < 8 ? realPathOf(entry.link, depth + 1) : undefined
    if (target === undefined) return undefined
    current = target
  }
  return current === '' ? '/' : current
}

/** Answers what the jail asks of the engine: the project, the file system, settings and tools. */
const world = (on: On, env: Record<string, string> = { HOME: '/home/me' }): void => {
  mock.env(on, env)
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('settings.read', () => ({ value: {} }))
  on('fs.stat', ($, e) => {
    const real = realPathOf(e.path)
    if (real === undefined) return { deny: `ENOENT: ${e.path}` }
    const entry = FILES[real] as Entry
    return { value: { kind: entry.kind, size: 0, mtimeMs: 0, isLink: false, realPath: e.resolve ? real : undefined } }
  })
  on('tool.call', () => ({ result: 'ok' }))
}

/** Why the plugin refused the call, or undefined when it reached the tool. */
const denial = (result: { deny?: string; isError?: boolean; text?: string }): string | undefined =>
  result.deny ?? (result.isError === true ? result.text : undefined)

test('allows writes inside the project, new nested folders included', async ($, on) => {
  world(on)
  expect(denial(await $.tool.call({ tool: 'Write', file_path: '/proj/src/app.ts', content: 'x' }))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'Write', file_path: '/proj/new/deep/file.ts', content: 'x' }))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'Write', file_path: 'notes/today.md', content: 'x' }))).toBeUndefined()
})

test('blocks symlink and .. escapes by their real path', async ($, on) => {
  world(on)
  const viaLink = denial(await $.tool.call({ tool: 'Write', file_path: '/proj/out/hosts', content: 'x' }))
  expect(viaLink).toContain('path-jail: blocked Write')
  expect(viaLink).toContain('/etc/hosts')

  const viaDots = denial(
    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/../../etc/hosts', old_string: 'a', new_string: 'b' }),
  )
  expect(viaDots).toContain('/etc/hosts')

  const viaMissingDots = denial(await $.tool.call({ tool: 'Write', file_path: '/proj/nope/../../etc/x', content: 'x' }))
  expect(viaMissingDots).toContain('/etc/x')
})

test('guards Bash redirections and file commands, following cd', async ($, on) => {
  world(on)
  const bash = async (command: string) => denial(await $.tool.call({ tool: 'Bash', command }))

  expect(await bash('npm test > /etc/motd')).toContain('/etc/motd')
  expect(await bash('cd .. && rm -rf other-project')).toContain('/other-project')
  expect(await bash('mv src/app.ts ~/backup.ts')).toContain('/home/me/backup.ts')
  expect(await bash('cp src/app.ts out/')).toContain('/etc')

  expect(await bash('npm test 2>&1 | tee -a logs/test.log')).toBeUndefined()
  expect(await bash('cd /tmp && rm -rf build && mkdir build')).toBeUndefined()
  expect(await bash('echo "a > /etc/passwd" >> notes.txt')).toBeUndefined()
  expect(await bash('cat > src/gen.ts <<EOF\nconst a = b > c\necho x > /etc/evil\nEOF')).toBeUndefined()
  expect(await bash('ls -la /etc && git status')).toBeUndefined()
})

test('blocks shell writes it cannot check, unless told not to', async ($, on) => {
  world(on)
  const result = denial(await $.tool.call({ tool: 'Bash', command: 'cp src/app.ts "$OUT_DIR/app.ts"' }))
  expect(result).toContain('shell expansion')
})

test('lets uncheckable shell writes through when blockUncheckable is off', { options: { blockUncheckable: false } }, async ($, on) => {
  world(on)
  expect(denial(await $.tool.call({ tool: 'Bash', command: 'cp src/app.ts "$OUT_DIR/app.ts"' }))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'Bash', command: 'rm /etc/hosts' }))).toContain('/etc/hosts')
})

test('extra allowed roots come from the configuration', { options: { allowedRoots: '/tmp, ~' } }, async ($, on) => {
  world(on)
  expect(denial(await $.tool.call({ tool: 'Write', file_path: '/home/me/notes.md', content: 'x' }))).toBeUndefined()
})

test('on Windows, where HOME is unset, ~ expands from USERPROFILE', { options: { allowedRoots: '~/notes' } }, async ($, on) => {
  world(on, { USERPROFILE: '/home/me' })
  FILES['/home/me/notes'] = { kind: 'dir' }
  expect(denial(await $.tool.call({ tool: 'Write', file_path: '/home/me/notes/today.md', content: 'x' }))).toBeUndefined()
  expect(denial(await $.tool.call({ tool: 'Write', file_path: '/home/me/other.md', content: 'x' }))).toContain('/home/me/other.md')
  delete FILES['/home/me/notes']
})

test('/jail lists the allowed folders', async ($, on) => {
  world(on)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run({
    command: 'jail',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(text).toContain('/proj')
  expect(text).toContain('/tmp')
})

test('the Bash reader finds write targets and skips quotes, heredocs and fd duplication', () => {
  const paths = (command: string) => writeTargets(command).map(target => target.path)
  expect(paths('echo hi > a.txt 2>&1 >> b.log &> c.log')).toEqual(['a.txt', 'b.log', 'c.log'])
  expect(paths('sed -i "s/a/b/" one.ts two.ts')).toEqual(['one.ts', 'two.ts'])
  expect(paths('rm -rf dist build')).toEqual(['dist', 'build'])
  expect(paths('cp -r src dest/')).toEqual(['dest/'])
  expect(paths('bash -c "touch /x/y"')).toEqual(['/x/y'])
  expect(paths("echo '> nope' | grep x")).toEqual([])
  expect(paths('echo "$(cat x > y)" > z')).toEqual(['y', 'z'])
  expect(writeTargets('cd sub && touch f')[0]?.cdChain).toEqual(['sub'])
})

test('plan mode and auto memory can write Claude Code\'s own plan and memory files', async ($, on) => {
  world(on)
  FILES['/home/me/.claude'] = { kind: 'dir' }
  try {
    expect(denial(await $.tool.call({ tool: 'Write', file_path: '/home/me/.claude/plans/brave-otter.md', content: '# Plan' }))).toBeUndefined()
    expect(denial(await $.tool.call({ tool: 'Write', file_path: '/home/me/.claude/projects/-proj/memory/MEMORY.md', content: 'x' }))).toBeUndefined()
    expect(denial(await $.tool.call({ tool: 'Write', file_path: '/home/me/.claude/settings.json', content: '{}' }))).toContain('outside the allowed folders')
    expect(denial(await $.tool.call({ tool: 'Write', file_path: '/home/me/.claude/projects/-proj/session.jsonl', content: 'x' }))).toContain('outside the allowed folders')
  } finally {
    delete FILES['/home/me/.claude']
  }
})

test('Git Bash drive paths read as Windows paths', () => {
  expect(fromGitBash('/c/Users/me/.claude/x')).toBe('C:\\Users/me/.claude/x')
  expect(fromGitBash('/d')).toBe('D:\\')
  expect(fromGitBash('/cygdrive/c/tmp/a')).toBe('C:\\tmp/a')
  expect(fromGitBash('/tmp/a')).toBe('/tmp/a')
  expect(fromGitBash('/code/app')).toBe('/code/app')
  expect(fromGitBash('src/c/a')).toBe('src/c/a')
})

test('the Bash reader sees through bash -lc and wrapper options', () => {
  const paths = (command: string) => writeTargets(command).map(target => target.path)
  expect(paths(`bash -lc 'rm -rf /etc/app'`)).toEqual(['/etc/app'])
  expect(paths(`sh -ec "touch /x/y"`)).toEqual(['/x/y'])
  expect(paths('sudo -u root rm /etc/hosts')).toEqual(['/etc/hosts'])
  expect(paths('sudo -E tee /etc/hosts')).toEqual(['/etc/hosts'])
  expect(paths('timeout 5 rm -rf /opt/x')).toEqual(['/opt/x'])
  expect(paths('nice -n 10 rm /opt/y')).toEqual(['/opt/y'])
  expect(paths('sudo rm /etc/z')).toEqual(['/etc/z'])
})
