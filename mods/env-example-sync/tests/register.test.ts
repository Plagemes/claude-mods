import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

import { envReads, isExampleName, isRealEnvFile } from '../hooks/env'

/** Stands in for the engine: a project on a virtual disk, the writes made to it, and the toasts. */
function project(on: On, files: Record<string, string>) {
  const seen = { writes: [] as { path: string; text: string }[], toasts: [] as string[] }
  on('session.root', () => ({ value: '/repo' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    seen.writes.push({ path: e.path, text: e.text })
    files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const EXAMPLE = 'PORT=3000\nDATABASE_URL=postgres://localhost/app\n'

test('appends a newly read variable to .env.example under a marker, and tells Claude and the user', async ($, on) => {
  const seen = project(on, { '/repo/.env.example': EXAMPLE })
  const result = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/stripe.ts',
    old_string: 'const key = ""',
    new_string: 'const key = process.env.STRIPE_SECRET_KEY\nconst hook = process.env["STRIPE_WEBHOOK_SECRET"]',
  })
  expect(seen.writes).toEqual([
    { path: '/repo/.env.example', text: `${EXAMPLE}\n# added by env-example-sync\nSTRIPE_SECRET_KEY=\nSTRIPE_WEBHOOK_SECRET=\n` },
  ])
  expect(seen.toasts).toEqual(['.env.example: added STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET'])
  expect(result.context?.[0]).toContain('added STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET to /repo/.env.example')
})

test('leaves it alone when the variable is already listed (even commented out), ignored, unchanged by the edit or in a test', async ($, on) => {
  const seen = project(on, { '/repo/.env.example': `${EXAMPLE}# SENTRY_DSN=\n` })
  const edit = (new_string: string, file_path = '/repo/src/app.ts', old_string = 'x') => $.tool.call({ tool: 'Edit', file_path, old_string, new_string })
  await edit('const a = process.env.PORT')
  await edit('const a = process.env.SENTRY_DSN')
  await edit('const a = process.env.NODE_ENV + process.env.CI')
  await edit('const a = process.env.NEW_THING', '/repo/src/app.ts', 'const a = process.env.NEW_THING')
  await edit('const a = process.env.NEW_THING', '/repo/src/app.test.ts')
  await edit('// uses process.env.COMMENTED_ONLY')
  await edit('process.env.NEW_THING', '/repo/README.md')
  expect(seen.writes).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('does nothing when the project has no example file, and never touches .env', async ($, on) => {
  const seen = project(on, { '/repo/.env': 'SECRET=1\n' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'process.env.API_KEY' })
  expect(seen.writes).toEqual([])
})

test('finds the nearest example file above the edited file, and falls back to .env.sample', async ($, on) => {
  const seen = project(on, { '/repo/apps/web/.env.sample': 'A=1\n', '/repo/.env.example': 'B=1\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/apps/web/src/lib/db.ts', content: 'export const url = process.env.DATABASE_URL\n' })
  expect(seen.writes.map(write => write.path)).toEqual(['/repo/apps/web/.env.sample'])
  expect(seen.writes[0]?.text).toBe('A=1\n\n# added by env-example-sync\nDATABASE_URL=\n')
})

test('a Write only counts variables the file did not already read', async ($, on) => {
  const seen = project(on, { '/repo/.env.example': EXAMPLE, '/repo/src/db.py': 'import os\nurl = os.environ["DB_URL"]\n' })
  await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/db.py',
    content: 'import os\nurl = os.environ["DB_URL"]\nkey = os.getenv("API_KEY", "x")\nhost = os.environ.get("DB_HOST")\n',
  })
  expect(seen.writes[0]?.text).toContain('API_KEY=\nDB_HOST=\n')
  expect(seen.writes[0]?.text).not.toContain('DB_URL=\n')
})

test('file and ignore are configurable', { options: { file: 'config/.env.dist', ignore: 'LEGACY_FLAG' } }, async ($, on) => {
  const seen = project(on, { '/repo/config/.env.dist': 'A=1\n', '/repo/.env.example': 'B=1\n' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/config/boot.rb', old_string: 'x', new_string: "ENV.fetch('LEGACY_FLAG')\nENV['REDIS_URL']" })
  expect(seen.writes).toEqual([{ path: '/repo/config/.env.dist', text: 'A=1\n\n# added by env-example-sync\nREDIS_URL=\n' }])
})

test('file can only name an example: a real .env falls back to the default names and is never written', { options: { file: '.env' } }, async ($, on) => {
  const seen = project(on, { '/repo/.env': 'SECRET=1\n', '/repo/.env.example': 'B=1\n' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'process.env.API_KEY' })
  expect(seen.writes.map(write => write.path)).toEqual(['/repo/.env.example'])
})

test('reads the variables of every supported language', () => {
  const code = [
    'process.env.A_JS; process.env["B_JS"]; import.meta.env.VITE_C; Bun.env.D_BUN; Deno.env.get("E_DENO")',
    'os.environ["F_PY"]; os.environ.get("G_PY"); os.getenv("H_PY", "d"); environ.get("I_PY")',
    "ENV['J_RB']; ENV.fetch('K_RB', 'x'); env('L_PHP'); getenv('M_PHP'); $_ENV['N_PHP']",
    'os.Getenv("O_GO"); os.LookupEnv("P_GO"); env::var("Q_RS"); System.getenv("R_JAVA")',
    'Environment.GetEnvironmentVariable("S_CS")',
    '// process.env.COMMENT_ONLY',
    'process.env.lowercase; this.env("x")',
  ].join('\n')
  expect(envReads(code)).toEqual([
    'A_JS', 'B_JS', 'VITE_C', 'D_BUN', 'E_DENO', 'F_PY', 'G_PY', 'H_PY', 'I_PY', 'J_RB', 'K_RB', 'L_PHP', 'M_PHP', 'N_PHP',
    'O_GO', 'P_GO', 'Q_RS', 'R_JAVA', 'S_CS',
  ])
})

test('tells real env files from examples', () => {
  for (const real of ['.env', '.env.local', '.env.production', '.env.development.local']) expect(isRealEnvFile(real)).toBe(true)
  for (const example of ['.env.example', '.env.sample', '.env.dist', 'example.env']) expect(isRealEnvFile(example)).toBe(false)
  expect(isExampleName('.env.example')).toBe(true)
  expect(isExampleName('.env')).toBe(false)
  expect(isExampleName('.env.local')).toBe(false)
})
