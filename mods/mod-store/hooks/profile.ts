// Pure helpers for per-project profiles, slimming and settings edits: no `$` here, so every rule is unit-tested.
import type { StoreInstall, StoreMod, StorePlanRow } from '../types'

const DAY_MS = 24 * 60 * 60_000

/** Folders a project walk never enters: dependencies, build output, caches and VCS internals. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', 'env', '__pycache__',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', '.idea', '.vscode', '.gradle', 'Pods', '.terraform',
])

/** Bounds of the project walk: how deep, how many folders listed and how many paths kept. */
export const WALK = { depth: 4, dirs: 300, paths: 5_000 } as const

/** Mods the store never proposes to disable unless the person ticks them. */
export const ALWAYS_KEPT: ReadonlySet<string> = new Set(['mod-store', 'mods-hub'])
const SAFETY_CATEGORIES: ReadonlySet<string> = new Set(['security', 'core'])
const SAFETY_NAME = /(?:guard|shield|jail|sentinel|safety)$/

// ── Globs ───────────────────────────────────────────────────────────────────

/**
 * A catalog glob as a RegExp over `/`-separated paths relative to the project root: `*` and `?` stay inside one
 * folder, `**` crosses folders (`**\/x` also matches `x` at the root), and a glob without `/` names the root only.
 */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? ''
    if (char === '*' && glob[index + 1] === '*') {
      const isFolder = glob[index + 2] === '/'
      source += isFolder ? '(?:.*/)?' : '.*'
      index += isFolder ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** The first path a glob matches, or undefined. Folders are listed with a trailing `/` so `k8s/**` matches `k8s/`. */
export function firstMatch(globs: readonly string[], paths: readonly string[]): string | undefined {
  for (const glob of globs) {
    const pattern = globToRegExp(glob)
    const found = paths.find(path => pattern.test(path) || (path.endsWith('/') && pattern.test(path.slice(0, -1))))
    if (found !== undefined) return found.replace(/\/$/, '')
  }
  return undefined
}

// ── Dependencies ────────────────────────────────────────────────────────────

const DEP_FILE = /(?:^|\/)(?:package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|Gemfile|composer\.json|Cargo\.toml|go\.mod)$/

/** Whether a project path is a manifest the store reads dependencies from. */
export const isDepFile = (path: string): boolean => DEP_FILE.test(path) && !path.includes('node_modules/')

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** A Python requirement's name (`Django>=4` → `django`), normalised the way pip compares names. */
const pythonName = (spec: string): string | undefined => {
  const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1]
  return name === undefined ? undefined : name.toLowerCase().replace(/_/g, '-')
}

/** TOML table keys (`name = ...`) inside the sections whose header `isSection` accepts; a light reader, not a TOML parser. */
function tomlKeys(text: string, isSection: (header: string) => boolean): string[] {
  const names: string[] = []
  let isInside = false
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[+([^\]]+)\]+\s*$/.exec(line)?.[1]
    if (header !== undefined) {
      isInside = isSection(header.trim())
      continue
    }
    const key = isInside ? /^\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=/.exec(line)?.[1] : undefined
    if (key !== undefined) names.push(key.toLowerCase())
  }
  return names
}

/** The dependency names a manifest declares, lower-case; empty when it cannot be read. */
export function parseDeps(path: string, text: string): string[] {
  const file = path.slice(path.lastIndexOf('/') + 1)
  try {
    if (file === 'package.json' || file === 'composer.json') {
      const root = asRecord(JSON.parse(text)) ?? {}
      const fields = file === 'package.json'
        ? ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        : ['require', 'require-dev']
      return fields.flatMap(field => Object.keys(asRecord(root[field]) ?? {})).map(name => name.toLowerCase())
    }
  } catch {
    return []
  }
  if (file.startsWith('requirements')) {
    return text.split(/\r?\n/).filter(line => !/^\s*(?:#|-)/.test(line)).map(pythonName).filter((name): name is string => name !== undefined)
  }
  if (file === 'pyproject.toml') {
    // PEP 621 arrays (`dependencies = ["x>=1"]`, optional groups) and Poetry / PDM tables.
    const quoted = [...text.matchAll(/^\s*"([A-Za-z0-9][^"]*)"\s*,?\s*$/gm)].map(match => pythonName(match[1] ?? ''))
    const inline = [...text.matchAll(/dependencies\s*=\s*\[([^\]]*)\]/g)].flatMap(match =>
      [...(match[1] ?? '').matchAll(/"([^"]+)"/g)].map(item => pythonName(item[1] ?? '')))
    const tables = tomlKeys(text, header => /dependencies/.test(header)).filter(name => name !== 'python')
    return [...quoted, ...inline, ...tables].filter((name): name is string => name !== undefined)
  }
  if (file === 'Pipfile') {
    return tomlKeys(text, header => header === 'packages' || header === 'dev-packages').map(name => name.replace(/_/g, '-'))
  }
  if (file === 'Cargo.toml') {
    return tomlKeys(text, header => /dependencies$/.test(header))
  }
  if (file === 'Gemfile') {
    return [...text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map(match => (match[1] ?? '').toLowerCase())
  }
  // go.mod: `require x v1` and the lines of a `require ( ... )` block.
  return [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v[0-9]/gm)].map(match => (match[1] ?? '').toLowerCase())
}

// ── Transcripts ─────────────────────────────────────────────────────────────

/** What one transcript says about use: last time each slash command and each `mcp__<plugin>__*` tool ran, the prompts typed. */
export type TranscriptUsage = {
  commands: Record<string, number>
  tools: Record<string, number>
  prompts: string[]
  first: number | null
  last: number | null
}

const COMMAND = /<command-name>\/?([A-Za-z0-9][A-Za-z0-9:_-]*)<\/command-name>/g
const MCP_CALL = /"type":"tool_use","id":"[^"]{1,120}","name":"mcp__([A-Za-z0-9._-]+?)__/g
const STAMP = /"timestamp":"([^"]{10,40})"/
const PROMPTS_KEPT = 200
const PROMPT_CHARS = 400

const latest = (into: Record<string, number>, key: string, at: number): void => {
  into[key] = Math.max(into[key] ?? 0, at)
}

/**
 * Reads a `~/.claude/projects/<project>/<session>.jsonl` transcript (or its newest chunk: a first partial line is
 * skipped) line by line. Only user lines are looked at for slash commands and prompts, and only `tool_use` blocks
 * for MCP tools, so a tool's description that mentions `<command-name>` never counts as a use.
 */
export function parseTranscript(text: string, isChunk = false): TranscriptUsage {
  const usage: TranscriptUsage = { commands: {}, tools: {}, prompts: [], first: null, last: null }
  const lines = text.split('\n')
  if (isChunk) lines.shift()
  for (const line of lines) {
    const stamp = STAMP.exec(line)?.[1]
    const at = stamp === undefined ? Number.NaN : Date.parse(stamp)
    if (!Number.isFinite(at)) continue
    usage.first = usage.first === null ? at : Math.min(usage.first, at)
    usage.last = usage.last === null ? at : Math.max(usage.last, at)
    const isUser = line.includes('"type":"user"')
    if (isUser && line.includes('<command-name>')) {
      for (const match of line.matchAll(COMMAND)) latest(usage.commands, (match[1] ?? '').toLowerCase(), at)
    } else if (isUser && usage.prompts.length < PROMPTS_KEPT) {
      const prompt = promptOf(line)
      if (prompt !== undefined) usage.prompts.push(prompt)
    }
    if (line.includes('"tool_use"') && line.includes('mcp__')) {
      for (const match of line.matchAll(MCP_CALL)) latest(usage.tools, match[1] ?? '', at)
    }
  }
  return usage
}

/** A typed prompt's text, lower-case and cut; undefined for tool results and command echoes. */
function promptOf(line: string): string | undefined {
  try {
    const content = asRecord(asRecord(JSON.parse(line))?.message)?.content
    return typeof content === 'string' && !content.startsWith('<')
      ? content.slice(0, PROMPT_CHARS).toLowerCase()
      : undefined
  } catch {
    return undefined
  }
}

/** Folds several transcripts into one usage, keeping the newest time of each command and tool. */
export function mergeUsage(all: readonly TranscriptUsage[]): TranscriptUsage {
  const merged: TranscriptUsage = { commands: {}, tools: {}, prompts: [], first: null, last: null }
  for (const usage of all) {
    for (const [key, at] of Object.entries(usage.commands)) latest(merged.commands, key, at)
    for (const [key, at] of Object.entries(usage.tools)) latest(merged.tools, key, at)
    merged.prompts.push(...usage.prompts.slice(0, Math.max(0, PROMPTS_KEPT - merged.prompts.length)))
    if (usage.first !== null) merged.first = merged.first === null ? usage.first : Math.min(merged.first, usage.first)
    if (usage.last !== null) merged.last = merged.last === null ? usage.last : Math.max(merged.last, usage.last)
  }
  return merged
}

/** The folder Claude Code keeps a project's transcripts in, under `projects/`: its path with every other character a `-`. */
export const projectFolder = (root: string): string => root.replace(/[^A-Za-z0-9]/g, '-')

/** Evidence of one mod's use: when, and what (`/mods`, a tool, a hub event). */
export type Use = { at: number; what: string }

/**
 * Which mod each use belongs to: slash commands through the catalog's command lists (or a `<plugin>:<command>`
 * spelling), tools by their `mcp__<plugin>__` server, hub events by their source.
 */
export function usesByMod(
  mods: readonly StoreMod[],
  usage: Pick<TranscriptUsage, 'commands' | 'tools'>,
  feed: Readonly<Record<string, number>> = {},
): Record<string, Use> {
  const names = new Set(mods.map(mod => mod.name))
  const owner = new Map<string, string>()
  for (const mod of mods) for (const command of mod.commands ?? []) owner.set(command.slice(1).toLowerCase(), mod.name)
  const uses: Record<string, Use> = {}
  const note = (name: string | undefined, at: number, what: string): void => {
    if (name === undefined || !names.has(name)) return
    if ((uses[name]?.at ?? 0) < at) uses[name] = { at, what }
  }
  for (const [command, at] of Object.entries(usage.commands)) {
    const colon = command.indexOf(':')
    note(colon > 0 ? command.slice(0, colon) : owner.get(command), at, `/${colon > 0 ? command.slice(colon + 1) : command}`)
  }
  for (const [server, at] of Object.entries(usage.tools)) note(server, at, 'its tool')
  for (const [source, at] of Object.entries(feed)) note(source.split('@')[0], at, 'hub events')
  return uses
}

// ── Proposals ───────────────────────────────────────────────────────────────

/** Why a mod is kept whatever the evidence says, or undefined: always-on, core, or (for a slim) a safety guard. */
export function protectedReason(mod: StoreMod, isSlim: boolean): string | undefined {
  if (ALWAYS_KEPT.has(mod.name) || mod.signals?.always === true) return 'always on'
  if (mod.category === 'core') return 'core'
  const hasSignals = (mod.signals?.files?.length ?? 0) > 0 || (mod.signals?.deps?.length ?? 0) > 0
  const isSafety = SAFETY_CATEGORIES.has(mod.category) || SAFETY_NAME.test(mod.name)
  // A guard leaves no trace until it fires, so a slim keeps every one; a profile keeps the general guards.
  return isSafety && (isSlim || !hasSignals) ? 'safety guard' : undefined
}

export type ProfileInput = {
  mods: readonly StoreMod[]
  installed: Readonly<Record<string, StoreInstall>>
  /** The project's paths, `/`-separated, folders with a trailing `/`. */
  paths: readonly string[]
  deps: readonly string[]
  /** Uses seen in this project's transcripts. */
  used: Readonly<Record<string, Use>>
  /** The project's recent prompts, lower-case, matched against intents. */
  prompts: readonly string[]
  /** The general mods kept when nothing in the project asks for them (the Essentials pack). */
  essentials: readonly string[]
}

/** How many of the project's prompts must mention an intent before it counts. */
const INTENT_PROMPTS = 2

/** Whether a prompt mentions a phrase as words (`write pr` in "please write pr notes", not in "rewrite projects"). */
export function mentions(prompt: string, phrase: string): boolean {
  const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(prompt)
}

/** The reason a project needs a mod, or undefined. */
function neededBecause(mod: StoreMod, input: ProfileInput, deps: ReadonlySet<string>): string | undefined {
  const found = firstMatch(mod.signals?.files ?? [], input.paths)
  if (found !== undefined) return `found ${found}`
  const dep = mod.signals?.deps?.find(name => deps.has(name))
  if (dep !== undefined) return `uses ${dep}`
  const use = input.used[mod.name]
  if (use !== undefined) return `you ran ${use.what} here`
  const intent = mod.signals?.intents?.find(phrase => input.prompts.filter(prompt => mentions(prompt, phrase)).length >= INTENT_PROMPTS)
  if (intent !== undefined) return `you asked about “${intent}”`
  return input.essentials.includes(mod.name) ? 'Essentials pack' : undefined
}

/** Why a project does not need a mod, in its own terms. */
function idleBecause(mod: StoreMod): string {
  const files = mod.signals?.files ?? []
  const deps = mod.signals?.deps ?? []
  if (files.length > 0) return `no ${files[0]}${files.length > 1 ? ' or similar' : ''} here`
  if (deps.length > 0) return `no ${deps.slice(0, 2).join(' or ')} dependency`
  return 'not used in this project'
}

/** The project profile: every installed mod of the catalog, kept or disabled, with why; nothing is written. */
export function proposeProfile(input: ProfileInput): StorePlanRow[] {
  const deps = new Set(input.deps.map(dep => dep.toLowerCase()))
  return input.mods.flatMap(mod => {
    const install = input.installed[mod.name]
    if (install === undefined) return []
    const guarded = protectedReason(mod, false)
    const needed = guarded ?? neededBecause(mod, input, deps)
    return [{
      name: mod.name,
      keep: needed !== undefined,
      proposed: needed !== undefined,
      isEnabled: install.isEnabled,
      reason: needed ?? idleBecause(mod),
      isProtected: guarded !== undefined,
    }]
  })
}

export type SlimInput = {
  mods: readonly StoreMod[]
  installed: Readonly<Record<string, StoreInstall>>
  uses: Readonly<Record<string, Use>>
  now: number
  days: number
}

/** "today", "1 d ago", "12 d ago". */
export const daysAgo = (now: number, at: number): string => {
  const days = Math.floor(Math.max(0, now - at) / DAY_MS)
  return days === 0 ? 'today' : `${days} d ago`
}

/** Installed, enabled mods unused for `days`: proposed off unless kept for a reason shown with them. */
export function proposeSlim(input: SlimInput): StorePlanRow[] {
  const since = input.now - input.days * DAY_MS
  return input.mods.flatMap(mod => {
    const install = input.installed[mod.name]
    if (install === undefined || !install.isEnabled) return []
    const guarded = protectedReason(mod, true)
    const use = input.uses[mod.name]
    const hasSurface = (mod.commands?.length ?? 0) > 0
    const reason = guarded
      ?? (use !== undefined && use.at >= since ? `used ${use.what} ${daysAgo(input.now, use.at)}` : undefined)
      ?? (install.installedAt !== undefined && install.installedAt >= since ? `installed ${daysAgo(input.now, install.installedAt)}` : undefined)
      ?? (hasSurface ? undefined : 'works in the background: leaves no trace to measure')
    return [{
      name: mod.name,
      keep: reason !== undefined,
      proposed: reason !== undefined,
      isEnabled: true,
      reason: reason ?? `no ${mod.commands?.[0] ?? 'use'} in ${input.days} d`,
      isProtected: guarded !== undefined,
    }]
  })
}

/** The mods a plan changes: those whose `keep` differs from whether they are enabled now. */
export const changesOf = (rows: readonly StorePlanRow[]): StorePlanRow[] => rows.filter(row => row.keep !== row.isEnabled)

// ── settings.local.json ─────────────────────────────────────────────────────

export type SettingsEdit =
  | { isOk: true; text: string; previous: Record<string, boolean | null> }
  | { isOk: false; reason: string }

/**
 * Applies `changes` to a settings file's `enabledPlugins` (`true`/`false` sets the entry, `null` removes it) and
 * returns the new text and each touched entry's previous value (null: absent), for Undo. Every other key and entry
 * is kept as it was. A file that is not a JSON object, or whose `enabledPlugins` is not one, is never overwritten.
 */
export function editEnabledPlugins(current: string | undefined, changes: Readonly<Record<string, boolean | null>>): SettingsEdit {
  let root: Record<string, unknown>
  if (current === undefined || current.trim() === '') {
    root = {}
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(current)
    } catch {
      return { isOk: false, reason: 'it is not valid JSON' }
    }
    const record = asRecord(parsed)
    if (record === undefined) return { isOk: false, reason: 'it is not a JSON object' }
    root = record
  }
  const existing = root.enabledPlugins
  if (existing !== undefined && asRecord(existing) === undefined) {
    return { isOk: false, reason: 'its enabledPlugins is not an object' }
  }
  const plugins: Record<string, unknown> = { ...(asRecord(existing) ?? {}) }
  const previous: Record<string, boolean | null> = {}
  for (const [id, value] of Object.entries(changes)) {
    const before = plugins[id]
    previous[id] = typeof before === 'boolean' ? before : null
    if (value === null) delete plugins[id]
    else plugins[id] = value
  }
  const next: Record<string, unknown> = { ...root }
  if (Object.keys(plugins).length === 0) delete next.enabledPlugins
  else next.enabledPlugins = plugins

  return { isOk: true, text: `${JSON.stringify(next, null, 2)}\n`, previous }
}

/** The entries `/mods profile reset` removes: every one of `marketplace` set to false. */
export function disabledEntries(current: string | undefined, marketplace: string): Record<string, null> {
  let plugins: Record<string, unknown> | undefined
  try {
    plugins = asRecord(asRecord(JSON.parse(current ?? '{}'))?.enabledPlugins)
  } catch {
    plugins = undefined
  }
  return Object.fromEntries(
    Object.entries(plugins ?? {}).filter(([id, value]) => value === false && id.endsWith(`@${marketplace}`)).map(([id]) => [id, null]),
  )
}
