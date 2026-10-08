import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { CodebaseMapSaved } from '../types'
import { bodyOf, buildMap, parseMeta } from './map'
import type { MapSource } from './map'
import { paneFailure } from './shared/render-safe'

const PANE = 'codebase-map'
const MAP_FILE = '.claude/codebase-map.md'
const SECTION_ID = 'codebase-map:map'
const GIT_TIMEOUT_MS = 15_000
const WALK_MAX_FILES = 5_000
const WALK_MAX_DIRS = 600
const DEFAULT_DEPTH = 3
const DEFAULT_MAX_CHARS = 6_000
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.venv', 'venv',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.gradle', '.idea', 'obj',
])
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db'])

const mapAtom = atom({ plugin: 'codebase-map', key: 'map' } as const, null)
const busyAtom = atom({ plugin: 'codebase-map', key: 'isBusy' } as const, false)
const errorAtom = atom({ plugin: 'codebase-map', key: 'error' } as const, null)

type Settings = { depth: number; maxChars: number; autoInject: boolean }
type Outcome = { map: CodebaseMapSaved } | { error: string }

const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** An outcome's error is a lowercase clause; as a toast or command answer it starts a sentence. */
const asSentence = (clause: string): string => clause.charAt(0).toUpperCase() + clause.slice(1)

const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repository'

const listWithGit = async ($: EngineInterface, root: string): Promise<string[] | undefined> => {
  try {
    const run = await $.process.run(
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
    )
    const paths = run.stdout.split('\0').filter(Boolean)
    return run.exitCode === 0 && paths.length > 0 ? paths : undefined
  } catch {
    return undefined
  }
}

const listByWalking = async ($: EngineInterface, root: string): Promise<string[]> => {
  const files: string[] = []
  const queue: string[] = ['']
  let visited = 0
  while (queue.length > 0 && visited < WALK_MAX_DIRS && files.length < WALK_MAX_FILES) {
    const dir = queue.shift() ?? ''
    visited += 1
    let entries: FsEntry[]
    try {
      entries = await $.fs.list(dir === '' ? root : `${root}/${dir}`)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.kind === 'dir' && !IGNORED_DIRS.has(entry.name)) queue.push(path)
      if (entry.kind === 'file' && !IGNORED_FILES.has(entry.name)) files.push(path)
    }
  }
  return files.slice(0, WALK_MAX_FILES)
}

const describeMap = (map: CodebaseMapSaved): string =>
  `${map.files} files in ${map.dirs} dirs (${map.source === 'git' ? 'git ls-files' : 'folder walk'})`

const sectionText = (map: CodebaseMapSaved): string =>
  [
    '# Repository map',
    `A compact map of this repository written by /map on ${new Date(map.generatedAt).toISOString().slice(0, 10)}: ` +
      'directories with their file counts, and the key files (entry points, configs, docs). ' +
      'It can be out of date; check a path before relying on it.',
    '',
    bodyOf(map.markdown),
  ].join('\n')

/** The fact `codebase-map.summary` on the hub's blackboard (size, source, when and where the map is saved), for any mod that wants to know; nothing without the hub. */
async function shareSummary($: EngineInterface, map: CodebaseMapSaved): Promise<void> {
  try {
    await $.mods.share({
      name: 'summary',
      value: { files: map.files, dirs: map.dirs, source: map.source, generatedAt: map.generatedAt, file: MAP_FILE, isTruncated: map.isTruncated },
    })
  } catch {
    // No hub: the map file and the pane are all there is.
  }
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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

async function loadSaved($: EngineInterface): Promise<void> {
  try {
    const path = `${await $.session.root()}/${MAP_FILE}`
    if (!(await $.fs.exists(path))) return
    const markdown = await $.fs.read(path)
    const meta = parseMeta(markdown)
    if (meta !== undefined) {
      const saved: CodebaseMapSaved = { markdown, ...meta, isTruncated: markdown.includes('cut to fit the size cap') }
      await update($, mapAtom, () => saved)
      await shareSummary($, saved)
    }
  } catch {
    // No saved map (or unreadable): /map makes one.
  }
}

async function refresh($: EngineInterface, settings: Settings): Promise<Outcome> {
  if (await read($, busyAtom)) return { error: 'a map is already being built.' }
  await update($, busyAtom, () => true)
  await update($, errorAtom, () => null)
  try {
    const root = await $.session.root()
    const fromGit = await listWithGit($, root)
    const source: MapSource = fromGit === undefined ? 'walk' : 'git'
    const paths = fromGit ?? (await listByWalking($, root))
    if (paths.length === 0) {
      const error = 'found no files to map in this folder.'
      await update($, errorAtom, () => error)
      return { error }
    }
    const now = await $.clock.now()
    const built = buildMap(paths, { name: baseName(root), depth: settings.depth, maxChars: settings.maxChars, now, source })
    await $.fs.write(`${root}/${MAP_FILE}`, built.markdown)
    const map: CodebaseMapSaved = {
      markdown: built.markdown,
      files: built.files,
      dirs: built.dirs,
      generatedAt: now,
      source,
      isTruncated: built.isTruncated,
    }
    await update($, mapAtom, () => map)
    await shareSummary($, map)
    return { map }
  } catch (error) {
    const message = `could not build the map: ${errorText(error)}`
    await update($, errorAtom, () => message)
    return { error: message }
  } finally {
    await update($, busyAtom, () => false)
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Codebase map', rows: 24 })
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    depth: clamp(options.depth, 1, 6, DEFAULT_DEPTH),
    maxChars: clamp(options.maxChars, 1_000, 40_000, DEFAULT_MAX_CHARS),
    autoInject: options.autoInject !== false,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'map',
      description: 'Map this repository (tree, dir counts, key files) and give it to Claude',
      argumentHint: '[show]',
    })
    // Waits until session.start has returned (afterStart): with every mod installed, waiting on the hub here ran
    // session.start past its 10 s budget.
    afterStart($, 'codebase-map', async () => {
      await greetHub($)
      await loadSaved($)
    })
    return next(e)
  })

  on('command.run', { command: 'map' }, async ($, e) => {
    const mode = e.args.trim().toLowerCase()
    if (mode !== '' && mode !== 'show') {
      return { text: `Unknown argument "${mode}". Use /map to rebuild the map or /map show to view it.` }
    }
    const saved = await read($, mapAtom)
    if (mode === 'show' && saved !== null) {
      await openPane($)
      return { text: `Showing the saved map, ${describeMap(saved)}.` }
    }
    await openPane($)
    const outcome = await refresh($, settings)
    if ('error' in outcome) return { text: asSentence(outcome.error) }
    const cut = outcome.map.isTruncated ? ` Cut to fit ${settings.maxChars} characters (raise maxChars for more).` : ''
    const where = settings.autoInject
      ? 'Claude reads it on every request.'
      : 'Claude has it for this conversation (autoInject is off).'
    return {
      text: `Mapped ${describeMap(outcome.map)} → ${MAP_FILE}. ${where}${cut}`,
      ...(settings.autoInject ? {} : { context: [sectionText(outcome.map)] }),
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!settings.autoInject || e.traits.includes('bare')) return composed
    const map = await read($, mapAtom)
    if (map === null) return composed
    return { sections: [...composed.sections, { id: SECTION_ID, text: sectionText(map), scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const map = await read($, mapAtom)
    const isBusy = await read($, busyAtom)
    const error = await read($, errorAtom)
    const where = settings.autoInject ? 'Claude reads it on every request' : 'not added to Claude’s prompt (autoInject off)'

    const copy = async (surface: typeof e.surface) => {
      if (map === null) return
      const copied = await $.ui.copy({ text: bodyOf(map.markdown), surface })
      $.ui.toast(copied.isCopied ? 'Map copied' : `Could not copy (${copied.reason})`)
    }
    const rebuild = async () => {
      const outcome = await refresh($, settings)
      $.ui.toast('error' in outcome ? asSentence(outcome.error) : describeMap(outcome.map))
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{map === null ? 'No map yet' : describeMap(map)}</Text>
          <Text dimColor wrap="truncate-end">
            {map === null ? 'Press Refresh (or run /map) to build one.' : `Saved in ${MAP_FILE} · ${where}`}
          </Text>
        </Box>
        <Box gap={1} flexWrap="wrap">
          {!isBusy && <Button key="refresh" label="Refresh" hotkey="r" variant="primary" onPress={() => void rebuild()} />}
          {map !== null && <Button key="copy" label="Copy" hotkey="c" onPress={press => void copy(press.surface)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {isBusy && <Text color="suggestion">Mapping the repository…</Text>}
        {error !== null && <Text color="error">{error}</Text>}
        {map !== null && <Markdown key="map" text={bodyOf(map.markdown)} />}
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'codebase-map', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
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

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
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
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
