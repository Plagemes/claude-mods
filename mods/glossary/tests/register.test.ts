import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

const ROOT = '/home/me/shop'

const GLOSSARY_MD = `# Glossary

| Term | Meaning |
| --- | --- |
| Tenant | A customer organisation with its own isolated data. |

- **Widget queue**: The background queue that renders widgets.
- SKU — Stock keeping unit, our product id.

**Ledger**: Append-only table of money movements.

## Bounded Context (BC)
A part of the domain with its own model.

## Billing
- see Ledger

Saga
: A long-running process coordinated by events.
`

type World = { files: Map<string, string>; sent: { text: string; context: readonly string[] }[]; statuses: (string | undefined)[] }

const typed = (command: string, args: string): CommandRunInput => ({
  command,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

/** A project whose files are `files` (paths relative to ROOT); records what each prompt carried. */
function world(on: On, files: Record<string, string>): World {
  const seen: World = { files: new Map(Object.entries(files).map(([path, text]) => [`${ROOT}/${path}`, text])), sent: [], statuses: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.stat', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file', size: text.length, mtimeMs: text.length, isLink: false } }
  })
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('prompt.submit', ($, e) => {
    seen.sent.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, context: e.context }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  mock.store(on)
  return seen
}

async function ask($: Engine, seen: World, text: string): Promise<readonly string[]> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  return seen.sent.at(-1)?.context ?? []
}

test('adds definitions of the terms a prompt uses, from every GLOSSARY.md layout', async ($, on) => {
  const seen = world(on, { 'GLOSSARY.md': GLOSSARY_MD })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const context = await ask($, seen, 'Why do tenants see the widget QUEUE stall when a saga touches the ledger and the BC in skunkworks?')
  expect(context).toHaveLength(1)
  const note = context[0] ?? ''
  expect(note).toContain('- **Tenant**: A customer organisation with its own isolated data.')
  expect(note).toContain('- **Widget queue**: The background queue that renders widgets.')
  expect(note).toContain('- **Ledger**: Append-only table of money movements.')
  expect(note).toContain('- **Bounded Context (BC)**: A part of the domain with its own model.')
  expect(note).toContain('- **Saga**: A long-running process coordinated by events.')
  expect(note).not.toContain('SKU')
  expect(note).not.toContain('Billing')
  expect(seen.statuses.at(-1)).toBe('📖 glossary: 5 terms')
})

test('tells a conversation each term once, and leaves prompts without terms alone', async ($, on) => {
  const seen = world(on, { 'GLOSSARY.md': GLOSSARY_MD })

  expect(await ask($, seen, 'Rename the SKU column')).toHaveLength(1)
  expect(await ask($, seen, 'And the sku index too')).toEqual([])
  expect(await ask($, seen, 'skunkworks project')).toEqual([])
  expect(await ask($, seen, '/define SKU = something')).toEqual([])
  expect(seen.sent.map(one => one.text)).toContain('Rename the SKU column')
})

test('/define adds and overrides terms, /glossary lists and removes them', async ($, on) => {
  const seen = world(on, { 'GLOSSARY.md': GLOSSARY_MD, '.claude/glossary.json': '[{ "term": "Shard", "definition": "A slice of the tenants table." }]' })

  const defined = await $.command.run(typed('define', 'Ledger = The double-entry book of all payments'))
  expect(defined.text).toContain('defined “Ledger”')
  expect((await $.command.run(typed('define', 'ledger'))).text).toBe('📖 Ledger: The double-entry book of all payments')

  const note = (await ask($, seen, 'Check the ledger and the shard'))[0] ?? ''
  expect(note).toContain('**Ledger**: The double-entry book of all payments')
  expect(note).toContain('**Shard**: A slice of the tenants table.')

  const listed = (await $.command.run(typed('glossary', ''))).text ?? ''
  expect(listed).toContain('- Ledger: The double-entry book of all payments (/define)')
  expect(listed).toContain('- Shard: A slice of the tenants table. (.claude/glossary.json)')

  expect((await $.command.run(typed('glossary', 'remove ledger'))).text).toBe('🗑 glossary: removed “Ledger”.')
  expect((await $.command.run(typed('glossary', 'remove Tenant'))).text).toContain('was not added with /define')
  expect((await $.command.run(typed('define', ''))).text).toContain('usage /define')
})

test('repeats definitions when configured, capped per prompt', { options: { repeatDefinitions: true, maxTermsPerPrompt: 1 } }, async ($, on) => {
  const seen = world(on, { '.claude/glossary.json': '{ "terms": { "PR": "pull request", "CI": "continuous integration" } }' })

  const first = await ask($, seen, 'Open a PR once CI is green')
  const second = await ask($, seen, 'Open a PR once CI is green')
  expect(first).toEqual(second)
  expect((first[0] ?? '').match(/^- /gm)).toHaveLength(1)
})

test('works quietly with no glossary at all', async ($, on) => {
  const seen = world(on, {})

  expect(await ask($, seen, 'Hello there')).toEqual([])
  expect((await $.command.run(typed('glossary', ''))).text).toContain('no terms yet')
  expect(seen.statuses).toEqual([])
})
