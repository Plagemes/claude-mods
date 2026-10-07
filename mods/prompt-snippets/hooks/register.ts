import type { EngineInterface, PluginOptions, Register } from 'claude-code'

type Source = 'built-in' | 'config' | 'custom'
type Snippet = { text: string; source: Source }
type Snippets = Map<string, Snippet>

const BUILT_IN: Record<string, string> = {
  review:
    'Review the changes I have made so far (git diff, staged changes included). Look for bugs, edge cases, missing error handling and unclear naming. List the findings by severity with file and line, and do not change any code yet.',
  tests:
    'Write tests for the code we just changed. Cover the happy path, edge cases and failure modes, follow the test style and tooling already in this repo, then run them and fix any failures.',
  explain:
    'Explain how this code works: its purpose, the main flow, the key data structures and any non-obvious decisions. Keep it concise and point to specific files and functions.',
  refactor:
    'Refactor this code for clarity and maintainability without changing its behaviour: simplify, remove duplication, improve names. Keep the change small and run the existing tests afterwards.',
  docs: 'Document this code: add or update doc comments for the public API and update any README or docs page that mentions it. Describe what and why, not how line by line.',
  perf: 'Look for performance problems in this code: needless work in hot paths, N+1 queries, repeated I/O, avoidable allocations. Measure before changing anything, explain the biggest win first, then apply it.',
  security:
    'Do a security review of this code: input validation, injection, authentication and authorization, secrets handling, unsafe deserialization and risky dependencies. Report concrete findings with file and line, ranked by severity, and propose fixes.',
}

const CUSTOM_KEY = 'custom'
const NAME = /^[a-z][a-z0-9_-]{0,31}$/
/** `:name:` on its own: not part of `a::b`, `10:30:45` or a longer word. */
const TOKEN = /(^|[^\w:]):([A-Za-z][\w-]{0,31}):(?![\w:])/g
/** Code fences and inline code are left alone, so `:review:` in backticks stays literal. */
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/
const PREVIEW_CHARS = 64
/** The prompt origins that are a person typing; plugin and system prompts are never expanded. */
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(text => typeof text === 'string')

const parseConfigured = (raw: PluginOptions[string] | undefined): Record<string, string> | 'invalid' => {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isStringMap(parsed) ? parsed : 'invalid'
  } catch {
    return 'invalid'
  }
}

const readCustom = async ($: EngineInterface): Promise<Record<string, string>> => {
  try {
    const stored = await $.store.get(CUSTOM_KEY)
    return isStringMap(stored) ? stored : {}
  } catch {
    return {}
  }
}

const collect = (target: Snippets, entries: Record<string, string>, source: Source): void => {
  for (const [name, text] of Object.entries(entries)) {
    if (NAME.test(name.toLowerCase()) && text.trim() !== '') {
      target.set(name.toLowerCase(), { text, source })
    }
  }
}

const expand = (text: string, snippets: Snippets): string =>
  text
    .split(CODE_SPAN)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(TOKEN, (whole: string, lead: string, name: string) => {
            const snippet = snippets.get(name.toLowerCase())
            return snippet === undefined ? whole : `${lead}${snippet.text}`
          }),
    )
    .join('')

const preview = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line
}

const load = async (
  $: EngineInterface,
  configured: Record<string, string> | 'invalid',
): Promise<Snippets> => {
  const snippets: Snippets = new Map()
  collect(snippets, BUILT_IN, 'built-in')
  collect(snippets, configured === 'invalid' ? {} : configured, 'config')
  collect(snippets, await readCustom($), 'custom')
  return snippets
}

export const register: Register = (on, options) => {
  const configured = parseConfigured(options.snippets)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'snippets',
      description: 'List the :shortcode: prompt snippets',
    })
    await $.command.register({
      name: 'snippet-add',
      description: 'Save a :shortcode: prompt snippet',
      argumentHint: '<name> <text>',
    })
    await $.command.register({
      name: 'snippet-remove',
      description: 'Remove a snippet you added with /snippet-add',
      argumentHint: '<name>',
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON_ORIGINS.has(e.origin.kind)) {
      return next(e)
    }

    const text = expand(e.text, await load($, configured))

    return next(text === e.text ? e : { ...e, text })
  })

  on('command.run', { command: 'snippets' }, async $ => {
    const snippets = await load($, configured)
    const lines = [...snippets].map(
      ([name, { text, source }]) => `  :${name}:  [${source}]  ${preview(text)}`,
    )
    const warning =
      configured === 'invalid' ? ['', 'The "snippets" setting is not a JSON object of strings and was ignored.'] : []

    return {
      text: ['Snippets (type :name: in a prompt; put it in backticks to keep it literal):', ...lines, ...warning].join('\n'),
    }
  })

  on('command.run', { command: 'snippet-add' }, async ($, e) => {
    const parsed = /^\s*:?([A-Za-z][\w-]{0,31}):?\s+(\S[\s\S]*)$/.exec(e.args)

    if (parsed === null) {
      return { text: 'Usage: /snippet-add <name> <text>   (name: letters, digits, - and _)' }
    }

    const name = (parsed[1] ?? '').toLowerCase()
    const text = (parsed[2] ?? '').trim()
    const known = (await load($, configured)).get(name)
    await $.store.set(CUSTOM_KEY, { ...(await readCustom($)), [name]: text })

    const verb = known?.source === 'custom' ? 'Updated' : known === undefined ? 'Saved' : `Saved (overrides the ${known.source} one)`

    return { text: `${verb} :${name}:. Type :${name}: in a prompt to use it.` }
  })

  on('command.run', { command: 'snippet-remove' }, async ($, e) => {
    const name = e.args.trim().replace(/^:|:$/g, '').toLowerCase()
    const custom = await readCustom($)

    if (!Object.hasOwn(custom, name)) {
      return { text: `:${name}: is not a snippet you added with /snippet-add.` }
    }

    await $.store.set(CUSTOM_KEY, Object.fromEntries(Object.entries(custom).filter(([key]) => key !== name)))

    return { text: `Removed :${name}:.` }
  })
}
