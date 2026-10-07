import type { EngineInterface, FsEntry, Register } from 'claude-code'

import { adviseColors, adviseSizes } from './advise'
import type { Finding } from './advise'
import { addedLiterals, findColorLiterals, findSizeLiterals } from './literals'
import { mergeTokens, parseColor, parseObjectTokens, parseStyleTokens } from './tokens'
import type { Rgb, Tokens } from './tokens'

const STYLED_FILE = /\.(?:css|scss|sass|less|jsx|tsx|vue|svelte|html?|astro)$/i
const NOT_CHECKED = /(?:\.(?:test|spec|stories)\.|(?:^|\/)node_modules\/|\.d\.ts$)/
const TOKEN_FILE = /^(?:_?(?:tokens?|variables?|vars|theme|colors?|palette|design-tokens|globals?|global)(?:\.[\w-]+)*\.(?:css|scss|sass|less|ts|js|mjs|cjs|json)|tailwind\.config\.(?:js|ts|cjs|mjs))$/i
const TOKEN_LIKE = /\.(?:css|scss|sass|less|ts|js|mjs|cjs|json)$/i
const TOKEN_FOLDERS = new Set(['tokens', 'theme', 'design-tokens'])
const SEARCH_FOLDERS = ['', 'src', 'src/styles', 'styles', 'src/theme', 'theme', 'src/tokens', 'tokens', 'src/styles/tokens', 'styles/tokens', 'app', 'src/app', 'src/assets/styles', 'src/design', 'design', 'src/css', 'css']
const MAX_TOKEN_FILE_BYTES = 200_000
const MAX_FILE_BYTES = 400_000
const CACHE_MS = 60_000
const MIN_COLOR_TOKENS = 2
const MAX_LISTED = 6

type Settings = { allowed: Rgb[]; checkSpacing: boolean; extraFiles: string[] }
/** The tokens found in the project, and the files that define them (these are never checked). */
type Found = { tokens: Tokens; files: Set<string> }
type Cache = { at: number; found: Found | undefined }

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const readSettings = (options: Record<string, unknown>): Settings => ({
  allowed: String(options.allow ?? '#fff,#000').split(',').map(parseColor).filter((color): color is Rgb => color !== undefined),
  checkSpacing: options.checkSpacing === true,
  extraFiles: String(options.tokenFiles ?? '').split(',').map(path => path.trim()).filter(path => path !== ''),
})

const parseTokenFile = (path: string, text: string): Tokens => (/\.(?:css|scss|sass|less)$/i.test(path) ? parseStyleTokens(text) : parseObjectTokens(text, path))

async function discoverTokens($: EngineInterface, settings: Settings): Promise<Found> {
  const root = ((await $.session.repo())?.root ?? (await $.session.cwd())).replace(/\/+$/, '')
  const files = new Set<string>()
  for (const folder of SEARCH_FOLDERS) {
    const path = folder === '' ? root : `${root}/${folder}`
    let entries: FsEntry[]
    try {
      entries = await $.fs.list(path)
    } catch {
      continue
    }
    const isTokenFolder = TOKEN_FOLDERS.has(basename(path))
    for (const entry of entries) {
      const isCandidate = TOKEN_FILE.test(entry.name) || (isTokenFolder && TOKEN_LIKE.test(entry.name))
      if (entry.kind === 'file' && isCandidate && !NOT_CHECKED.test(entry.name) && entry.size <= MAX_TOKEN_FILE_BYTES) files.add(`${path}/${entry.name}`)
    }
  }
  for (const extra of settings.extraFiles) files.add(extra.startsWith('/') ? extra : `${root}/${extra}`)

  const parts: Tokens[] = []
  for (const path of files) {
    try {
      parts.push(parseTokenFile(path, await $.fs.read(path)))
    } catch {
      // A file that cannot be read has no tokens to offer.
    }
  }
  return { tokens: mergeTokens(parts), files }
}

/** The project's tokens, looked up at most once a minute; undefined when it has none worth checking against. */
async function tokensOf($: EngineInterface, cache: Cache, settings: Settings): Promise<Found | undefined> {
  const now = await $.clock.now()
  if (now - cache.at >= CACHE_MS) {
    const found = await discoverTokens($, settings)
    cache.at = now
    cache.found = found.tokens.colors.length >= MIN_COLOR_TOKENS || (settings.checkSpacing && found.tokens.sizes.length > 0) ? found : undefined
  }
  return cache.found
}

async function readCurrent($: EngineInterface, path: string): Promise<string> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' && stat.size <= MAX_FILE_BYTES ? await $.fs.read(path) : ''
  } catch {
    return ''
  }
}

const listOf = (findings: readonly Finding[]): string =>
  [
    ...findings.slice(0, MAX_LISTED).map(finding => `- ${finding.text}${finding.count > 1 ? ` (x${finding.count})` : ''} (line ${finding.line}) -> ${finding.advice}`),
    ...(findings.length > MAX_LISTED ? [`- and ${findings.length - MAX_LISTED} more`] : []),
  ].join('\n')

/** Tells mods-hub what the check found, for mods that listen to `lint.result`; nothing happens without a hub. */
async function publishFindings($: EngineInterface, path: string, errors: number, warnings: number): Promise<void> {
  await hubPublish($, { topic: 'lint.result', data: { tool: 'css-token-guard', errors, warnings, files: [path] } })
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['lint.result'], consumes: [] })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  const settings = readSettings(options)
  const cache: Cache = { at: Number.NEGATIVE_INFINITY, found: undefined }

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const name = basename(e.file_path)
    if (!STYLED_FILE.test(e.file_path) || NOT_CHECKED.test(e.file_path) || TOKEN_FILE.test(name) || e._host !== undefined) return next(e)
    const found = await tokensOf($, cache, settings)
    if (found === undefined || found.files.has(e.file_path)) return next(e)

    const before = e.tool === 'Write' ? await readCurrent($, e.file_path) : e.old_string
    const after = e.tool === 'Write' ? e.content : e.new_string
    const findings = [
      ...(found.tokens.colors.length >= MIN_COLOR_TOKENS ? adviseColors(found.tokens, addedLiterals(findColorLiterals(before), findColorLiterals(after)), settings.allowed) : []),
      ...(settings.checkSpacing ? adviseSizes(found.tokens, addedLiterals(findSizeLiterals(before), findSizeLiterals(after))) : []),
    ]
    if (findings.length === 0) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await publishFindings($, e.file_path, 0, findings.length)
    await hubNotify($, { level: 'info', title: `${findings.length} hard-coded value${findings.length === 1 ? '' : 's'} in ${name}, tokens exist` })
    const note =
      `css-token-guard: this edit to ${e.file_path} hard-codes values that the project's design tokens cover:\n${listOf(findings)}\n` +
      'Use the tokens instead of literals. If a literal is intended, put "token-ok" in a comment on that line.'
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
