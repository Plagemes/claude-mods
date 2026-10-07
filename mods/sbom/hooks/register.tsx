import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SbomReviewItem, SbomView } from '../types'
import { dedupe, ECOSYSTEM_LABELS, FILE_NAMES, FORMAT_LABELS, parseFormat, purlOf, render, summarize } from './formats'
import type { Format } from './formats'
import {
  licenseFromCargoToml,
  licenseFromCratesJson,
  licenseFromMetadata,
  licenseFromPackageJson,
  licenseFromPypiJson,
  licenseFromText,
} from './licenses'
import { parseLockfile } from './lockfiles'
import type { Dependency } from './lockfiles'
import {
  SKIPPED_DIRS,
  distInfoKey,
  escapeGoPath,
  inBatches,
  joinPath,
  licenseFiles,
  pickLockfiles,
  pnpmStorePath,
  projectNameOf,
  relativeTo,
} from './sources'
import type { FoundLockfile } from './sources'

type Settings = { format: Format; outputDir: string; registryLookup: boolean }
/** The last scan's packages, so other formats are written without scanning again. */
type Scan = { root: string; project: string; sources: string[]; dependencies: Dependency[]; notes: string[] }
type Memory = { scan: Scan | undefined; isBusy: boolean }
/** Where each package came from (its lockfile's folder), by package URL. */
type Origins = Map<string, string>
type Budget = { reads: number }

const PANE = 'sbom'
const EMPTY: SbomView = { phase: 'idle', project: '', sources: [], counts: null, written: null, notes: [] }
const FORMATS: readonly Format[] = ['cyclonedx', 'spdx', 'md']
const READ_BATCH = 16
const MAX_LICENSE_READS = 4_000
const MAX_LOOKUPS = 300
const LOOKUP_BATCH = 8
const LOOKUP_TIMEOUT_MS = 8_000
const GIT_TIMEOUT_MS = 10_000
const VENV_DIRS = ['.venv', 'venv', 'env']
const LICENSE_ROWS = 10
const REVIEW_ROWS = 30
const NAME_COLUMNS = 24
const USER_AGENT = 'claude-mods-sbom/1.0.0 (https://github.com/plagemes/claude-mods)'
const LOCKFILE_NAMES = 'package-lock.json, pnpm-lock.yaml, yarn.lock, poetry.lock, uv.lock, requirements*.txt, Cargo.lock, go.mod or go.sum'
const USAGE = 'Usage: /sbom [cyclonedx|spdx|md]: writes sbom.cdx.json (CycloneDX 1.5), sbom.spdx.json (SPDX 2.3) or SBOM.md.'
const CLASS_STYLE: Record<SbomReviewItem['class'], { glyph: string; color: string }> = {
  copyleft: { glyph: '●', color: 'error' },
  'weak copyleft': { glyph: '●', color: 'warning' },
  other: { glyph: '○', color: 'suggestion' },
  unknown: { glyph: '?', color: 'inactive' },
  permissive: { glyph: '✓', color: 'success' },
}

const view = atom({ plugin: 'sbom', key: 'view' } as const, EMPTY)

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function listNames($: EngineInterface, path: string): Promise<{ files: string[]; dirs: string[] }> {
  const entries = await $.fs.list(path).catch(() => [])
  return {
    files: entries.filter(entry => entry.kind === 'file').map(entry => entry.name),
    dirs: entries.filter(entry => entry.kind === 'dir').map(entry => entry.name),
  }
}

/** The git root of the session's folder, else the folder itself. */
async function projectRoot($: EngineInterface): Promise<string> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
    if (top.exitCode === 0 && top.stdout.trim() !== '') return top.stdout.trim()
  } catch {
    // Not a repository, or no git: the session's folder is the project.
  }
  return $.session.cwd()
}

/** Lockfiles at the root and one folder down (monorepo packages), dependency folders skipped. */
async function findLockfiles($: EngineInterface, root: string): Promise<FoundLockfile[]> {
  const top = await listNames($, root)
  const found = pickLockfiles(root, top.files)
  const subdirs = top.dirs.filter(name => !name.startsWith('.') && !SKIPPED_DIRS.has(name))
  for (const name of subdirs) {
    const dir = joinPath(root, name)
    found.push(...pickLockfiles(dir, (await listNames($, dir)).files))
  }
  return found
}

/** Reads and parses every lockfile; a file that cannot be read or parsed becomes a note. */
async function readLockfiles(
  $: EngineInterface,
  root: string,
  files: readonly FoundLockfile[],
  origins: Origins,
  notes: string[],
): Promise<Dependency[]> {
  const all: Dependency[] = []
  for (const file of files) {
    const path = joinPath(file.dir, file.name)
    const label = relativeTo(root, path)
    const text = await readText($, path)
    if (text === undefined) {
      notes.push(`${label}: could not be read (over 4 MB?)`)
      continue
    }
    const manifest = file.kind === 'yarn.lock' ? await readText($, joinPath(file.dir, 'package.json')) : undefined
    try {
      const found = parseLockfile(file.kind, text, { fileName: file.name, manifest })
      for (const dependency of found) if (!origins.has(purlOf(dependency))) origins.set(purlOf(dependency), file.dir)
      all.push(...found)
    } catch (error) {
      notes.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return all
}

/** Licenses from what is installed: node_modules, a virtualenv's METADATA, the cargo registry, the Go module cache. */
async function readInstalledLicenses($: EngineInterface, dependencies: readonly Dependency[], origins: Origins, budget: Budget): Promise<void> {
  const missing = dependencies.filter(dependency => dependency.license === undefined && dependency.version !== '')
  const [cargoSources, goCache] = await Promise.all([cargoRegistrySources($), goModuleCache($)])
  const pythonIndexes = new Map<string, Map<string, string>>()

  await inBatches(missing, READ_BATCH, async dependency => {
    if (budget.reads >= MAX_LICENSE_READS) return
    const dir = origins.get(purlOf(dependency)) ?? '.'
    if (dependency.ecosystem === 'npm') {
      dependency.license = await npmInstalledLicense($, dir, dependency, budget)
    } else if (dependency.ecosystem === 'pypi') {
      let index = pythonIndexes.get(dir)
      if (index === undefined) {
        index = await sitePackagesIndex($, dir)
        pythonIndexes.set(dir, index)
      }
      const folder = index.get(`${dependency.name}@${dependency.version}`)
      if (folder === undefined) return
      budget.reads += 1
      const metadata = await readText($, joinPath(folder, 'METADATA'))
      dependency.license = metadata === undefined ? undefined : licenseFromMetadata(metadata)
    } else if (dependency.ecosystem === 'cargo') {
      for (const source of cargoSources) {
        budget.reads += 1
        const manifest = await readText($, joinPath(source, `${dependency.name}-${dependency.version}`, 'Cargo.toml'))
        if (manifest !== undefined) {
          dependency.license = licenseFromCargoToml(manifest)
          return
        }
      }
    } else if (goCache !== undefined) {
      const folder = joinPath(goCache, `${escapeGoPath(dependency.name)}@${dependency.version}`)
      const [file] = licenseFiles((await listNames($, folder)).files)
      if (file === undefined) return
      budget.reads += 1
      const text = await readText($, joinPath(folder, file))
      dependency.license = text === undefined ? undefined : licenseFromText(text)
    }
  })
}

async function npmInstalledLicense($: EngineInterface, dir: string, dependency: Dependency, budget: Budget): Promise<string | undefined> {
  for (const path of [joinPath(dir, 'node_modules', dependency.name, 'package.json'), pnpmStorePath(dir, dependency.name, dependency.version)]) {
    budget.reads += 1
    const text = await readText($, path)
    if (text === undefined) continue
    const manifest = licenseFromPackageJson(text)
    if (manifest.version === dependency.version) return manifest.license
  }
  return undefined
}

/** `name@version` → dist-info folder, for each virtualenv beside the lockfile. */
async function sitePackagesIndex($: EngineInterface, dir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const venv of VENV_DIRS) {
    const lib = joinPath(dir, venv, 'lib')
    const candidates = [joinPath(dir, venv, 'Lib', 'site-packages')]
    for (const python of (await listNames($, lib)).dirs) candidates.push(joinPath(lib, python, 'site-packages'))
    for (const sitePackages of candidates) {
      for (const folder of (await listNames($, sitePackages)).dirs) {
        const key = distInfoKey(folder)
        if (key !== undefined) index.set(key, joinPath(sitePackages, folder))
      }
    }
  }
  return index
}

async function cargoRegistrySources($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('CARGO_HOME').catch(() => undefined)) ?? (await homeDir($, '.cargo'))
  if (home === undefined) return []
  const src = joinPath(home, 'registry', 'src')
  return (await listNames($, src)).dirs.map(name => joinPath(src, name))
}

async function goModuleCache($: EngineInterface): Promise<string | undefined> {
  const cache = await $.env.get('GOMODCACHE').catch(() => undefined)
  if (cache !== undefined && cache !== '') return cache
  const gopath = (await $.env.get('GOPATH').catch(() => undefined))?.split(/[:;]/)[0]
  if (gopath !== undefined && gopath !== '') return joinPath(gopath, 'pkg', 'mod')
  return homeDir($, 'go/pkg/mod')
}

async function homeDir($: EngineInterface, below: string): Promise<string | undefined> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined))
  return home === undefined || home === '' ? undefined : joinPath(home, below)
}

/**
 * Fetches with a deadline (`$.http.fetch` has none of its own): the body of a 2xx answer, null when the registry
 * answered that it has no such package (4xx), undefined when there was no real answer (offline, timeout, 5xx, 429).
 */
async function fetchText($: EngineInterface, url: string, headers: Record<string, string>): Promise<string | null | undefined> {
  let timer: { cancel: () => void } | undefined
  const deadline = new Promise<undefined>(resolve => {
    timer = $.clock.after(LOOKUP_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const response = await Promise.race([$.http.fetch(url, { headers }), deadline])
    if (response === undefined) return undefined
    if (response.ok) return response.text
    return response.status >= 400 && response.status < 500 && response.status !== 429 ? null : undefined
  } catch {
    return undefined
  } finally {
    timer?.cancel()
  }
}

/** Asks npm, PyPI and crates.io for the licenses still unknown; answers are cached across sessions. */
async function lookUpLicenses($: EngineInterface, dependencies: readonly Dependency[], notes: string[]): Promise<void> {
  const unknown = dependencies.filter(dependency => dependency.license === undefined && dependency.version !== '' && dependency.ecosystem !== 'golang')
  if (unknown.length > MAX_LOOKUPS) notes.push(`Looked up ${MAX_LOOKUPS} of ${unknown.length} unknown licenses online.`)
  await inBatches(unknown.slice(0, MAX_LOOKUPS), LOOKUP_BATCH, async dependency => {
    const key = `license:${purlOf(dependency)}`
    const cached: unknown = await $.store.get(key).catch(() => undefined)
    if (typeof cached === 'string') {
      dependency.license = cached === '' ? undefined : cached
      return
    }
    const { name, version } = dependency
    const text =
      dependency.ecosystem === 'npm'
        ? await fetchText($, `https://registry.npmjs.org/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`, {})
        : dependency.ecosystem === 'pypi'
          ? await fetchText($, `https://pypi.org/pypi/${name}/${encodeURIComponent(version)}/json`, {})
          : await fetchText($, `https://crates.io/api/v1/crates/${name}/${encodeURIComponent(version)}`, { 'User-Agent': USER_AGENT })
    // No answer (offline, a timeout, a 5xx): try again next scan rather than remember "unknown" for good.
    if (text === undefined) return
    const license =
      text === null
        ? undefined
        : dependency.ecosystem === 'npm'
          ? licenseFromPackageJson(text).license
          : dependency.ecosystem === 'pypi'
            ? licenseFromPypiJson(text)
            : licenseFromCratesJson(text)
    dependency.license = license
    await $.store.set(key, license ?? '').catch(() => undefined)
  })
}

async function scan($: EngineInterface, settings: Settings): Promise<Scan> {
  const root = await projectRoot($)
  const notes: string[] = []
  const origins: Origins = new Map()
  const files = await findLockfiles($, root)
  const dependencies = dedupe(await readLockfiles($, root, files, origins, notes))
  const budget: Budget = { reads: 0 }
  await readInstalledLicenses($, dependencies, origins, budget)
  if (budget.reads >= MAX_LICENSE_READS) notes.push(`Stopped reading installed packages after ${MAX_LICENSE_READS} files.`)
  if (settings.registryLookup) await lookUpLicenses($, dependencies, notes)
  const project = projectNameOf(root, await readText($, joinPath(root, 'package.json')))
  return { root, project, sources: files.map(file => relativeTo(root, joinPath(file.dir, file.name))), dependencies, notes }
}

/** Scans (or reuses the last scan), writes the document and fills the pane; answers the line the person is told. */
async function build($: EngineInterface, settings: Settings, memory: Memory, format: Format, isFresh: boolean): Promise<string> {
  if (memory.isBusy) return 'An SBOM is already being built.'
  memory.isBusy = true
  try {
    await update($, view, (current): SbomView => ({ ...current, phase: 'scanning' }))
    const result = isFresh || memory.scan === undefined ? await scan($, settings) : memory.scan
    memory.scan = result
    const counts = summarize(result.dependencies)
    const shown = { ...counts, licenses: counts.licenses.slice(0, LICENSE_ROWS), review: counts.review.slice(0, REVIEW_ROWS) }
    const base = { phase: 'done' as const, project: result.project, sources: result.sources, counts: shown, notes: result.notes }
    if (result.dependencies.length === 0) {
      await update($, view, (): SbomView => ({ ...base, written: null }))
      return `No dependencies found: no ${LOCKFILE_NAMES} under ${result.root}.`
    }

    const path = joinPath(result.root, settings.outputDir, FILE_NAMES[format])
    const timestamp = new Date(await $.clock.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const meta = { project: result.project, timestamp, uuid: crypto.randomUUID(), sources: result.sources }
    await $.fs.write(path, render(format, result.dependencies, meta))
    const written = { label: FORMAT_LABELS[format], path: relativeTo(result.root, path) }
    await update($, view, (): SbomView => ({ ...base, written }))

    const ecosystems = Object.entries(counts.byEcosystem)
      .map(([ecosystem, count]) => `${ECOSYSTEM_LABELS[ecosystem as Dependency['ecosystem']]} ${count}`)
      .join(', ')
    const review = counts.classes.copyleft + counts.classes['weak copyleft']
    return (
      `Wrote ${written.path} (${written.label}): ${counts.total} packages (${ecosystems}), ` +
      `${counts.classes.unknown} without a known license, ${review} copyleft to review.`
    )
  } catch (error) {
    await update($, view, (current): SbomView => ({ ...current, phase: 'done', notes: [...current.notes, String(error)] }))
    return `Could not build the SBOM: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    memory.isBusy = false
  }
}

async function pressBuild($: EngineInterface, settings: Settings, memory: Memory, format: Format, isFresh: boolean): Promise<void> {
  $.ui.toast(await build($, settings, memory, format, isFresh))
}

export const register: Register = (on, options) => {
  const chosen = parseFormat(typeof options.format === 'string' ? options.format : '', 'cyclonedx')
  const settings: Settings = {
    format: chosen ?? 'cyclonedx',
    outputDir: typeof options.outputDir === 'string' ? options.outputDir.trim().replace(/^\.?\/+|\/+$/g, '') : '',
    registryLookup: options.registryLookup === true,
  }
  const memory: Memory = { scan: undefined, isBusy: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sbom',
      description: 'Software bill of materials: every dependency and its license (CycloneDX, SPDX or Markdown)',
      argumentHint: '[cyclonedx|spdx|md]',
    })
    return next(e)
  })

  on('command.run', { command: 'sbom' }, async ($, e) => {
    const format = parseFormat(e.args, settings.format)
    if (format === undefined) return { text: USAGE }
    await $.ui.open({ id: PANE, title: 'SBOM' }).catch(() => undefined)
    return { text: await build($, settings, memory, format, true) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, view)
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
    if (current.phase === 'scanning' || current.counts === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{current.phase === 'scanning' ? '⧗ Reading lockfiles and licenses…' : 'No SBOM yet'}</Text>
          {current.phase !== 'scanning' && <Text dimColor>Run /sbom to list every dependency and its license.</Text>}
          {close}
        </Box>
      )
    }

    const { counts } = current
    const columns = e.props.bodyColumns
    const nameWidth = Math.min(NAME_COLUMNS, Math.max(8, ...counts.licenses.map(([license]) => license.length)))
    const barWidth = Math.max(4, Math.min(30, columns - nameWidth - 8))
    const most = Math.max(1, ...counts.licenses.map(([, count]) => count))
    const ecosystems = Object.entries(counts.byEcosystem)
      .map(([ecosystem, count]) => `${ECOSYSTEM_LABELS[ecosystem as SbomReviewItem['ecosystem']]} ${count}`)
      .join(' · ')
    const classes = (['permissive', 'weak copyleft', 'copyleft', 'other', 'unknown'] as const).filter(kind => counts.classes[kind] > 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="header" flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Text bold>SBOM · {current.project}</Text>
            {current.written !== null && (
              <Text color="success" wrap="truncate-start">
                ✓ {current.written.path}
              </Text>
            )}
          </Box>
          <Text>
            {counts.total} packages{ecosystems === '' ? '' : ` · ${ecosystems}`}
            {counts.dev > 0 ? ` · ${counts.dev} dev-only` : ''}
          </Text>
          <Text dimColor wrap="truncate-end">
            from {current.sources.join(', ') || 'no lockfile'}
          </Text>
        </Box>
        {counts.total > 0 && (
          <Box key="licenses" flexDirection="column">
            <Text bold>Licenses</Text>
            {counts.licenses.map(([license, count]) => (
              <Box key={`license:${license}`} flexDirection="row" gap={1}>
                <Text color={license === 'unknown' ? 'inactive' : undefined} wrap="truncate-end">
                  {license.length > nameWidth ? `${license.slice(0, nameWidth - 1)}…` : license.padEnd(nameWidth)}
                </Text>
                <Text color={license === 'unknown' ? 'inactive' : 'suggestion'}>{'█'.repeat(Math.max(1, Math.round((count / most) * barWidth)))}</Text>
                <Text dimColor>{count}</Text>
              </Box>
            ))}
            <Text dimColor>{classes.map(kind => `${kind} ${counts.classes[kind]}`).join(' · ')}</Text>
          </Box>
        )}
        {counts.review.length > 0 && (
          <Box key="review" flexDirection="column">
            <Text bold>To review: copyleft, unknown or non-SPDX licenses</Text>
            {counts.review.map(item => (
              <Box key={`review:${item.ecosystem}:${item.name}@${item.version}`} flexDirection="row" gap={1}>
                <Text color={CLASS_STYLE[item.class].color}>{CLASS_STYLE[item.class].glyph}</Text>
                <Box flexGrow={1}>
                  <Text wrap="truncate-end">
                    {item.name} {item.version} <Text dimColor>· {ECOSYSTEM_LABELS[item.ecosystem]}</Text>
                  </Text>
                </Box>
                <Text color={CLASS_STYLE[item.class].color}>{item.license ?? 'unknown'}</Text>
              </Box>
            ))}
            {counts.review.length >= REVIEW_ROWS && <Text dimColor>…the full list is in the written document.</Text>}
          </Box>
        )}
        {current.notes.length > 0 && (
          <Box key="notes" flexDirection="column">
            {current.notes.map(note => (
              <Text color="warning" wrap="truncate-end">
                ⚠ {note}
              </Text>
            ))}
          </Box>
        )}
        <Box key="actions" flexDirection="row" gap={1} flexWrap="wrap">
          {counts.total > 0 &&
            FORMATS.map((format, index) => (
              <Button
                key={`write:${format}`}
                label={`Write ${FORMAT_LABELS[format]}`}
                hotkey={String(index + 1)}
                variant={format === settings.format ? 'primary' : undefined}
                onPress={() => void pressBuild($, settings, memory, format, false)}
              />
            ))}
          <Button key="rescan" label="Rescan" hotkey="r" onPress={() => void pressBuild($, settings, memory, settings.format, true)} />
          {close}
        </Box>
      </Box>
    )
  })
}
