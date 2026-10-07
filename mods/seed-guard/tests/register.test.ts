import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'

const REMOTE_ENV = 'DATABASE_URL="postgresql://app:s3cret@db.abcdefgh.supabase.co:5432/postgres?sslmode=require"\n'
const LOCAL_ENV = 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dev\n'

/** Stands in for the engine: files by absolute path, process variables, and a record of the commands that run. */
function engine(on: On, files: Record<string, string> = {}, variables: Record<string, string> = {}) {
  const ran: string[] = []
  mock.env(on, variables)
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: 'ran' }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.root', () => ({ value: '/repo' }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  return ran
}

const DESTRUCTIVE = [
  'npx prisma migrate reset --force',
  'prisma migrate reset',
  'npx prisma db push --force-reset',
  'npx prisma db seed',
  'pnpm exec prisma migrate reset',
  'yarn prisma migrate reset',
  'rails db:reset',
  'bin/rails db:drop',
  'bundle exec rake db:seed',
  'rails db:schema:load',
  'php artisan migrate:fresh --seed',
  'php artisan db:seed',
  'python manage.py flush --no-input',
  'python3 manage.py loaddata fixtures.json',
  'django-admin flush',
  'npx knex seed:run',
  'knex migrate:rollback --all',
  'npx sequelize db:seed:all',
  'npx sequelize-cli db:drop',
  'npx typeorm schema:drop',
  'mix ecto.reset',
  'diesel database reset',
  'dropdb myapp',
  'npm run seed',
  'npm run db:reset',
  'pnpm db:seed',
  'yarn seed:dev',
  'bun run db:drop',
  'cd backend && npx prisma migrate reset',
  'pnpm --filter api db:reset',
  'npm --prefix api run seed',
  'pnpm -F api exec prisma migrate reset',
  'bash -c "npx prisma migrate reset --force"',
  "cd api && sh -lc 'rails db:reset'",
  'npm run reset',
  'npm run drop:db',
]

const HARMLESS = [
  'npx prisma migrate dev',
  'npx prisma migrate deploy',
  'npx prisma generate',
  'npx prisma db push',
  'rails db:migrate',
  'rails server',
  'php artisan migrate',
  'python manage.py runserver',
  'python manage.py migrate',
  'npx knex migrate:latest',
  'npm run dev',
  'npm test',
  'npm install',
  'pnpm build',
  'yarn add left-pad',
  'docker compose exec app rails db:reset',
  'echo "run rails db:reset later"',
  'git commit -m "add seed script"',
  'ls -la',
  'npm run reset-project',
  'npm run reset-cache',
  'yarn fresh-install',
  'bash -c "npm run build"',
]

test('denies seed, reset and drop commands when .env points at a remote database', async ($, on) => {
  const ran = engine(on, { '/repo/.env': REMOTE_ENV, '/repo/backend/.env': REMOTE_ENV })
  for (const command of DESTRUCTIVE) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('seed-guard')
    expect(result.deny).toContain('db.abcdefgh.supabase.co')
    expect(result.deny).toContain('(from /repo')
  }
  expect(ran).toHaveLength(0)
})

test('lets the same commands through when the database is on the own machine', async ($, on) => {
  const ran = engine(on, { '/repo/.env': LOCAL_ENV, '/repo/backend/.env': LOCAL_ENV })
  for (const command of DESTRUCTIVE) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'allowed'}`).toBe(`${command} => allowed`)
  }
  expect(ran).toHaveLength(DESTRUCTIVE.length)
})

test('never touches commands that are not destructive', async ($, on) => {
  const ran = engine(on, { '/repo/.env': REMOTE_ENV })
  for (const command of HARMLESS) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'allowed'}`).toBe(`${command} => allowed`)
  }
  expect(ran).toHaveLength(HARMLESS.length)
})

test('recognises own-machine databases: sockets, files, 127.x, ::1, docker service names, host.docker.internal', async ($, on) => {
  engine(on)
  const allowed = [
    'postgres:///dev',
    'postgresql://u:p@127.0.0.1:5432/dev',
    'postgresql://u:p@[::1]:5432/dev',
    'mysql://root@localhost/dev',
    'postgresql://u:p@db:5432/dev',
    'postgresql://u:p@postgres/dev',
    'postgresql://u:p@host.docker.internal:5432/dev',
    'postgresql:///dev?host=/var/run/postgresql',
    'file:./dev.db',
    'sqlite:///data/app.db',
    './dev.sqlite3',
    'postgresql://u:p%40ss@localhost/dev',
  ]
  for (const url of allowed) {
    const result = await $.tool.call({ tool: 'Bash', command: `DATABASE_URL='${url}' rails db:reset` })
    expect(`${url} => ${result.deny ?? 'allowed'}`).toBe(`${url} => allowed`)
  }
  const remote = [
    'postgresql://u:p@10.0.3.7:5432/prod',
    'postgresql://u:p@localhost.evil.example.com/dev',
    'mongodb+srv://u:p@cluster0.mongodb.net/app',
    'postgresql://u:p@db.example.com,localhost/dev',
    'postgresql://u:p@localhost/dev?host=db.example.com',
  ]
  for (const url of remote) {
    const result = await $.tool.call({ tool: 'Bash', command: `DATABASE_URL='${url}' rails db:reset` })
    expect(`${url} => ${result.deny ?? 'ALLOWED'}`).toContain('seed-guard')
  }
})

test('the command line wins over the process environment, and that over .env', async ($, on) => {
  engine(on, { '/repo/.env': REMOTE_ENV }, { DATABASE_URL: 'postgresql://postgres@localhost/dev' })
  expect((await $.tool.call({ tool: 'Bash', command: 'npx prisma migrate reset' })).deny).toBeUndefined()
  const overridden = await $.tool.call({ tool: 'Bash', command: 'DATABASE_URL=postgresql://u@prod.example.com/app npx prisma migrate reset' })
  expect(overridden.deny).toContain('prod.example.com')
  expect(overridden.deny).toContain('from the command')
  const exported = await $.tool.call({ tool: 'Bash', command: 'export DATABASE_URL=postgresql://u@prod.example.com/app && rails db:drop' })
  expect(exported.deny).toContain('prod.example.com')
})

test('a remote environment from the process is reported as such', async ($, on) => {
  engine(on, {}, { DATABASE_URL: 'postgresql://u:p@rds.amazonaws.com/app' })
  const result = await $.tool.call({ tool: 'Bash', command: 'rails db:seed' })
  expect(result.deny).toContain('from the environment')
})

test('RAILS_ENV=production and friends are refused whatever the database says', async ($, on) => {
  engine(on, { '/repo/.env': LOCAL_ENV })
  const result = await $.tool.call({ tool: 'Bash', command: 'RAILS_ENV=production bin/rails db:seed' })
  expect(result.deny).toContain('RAILS_ENV=production')
  expect((await $.tool.call({ tool: 'Bash', command: 'RAILS_ENV=development bin/rails db:seed' })).deny).toBeUndefined()
})

test('without any DATABASE_URL it allows, unless denyUnknown is on', async ($, on) => {
  engine(on)
  expect((await $.tool.call({ tool: 'Bash', command: 'rails db:reset' })).deny).toBeUndefined()
})

test('denyUnknown refuses when the target cannot be identified', { options: { denyUnknown: true } }, async ($, on) => {
  engine(on, { '/repo/.env': 'DATABASE_URL=${DB_HOST_URL}\n' })
  const result = await $.tool.call({ tool: 'Bash', command: 'rails db:reset' })
  expect(result.deny).toContain('cannot be identified')
})

test('allowHosts adds your own docker-compose service names, with wildcards', { options: { allowHosts: 'devdb,*.dev.internal' } }, async ($, on) => {
  engine(on, { '/repo/.env': 'DATABASE_URL=postgresql://u:p@pg.dev.internal:5432/app\n' })
  expect((await $.tool.call({ tool: 'Bash', command: 'rails db:reset' })).deny).toBeUndefined()
  const other = await $.tool.call({ tool: 'Bash', command: 'DATABASE_URL=postgresql://u:p@postgres/app rails db:reset' })
  expect(other.deny).toContain('"postgres"')
})

test('fails closed when its own check throws on a destructive command, and leaves other commands alone', async ($, on) => {
  const ran: string[] = []
  on('env.get', () => {
    throw new Error('env is unavailable')
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: 'ran' }
  })
  expect((await $.tool.call({ tool: 'Bash', command: 'npx prisma migrate reset' })).deny).toContain('its check failed')
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test' })).deny).toBeUndefined()
  expect(ran).toEqual(['npm test'])
})
