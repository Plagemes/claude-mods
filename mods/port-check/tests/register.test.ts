import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { analyze, portIn } from '../hooks/servers'
import { fakeHub } from './hub'

type Listening = Record<number, { pid: number; name: string; args?: string }>

/** Stands in for the engine: a project on a virtual disk, the processes listening on ports (lsof or ss), and what runs. */
function machine(on: On, listening: Listening, options: { files?: Record<string, string>; tools?: 'lsof' | 'ss' | 'none' } = {}) {
  const tools = options.tools ?? 'lsof'
  const seen = { probed: [] as number[], toasts: [] as string[], ran: [] as string[] }
  /** lsof is asked `-iTCP:3000`, ss `sport = :3000`. */
  const portOf = (argv: readonly string[]) => Number((argv.find(arg => /^(?:-iTCP)?:\d+$/.test(arg)) ?? '').split(':')[1])
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') seen.ran.push(e.command)
    return { result: 'ran' }
  })
  on('fs.read', (_$, e) => {
    const text = options.files?.[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', (_$, e) => {
    const result = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [program = ''] = e.argv
    if (program === 'ps') {
      const args = Object.values(listening).find(item => String(item.pid) === e.argv[2])?.args
      return args === undefined ? result(1, '') : result(0, `${args}\n`)
    }
    if (program === 'lsof' || program === 'ss') {
      if (tools === 'none' || (program === 'lsof' && tools === 'ss')) return { deny: `failed to start: ENOENT (${program})` }
      const port = portOf(e.argv)
      seen.probed.push(port)
      const found = listening[port]
      if (found === undefined) return result(1, '')
      return result(0, program === 'lsof' ? `p${found.pid}\nc${found.name}\n` : `LISTEN 0 511 *:${port} *:* users:(("${found.name}",pid=${found.pid},fd=19))\n`)
    }
    return { deny: 'unexpected command' }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const NODE_ON_3000: Listening = { 3000: { pid: 4821, name: 'node', args: 'node /app/server.js --watch' } }
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

test('tells the user and Claude which process holds the port, and still lets the command run', async ($, on) => {
  const seen = machine(on, NODE_ON_3000)
  const result = await bash($, 'next dev')
  expect(seen.ran).toEqual(['next dev'])
  expect(seen.toasts).toEqual(['port 3000 is already in use by node (pid 4821)'])
  expect(result.context?.[0]).toContain("port 3000 (next's port for this command) is already listening: node, pid 4821: node /app/server.js --watch")
  expect(result.context?.[0]).toContain('kill 4821')
})

test('with mods-hub: the busy-port toast is a warning notification, and Claude still gets the note', async ($, on) => {
  const seen = machine(on, NODE_ON_3000)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])

  const result = await bash($, 'next dev')
  expect(seen.ran).toEqual(['next dev'])
  expect(seen.toasts).toEqual([])
  expect(hub.notified).toEqual([{ level: 'warning', title: 'port 3000 is already in use by node (pid 4821)' }])
  expect(result.context?.[0]).toContain('kill 4821')
})

test('reads the commands behind sudo, env and bash -c like the shared shell reader does', () => {
  expect(analyze('sudo -u app env PORT=4000 next dev').servers).toEqual([{ tool: 'next', port: 4000 }])
  expect(analyze('bash -c "next dev -p 4100"').servers).toEqual([{ tool: 'next', port: 4100 }])
  expect(analyze('cd web && PORT=4200 npm run dev').scripts).toEqual([{ name: 'dev', args: [], env: { PORT: '4200' }, directory: 'web' }])
})

test('stays quiet when the port is free, and never probes for commands that start no server', async ($, on) => {
  const seen = machine(on, NODE_ON_3000)
  expect((await bash($, 'vite')).context).toBeUndefined()
  expect(seen.probed).toEqual([5173])
  for (const command of ['npm install', 'git status', 'psql -p 3000 -h localhost app', 'ls -la', 'next build', 'vite build', 'npm test', 'rails console', 'python script.py']) {
    seen.probed.length = 0
    expect((await bash($, command)).context).toBeUndefined()
    expect(seen.probed).toEqual([])
  }
  expect(seen.toasts).toEqual([])
})

test('uses the right port for each tool: defaults, flags and addresses', async ($, on) => {
  const seen = machine(on, {})
  const probed = async (command: string) => {
    seen.probed.length = 0
    await bash($, command)
    return seen.probed
  }
  expect(await probed('npx vite --port 4000')).toEqual([4000])
  expect(await probed('vite preview')).toEqual([4173])
  expect(await probed('next dev -p 3001')).toEqual([3001])
  expect(await probed('next start --port=3002')).toEqual([3002])
  expect(await probed('PORT=4100 react-scripts start')).toEqual([4100])
  expect(await probed('bin/rails s')).toEqual([3000])
  expect(await probed('bundle exec rails server -p 4000 -b 0.0.0.0')).toEqual([4000])
  expect(await probed('python manage.py runserver')).toEqual([8000])
  expect(await probed('python3 manage.py runserver 0.0.0.0:8080')).toEqual([8080])
  expect(await probed('flask run')).toEqual([5000])
  expect(await probed('flask --app app run --port 5050')).toEqual([5050])
  expect(await probed('python -m flask run -p 5051')).toEqual([5051])
  expect(await probed('uvicorn app.main:app --reload')).toEqual([8000])
  expect(await probed('uvicorn app.main:app --host 0.0.0.0 --port 9000')).toEqual([9000])
  expect(await probed('gunicorn -b 0.0.0.0:8081 app:app')).toEqual([8081])
  expect(await probed('python -m http.server')).toEqual([8000])
  expect(await probed('python -m http.server 9001')).toEqual([9001])
  expect(await probed('php artisan serve --port=8001')).toEqual([8001])
  expect(await probed('php -S localhost:8002 -t public')).toEqual([8002])
  expect(await probed('ng serve')).toEqual([4200])
  expect(await probed('astro dev')).toEqual([4321])
  expect(await probed('hugo server')).toEqual([1313])
  expect(await probed('streamlit run app.py --server.port 8600')).toEqual([8600])
  expect(await probed('node server.js --port 4005')).toEqual([4005])
})

test('follows package scripts, with ports given in the script, after "--", or in the environment', async ($, on) => {
  const pkg = JSON.stringify({ scripts: { dev: 'vite', start: 'next start -p 3100', both: 'concurrently "vite --port 5000" "npm:api"', api: 'node server.js', web: 'PORT=3500 next dev', 'dev:all': 'npm run dev' } })
  const seen = machine(on, {}, { files: { '/repo/package.json': pkg, '/repo/web/package.json': JSON.stringify({ scripts: { dev: 'astro dev' } }) } })
  const probed = async (command: string) => {
    seen.probed.length = 0
    await bash($, command)
    return seen.probed
  }
  expect(await probed('npm run dev')).toEqual([5173])
  expect(await probed('npm start')).toEqual([3100])
  expect(await probed('pnpm dev')).toEqual([5173])
  expect(await probed('yarn dev --port 4200')).toEqual([4200])
  expect(await probed('npm run dev -- --port 4100')).toEqual([4100])
  expect(await probed('bun run web')).toEqual([3500])
  expect(await probed('PORT=3600 npm run web')).toEqual([3500])
  expect(await probed('npm run both')).toEqual([5000])
  expect(await probed('npm run dev:all')).toEqual([5173])
  expect(await probed('cd web && npm run dev')).toEqual([4321])
  expect(await probed('pnpm --filter web dev')).toEqual([5173])
  expect(await probed('npm --prefix web run dev -- --port 4300')).toEqual([4300])
  expect(await probed('npm run missing')).toEqual([])
  expect(await probed('npm run api')).toEqual([])
})

test('names every busy port of a command that starts several servers', async ($, on) => {
  const seen = machine(on, { 5000: { pid: 11, name: 'vite' }, 8000: { pid: 22, name: 'python3' } }, { files: { '/repo/package.json': JSON.stringify({ scripts: { dev: 'concurrently "vite --port 5000" "uvicorn app:app"' } }) } })
  const result = await bash($, 'npm run dev')
  expect(seen.toasts).toEqual(['port 5000 is already in use by vite (pid 11)', 'port 8000 is already in use by python3 (pid 22)'])
  expect(result.context).toHaveLength(2)
})

test('falls back to ss when lsof is not installed, and says nothing when neither is', async ($, on) => {
  const withSs = machine(on, NODE_ON_3000, { tools: 'ss' })
  expect((await bash($, 'next dev')).context?.[0]).toContain('port 3000')
  expect(withSs.toasts).toEqual(['port 3000 is already in use by node (pid 4821)'])
})

test('is silent when no tool can look at ports', async ($, on) => {
  const seen = machine(on, NODE_ON_3000, { tools: 'none' })
  const result = await bash($, 'next dev')
  expect(result.context).toBeUndefined()
  expect(seen.ran).toEqual(['next dev'])
  expect(seen.toasts).toEqual([])
})

test('port parsing', () => {
  expect(portIn('4000')).toBe(4000)
  expect(portIn('0.0.0.0:4000')).toBe(4000)
  expect(portIn('[::]:4000')).toBe(4000)
  expect(portIn('tcp://0.0.0.0:4000')).toBe(4000)
  expect(portIn('app:app')).toBeUndefined()
  expect(portIn('70000')).toBeUndefined()
  expect(portIn(undefined)).toBeUndefined()
  expect(analyze('npm run dev -- --port 4100').scripts).toEqual([{ name: 'dev', args: ['--port', '4100'], env: {}, directory: '' }])
})
