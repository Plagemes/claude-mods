import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { CodebaseMapSaved } from '../types'
import { bodyOf, buildMap, parseMeta } from './map'
import type { MapSource } from './map'

const NAME = 'codebase-map'
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

async function loadSaved($: EngineInterface): Promise<void> {
  try {
    const path = `${await $.session.root()}/${MAP_FILE}`
    if (!(await $.fs.exists(path))) return
    const markdown = await $.fs.read(path)
    const meta = parseMeta(markdown)
    if (meta !== undefined) {
      await update($, mapAtom, () => ({ markdown, ...meta, isTruncated: markdown.includes('cut to fit the size cap') }))
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
    await $.command.register({
      name: 'map',
      description: 'Map this repository (tree, dir counts, key files) and give it to Claude',
      argumentHint: '[show]',
    })
    await loadSaved($)
    return next(e)
  })

  on('command.run', { command: 'map' }, async ($, e) => {
    const mode = e.args.trim().toLowerCase()
    if (mode !== '' && mode !== 'show') {
      return { text: `${NAME}: unknown argument "${mode}". Use /map to rebuild the map or /map show to view it.` }
    }
    const saved = await read($, mapAtom)
    if (mode === 'show' && saved !== null) {
      await openPane($)
      return { text: `${NAME}: showing the saved map, ${describeMap(saved)}.` }
    }
    await openPane($)
    const outcome = await refresh($, settings)
    if ('error' in outcome) return { text: `${NAME}: ${outcome.error}` }
    const cut = outcome.map.isTruncated ? ` Cut to fit ${settings.maxChars} characters (raise maxChars for more).` : ''
    const where = settings.autoInject
      ? 'Claude reads it on every request.'
      : 'Claude has it for this conversation (autoInject is off).'
    return {
      text: `${NAME}: mapped ${describeMap(outcome.map)} → ${MAP_FILE}. ${where}${cut}`,
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
      $.ui.toast(copied.isCopied ? `${NAME}: map copied` : `${NAME}: could not copy (${copied.reason})`)
    }
    const rebuild = async () => {
      const outcome = await refresh($, settings)
      $.ui.toast('error' in outcome ? `${NAME}: ${outcome.error}` : `${NAME}: ${describeMap(outcome.map)}`)
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
  })
}
