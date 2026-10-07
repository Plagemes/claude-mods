import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { codeOnly, gitStateChange, isDocPath, isTestPath, shellRefusal, shellWrites } from '../hooks/scope'

const ROOT = '/work/shop'
const CART = `export function total(items: Item[]): number {
  // Sums the prices.
  return items.reduce((sum, item) => sum + item.price, 0)
}
`
const FOLDERS = ['/', '/work', ROOT, `${ROOT}/src`, `${ROOT}/test`, `${ROOT}/docs`, '/tmp']

type World = { clock: MockClock; files: Map<string, string>; ran: string[]; written: string[]; agents: { name: string; tools?: readonly string[]; prompt: string; model?: string }[]; submitted: string[]; filled: string[] }

/** A project with src/, test/ and docs/, where every tool call that gets through is recorded. */
function world(on: On): World {
  const seen: World = {
    clock: mock.clock(on),
    files: new Map([[`${ROOT}/src/cart.ts`, CART], [`${ROOT}/README.md`, '# Shop\n']]),
    ran: [],
    written: [],
    agents: [],
    submitted: [],
    filled: [],
  }
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.list', () => ({
    value: ['Read', 'Edit', 'Write', 'Bash', 'Grep'].map(name => ({ name, description: name, isReadOnly: false })),
  }) as never)
  on('agent.register', ($, e) => {
    seen.agents.push(e)
    return { value: { agent: `agent-presets:${e.name}` } }
  })
  on('agent.spawn', ($, e) => {
    const loose = e as unknown as Record<string, unknown>
    const type = e.subagentType ?? String(loose.subagent_type)
    return { model: 'claude', agentId: `${type.split(':').pop()}-1` }
  })
  on('agent.list', () => ({ value: [{ id: 'mig-7', type: 'agent-presets:migrator', description: 'rename', status: 'running' }] }))
  on('fs.stat', ($, e) => {
    const isFolder = FOLDERS.includes(e.path)
    if (!isFolder && !seen.files.has(e.path)) return { deny: 'ENOENT' }
    return { value: { kind: isFolder ? 'dir' : 'file', size: 1, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') seen.ran.push(e.command)
    if ('file_path' in e && typeof e.file_path === 'string') seen.written.push(e.file_path.replace(`${ROOT}/`, ''))
    return { result: 'ok' }
  })
  on('prompt.submit', ($, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: 'the flaky cart test', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return seen
}

const spawn = ($: Engine, name: string) => $.agent.spawn({ prompt: 'go', description: 'job', subagentType: `agent-presets:${name}` } as never)
const as = (agentId: string, call: Record<string, unknown>) => ({ ...call, agentId }) as never
const denied = (result: { deny?: string; isError?: boolean; text?: string }) => String(result.deny ?? (result.isError === true ? result.text : ''))

test('knows tests from docs from code, comments from code, and what a command writes', async () => {
  expect(isTestPath('src/cart.test.ts')).toBe(true)
  expect(isTestPath('tests/unit/test_cart.py')).toBe(true)
  expect(isTestPath('pkg/cart_test.go')).toBe(true)
  expect(isTestPath('src/cart.ts')).toBe(false)
  expect(isDocPath('docs/setup.html')).toBe(true)
  expect(isDocPath('CHANGELOG')).toBe(true)
  expect(isDocPath('src/cart.ts')).toBe(false)

  const commented = CART.replace('// Sums the prices.', '/**\n   * Sums the prices, in cents.\n   */')
  expect(codeOnly(commented, 'cart.ts')).toBe(codeOnly(CART, 'cart.ts'))
  expect(codeOnly(CART.replace('0)', '1)'), 'cart.ts')).not.toBe(codeOnly(CART, 'cart.ts'))
  const py = 'def total(items):\n    return sum(i.price for i in items)  # cents\n'
  expect(codeOnly(py.replace(':\n', ':\n    """Sum of the prices."""\n'), 'cart.py')).toBe(codeOnly(py, 'cart.py'))
  expect(codeOnly('url = "http://x"  # site', 'a.py')).toBe('url = "http://x"')

  expect(shellWrites('npm test -- cart 2>&1 | tail -5')).toEqual([])
  expect(shellWrites('echo hi > src/a.ts && cp a b')).toEqual(['src/a.ts', 'b'])
  expect(shellWrites("sed -i 's/a/b/' src/a.ts")).toBeUndefined()
  expect(shellWrites("perl -pi -e 's/a/b/' x")).toBeUndefined()
  expect(shellWrites('perl -Mstrict -e 1')).toEqual([])
  expect(gitStateChange('git -C . commit -m wip')).toBe('git commit')
  expect(gitStateChange('git diff HEAD~1')).toBeUndefined()
  expect(shellRefusal('tests', 'mkdir -p test/fixtures && touch test/fixtures/cart.json', ROOT)).toBeUndefined()
  expect(shellRefusal('tests', 'npm install --save-dev vitest', ROOT)).toContain('dependencies')
  expect(shellRefusal('project', 'git push origin main', ROOT)).toContain('no git push')
})

test('registers four presets with focused briefs and only the tools this build has', { options: { model: 'sonnet' } }, async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(seen.agents.map(agent => agent.name)).toEqual(['debugger', 'test-writer', 'doc-writer', 'migrator'])
  expect(seen.agents.every(agent => agent.model === 'sonnet')).toBe(true)
  expect(seen.agents[0]?.prompt).toContain('Reproduce')
  expect(seen.agents[0]?.prompt).toContain('regression test')
  expect(seen.agents[1]?.tools).toEqual(['Read', 'Grep', 'Edit', 'Write', 'Bash'])
  expect(seen.agents[2]?.tools).toEqual(['Read', 'Grep', 'Edit', 'Write'])
})

test('the test writer writes tests only; other agents and the main loop are untouched', async ($, on) => {
  const seen = world(on)
  await spawn($, 'test-writer')

  expect(denied(await $.tool.call(as('test-writer-1', { tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: '0)', new_string: '1)' })))).toContain(
    'may only write test files and fixtures, not src/cart.ts',
  )
  await $.tool.call(as('test-writer-1', { tool: 'Write', file_path: `${ROOT}/test/cart/new.test.ts`, content: 'test()' }))
  expect(denied(await $.tool.call(as('test-writer-1', { tool: 'Bash', command: 'echo x >> src/cart.ts' })))).toContain('may not write src/cart.ts')
  expect(denied(await $.tool.call(as('test-writer-1', { tool: 'Bash', command: 'git commit -am tests' })))).toContain('no git commit')
  await $.tool.call(as('test-writer-1', { tool: 'Bash', command: 'npm test -- cart' }))
  expect(denied(await $.tool.call(as('test-writer-1', { tool: 'Write', file_path: '/etc/hosts', content: 'x' })))).toContain('writes only inside the project')

  await $.tool.call(as('someone-else', { tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: '0)', new_string: '1)' }))
  await $.tool.call({ tool: 'Bash', command: 'git commit -am wip' })
  expect(seen.written).toEqual(['test/cart/new.test.ts', 'src/cart.ts'])
  expect(seen.ran).toEqual(['npm test -- cart', 'git commit -am wip'])
})

test('the doc writer may touch comments in code but not the code itself', async ($, on) => {
  const seen = world(on)
  await spawn($, 'doc-writer')
  const edit = (old_string: string, new_string: string) =>
    $.tool.call(as('doc-writer-1', { tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string, new_string }))

  await edit('// Sums the prices.', '// Sums the prices, in cents, of every item.')
  expect(denied(await edit('sum + item.price', 'sum + item.price * 2'))).toContain('may change only comments and docstrings in src/cart.ts')
  await $.tool.call(as('doc-writer-1', { tool: 'Write', file_path: `${ROOT}/docs/cart.md`, content: '# Cart' }))
  expect(denied(await $.tool.call(as('doc-writer-1', { tool: 'Write', file_path: `${ROOT}/src/new.ts`, content: 'x' })))).toContain(
    'may not create code files',
  )
  expect(seen.written).toEqual(['src/cart.ts', 'docs/cart.md'])
})

test('an agent it did not see start is looked up; the migrator stays inside the project', async ($, on) => {
  const seen = world(on)
  expect(denied(await $.tool.call(as('mig-7', { tool: 'Write', file_path: `${ROOT}/../other/x.ts`, content: 'x' })))).toContain(
    'writes only inside the project',
  )
  await $.tool.call(as('mig-7', { tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: 'total', new_string: 'sumOf' }))
  await $.tool.call(as('mig-7', { tool: 'Write', file_path: '/tmp/codemod.js', content: 'x' }))
  expect(seen.written).toEqual(['src/cart.ts', '/tmp/codemod.js'])
})

test('/presets lists the presets as cards with Use buttons, and hands a task over', async ($, on) => {
  const seen = world(on)
  const run = (args: string) =>
    $.command.run({ command: 'presets', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect((await run('')).text).toContain('agent-presets:test-writer (test files and fixtures only)')

  const props: RenderPropsOf['CommandOutput'] = { command: 'presets', args: '', text: 'listing', isErrored: false }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-presets', surface, component: 'CommandOutput', props })
    expect((await ui.find({ key: 'preset:debugger' }))?.text).toContain('regression test')
    await ui.press({ key: 'use:debugger' })
    await ui.unmount()
  }
  expect(seen.filled[0]).toBe('Use the agent-presets:debugger agent to the flaky cart test')

  expect((await run('test-writer cover src/cart.ts')).text).toBe('Handing it to agent-presets:test-writer.')
  await seen.clock.advance(0)
  expect(seen.submitted).toEqual(['Use the agent-presets:test-writer agent to cover src/cart.ts'])
  expect((await run('linter go')).text).toContain('There is no preset "linter"')
})

test('regression: the shell check reads what a command writes, not comparisons, copy sources or read-only git', () => {
  // A `>` inside quotes or a here-document body is no redirection.
  expect(shellRefusal('tests', 'python -c "print(1 > 0)"', ROOT)).toBeUndefined()
  expect(shellRefusal('tests', "jq '.[] | select(.x > 3)' data.json", ROOT)).toBeUndefined()
  expect(shellRefusal('tests', "cat > tests/test_cart.py <<'EOF'\nassert total([]) > -1\nEOF", ROOT)).toBeUndefined()
  // cp writes its destination; chmod's mode is no path; a test folder may be made.
  expect(shellRefusal('tests', 'cp src/data.json tests/fixtures/', ROOT)).toBeUndefined()
  expect(shellRefusal('tests', 'chmod +x tests/run.sh', ROOT)).toBeUndefined()
  expect(shellRefusal('tests', 'mkdir -p src/__tests__', ROOT)).toBeUndefined()
  expect(shellRefusal('tests', 'cp tests/fixtures/a.json src/a.json', ROOT)).toContain('src/a.json')
  expect(shellRefusal('tests', 'mv src/cart.ts tests/cart.ts', ROOT)).toContain('src/cart.ts')
  expect(shellRefusal('tests', 'echo x &> src/out.log', ROOT)).toContain('src/out.log')
  // Read-only git forms pass; global options do not hide a state change.
  expect(gitStateChange('git merge-base HEAD main')).toBeUndefined()
  expect(gitStateChange('git stash list')).toBeUndefined()
  expect(gitStateChange('git tag --contains abc123')).toBeUndefined()
  expect(gitStateChange('git worktree list')).toBeUndefined()
  expect(gitStateChange('git stash')).toBe('git stash')
  expect(gitStateChange('git tag v1.2.0')).toBe('git tag')
  expect(gitStateChange('git --no-pager commit -m wip')).toBe('git commit')
  expect(gitStateChange('git -P push origin main')).toBe('git push')
})
