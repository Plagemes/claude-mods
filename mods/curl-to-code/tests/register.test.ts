import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const run = async ($: Engine, args: string): Promise<string> =>
  (
    await $.command.run({
      command: 'curl2code',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
  ).text ?? ''

/** A project made of `files` (name to content) in /proj. */
const project = (on: On, files: Record<string, string> = {}) => {
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', (_$, e) => ({ value: e.path.startsWith('/proj/') && e.path.slice('/proj/'.length) in files }))
  on('fs.read', (_$, e) => {
    const content = files[e.path.slice('/proj/'.length)]
    return content === undefined ? { deny: 'ENOENT' } : { value: content }
  })
}

const CURL = `curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{"name":"x"}'`

test('registers /curl2code when the session starts', async ($, on) => {
  const registered: string[] = []
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['curl2code'])
})

test('a leading language word picks the generator, and the answer is a fenced block', async ($, on) => {
  project(on)

  const python = await run($, `python ${CURL}`)
  expect(python.startsWith('```python\nimport requests')).toBe(true)
  expect(python).toContain("json={\n        'name': 'x',\n    },")
  expect(python.trimEnd().endsWith('```')).toBe(true)

  const go = await run($, `golang ${CURL}`)
  expect(go.startsWith('```go\npackage main')).toBe(true)

  const axios = await run($, `axios ${CURL}`)
  expect(axios).toContain("import axios from 'axios';")
})

test('with no language it uses fetch', async ($, on) => {
  project(on)

  const text = await run($, CURL)

  expect(text.startsWith('```js\nconst response = await fetch(')).toBe(true)
})

test('with no language it follows the project: go.mod, Python files, axios in package.json', async ($, on) => {
  const files: Record<string, string> = { 'go.mod': 'module x' }
  project(on, files)
  expect(await run($, CURL)).toContain('package main')

  delete files['go.mod']
  files['requirements.txt'] = 'requests'
  expect(await run($, CURL)).toContain('import requests')

  delete files['requirements.txt']
  files['package.json'] = '{ "dependencies": { "axios": "^1.7.0" } }'
  expect(await run($, CURL)).toContain("import axios from 'axios';")

  files['package.json'] = '{ "dependencies": {} }'
  expect(await run($, CURL)).toContain('await fetch(')
})

test('the configured default language beats detection, an explicit one beats both', { options: { defaultLanguage: 'python' } }, async ($, on) => {
  project(on, { 'go.mod': 'module x' })

  expect(await run($, CURL)).toContain('import requests')
  expect(await run($, `go ${CURL}`)).toContain('package main')
})

test('lists what could not be carried over', async ($, on) => {
  project(on)

  const text = await run($, `curl -sS -o out.json -H "Authorization: Bearer $TOKEN" https://api.example.com/me`)

  expect(text).toContain('Not carried over:')
  expect(text).toContain('- ignored: --output out.json')
  expect(text).toContain('- shell variables stay literal text ($TOKEN)')
})

test('explains itself when there is nothing to convert or the curl command is broken', async ($, on) => {
  project(on)

  expect(await run($, '')).toContain('Usage: /curl2code')
  expect(await run($, 'python')).toContain('Usage: /curl2code')
  expect(await run($, `curl 'https://x.io`)).toContain('Could not read the curl command: a \' quote is never closed')
  expect(await run($, 'curl -X POST')).toContain('no URL found')
})
