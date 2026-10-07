import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findNeverEnding, segmentsOf } from '../hooks/detect'
import { fakeHub } from './hub'

/** The engine under the plugin: every Bash call that reaches it succeeds, and the commands that reached it are kept. */
const engine = (on: On) => {
  const ran: string[] = []
  on('tool.call', (_$, e) => {
    ran.push(String((e as { command?: string }).command))
    return { result: 'ok', text: 'ok' }
  })
  return ran
}

test('denies a watch-mode test run and says what to run instead', async ($, on) => {
  const ran = engine(on)
  mock.env(on, {})

  const result = await $.tool.call({ tool: 'Bash', command: 'npx jest --watch src/app' })

  expect(result.deny).toContain('watch-mode-guard: `npx jest --watch src/app` keeps running until it is stopped')
  expect(result.deny).toContain('Run `jest --ci` (without --watch) so it runs once.')
  expect(result.deny).toContain('run_in_background: true')
  expect(ran).toEqual([])
})

test('denies a dev server and points to run_in_background', async ($, on) => {
  const ran = engine(on)
  mock.env(on, {})

  const result = await $.tool.call({ tool: 'Bash', command: 'cd web && npm run dev -- --port 3001' })

  expect(result.deny).toContain('`npm run dev -- --port 3001`')
  expect(result.deny).toContain('Start it with run_in_background: true and check its output while it runs.')
  expect(ran).toEqual([])
})

test('lets the same command through when it runs in the background', async ($, on) => {
  const ran = engine(on)
  mock.env(on, {})

  const result = await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })

  expect(result.deny).toBeUndefined()
  expect(ran).toEqual(['npm run dev'])
})

test('lets through ordinary commands, one-shot variants and bounded or backgrounded ones', async ($, on) => {
  const ran = engine(on)
  mock.env(on, {})
  const fine = ['npm test', 'npm run build', 'vitest run', 'jest --ci', 'tsc --noEmit', 'tail -n 50 server.log', 'timeout 30 npm run dev', 'npm run dev &', 'docker compose up -d']

  for (const command of fine) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(result.deny).toBeUndefined()
  }
  expect(ran).toEqual(fine)
})

test('vitest watches by default, so it is denied unless it runs once or CI is set', async ($, on) => {
  engine(on)
  mock.env(on, {})

  const bare = await $.tool.call({ tool: 'Bash', command: 'npx vitest src/app.test.ts' })
  const once = await $.tool.call({ tool: 'Bash', command: 'npx vitest run src/app.test.ts' })

  expect(bare.deny).toContain('Run `vitest run` so it runs once and exits.')
  expect(once.deny).toBeUndefined()
})

test('vitest is left alone when CI is set in the environment', async ($, on) => {
  const ran = engine(on)
  mock.env(on, { CI: 'true' })

  const result = await $.tool.call({ tool: 'Bash', command: 'vitest' })

  expect(result.deny).toBeUndefined()
  expect(ran).toEqual(['vitest'])
})

test('the allow option lets matching commands through', { options: { allow: '^npm start$' } }, async ($, on) => {
  const ran = engine(on)
  mock.env(on, {})

  const allowed = await $.tool.call({ tool: 'Bash', command: 'npm start' })
  const other = await $.tool.call({ tool: 'Bash', command: 'npm run dev' })

  expect(allowed.deny).toBeUndefined()
  expect(other.deny).toBeDefined()
  expect(ran).toEqual(['npm start'])
})

const blocked = (command: string, isCi = false) => findNeverEnding(command, isCi)?.command

test('finds the usual watchers and servers', () => {
  const never = [
    'jest --watchAll',
    'npm test -- --watch',
    'yarn test --watchAll',
    'vitest',
    'vitest --watch',
    'tsc -w',
    'tsc --watch --noEmit',
    'nodemon server.js',
    'webpack --watch',
    'webpack serve',
    'rollup -c -w',
    'npm run dev',
    'npm start',
    'npm run serve',
    'pnpm dev',
    'yarn start',
    'bun run dev',
    'npm run test:watch',
    'npm run build:watch',
    'vite',
    'vite --host',
    'vite preview',
    'next dev',
    'npx next start',
    'astro dev',
    'rails s',
    'bundle exec rails server',
    'bin/rails s -p 4000',
    'docker compose up',
    'docker-compose up --build',
    'docker logs -f web',
    'docker compose logs --follow api',
    'kubectl logs -f pod/web',
    'kubectl port-forward svc/web 8080:80',
    'tail -f app.log',
    'tail -F /var/log/syslog',
    'tail -fn 20 app.log',
    'python -m http.server 8000',
    'python3 -m http.server',
    'python manage.py runserver',
    'poetry run flask run',
    'uvicorn app:app --reload',
    'php artisan serve',
    'php -S localhost:8000',
    'cargo watch -x test',
    'dotnet watch run',
    'node --watch index.js',
    'bun --hot index.ts',
    'ping example.com',
    'journalctl -fu nginx',
    'watch -n 1 date',
    'sudo -E npm run dev',
    'NODE_ENV=development npm run dev',
    'npm run build && npm run dev',
  ]
  expect(never.filter(command => blocked(command) === undefined)).toEqual([])
})

test('lets through the one-shot versions of the same tools', () => {
  const fine = [
    'jest --ci',
    'npm test',
    'npm run build',
    'npm run build:dev',
    'npm run lint',
    'yarn install',
    'pnpm install --frozen-lockfile',
    'vitest run',
    'vitest --run',
    'vitest --watch=false',
    'vitest bench',
    'tsc --noEmit',
    'tsc -p tsconfig.build.json',
    'vite build',
    'next build',
    'astro build',
    'rails db:migrate',
    'bundle exec rake',
    'docker compose up -d',
    'docker compose up --detach --build',
    'docker compose up --wait',
    'docker compose logs --tail 100 api',
    'docker logs web',
    'kubectl logs pod/web',
    'kubectl get pods',
    'tail -n 100 app.log',
    'tail app.log',
    'python script.py',
    'python -m pytest',
    'python manage.py migrate',
    'grep runserver README.md',
    'cat watch.log',
    'ping -c 4 example.com',
    'top -b -n 1',
    'journalctl -n 50 --no-pager',
    'node index.js',
    'timeout 30 tail -f app.log',
    'nohup npm run dev > dev.log 2>&1 &',
    'npm run dev & sleep 5 && curl localhost:3000',
    'echo "npm run dev"',
    'git commit -m "add watch mode"',
  ]
  expect(fine.filter(command => blocked(command) !== undefined)).toEqual([])
})

test('names the part of a compound command that never ends, and reads CI from the command', () => {
  expect(blocked('npm ci && npm run build && npm run dev && echo done')).toBe('npm run dev')
  expect(blocked('CI=1 vitest')).toBeUndefined()
  expect(blocked('vitest', true)).toBeUndefined()
  expect(findNeverEnding('docker compose up', false)?.instead).toContain('docker compose up -d')
})

test('segmentsOf splits at connectors outside quotes and marks what is sent to the background', () => {
  expect(segmentsOf(`echo "a && b"; sleep 1 & npm run dev`)).toEqual([
    { words: ['echo', 'a && b'], isBackground: false },
    { words: ['sleep', '1'], isBackground: true },
    { words: ['npm', 'run', 'dev'], isBackground: false },
  ])
  // The shared shell reader sets redirections apart from the words.
  expect(segmentsOf('npm start > out.log 2>&1')).toEqual([{ words: ['npm', 'start'], isBackground: false }])
})

test('regression: explicit one-shot flags, build scripts, help output and look-alikes are not refused', () => {
  const fine = [
    'npm test -- --watchAll=false',
    'jest --watch=false',
    'npm run storybook:build',
    'npm run dev:build',
    'yarn preview:build',
    'vite --help',
    'nodemon --version',
    'next dev --help',
    'docker compose up --help',
    'kubectl get pods -owide',
    'docker compose -f docker-compose.yml logs web',
    'docker compose up --abort-on-container-exit',
    'docker compose up --exit-code-from tests',
    'top -l 1',
    'ping -n 3 example.com',
  ]
  expect(fine.filter(command => blocked(command) !== undefined)).toEqual([])
  expect(blocked('docker compose -f docker-compose.dev.yml up')).toBe('docker compose -f docker-compose.dev.yml up')
  expect(blocked('kubectl -n web logs -f api')).toBe('kubectl -n web logs -f api')
  expect(blocked('kubectl get pods -Aw')).toBe('kubectl get pods -Aw')
})

test('regression: here-document bodies are text, not commands', () => {
  expect(blocked("python3 - <<'EOF'\nimport json\ntop = 5\nwatch = True\nprint(top)\nEOF")).toBeUndefined()
  expect(blocked('cat > NOTES.md <<EOF\n## Dev\nnpm run dev\ntail -f app.log\nEOF\nnpm run build')).toBeUndefined()
  expect(blocked("cat > x <<-'END'\n\tnpm run dev\n\tEND\nnpm run dev")).toBe('npm run dev')
  expect(blocked("cat <<< 'npm run dev'")).toBeUndefined()
  expect(blocked('npm run \\\n  dev')).toBe('npm run dev')
})

test('regression: a Bash call with a short timeout of its own is bounded and let through; a long one is not', async ($, on) => {
  const ran = engine(on)
  mock.env(on, {})

  const short = await $.tool.call({ tool: 'Bash', command: 'npm run dev', timeout: 15_000 })
  const long = await $.tool.call({ tool: 'Bash', command: 'npm run dev', timeout: 600_000 })

  expect(short.deny).toBeUndefined()
  expect(long.deny).toContain('npm run dev')
  expect(ran).toEqual(['npm run dev'])
})

test('regression: a never-ending command inside bash -lc or sh -c is caught', () => {
  expect(blocked('bash -lc "cd web && npm run dev"')).toBe('npm run dev')
  expect(blocked("sh -c 'vitest'")).toBe('vitest')
  expect(blocked('bash -c "npm run dev" &')).toBeUndefined()
  expect(blocked('timeout 60 bash -c "npm run dev"')).toBeUndefined()
  expect(blocked('bash -c "npm run build"')).toBeUndefined()
})

test('the shared shell reader: substitutions, heredocs fed to a shell, groups and pipelines sent to the background', () => {
  expect(blocked('echo "$(npm run dev)"')).toBe('npm run dev')
  expect(blocked('bash <<EOF\ncd web\nnpm run dev\nEOF')).toBe('npm run dev')
  expect(blocked(`su -c 'tail -f /var/log/app.log' app`)).toBe('tail -f /var/log/app.log')
  expect(blocked('(cd web && npm run dev) & sleep 5')).toBeUndefined()
  expect(blocked('npm run dev | tee dev.log &')).toBeUndefined()
  expect(blocked('timeout 30 bash <<EOF\nnpm run dev\nEOF')).toBeUndefined()
  expect(blocked('watch -n 2 kubectl get pods')).toBe('watch kubectl get pods')
})

test('with mods-hub: a refusal is published as risk.blocked', async ($, on) => {
  engine(on)
  mock.env(on, {})
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])
  expect((await $.tool.call({ tool: 'Bash', command: 'cd web && npm run dev' })).deny).toContain('watch-mode-guard')
  expect((await $.tool.call({ tool: 'Bash', command: 'npm run build' })).deny).toBeUndefined()
  expect(hub.published).toEqual([
    {
      topic: 'risk.blocked',
      data: { guard: 'watch-mode-guard', tool: 'Bash', reason: 'never-ending: npm run dev keeps running in the foreground', severity: 'low', command: 'cd web && npm run dev' },
    },
  ])
})
