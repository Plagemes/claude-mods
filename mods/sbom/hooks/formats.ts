import type { SbomCounts, SbomReviewItem } from '../types'
import { classifyLicense, isSingleSpdxId, isSpdx } from './licenses'
import type { LicenseClass } from './licenses'
import type { Dependency, Ecosystem } from './lockfiles'

export type Format = 'cyclonedx' | 'spdx' | 'md'

/** What the document says about the project it describes. */
export type BomMeta = { project: string; timestamp: string; uuid: string; sources: readonly string[] }


export const FILE_NAMES: Record<Format, string> = { cyclonedx: 'sbom.cdx.json', spdx: 'sbom.spdx.json', md: 'SBOM.md' }
export const FORMAT_LABELS: Record<Format, string> = { cyclonedx: 'CycloneDX 1.5', spdx: 'SPDX 2.3', md: 'Markdown' }
export const ECOSYSTEM_LABELS: Record<Ecosystem, string> = { npm: 'npm', pypi: 'PyPI', cargo: 'crates.io', golang: 'Go' }
const TOOL = { name: 'claude-mods sbom', version: '1.0.0' }
const REVIEW_ORDER: Record<LicenseClass, number> = { copyleft: 0, 'weak copyleft': 1, unknown: 2, other: 3, permissive: 4 }

/** The format `/sbom <args>` asks for: `cyclonedx` (`cdx`, `json`), `spdx`, `md` (`markdown`); undefined when unrecognised. */
export const parseFormat = (args: string, fallback: Format): Format | undefined => {
  const word = args.trim().toLowerCase()
  if (word === '') return fallback
  if (word === 'cyclonedx' || word === 'cdx' || word === 'json') return 'cyclonedx'
  if (word === 'spdx') return 'spdx'
  if (word === 'md' || word === 'markdown') return 'md'
  return undefined
}

const encodeSegments = (path: string): string => path.split('/').map(encodeURIComponent).join('/')

/** The package URL (purl) of a dependency: `pkg:npm/%40scope/name@1.0.0`, `pkg:pypi/requests@2.31.0`, ... */
export const purlOf = (dependency: Dependency): string => {
  const version = dependency.version === '' ? '' : `@${encodeURIComponent(dependency.version)}`
  const name = dependency.ecosystem === 'pypi' ? dependency.name.toLowerCase().replace(/[-_.]+/g, '-') : dependency.name
  return `pkg:${dependency.ecosystem}/${encodeSegments(name)}${version}`
}

/** One entry per package URL: prod wins over dev, and the first license found is kept. */
export const dedupe = (dependencies: readonly Dependency[]): Dependency[] => {
  const merged = new Map<string, Dependency>()
  for (const dependency of dependencies) {
    const key = purlOf(dependency)
    const known = merged.get(key)
    if (known === undefined) {
      merged.set(key, { ...dependency })
      continue
    }
    known.license ??= dependency.license
    if (known.isDev === undefined || dependency.isDev === false) known.isDev = dependency.isDev
  }
  return [...merged.values()].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

export const summarize = (dependencies: readonly Dependency[]): SbomCounts => {
  const byEcosystem: Partial<Record<Ecosystem, number>> = {}
  const licenses = new Map<string, number>()
  const classes: Record<LicenseClass, number> = { permissive: 0, 'weak copyleft': 0, copyleft: 0, other: 0, unknown: 0 }
  const review: SbomReviewItem[] = []
  for (const dependency of dependencies) {
    byEcosystem[dependency.ecosystem] = (byEcosystem[dependency.ecosystem] ?? 0) + 1
    const label = dependency.license ?? 'unknown'
    licenses.set(label, (licenses.get(label) ?? 0) + 1)
    const kind = classifyLicense(dependency.license)
    classes[kind] += 1
    if (kind !== 'permissive') {
      review.push({ name: dependency.name, version: dependency.version, ecosystem: dependency.ecosystem, license: dependency.license, class: kind })
    }
  }
  review.sort((a, b) => REVIEW_ORDER[a.class] - REVIEW_ORDER[b.class] || a.name.localeCompare(b.name))
  return {
    total: dependencies.length,
    dev: dependencies.filter(dependency => dependency.isDev === true).length,
    byEcosystem,
    licenses: [...licenses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    classes,
    review,
  }
}

// ── CycloneDX 1.5 ───────────────────────────────────────────────────────────

const cyclonedxLicenses = (license: string | undefined): object[] | undefined => {
  if (license === undefined) return undefined
  if (isSingleSpdxId(license)) return [{ license: { id: license } }]
  if (isSpdx(license)) return [{ expression: license }]
  return [{ license: { name: license } }]
}

export const toCycloneDx = (dependencies: readonly Dependency[], meta: BomMeta): string => {
  const components = dependencies.map(dependency => {
    const purl = purlOf(dependency)
    const scoped = dependency.ecosystem === 'npm' && dependency.name.startsWith('@') ? dependency.name.split('/') : undefined
    return {
      type: 'library',
      'bom-ref': purl,
      ...(scoped !== undefined && scoped.length === 2 ? { group: scoped[0], name: scoped[1] } : { name: dependency.name }),
      ...(dependency.version === '' ? {} : { version: dependency.version }),
      ...(dependency.isDev === undefined ? {} : { scope: dependency.isDev ? 'excluded' : 'required' }),
      ...(cyclonedxLicenses(dependency.license) === undefined ? {} : { licenses: cyclonedxLicenses(dependency.license) }),
      purl,
    }
  })
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${meta.uuid}`,
    version: 1,
    metadata: {
      timestamp: meta.timestamp,
      tools: { components: [{ type: 'application', author: 'Plagemes', ...TOOL }] },
      component: { type: 'application', 'bom-ref': 'root-component', name: meta.project },
      properties: meta.sources.map(source => ({ name: 'claude-mods:sbom:source', value: source })),
    },
    components,
  }
  return `${JSON.stringify(bom, null, 2)}\n`
}

// ── SPDX 2.3 ────────────────────────────────────────────────────────────────

const spdxIdOf = (text: string): string => text.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '')

export const toSpdx = (dependencies: readonly Dependency[], meta: BomMeta): string => {
  const rootId = 'SPDXRef-Root'
  const used = new Set<string>([rootId])
  const packages = dependencies.map(dependency => {
    let id = `SPDXRef-Package-${spdxIdOf(`${dependency.ecosystem}-${dependency.name}-${dependency.version}`)}`
    for (let n = 2; used.has(id); n += 1) id = `${id.replace(/-\d+$/, '')}-${n}`
    used.add(id)
    return {
      SPDXID: id,
      name: dependency.name,
      ...(dependency.version === '' ? {} : { versionInfo: dependency.version }),
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: dependency.license !== undefined && isSpdx(dependency.license) ? dependency.license : 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purlOf(dependency) }],
      primaryPackagePurpose: 'LIBRARY',
    }
  })
  const document = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${meta.project} SBOM`,
    documentNamespace: `https://spdx.org/spdxdocs/${encodeURIComponent(meta.project)}-${meta.uuid}`,
    creationInfo: { created: meta.timestamp, creators: [`Tool: ${TOOL.name.replace(/ /g, '-')}-${TOOL.version}`] },
    packages: [
      {
        SPDXID: rootId,
        name: meta.project,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        copyrightText: 'NOASSERTION',
        primaryPackagePurpose: 'APPLICATION',
      },
      ...packages,
    ],
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootId },
      ...packages.map((entry, index) =>
        dependencies[index]?.isDev === true
          ? { spdxElementId: entry.SPDXID, relationshipType: 'DEV_DEPENDENCY_OF', relatedSpdxElement: rootId }
          : { spdxElementId: rootId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: entry.SPDXID },
      ),
    ],
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

// ── Markdown ────────────────────────────────────────────────────────────────

const cell = (text: string): string => text.replace(/\|/g, '\\|')

export const toMarkdown = (dependencies: readonly Dependency[], meta: BomMeta): string => {
  const summary = summarize(dependencies)
  const ecosystems = Object.entries(summary.byEcosystem)
    .map(([ecosystem, count]) => `${ECOSYSTEM_LABELS[ecosystem as Ecosystem]} ${count}`)
    .join(' · ')
  const licenses = summary.licenses.map(([license, count]) => `${license} ${count}`).join(', ')
  const scope = (dependency: Dependency): string => (dependency.isDev === undefined ? '' : dependency.isDev ? 'dev' : 'runtime')
  return [
    `# Software Bill of Materials: ${meta.project}`,
    '',
    `Generated ${meta.timestamp.slice(0, 10)} by ${TOOL.name} ${TOOL.version} from ${meta.sources.join(', ') || 'no lockfile'}.`,
    '',
    `**${summary.total} packages** (${summary.dev} dev-only) · ${ecosystems}`,
    '',
    `**Licenses:** ${licenses}`,
    '',
    '| Package | Version | Ecosystem | License | Scope |',
    '| --- | --- | --- | --- | --- |',
    ...dependencies.map(
      dependency =>
        `| ${cell(dependency.name)} | ${cell(dependency.version || '(unpinned)')} | ${ECOSYSTEM_LABELS[dependency.ecosystem]} | ` +
        `${cell(dependency.license ?? 'unknown')} | ${scope(dependency)} |`,
    ),
    '',
  ].join('\n')
}

export const render = (format: Format, dependencies: readonly Dependency[], meta: BomMeta): string =>
  format === 'cyclonedx' ? toCycloneDx(dependencies, meta) : format === 'spdx' ? toSpdx(dependencies, meta) : toMarkdown(dependencies, meta)
