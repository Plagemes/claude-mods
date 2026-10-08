import { test, expect } from 'claude-code/testing'

import { fakeHub } from './hub'

// Built at run time so this file holds nothing a secret scanner would flag.
const fake = (prefix: string, body: string) => prefix + body
const AWS_KEY = fake('AKIA', 'Z7Q3M9XK2P4W8L5N')
const GITHUB_TOKEN = fake('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')
const PEM_HEADER = fake('-----BEGIN RSA PRIV', 'ATE KEY-----')

test('denies a write that contains an AWS key, naming the pattern and the line but not the key', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/config.ts',
    content: `export const region = 'eu-west-1'\nexport const key = '${AWS_KEY}'\n`,
  })
  expect(result.deny).toContain('AWS access key')
  expect(result.deny).toContain('line 2')
  expect(result.deny).not.toContain(AWS_KEY)
})

test('lets clean content through to the tool', async ($, on) => {
  on('tool.call', () => ({ result: 'written' }))
  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/readme.md',
    content: 'Set API_KEY in your environment, e.g. API_KEY="your-key-here".\nconst k = process.env.SERVICE_API_KEY\n',
  })
  expect(result.deny).toBeUndefined()
  expect(result.result).toBe('written')
})

test('scans the new text of an Edit and a NotebookEdit', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const edit = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/ci.yml',
    old_string: 'token: TODO',
    new_string: `token: ${GITHUB_TOKEN}`,
  })
  expect(edit.deny).toContain('GitHub token')

  const notebook = await $.tool.call({
    tool: 'NotebookEdit',
    notebook_path: '/repo/nb.ipynb',
    new_source: `key = """\n${PEM_HEADER}\n"""`,
  })
  expect(notebook.deny).toContain('private key')
})

test('flags a high-entropy *_SECRET assignment but not a placeholder or a variable reference', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const real = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/.env.js',
    content: 'export const APP_SECRET = "9fA3kD82hQzL0pX7vB1mW4nE6tY"',
  })
  expect(real.deny).toContain('high-entropy secret assignment')

  const placeholder = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/.env.js',
    content: 'export const APP_SECRET = "changeme-changeme-changeme"\nconst DB_TOKEN = process.env.DB_TOKEN_VALUE_FROM_VAULT',
  })
  expect(placeholder.deny).toBeUndefined()
})

test('the allowlist regex exempts matching paths', { options: { allowlist: 'fixtures/' } }, async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const fixture = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/test/fixtures/keys.txt',
    content: `AWS_ACCESS_KEY_ID=${AWS_KEY}`,
  })
  expect(fixture.deny).toBeUndefined()

  const source = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/keys.txt',
    content: `AWS_ACCESS_KEY_ID=${AWS_KEY}`,
  })
  expect(source.deny).toContain('AWS access key')
})

test('also scans every edit of a MultiEdit, in builds that have that tool', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  // This build has no MultiEdit tool, so its input is not in the types.
  const multiEdit = {
    tool: 'MultiEdit',
    file_path: '/repo/app.ts',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: `const token = '${GITHUB_TOKEN}'` },
    ],
  } as never
  const result = await $.tool.call(multiEdit)
  expect(result.deny).toContain('GitHub token')
})

test('scans a 200KB identifier-like line without catastrophic backtracking', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const started = Date.now()
  const result = await $.tool.call({ tool: 'Write', file_path: '/repo/blob.txt', content: 'token'.repeat(40_000) })
  expect(result.deny).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(1_000)
})

test('a .env.example full of made-up values is written; a real key format in it is still refused', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const template = [
    'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/myapp',
    'NEXTAUTH_SECRET=generate-with-openssl-rand-base64-32',
    'JWT_SECRET=supersecretkey123456789',
    'SESSION_SECRET=replace_me_with_a_32_char_secret',
    'API_TOKEN=token_goes_here_1234567890',
    'SECRET_KEY=django-insecure-abc123def456ghi789',
  ].join('\n')
  const example = await $.tool.call({ tool: 'Write', file_path: '/repo/.env.example', content: template })
  expect(example.deny).toBeUndefined()

  const leaked = await $.tool.call({ tool: 'Write', file_path: '/repo/.env.example', content: `${template}\nGH_TOKEN=${GITHUB_TOKEN}` })
  expect(leaked.deny).toContain('GitHub token')

  // Outside a template, fill-me-in values pass but a random-looking one does not.
  const env = await $.tool.call({ tool: 'Write', file_path: '/repo/.env', content: 'NEXTAUTH_SECRET=generate-with-openssl-rand-base64-32\nAPP_SECRET="9fA3kD82hQzL0pX7vB1mW4nE6tY"' })
  expect(env.deny).toContain('line 2: high-entropy secret assignment')
})

test('the shared rules: a JWT and a documented example key', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const jwt = fake('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/auth.ts', content: `const t = '${jwt}'` })).deny).toContain('JSON web token')
  const documented = fake('AKIA', 'IOSFODNN7EXAMPLE')
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/docs.ts', content: `// e.g. ${documented}` })).deny).toBeUndefined()
})

test('with mods-hub: a refusal publishes secret.detected per kind and risk.blocked, never the value', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked', 'secret.detected'], consumes: [] }])
  await $.tool.call({ tool: 'Write', file_path: '/repo/config.ts', content: `const a = '${AWS_KEY}'\nconst b = '${GITHUB_TOKEN}'\nconst c = '${AWS_KEY}'` })
  expect(hub.published).toEqual([
    { topic: 'secret.detected', data: { kind: 'aws-key', where: 'edit', action: 'blocked', path: '/repo/config.ts' } },
    { topic: 'secret.detected', data: { kind: 'github-token', where: 'edit', action: 'blocked', path: '/repo/config.ts' } },
    { topic: 'risk.blocked', data: { guard: 'secret-shield', tool: 'Write', reason: 'secret-in-file: AWS access key, GitHub token', severity: 'high', path: '/repo/config.ts' } },
  ])
  expect(JSON.stringify(hub.published)).not.toContain(AWS_KEY)
})
