import type { OutdatedKind as Kind, OutdatedManager as Manager, OutdatedPackage as Package } from '../types'

export type { Kind, Manager, Package }

const RISK: Record<Kind, number> = { major: 0, minor: 1, patch: 2 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

// ── Versions ────────────────────────────────────────────────────────────────

/** The numeric release parts of a version (`v1.2.3-rc.1` → [1, 2, 3]), missing parts 0. */
const releaseOf = (version: string): [number, number, number] => {
  const parts = version
    .trim()
    .replace(/^[v=^~]+/, '')
    .split(/[-+]/)[0]
    ?.split('.')
    .map(part => Number.parseInt(part, 10)) ?? []
  const at = (index: number): number => (Number.isFinite(parts[index]) ? (parts[index] as number) : 0)
  return [at(0), at(1), at(2)]
}

/**
 * How risky the jump from `from` to `to` is, by semver: another major is
 * `major`; in 0.x another minor (and in 0.0.x another patch) is too, as
 * caret ranges treat them; otherwise `minor` or `patch`. Undefined when
 * `to` is not newer.
 */
export const classify = (from: string, to: string): Kind | undefined => {
  const [a1, a2, a3] = releaseOf(from)
  const [b1, b2, b3] = releaseOf(to)
  if (compareVersions(to, from) <= 0) return undefined
  if (a1 !== b1) return 'major'
  if (a1 === 0 && a2 !== b2) return 'major'
  if (a1 === 0 && a2 === 0 && a3 !== b3) return 'major'
  if (a2 !== b2) return 'minor'
  return 'patch'
}

/** Orders versions by their numbers, a pre-release before its release. */
export const compareVersions = (a: string, b: string): number => {
  const left = releaseOf(a)
  const right = releaseOf(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] as number) - (right[i] as number)
    if (diff !== 0) return diff
  }
  const pre = (version: string): string => version.replace(/^[v=^~]+/, '').split('+')[0]?.split('-').slice(1).join('-') ?? ''
  const [preA, preB] = [pre(a), pre(b)]
  if (preA === preB) return 0
  if (preA === '') return 1
  if (preB === '') return -1
  return preA.localeCompare(preB, undefined, { numeric: true })
}

/** A row from what a tool reported: the jump to latest, and the best jump short of a major one. */
const rowOf = (manager: Manager, name: string, current: string, latest: string, wanted?: string, extra: Partial<Package> = {}): Package | undefined => {
  const kind = classify(current, latest)
  const wantedKind = wanted === undefined ? undefined : classify(current, wanted)
  if (kind === undefined && wantedKind === undefined) return extra.deprecated === undefined ? undefined : { manager, name, current, latest, kind: 'patch', ...extra }
  const safe = wanted !== undefined && wantedKind !== undefined && wantedKind !== 'major' ? { version: wanted, kind: wantedKind } : kind !== undefined && kind !== 'major' ? { version: latest, kind } : undefined
  return { manager, name, current, latest, kind: kind ?? wantedKind ?? 'patch', ...(safe === undefined ? {} : { safe }), ...extra }
}

const parseJson = (text: string): unknown => {
  const start = text.search(/[[{]/)
  if (start === -1) return {}
  return JSON.parse(text.slice(start))
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/** `npm outdated --json --long`: an object by package; `type` says dev. A package missing `current` is not installed and is skipped. */
export const parseNpmOutdated = (text: string): Package[] => {
  const report = parseJson(text)
  if (!isRecord(report)) return []
  if (isRecord(report.error)) throw new Error(str(report.error.summary) ?? 'npm outdated failed')
  return Object.entries(report).flatMap(([name, entry]) => {
    const info = Array.isArray(entry) ? entry[0] : entry
    if (!isRecord(info)) return []
    const current = str(info.current)
    const latest = str(info.latest)
    if (current === undefined || latest === undefined) return []
    const row = rowOf('npm', name, current, latest, str(info.wanted), { isDev: info.type === 'devDependencies', isDirect: true })
    return row === undefined ? [] : [row]
  })
}

/** `pnpm outdated --format json`: like npm's, with `dependencyType` and `isDeprecated`; older pnpm writes a list. */
export const parsePnpmOutdated = (text: string): Package[] => {
  const report = parseJson(text)
  const entries: [string, unknown][] = Array.isArray(report)
    ? report.filter(isRecord).map(item => [str(item.packageName) ?? str(item.name) ?? '?', item])
    : isRecord(report)
      ? Object.entries(report)
      : []
  return entries.flatMap(([name, info]) => {
    if (!isRecord(info)) return []
    const current = str(info.current)
    const latest = str(info.latest) ?? (isRecord(info.latestManifest) ? str(info.latestManifest.version) : undefined)
    if (current === undefined || latest === undefined) return []
    const extra: Partial<Package> = {
      isDev: info.dependencyType === 'devDependencies',
      isDirect: true,
      ...(info.isDeprecated === true ? { deprecated: 'deprecated on the registry' } : {}),
    }
    const row = rowOf('pnpm', name, current, latest, str(info.wanted), extra)
    return row === undefined ? [] : [row]
  })
}

/** `yarn outdated --json` (Yarn 1): one `table` line with a head and a body of rows. */
export const parseYarnOutdated = (text: string): Package[] => {
  for (const line of text.split(/\r?\n/)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed) || parsed.type !== 'table' || !isRecord(parsed.data)) continue
    const head = Array.isArray(parsed.data.head) ? parsed.data.head.map(String) : []
    const body = Array.isArray(parsed.data.body) ? parsed.data.body.filter(Array.isArray) : []
    const column = (row: unknown[], name: string): string | undefined => str(row[head.indexOf(name)])
    return body.flatMap(row => {
      const name = column(row, 'Package')
      const current = column(row, 'Current')
      const latest = column(row, 'Latest')
      if (name === undefined || current === undefined || latest === undefined || current === 'exotic') return []
      const result = rowOf('yarn', name, current, latest, column(row, 'Wanted'), { isDev: column(row, 'Package Type') === 'devDependencies', isDirect: true })
      return result === undefined ? [] : [result]
    })
  }
  return []
}

/** `pip list --outdated --format=json` (and `uv pip list --outdated --format json`): every installed package, direct or not. */
export const parsePipOutdated = (text: string, direct?: ReadonlySet<string>): Package[] => {
  const report = parseJson(text)
  if (!Array.isArray(report)) return []
  return report.filter(isRecord).flatMap(item => {
    const name = str(item.name)
    const current = str(item.version)
    const latest = str(item.latest_version)
    if (name === undefined || current === undefined || latest === undefined) return []
    const isDirect = direct === undefined || direct.size === 0 ? undefined : direct.has(normalizePythonName(name))
    const row = rowOf('pip', name, current, latest, undefined, isDirect === undefined ? {} : { isDirect })
    return row === undefined ? [] : [row]
  })
}

/** `cargo outdated --root-deps-only --format json`: `project`, `compat` (semver-compatible, `---` for none) and `latest`. */
export const parseCargoOutdated = (text: string): Package[] => {
  const report = parseJson(text)
  if (!isRecord(report) || !Array.isArray(report.dependencies)) return []
  return report.dependencies.filter(isRecord).flatMap(item => {
    const name = str(item.name)
    const current = str(item.project)
    const latest = str(item.latest)
    if (name === undefined || current === undefined || latest === undefined || name.includes('->') || !/^\d/.test(latest)) return []
    const compat = str(item.compat)
    const row = rowOf('cargo', name, current, latest, compat !== undefined && /^\d/.test(compat) ? compat : undefined, {
      isDev: item.kind === 'Development',
      isDirect: true,
    })
    return row === undefined ? [] : [row]
  })
}

/** The JSON values of a stream of concatenated objects (what `go list -json` writes). */
export const jsonStream = (text: string): unknown[] => {
  const values: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        values.push(JSON.parse(text.slice(start, i + 1)))
        start = -1
      }
    }
  }
  return values
}

/** `go list -u -m -json all`: modules with an `Update`; the main module is skipped, indirect ones flagged. */
export const parseGoList = (text: string): Package[] =>
  jsonStream(text)
    .filter(isRecord)
    .flatMap(module => {
      const name = str(module.Path)
      const current = str(module.Version)
      const update = isRecord(module.Update) ? str(module.Update.Version) : undefined
      const deprecated = str(module.Deprecated)
      if (module.Main === true || name === undefined || current === undefined || (update === undefined && deprecated === undefined)) return []
      const row = rowOf('go', name, current, update ?? current, undefined, {
        isDirect: module.Indirect !== true,
        ...(deprecated === undefined ? {} : { deprecated }),
      })
      return row === undefined ? [] : [row]
    })

// ── Python direct dependencies ──────────────────────────────────────────────

export const normalizePythonName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')

const NAME_AT_START = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@(]|$)/

/** The names a requirements file asks for (`name==1.0`, `name[extra]>=1`, `name ; marker`); options and URLs skipped. */
export const requirementNames = (text: string): Set<string> => {
  const names = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    const name = line.startsWith('-') ? undefined : NAME_AT_START.exec(line)?.[1]
    if (name !== undefined) names.add(normalizePythonName(name))
  }
  return names
}

const POETRY_DEPENDENCIES = /^tool\.poetry\.(?:dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/

/**
 * The names a pyproject.toml asks for: PEP 621 `dependencies` and optional
 * ones, `[dependency-groups]`, uv's `dev-dependencies`, and Poetry's
 * dependency tables (`python` itself left out).
 */
export const pyprojectNames = (text: string): Set<string> => {
  const names = new Set<string>()
  let section = ''
  let inArray = false
  const addQuoted = (line: string): void => {
    for (const match of line.matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.add(normalizePythonName(match[1] as string))
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, '').trim()
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line)
    if (header !== null) {
      section = header[1] as string
      inArray = false
      continue
    }
    if (inArray) {
      addQuoted(line.split(']')[0] ?? '')
      if (line.includes(']')) inArray = false
      continue
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line)
    if (assignment === null) continue
    const [, key = '', value = ''] = assignment
    if (POETRY_DEPENDENCIES.test(section)) {
      if (key !== 'python') names.add(normalizePythonName(key))
      continue
    }
    const isDependencyArray =
      (section === 'project' && key === 'dependencies') ||
      section === 'project.optional-dependencies' ||
      section === 'dependency-groups' ||
      (section === 'tool.uv' && key === 'dev-dependencies')
    if (!isDependencyArray || !value.startsWith('[')) continue
    addQuoted(value.slice(1).split(']')[0] ?? '')
    inArray = !value.includes(']')
  }
  return names
}

// ── Showing and asking ──────────────────────────────────────────────────────

/** Riskiest first: major jumps, then minor, then patch; deprecated packages first within each. */
export const sortByRisk = (packages: readonly Package[]): Package[] =>
  [...packages].sort(
    (a, b) =>
      RISK[a.kind] - RISK[b.kind] ||
      Number(b.deprecated !== undefined) - Number(a.deprecated !== undefined) ||
      Number(a.isDirect === false) - Number(b.isDirect === false) ||
      a.name.localeCompare(b.name),
  )

/** The command that upgrades a package to `version` with its own manager. */
export const upgradeCommand = (pkg: Package, version: string = pkg.latest): string => {
  const dev = pkg.isDev === true
  switch (pkg.manager) {
    case 'npm':
      return `npm install ${pkg.name}@${version}${dev ? ' --save-dev' : ''}`
    case 'pnpm':
      return `pnpm add ${pkg.name}@${version}${dev ? ' -D' : ''}`
    case 'yarn':
      return `yarn add ${pkg.name}@${version}${dev ? ' --dev' : ''}`
    case 'pip':
      return `pip install --upgrade "${pkg.name}==${version}"`
    case 'cargo':
      return version === pkg.safe?.version ? `cargo update -p ${pkg.name} --precise ${version}` : `cargo add ${pkg.name}@${version}`
    case 'go':
      return `go get ${pkg.name}@${version}`
  }
}

/** The packages a safe upgrade covers: direct ones with a patch or minor version available. */
export const safeUpgrades = (packages: readonly Package[]): Package[] => packages.filter(pkg => pkg.safe !== undefined && pkg.isDirect !== false)

export const upgradePrompt = (packages: readonly Package[]): string => {
  const lines = sortByRisk(packages).map(pkg => {
    const safe = pkg.safe as NonNullable<Package['safe']>
    return `- ${pkg.name} ${pkg.current} → ${safe.version} (${safe.kind}): \`${upgradeCommand(pkg, safe.version)}\``
  })
  return [
    'Upgrade these dependencies to their newest patch or minor version, no major upgrades:',
    ...lines,
    '',
    'Use the project\'s package manager so the lockfile is updated, then run the test suite (and the build or type check if there is one) and fix anything that breaks. Finish with a short list of what changed.',
  ].join('\n')
}

/** `3 major · 2 minor · 4 patch · 1 deprecated`, the kinds that occur. */
export const kindLine = (packages: readonly Package[]): string => {
  const counts = (['major', 'minor', 'patch'] as const).map(kind => [kind, packages.filter(pkg => pkg.kind === kind).length] as const)
  const deprecated = packages.filter(pkg => pkg.deprecated !== undefined).length
  return [...counts.filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`), ...(deprecated > 0 ? [`${deprecated} deprecated`] : [])].join(' · ')
}
