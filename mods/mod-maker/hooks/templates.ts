/** The kinds of mod `/new-mod` scaffolds, each a working example to grow from. */
export const KINDS = ['guard', 'status', 'pane', 'command'] as const
export type Kind = (typeof KINDS)[number]

/** Everything a scaffold is made from. */
export type ModSpec = {
  name: string
  description: string
  kind: Kind
  /** The author's name for plugin.json; omitted when unknown. */
  author?: string
  /** `owner/repo` on GitHub, when the folder is a clone of one. */
  repository?: string
  /** The collection's marketplace name (`.claude-plugin/marketplace.json`), when it has one. */
  marketplace?: string
  /** True inside a collection (a repository with a `mods/` folder). */
  isCollection: boolean
}

/** What `/new-mod` was asked, or why it could not be read. */
export type Parsed =
  | { isOk: true; name: string; description: string; kind: Kind }
  | { isOk: false; reason: string }

export const MAX_NAME = 64
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_DESCRIPTION = 300
const KIND_FLAG = /^--kind(?:=(.*))?$/

/** What each kind's template does, used when no description is given. */
const DEFAULT_DESCRIPTIONS: Record<Kind, (name: string) => string> = {
  guard: () => 'Blocks risky Bash commands before they run.',
  status: () => 'Shows a live count of tool calls in the status line.',
  pane: name => `Lists this session's tool calls in a pane: /${name} opens it.`,
  command: name => `Adds the /${name} command, which counts the words you give it.`,
}

export const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value)

/** Why `name` cannot name a mod, or undefined when it can. */
export function nameProblem(name: string): string | undefined {
  if (name === '') return 'Give the mod a name.'
  if (name.length > MAX_NAME) return `"${name}" is longer than ${MAX_NAME} characters.`
  if (!NAME.test(name)) return `"${name}" is not kebab-case: use lowercase letters, digits and single hyphens, starting with a letter (my-mod).`
  return undefined
}

/** Splits arguments on spaces, keeping "quoted words" together. */
export function tokenize(args: string): string[] {
  const tokens: string[] = []
  for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens
}

/** Reads `<name> [description] [--kind guard|status|pane|command]`; the flag may stand anywhere. */
export function parseArgs(args: string, defaultKind: Kind): Parsed {
  const tokens = tokenize(args.trim())
  let kind: Kind = defaultKind
  const words: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    const flag = KIND_FLAG.exec(token)
    if (flag === null) {
      words.push(token)
      continue
    }
    const value = (flag[1] ?? tokens[(index += 1)] ?? '').toLowerCase()
    if (!isKind(value)) return { isOk: false, reason: `--kind takes ${KINDS.join(', ')}${value === '' ? '' : `, not "${value}"`}.` }
    kind = value
  }
  const [name = '', ...rest] = words
  const problem = nameProblem(name)
  if (problem !== undefined) return { isOk: false, reason: problem }
  const description = rest.join(' ').replace(/\s+/g, ' ').trim()
  if (description.length > MAX_DESCRIPTION) return { isOk: false, reason: `Keep the description under ${MAX_DESCRIPTION} characters.` }

  return { isOk: true, name, kind, description: description === '' ? DEFAULT_DESCRIPTIONS[kind](name) : description }
}

/** `owner/repo` from a GitHub remote URL (https or ssh), or undefined. */
export function githubRepository(remote: string): string | undefined {
  const match = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return match ? `${match[1]}/${match[2]}` : undefined
}

/** The `name` of a `.claude-plugin/marketplace.json`, or undefined when the text is not one. */
export function marketplaceName(text: string): string | undefined {
  try {
    const name: unknown = (JSON.parse(text) as { name?: unknown } | null)?.name
    return typeof name === 'string' && /^[\w.-]+$/.test(name) ? name : undefined
  } catch {
    return undefined
  }
}

export const pascalCase = (name: string): string =>
  name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')

export const titleCase = (name: string): string =>
  name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')

/** `text` as a single-quoted TypeScript string literal. */
export const quote = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** The relative path of the hooks module for a kind (JSX needs .tsx). */
export const moduleFile = (kind: Kind): string => (kind === 'pane' ? 'register.tsx' : 'register.ts')

function manifest(spec: ModSpec): string {
  const github = spec.repository === undefined ? undefined : `https://github.com/${spec.repository}`
  return json({
    name: spec.name,
    version: '1.0.0',
    description: spec.description,
    ...(spec.author === undefined ? {} : { author: { name: spec.author } }),
    ...(github === undefined ? {} : { repository: github }),
    license: 'MIT',
    keywords: ['claude-mods', spec.kind],
    ...(spec.kind === 'pane' ? { types: './types/index.d.ts' } : {}),
    ...(spec.kind === 'status'
      ? {
          userConfig: {
            label: {
              type: 'string',
              title: 'Label',
              description: 'The word shown after the count in the status line.',
              default: 'tool calls',
            },
          },
        }
      : {}),
  })
}

// ── Hooks modules ────────────────────────────────────────────────────────────

const guardModule = (spec: ModSpec): string => `import type { Register } from 'claude-code'

/** A Bash command this guard refuses, and why. */
type Rule = { pattern: RegExp; reason: string }

// TODO: list the commands that must never run in your projects.
const RULES: readonly Rule[] = [
  { pattern: /\\bgit\\s+push\\b.*\\s(?:--force|-f)\\b/, reason: 'a force-push rewrites shared history' },
  { pattern: /\\brm\\s+-[a-z]*r[a-z]*f[a-z]*\\s+\\/(?:\\s|$)/, reason: 'a recursive delete from / wipes the machine' },
]

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const rule = RULES.find(one => one.pattern.test(e.command))
    if (rule === undefined) return next(e)

    return { deny: \`${spec.name} blocked this command: \${rule.reason}.\` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '${spec.name}: the guard failed, so the command was blocked.' }))
}
`

const statusModule = (): string => `import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : 'tool calls'
  let calls = 0

  on('tool.call', async ($, e, next) => {
    calls += 1
    // TODO: show what matters to you: a timer, the git branch, a test verdict…
    $.ui.status(\`\${calls} \${label}\`)

    return next(e)
  })
}
`

const commandModule = (spec: ModSpec): string => `import type { Register } from 'claude-code'

/** How many words a text holds. TODO: replace with what your command does. */
const countWords = (text: string): number => text.split(/\\s+/).filter(word => word !== '').length

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: '${spec.name}',
      description: ${quote(spec.description)},
      argumentHint: '<text>',
    })

    return next(e)
  })

  on('command.run', { command: '${spec.name}' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') return { text: 'Usage: /${spec.name} <text>' }
    const words = countWords(text)

    return { text: \`\${words} \${words === 1 ? 'word' : 'words'}\` }
  })
}
`

const paneModule = (spec: ModSpec): string => {
  const type = `${pascalCase(spec.name)}Call`
  return `import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ${type} } from '../types'

const PANE = '${spec.name}'
const KEPT = 200
const CHROME_ROWS = 3

const calls = atom({ plugin: '${spec.name}', key: 'calls' } as const, [])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: '${spec.name}', description: ${quote(spec.description)} })

    return next(e)
  })

  on('command.run', { command: '${spec.name}' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: ${quote(titleCase(spec.name))} })

    return { text: opened.isPlaced ? 'Opened the pane.' : \`The pane is waiting for room: \${opened.reason}\` }
  })

  // TODO: record what your pane shows. Here: every tool call and whether it failed.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const call: ${type} = { id: e.tool_use_id, tool: e.tool, isError: ran.deny !== undefined || ran.isError === true }
    await update($, calls, list => [...list, call].slice(-KEPT))

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, calls)
    const room = Math.max(1, e.props.scroll.bodyRows - CHROME_ROWS)

    return (
      <Box flexDirection="column">
        <Text bold>{list.length} tool calls this session</Text>
        {list.length === 0 && <Text dimColor>None yet.</Text>}
        {list.slice(-room).map(call => (
          <Box key={\`call:\${call.id}\`}>
            <Text color={call.isError ? 'error' : 'success'}>
              {call.isError ? '✗' : '✓'} {call.tool}
            </Text>
          </Box>
        ))}
        <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )
  })
}
`
}

const paneTypes = (spec: ModSpec): string => `/** One tool call the pane lists. */
export type ${pascalCase(spec.name)}Call = { id: string; tool: string; isError: boolean }

declare module 'claude-code' {
  interface PluginState {
    '${spec.name}': { calls: ${pascalCase(spec.name)}Call[] }
  }
}
`

// ── Tests ────────────────────────────────────────────────────────────────────

const guardTest = (spec: ModSpec): string => `import { expect, test } from 'claude-code/testing'

test('blocks a force-push and lets other commands run', async ($, on) => {
  const ran: string[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const blocked = await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
  expect(blocked.deny).toBe('${spec.name} blocked this command: a force-push rewrites shared history.')

  const allowed = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(allowed.deny).toBeUndefined()
  expect(ran).toEqual(['git push origin main'])
})

test('blocks a recursive delete from the root', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const blocked = await $.tool.call({ tool: 'Bash', command: 'rm -rf /' })
  expect(blocked.deny).toContain('a recursive delete from / wipes the machine')
})
`

const statusTest = (): string => `import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/** Answers tool calls and records every status line the mod shows. */
function engine(on: On): (string | undefined)[] {
  const shown: (string | undefined)[] = []
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('ui.status', ($, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  return shown
}

test('shows the running count of tool calls', async ($, on) => {
  const shown = engine(on)
  await $.tool.call({ tool: 'Bash', command: 'echo one' })
  await $.tool.call({ tool: 'Bash', command: 'echo two' })
  expect(shown).toEqual(['1 tool calls', '2 tool calls'])
})

test('reads its label from userConfig', { options: { label: 'calls' } }, async ($, on) => {
  const shown = engine(on)
  await $.tool.call({ tool: 'Bash', command: 'echo one' })
  expect(shown).toEqual(['1 calls'])
})
`

const commandTest = (spec: ModSpec): string => `import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const run = ($: Engine, args: string) =>
  $.command.run({ command: '${spec.name}', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('registers /${spec.name} and counts the words it is given', async ($, on) => {
  const registered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['${spec.name}'])
  expect((await run($, 'one two  three')).text).toBe('3 words')
  expect((await run($, 'one')).text).toBe('1 word')
})

test('explains its usage when given nothing', async $ => {
  expect((await run($, '  ')).text).toBe('Usage: /${spec.name} <text>')
})
`

const paneTest = (spec: ModSpec): string => `import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PANE: RenderPropsOf['Pane'] = {
  title: ${quote(titleCase(spec.name))},
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

/** Answers what the mod asks of the engine and records the panes it opens and closes. */
function engine(on: On) {
  const panes: string[] = []
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    panes.push(\`open \${e.id}\`)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    panes.push(\`close \${e.id}\`)
    return { value: undefined }
  })
  on('tool.call', ($, e) =>
    e.tool === 'Read' ? { isError: true as const, result: 'File does not exist.' } : { result: { stdout: '', stderr: '', interrupted: false } },
  )
  return panes
}

const open = ($: Engine) =>
  $.command.run({ command: '${spec.name}', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

test('/${spec.name} opens the pane, which lists the tool calls', async ($, on) => {
  const panes = engine(on)
  expect((await open($)).text).toBe('Opened the pane.')
  expect(panes).toEqual(['open ${spec.name}'])

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Read', file_path: '/missing.txt' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: '${spec.name}', surface, component: 'Pane', requestId: '${spec.name}', props: PANE })
    expect(await ui.find({ type: 'Text', text: '2 tool calls this session' })).toBeDefined()
    expect((await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('call:')).map(box => box.text)).toEqual(['✓ Bash', '✗ Read'])
    await ui.unmount()
  }
})

test('Close closes the pane', async ($, on) => {
  const panes = engine(on)
  const ui = await $.ui.mount({ plugin: '${spec.name}', surface: 'terminal', component: 'Pane', requestId: '${spec.name}', props: PANE })
  expect(await ui.find({ type: 'Text', text: 'None yet.' })).toBeDefined()
  await ui.press({ key: 'close' })
  expect(panes).toEqual(['close ${spec.name}'])
})
`

// ── README ───────────────────────────────────────────────────────────────────

const USAGE: Record<Kind, (spec: ModSpec) => string> = {
  guard: spec => `Claude's Bash commands that match a rule are refused before they run, with the reason (\`${spec.name} blocked this command: a force-push rewrites shared history.\`). Everything else runs as usual.`,
  status: () => 'The status line under the prompt counts the tool calls of the session: `12 tool calls`.',
  pane: spec => `\`/${spec.name}\` opens a pane listing this session's tool calls, \`✓\` or \`✗\` each. **Close** (hotkey \`q\`) closes it.`,
  command: spec => `\`/${spec.name} <text>\` answers with the number of words in the text.`,
}

const HOW: Record<Kind, string> = {
  guard: '- Hooks `tool.call` for Bash and answers `{ deny }` for a matching command, without calling `next`.\n- Its `.catch` refuses the command too, so a failing guard never lets one through.',
  status: '- Hooks `tool.call` and calls `$.ui.status` with the running count.\n- The count lives in the module, so a hot reload starts it over.',
  pane: '- Registers its command at `session.start` and opens the pane with `$.ui.open`.\n- Records each tool call in `$.state` from a `tool.call` hook; the `ui.render` hook for the pane draws them, and redraws on every change.',
  command: '- Registers the command at `session.start` with `$.command.register`.\n- Answers it from a `command.run` hook that returns `{ text }`.',
}

function readme(spec: ModSpec): string {
  // `claude plugin install` has no --marketplace option: add the marketplace, then install `<mod>@<marketplace>`.
  const marketplace = spec.marketplace ?? spec.repository?.split('/')[1]
  const install = spec.repository !== undefined && spec.isCollection
    ? `/plugin marketplace add ${spec.repository}\n/plugin install ${spec.name}@${marketplace}`
    : `claude --plugin-dir ${spec.isCollection ? `mods/${spec.name}` : `./${spec.name}`}`
  const configuration = spec.kind === 'status'
    ? '| Key | Type | Default | Description |\n| --- | --- | --- | --- |\n| `label` | string | `tool calls` | The word shown after the count. |'
    : 'No configuration needed.'

  return `# ${spec.name}
> ${spec.description}

**Category:** TODO · **Version:** 1.0.0

## What it does
TODO: two to four sentences: what ${spec.name} does, and when it helps.

## Install
\`\`\`
${install}
\`\`\`

## Usage
${USAGE[spec.kind](spec)}

## Configuration
${configuration}

## How it works
${HOW[spec.kind]}
`
}

/** Every file of a new mod, by its path relative to the mod's folder. */
export function scaffold(spec: ModSpec): Record<string, string> {
  const hooksModule = moduleFile(spec.kind)
  const modules: Record<Kind, () => string> = {
    guard: () => guardModule(spec),
    status: () => statusModule(),
    pane: () => paneModule(spec),
    command: () => commandModule(spec),
  }
  const tests: Record<Kind, () => string> = {
    guard: () => guardTest(spec),
    status: () => statusTest(),
    pane: () => paneTest(spec),
    command: () => commandTest(spec),
  }

  return {
    '.claude-plugin/plugin.json': manifest(spec),
    'hooks/hooks.json': json({ modules: [`./${hooksModule}`] }),
    [`hooks/${hooksModule}`]: modules[spec.kind](),
    ...(spec.kind === 'pane' ? { 'types/index.d.ts': paneTypes(spec) } : {}),
    'tests/register.test.ts': tests[spec.kind](),
    'README.md': readme(spec),
  }
}
