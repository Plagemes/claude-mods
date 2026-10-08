import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'

import { findGlobalInstall } from '../hooks/pip'
import { fakeHub } from './hub'

/** Stands in for the engine: records the commands that reach the Bash tool, answers the project folder and its listing. */
function engine(on: On, variables: Record<string, string> | 'broken' = {}, folders: string[] = []) {
  const ran: string[] = []
  if (variables === 'broken') {
    on('env.get', () => {
      throw new Error('env is unavailable')
    })
  } else {
    mock.env(on, variables)
  }
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: 'ran' }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.list', () => ({
    value: folders.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  return ran
}

const GLOBAL_INSTALLS = [
  'pip install requests',
  'pip3 install -r requirements.txt',
  'python3 -m pip install flask',
  'python3.12 -m pip install --upgrade pip',
  'sudo pip install httpx',
  'pip install --user black',
  'FOO=1 pip install rich',
  'cd backend && pip install -e .',
  'pip install pytest; pytest',
  'source /opt/other/setup.sh && pip install x',
  // The shared shell reader: wrappers, shells handed a script, substitutions, heredocs fed to a shell.
  'timeout 300 pip install torch',
  'bash -c "pip install requests"',
  'echo "$(pip install requests)"',
  'bash <<EOF\npip install requests\nEOF',
  'bash -c "source .venv/bin/activate" && pip install requests',
]

const ISOLATED = [
  'source .venv/bin/activate && pip install requests',
  '. venv/bin/activate; pip3 install -r requirements.txt',
  '.venv/bin/pip install requests',
  './venv/bin/python -m pip install flask',
  'conda activate api && pip install numpy',
  'VIRTUAL_ENV=/tmp/x pip install requests',
  'PIP_REQUIRE_VIRTUALENV=1 pip install requests',
  'uv pip install requests',
  'uv add requests',
  'poetry add requests',
  'pipx install black',
  'pipenv install requests',
  'pip install --dry-run requests',
  'pip install --target ./vendor requests',
  'pip list',
  'pip freeze > requirements.txt',
  'python -m venv .venv && .venv/bin/pip install -r requirements.txt',
  'echo "remember to pip install requests"',
  'git commit -m "pip install docs"',
  'ls -la',
  'source .venv/bin/activate && bash -c "pip install requests"',
  'env VIRTUAL_ENV=/repo/.venv pip install requests',
]

test('denies pip install when no virtualenv is active, whatever the spelling', async ($, on) => {
  const ran = engine(on)
  for (const command of GLOBAL_INSTALLS) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('venv-guard')
    expect(result.deny).toContain('system Python')
  }
  expect(ran).toHaveLength(0)
})

test('lets through installs that are isolated by the command itself, and everything that is not pip install', async ($, on) => {
  const ran = engine(on)
  for (const command of ISOLATED) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'allowed'}`).toBe(`${command} => allowed`)
  }
  expect(ran).toHaveLength(ISOLATED.length)
})

test('lets pip install through when VIRTUAL_ENV or a named conda env is active', async ($, on) => {
  engine(on, { VIRTUAL_ENV: '/repo/.venv' })
  expect((await $.tool.call({ tool: 'Bash', command: 'pip install requests' })).deny).toBeUndefined()
})

test('a conda env counts, the conda base does not', async ($, on) => {
  const variables: Record<string, string> = { CONDA_PREFIX: '/opt/conda', CONDA_DEFAULT_ENV: 'base' }
  engine(on, variables)
  expect((await $.tool.call({ tool: 'Bash', command: 'pip install requests' })).deny).toContain('venv-guard')
})

test('a named conda env counts', async ($, on) => {
  engine(on, { CONDA_PREFIX: '/opt/conda/envs/api', CONDA_DEFAULT_ENV: 'api' })
  expect((await $.tool.call({ tool: 'Bash', command: 'pip install requests' })).deny).toBeUndefined()
})

test('points at the project environment when there is one, and at how to create one when there is not', async ($, on) => {
  engine(on, {}, ['.venv', 'src'])
  const withVenv = await $.tool.call({ tool: 'Bash', command: 'pip install requests' })
  expect(withVenv.deny).toContain('This project has .venv/')
  expect(withVenv.deny).toContain('source .venv/bin/activate')
})

test('suggests creating an environment when the project has none', async ($, on) => {
  engine(on, {}, ['src'])
  const result = await $.tool.call({ tool: 'Bash', command: 'pip install requests' })
  expect(result.deny).toContain('python3 -m venv .venv')
  expect(result.deny).toContain('uv venv')
})

test('allowGlobal switches the guard off', { options: { allowGlobal: true } }, async ($, on) => {
  const ran = engine(on)
  const result = await $.tool.call({ tool: 'Bash', command: 'pip install requests' })
  expect(result.deny).toBeUndefined()
  expect(ran).toEqual(['pip install requests'])
})

test('fails closed for a pip command when its own check throws, and leaves other commands alone', async ($, on) => {
  const ran = engine(on, 'broken')
  expect((await $.tool.call({ tool: 'Bash', command: 'pip install requests' })).deny).toContain('its check failed')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(ran).toEqual(['ls'])
})

test('regression: sudo pip and pip --user are refused even with a virtualenv active', async ($, on) => {
  const ran = engine(on, { VIRTUAL_ENV: '/repo/.venv' })
  for (const command of ['sudo pip install httpx', 'source .venv/bin/activate && sudo pip install httpx', 'pip install --user black']) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('installs into the system Python even with a virtualenv active')
  }
  expect((await $.tool.call({ tool: 'Bash', command: 'pip install httpx' })).deny).toBeUndefined()
  expect(ran).toEqual(['pip install httpx'])
})

test('regression: here-document bodies are text, not commands', async ($, on) => {
  const ran = engine(on)
  const readme = "cat > README.md <<'EOF'\n## Install\npip install mypkg\nEOF"
  expect((await $.tool.call({ tool: 'Bash', command: readme })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cat > x <<EOF\npip install a\nEOF\npip install b' })).deny).toContain('"pip install b"')
  expect(ran).toEqual([readme])
})

test('an activation reaches the scripts run after it, but not the other way round', () => {
  expect(findGlobalInstall('. .venv/bin/activate; sh -c "pip install a"')).toBeUndefined()
  expect(findGlobalInstall('sh -c ". .venv/bin/activate"; pip install a')).toEqual({ command: 'pip install a', isSystemWide: false })
  expect(findGlobalInstall('sudo -H pip install a')).toEqual({ command: 'sudo pip install a', isSystemWide: true })
})

test('with mods-hub: a deny is published as risk.blocked', async ($, on) => {
  engine(on)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])
  expect((await $.tool.call({ tool: 'Bash', command: 'pip install requests' })).deny).toContain('venv-guard')
  expect((await $.tool.call({ tool: 'Bash', command: 'sudo pip install requests' })).deny).toContain('venv-guard')
  expect(hub.published).toEqual([
    { topic: 'risk.blocked', data: { guard: 'venv-guard', tool: 'Bash', reason: 'no-virtualenv: pip install with no virtualenv active', severity: 'low', command: 'pip install requests' } },
    {
      topic: 'risk.blocked',
      data: { guard: 'venv-guard', tool: 'Bash', reason: 'system-wide-install: sudo pip or pip --user installs into the system Python', severity: 'medium', command: 'sudo pip install requests' },
    },
  ])
})
