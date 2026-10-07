import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findNeverEnding, segmentsOf } from '../hooks/detect'

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
  expect(segmentsOf('npm start > out.log 2>&1')).toEqual([{ words: ['npm', 'start', '>', 'out.log', '2>&1'], isBackground: false }])
})
