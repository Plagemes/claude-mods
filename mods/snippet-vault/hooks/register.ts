import type { EngineInterface, Register } from 'claude-code'

type Snippet = { code: string; lang: string; savedAt: number }
type Vault = Record<string, Snippet>
type Block = { lang: string; code: string }
type Reply = { text: string }

const VAULT_KEY = 'snippets'
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/
const MAX_CODE_LENGTH = 50_000
const MAX_SNIPPETS = 200
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/

const isSnippet = (value: unknown): value is Snippet =>
  typeof value === 'object' && value !== null && typeof (value as Snippet).code === 'string' && typeof (value as Snippet).savedAt === 'number'

const formatDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

// Closes the fence it opened: the same character, at least as many times, nothing else on the line.
const isFenceClose = (line: string, marker: string): boolean => {
  const trimmed = line.trim()
  return trimmed.length >= marker.length && trimmed === marker.charAt(0).repeat(trimmed.length)
}

const lastFencedBlock = (text: string): Block | undefined => {
  let last: Block | undefined
  let open: { marker: string; lang: string; lines: string[] } | undefined
  for (const line of text.split('\n')) {
    if (open === undefined) {
      const opened = FENCE_OPEN.exec(line)
      if (opened?.[1] !== undefined) open = { marker: opened[1], lang: opened[2] ?? '', lines: [] }
    } else if (isFenceClose(line, open.marker)) {
      last = { lang: open.lang, code: open.lines.join('\n') }
      open = undefined
    } else {
      open.lines.push(line)
    }
  }
  return last
}

// Fences the snippet with more backticks than any run inside it, so it pastes back intact.
const fenced = ({ code, lang }: Snippet): string => {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${lang}\n${code}\n${fence}`
}

const readVault = async ($: EngineInterface): Promise<Vault> => {
  const stored = await $.store.get(VAULT_KEY)
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, Snippet] => isSnippet(entry[1])))
}

// What the person selected wins; otherwise the newest fenced block in the assistant's answers.
const findSource = async ($: EngineInterface): Promise<Block | undefined> => {
  const selected = (await $.ui.selection().catch(() => undefined))?.text.trim()
  if (selected !== undefined && selected !== '') return { lang: '', code: selected }

  const messages = await $.session.messages()
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue
    const block = lastFencedBlock(message.text)
    if (block !== undefined) return block
  }
  return undefined
}

/** The snippet saved under `name`; own keys only, so `constructor` is not read off Object.prototype. */
const snippetIn = (vault: Vault, name: string): Snippet | undefined => (Object.hasOwn(vault, name) ? vault[name] : undefined)

const parseName = (args: string): string | undefined => {
  const name = args.trim().toLowerCase()
  return NAME_PATTERN.test(name) ? name : undefined
}

const saveSnippet = async ($: EngineInterface, args: string): Promise<Reply> => {
  const name = parseName(args)
  if (name === undefined) return { text: 'usage: /save-snippet <name> (letters, digits, . _ -, up to 40 characters)' }

  const source = await findSource($)
  if (source === undefined) return { text: 'No code block in the answers so far, and nothing selected.' }
  if (source.code.length > MAX_CODE_LENGTH) return { text: `That is over ${MAX_CODE_LENGTH} characters, too large to keep.` }

  const vault = await readVault($)
  const isNew = snippetIn(vault, name) === undefined
  if (isNew && Object.keys(vault).length >= MAX_SNIPPETS) {
    return { text: `The vault holds ${MAX_SNIPPETS} snippets already; /delete-snippet one first.` }
  }
  await $.store.set(VAULT_KEY, { ...vault, [name]: { ...source, savedAt: await $.clock.now() } })
  const lines = source.code.split('\n').length
  return { text: `📎 snippet ${name} ${isNew ? 'saved' : 'updated'} (${lines} line${lines === 1 ? '' : 's'}${source.lang === '' ? '' : `, ${source.lang}`}).` }
}

const listSnippets = async ($: EngineInterface): Promise<Reply> => {
  const entries = Object.entries(await readVault($)).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return { text: 'No snippets yet. Select code or ask for some, then run /save-snippet <name>.' }

  const rows = entries.map(([name, { code, lang, savedAt }]) => {
    const lines = code.split('\n').length
    return `${name} · ${lang === '' ? 'text' : lang} · ${lines} line${lines === 1 ? '' : 's'} · ${formatDate(savedAt)}`
  })
  return { text: [`📎 Snippets (${entries.length})`, ...rows, 'Put one in your prompt with /snippet <name>.'].join('\n') }
}

const useSnippet = async ($: EngineInterface, args: string): Promise<Reply> => {
  if (args.trim() === '') return listSnippets($)
  const name = parseName(args)
  const vault = await readVault($)
  const snippet = name === undefined ? undefined : snippetIn(vault, name)
  if (name === undefined || snippet === undefined) {
    const known = Object.keys(vault).sort()
    return { text: `No snippet called ${args.trim()}.${known.length === 0 ? '' : ` Saved: ${known.join(', ')}.`}` }
  }

  const { isFilled } = await $.prompt.fill({ text: fenced(snippet), mode: 'insert' })
  return { text: isFilled ? `📎 snippet ${name} is in your prompt.` : 'The prompt box cannot take text right now.' }
}

const deleteSnippet = async ($: EngineInterface, args: string): Promise<Reply> => {
  const name = parseName(args)
  if (name === undefined) return { text: 'usage: /delete-snippet <name>' }

  const vault = await readVault($)
  if (snippetIn(vault, name) === undefined) return { text: `No snippet called ${name}.` }

  await $.store.set(VAULT_KEY, Object.fromEntries(Object.entries(vault).filter(([key]) => key !== name)))
  return { text: `📎 snippet ${name} deleted.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'save-snippet',
      description: 'Save the selected text, or the last code block Claude wrote, as a snippet',
      argumentHint: '<name>',
    })
    await registerCommand($, { name: 'snippet', description: 'Put a saved snippet into the prompt', argumentHint: '<name>' })
    await registerCommand($, { name: 'vault', description: 'List the saved snippets' })
    await registerCommand($, { name: 'delete-snippet', description: 'Delete a saved snippet', argumentHint: '<name>' })
    return next(e)
  })

  on('command.run', { command: 'save-snippet' }, ($, e) => saveSnippet($, e.args))
  on('command.run', { command: 'snippet' }, ($, e) => useSnippet($, e.args))
  on('command.run', { command: 'vault' }, $ => listSnippets($))
  on('command.run', { command: 'delete-snippet' }, ($, e) => deleteSnippet($, e.args))
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}
