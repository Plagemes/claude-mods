import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import type { ComponentCatalogScan } from '../types'
import { catalogSection, componentNameFromPath, describeProps, isComponentFile, parseComponents, searchComponents, similarComponents } from './catalog'
import type { Component } from './catalog'

const PANE = 'components'
const SECTION_ID = 'component-catalog:components'
const DEFAULT_DIRS = 'components, src/components, ui, src/ui, app/components, src/app/components, src/lib/components, lib/components'
const DEFAULT_PROMPT_CHARS = 3000
const MAX_FILES = 1500
const MAX_DIRS = 400
const MAX_DEPTH = 8
const MAX_FILE_BYTES = 256 * 1024
const READ_BATCH = 16
const MAX_SHOWN = 50
const MAX_SIMILAR = 3
const STALE_MS = 60_000
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '__tests__', '__mocks__', '__snapshots__', '.storybook', 'stories',
])

const scanAtom = atom({ plugin: 'component-catalog', key: 'scan' } as const, null)
const scanningAtom = atom({ plugin: 'component-catalog', key: 'isScanning' } as const, false)
const queryAtom = atom({ plugin: 'component-catalog', key: 'query' } as const, '')
const sectionAtom = atom({ plugin: 'component-catalog', key: 'section' } as const, null)

type Settings = { dirs: string[]; promptChars: number; warnSimilar: boolean }

const relativeTo = (root: string, path: string): string | undefined => {
  const base = root.replace(/[\\/]+$/, '')
  if (!path.startsWith(`${base}/`) && !path.startsWith(`${base}\\`)) return undefined
  return path.slice(base.length + 1).replace(/\\/g, '/')
}

const isInDirs = (path: string, dirs: readonly string[]): boolean => dirs.some(dir => path.startsWith(`${dir}/`))

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const describeScan = (scan: ComponentCatalogScan): string => {
  if (scan.dirs.length === 0) return 'no component folders found.'
  const count = `${scan.components.length} component${scan.components.length === 1 ? '' : 's'}`
  return `${count} in ${scan.dirs.join(', ')}${scan.isCut ? ` (stopped at ${MAX_FILES} files)` : ''}.`
}

/** The component files under `dir` (relative to `root`), breadth first, within the walk's caps. */
async function listFiles($: EngineInterface, root: string, dir: string, seen: Set<string>): Promise<{ files: { path: string; size: number }[]; isCut: boolean }> {
  const files: { path: string; size: number }[] = []
  const queue: { path: string; depth: number }[] = [{ path: dir, depth: 0 }]
  let visited = 0
  while (queue.length > 0) {
    if (visited >= MAX_DIRS || seen.size >= MAX_FILES) return { files, isCut: true }
    const current = queue.shift() as { path: string; depth: number }
    visited += 1
    let entries: FsEntry[]
    try {
      entries = await $.fs.list(`${root}/${current.path}`)
    } catch {
      continue
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${current.path}/${entry.name}`
      if (entry.kind === 'dir' && !IGNORED_DIRS.has(entry.name) && current.depth < MAX_DEPTH) queue.push({ path, depth: current.depth + 1 })
      if (entry.kind === 'file' && isComponentFile(entry.name) && entry.size <= MAX_FILE_BYTES && !seen.has(path)) {
        seen.add(path)
        files.push({ path, size: entry.size })
      }
    }
  }
  return { files, isCut: false }
}

async function parseFile($: EngineInterface, root: string, path: string): Promise<Component[]> {
  try {
    return parseComponents(path, await $.fs.read(`${root}/${path}`))
  } catch {
    return []
  }
}

/** Re-reads the component folders and stores what they hold. */
async function scanProject($: EngineInterface, settings: Settings): Promise<ComponentCatalogScan> {
  await update($, scanningAtom, () => true)
  try {
    const root = await $.session.root()
    const dirs: string[] = []
    const seen = new Set<string>()
    const files: string[] = []
    let isCut = false
    for (const dir of settings.dirs) {
      const stat = await $.fs.stat(`${root}/${dir}`).catch(() => undefined)
      if (stat?.kind !== 'dir') continue
      dirs.push(dir)
      const listed = await listFiles($, root, dir, seen)
      files.push(...listed.files.map(file => file.path))
      isCut ||= listed.isCut
    }
    const components: Component[] = []
    for (let i = 0; i < files.length; i += READ_BATCH) {
      const batch = await Promise.all(files.slice(i, i + READ_BATCH).map(path => parseFile($, root, path)))
      components.push(...batch.flat())
    }
    const scan: ComponentCatalogScan = { components, dirs, files: files.length, scannedAt: await $.clock.now(), isCut }
    await update($, scanAtom, () => scan)
    await refreshSection($, settings)
    return scan
  } finally {
    await update($, scanningAtom, () => false)
  }
}

async function scanQuietly($: EngineInterface, settings: Settings): Promise<void> {
  if (await read($, scanningAtom)) return
  try {
    await scanProject($, settings)
  } catch (error) {
    $.ui.log(`component-catalog: scan failed: ${errorText(error)}`, { to: 'debug' })
  }
}

/** Composes the prompt section from the latest scan; called between turns so the prompt cache holds within one. */
async function refreshSection($: EngineInterface, settings: Settings): Promise<void> {
  const scan = await read($, scanAtom)
  const section = scan === null ? null : catalogSection(scan.components, scan.dirs, settings.promptChars)
  if (section !== (await read($, sectionAtom))) await update($, sectionAtom, () => section)
}

/** Re-parses one edited file into the stored scan. */
async function rescanFile($: EngineInterface, root: string, path: string): Promise<void> {
  const found = await parseFile($, root, path)
  await update($, scanAtom, scan =>
    scan === null ? null : { ...scan, components: [...scan.components.filter(component => component.path !== path), ...found] },
  )
}

const similarityNote = (matches: readonly { name: string; path: string; existing: Component }[]): string =>
  [
    'component-catalog: the component you just created looks like one that already exists:',
    ...matches.map(
      ({ name, path, existing }) =>
        `- ${name} (${path}) ≈ ${existing.name} (${existing.path})${existing.purpose === '' ? '' : `: ${existing.purpose}`}` +
        `${existing.props.length === 0 ? '' : ` · props: ${describeProps(existing.props, true)}`}`,
    ),
    'If it serves the same purpose, reuse or extend the existing component (and remove the new file) instead of keeping a duplicate. If it is genuinely different, carry on and make the difference clear in its name.',
  ].join('\n')

async function mention($: EngineInterface, component: Component): Promise<void> {
  const filled = await $.prompt.fill({ text: `the existing ${component.name} component (${component.path}) `, mode: 'insert' })
  if (!filled.isFilled) $.ui.toast('The prompt box is not available right now.')
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    dirs: String(options.componentDirs ?? DEFAULT_DIRS)
      .split(',')
      .map(dir => dir.trim().replace(/^\.\//, '').replace(/[\\/]+$/, ''))
      .filter(Boolean),
    promptChars: Math.max(0, Math.round(Number(options.promptChars ?? DEFAULT_PROMPT_CHARS)) || 0),
    warnSimilar: options.warnSimilar !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'components',
      description: 'Browse the UI components this project already has, with their props',
      argumentHint: '[search | rescan]',
    })
    $.clock.after(0, () => void scanQuietly($, settings))
    return next(e)
  })

  on('command.run', { command: 'components' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg.toLowerCase() === 'rescan') {
      if (await read($, scanningAtom)) return { text: 'A scan is already running.' }
      try {
        return { text: `Rescanned: ${describeScan(await scanProject($, settings))}` }
      } catch (error) {
        return { text: `The scan failed: ${errorText(error)}` }
      }
    }
    await update($, queryAtom, () => arg)
    const opened = await $.ui.open({ id: PANE, title: 'Components', focus: true })
    const scan = await read($, scanAtom)
    if (scan === null || (await $.clock.now()) - scan.scannedAt > STALE_MS) $.clock.after(0, () => void scanQuietly($, settings))
    const shown = opened.isPlaced ? '' : ' Widen the terminal to see the pane.'
    if (scan === null) return { text: `Scanning ${settings.dirs.join(', ')}…${shown}` }
    if (scan.dirs.length === 0) return { text: `No component folders found (looked for ${settings.dirs.join(', ')}). Set componentDirs in the plugin's config.` }
    const matches = arg === '' ? '' : ` ${searchComponents(scan.components, arg).length} match "${arg}".`
    return { text: `${describeScan(scan)}${matches}${shown}` }
  })

  on('turn.start', async ($, e, next) => {
    await refreshSection($, settings)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (settings.promptChars === 0 || e.traits.includes('bare')) return composed
    const section = await read($, sectionAtom)
    if (section === null) return composed
    return { sections: [...composed.sections.filter(one => one.id !== SECTION_ID), { id: SECTION_ID, text: section, scope: 'session' }] }
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const root = await $.session.root()
    const path = relativeTo(root, e.file_path)
    if (path === undefined || !isComponentFile(path)) return next(e)
    const scan = await read($, scanAtom)
    const isNew = e.tool === 'Write' && !(await $.fs.exists(e.file_path).catch(() => true))
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || scan === null) return ran
    if (isInDirs(path, scan.dirs)) await rescanFile($, root, path)
    if (!isNew || !settings.warnSimilar || e.tool !== 'Write') return ran

    const declared = parseComponents(path, e.content).map(component => component.name)
    const fromFile = componentNameFromPath(path)
    const names = declared.length > 0 ? declared : /^[A-Z]/.test(fromFile) ? [fromFile] : []
    const matches = names.flatMap(name =>
      similarComponents(name, path, scan.components)
        .slice(0, MAX_SIMILAR)
        .map(existing => ({ name, path, existing })),
    )
    if (matches.length === 0) return ran
    const first = matches[0] as { name: string; existing: Component }
    $.ui.toast(`${first.name} looks like the existing ${first.existing.name} (${first.existing.path})`)
    return { ...ran, context: [...(ran.context ?? []), similarityNote(matches)] }
  }).catch(($, e, next) => next(e)) // after `next`, this replays its answer: the write never runs twice

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const scan = await read($, scanAtom)
    const isScanning = await read($, scanningAtom)
    const query = await read($, queryAtom)
    const setQuery = (value: string) => void update($, queryAtom, () => value.trim())

    const field = () => {
      if (e.surface === 'mobile') return query === '' ? null : <Text dimColor>{`Search: ${query}`}</Text>
      const { Input } = $.ui.resolve(e)
      return (
        <Input
          key="search"
          placeholder="Filter by name, prop, path or purpose"
          submitLabel="filter"
          value={query}
          autoFocus
          onInput={setQuery}
          onSubmit={setQuery}
        />
      )
    }

    if (scan === null) return <Text dimColor>{isScanning ? 'Scanning component folders…' : 'Run /components to scan.'}</Text>
    const matches = searchComponents(scan.components, query)
    const shown = matches.slice(0, MAX_SHOWN)

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1} flexWrap="wrap">
          <Text bold>Components</Text>
          <Text dimColor wrap="truncate-end">{isScanning ? 'rescanning…' : describeScan(scan)}</Text>
        </Box>
        {scan.dirs.length === 0 ? (
          <Text dimColor>{`No component folders found. Looked for: ${settings.dirs.join(', ')}.`}</Text>
        ) : (
          <Box flexDirection="column">
            {field()}
            <Text dimColor>
              {query === ''
                ? `${scan.components.length} components${matches.length > shown.length ? ` · first ${shown.length} shown` : ''}`
                : `${matches.length} of ${scan.components.length} match "${query}"${matches.length > shown.length ? ` · first ${shown.length} shown` : ''}`}
            </Text>
          </Box>
        )}
        {shown.map(component => (
          <Box key={`c:${component.path}#${component.name}`} flexDirection="column">
            <Box gap={1}>
              <Text bold color="suggestion">{component.name}</Text>
              <Text dimColor wrap="truncate-start">{component.path}</Text>
              <Button
                key={`mention:${component.path}#${component.name}`}
                label="mention"
                plain
                dimColor
                onPress={() => void mention($, component)}
              />
            </Box>
            {component.purpose !== '' && <Text wrap="truncate-end">{component.purpose}</Text>}
            <Text dimColor wrap="truncate-end">
              {component.props.length === 0 ? 'no props found' : `props: ${describeProps(component.props, true)}`}
            </Text>
          </Box>
        ))}
        <Box gap={1}>
          <Button key="rescan" label="Rescan" hotkey="r" onPress={() => void scanQuietly($, settings)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
