import { describe, expect, test } from 'claude-code/testing'

import {
  buildCatalog,
  compareVersions,
  countsOf,
  FILTER_ALL,
  FILTER_INSTALLED,
  FILTER_UPDATES,
  filterOptions,
  formatAge,
  installLine,
  isCatalogOf,
  matchMods,
  paginate,
  parseArgs,
  parseCatalogMeta,
  parseMarketplace,
  readmeRawUrl,
  readmeUrl,
  rowsOf,
  statusOf,
  trimReadme,
  updatesOf,
} from '../hooks/catalog'
import { argv, claudeBinary, parseInstalled, parseMarketplaceNames, parseOutcome } from '../hooks/cli'
import type { StoreInstalled } from '../types'

const SOURCE = { repository: 'plagemes/claude-mods', branch: 'main' }

const MARKETPLACE = JSON.stringify({
  name: 'claude-mods',
  owner: { name: 'Plagemes' },
  plugins: [
    { name: 'mod-store', source: './mods/mod-store', description: 'An in-terminal app store.', version: '1.0.0', category: 'core', author: { name: 'Plagemes' }, keywords: ['store'] },
    { name: 'secret-shield', source: './mods/secret-shield', description: 'Blocks reads of .env files and other secrets.', version: '1.2.0', category: 'security', keywords: ['secrets', 'guard'] },
    { name: 'rm-rf-guard', source: './mods/rm-rf-guard', description: 'Stops recursive deletes outside the project.', version: '1.0.0', category: 'security', keywords: ['shell', 'guard'] },
    { name: 'git-status-line', source: './mods/git-status-line', description: 'Branch and dirty count in the status line.', version: '2.0.0', category: 'git', keywords: ['git', 'status-line'] },
    { name: 'cost-meter', source: './mods/cost-meter', description: 'Live session cost.', version: '1.1.0', category: 'cost', keywords: ['tokens'] },
    { name: 'lab-thing', source: { source: 'github', repo: 'someone/else' }, description: 'From elsewhere.', version: '0.1.0', category: 'Labs' },
    { name: '--scope', source: './mods/evil', description: 'An option in disguise.', version: '1.0.0', category: 'core' },
    { description: 'No name at all.' },
    { name: 'mod-store', source: './mods/dupe', description: 'A duplicate.', version: '9.9.9', category: 'core' },
  ],
})

const META = JSON.stringify({
  categories: [
    { id: 'core', title: 'Core', tagline: 'The mod store and essentials.' },
    { id: 'security', title: 'Security & Guardrails', tagline: 'Stop dangerous actions before they happen.' },
    { id: 'git', title: 'Git & Versioning', tagline: 'Branches, commits and PRs without friction.' },
    { id: 'cost', title: 'Cost, Tokens & Context', tagline: 'Know what every turn costs.' },
    { id: 'team', title: 'Team & Docs', tagline: 'Unused here.' },
  ],
  mods: [
    { name: 'mod-store', category: 'core', tier: 'complex' },
    { name: 'secret-shield', category: 'security', tier: 'simple' },
  ],
})

const catalog = buildCatalog(parseMarketplace(MARKETPLACE), parseCatalogMeta(META), SOURCE, 1_000)
const installed: StoreInstalled = {
  isKnown: true,
  mods: {
    'secret-shield': { version: '1.0.0', scope: 'user', isEnabled: true },
    'git-status-line': { version: '2.0.0', scope: 'project', isEnabled: false },
  },
}

const run = (stdout: string, exitCode = 0, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

describe('catalog parsing', () => {
  test('reads the marketplace entries and skips invalid, unsafe and duplicate ones', () => {
    const market = parseMarketplace(MARKETPLACE)
    expect(market.name).toBe('claude-mods')
    expect(market.mods.map(mod => mod.name)).toEqual([
      'mod-store',
      'secret-shield',
      'rm-rf-guard',
      'git-status-line',
      'cost-meter',
      'lab-thing',
    ])
    expect(market.mods[0]).toEqual({
      name: 'mod-store',
      description: 'An in-terminal app store.',
      version: '1.0.0',
      category: 'core',
      keywords: ['store'],
      author: 'Plagemes',
      path: 'mods/mod-store',
    })
    expect(market.mods.find(mod => mod.name === 'lab-thing')?.path).toBeUndefined()
  })

  test('refuses what is not a marketplace file', () => {
    expect(() => parseMarketplace('{"plugins": []}')).toThrow('not valid')
    expect(() => parseMarketplace('<html>404</html>')).toThrow()
  })

  test('merges catalog.json titles, taglines and tiers, and names unknown categories', () => {
    expect(catalog.categories.map(category => category.id)).toEqual(['core', 'security', 'git', 'cost', 'labs'])
    expect(catalog.categories[1]).toEqual({
      id: 'security',
      title: 'Security & Guardrails',
      tagline: 'Stop dangerous actions before they happen.',
    })
    expect(catalog.categories[4]).toEqual({ id: 'labs', title: 'Labs', tagline: '' })
    expect(catalog.mods.find(mod => mod.name === 'mod-store')?.tier).toBe('complex')
    expect(catalog).toMatchObject({ marketplace: 'claude-mods', repository: 'plagemes/claude-mods', branch: 'main', fetchedAt: 1_000 })
  })

  test('works without catalog.json, and recognises a cached catalog of the same source only', () => {
    const bare = buildCatalog(parseMarketplace(MARKETPLACE), undefined, SOURCE, 5)
    expect(bare.categories.map(category => category.title)).toEqual(['Core', 'Security', 'Git', 'Cost', 'Labs'])
    expect(isCatalogOf(JSON.parse(JSON.stringify(bare)), SOURCE)).toBe(true)
    expect(isCatalogOf(bare, { repository: 'fork/claude-mods', branch: 'main' })).toBe(false)
    expect(isCatalogOf({ repository: 'plagemes/claude-mods' }, SOURCE)).toBe(false)
  })
})

describe('versions and status', () => {
  test('compares versions numerically, pre-releases first', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1)
    expect(compareVersions('1.0.0', '1.0')).toBe(0)
    expect(compareVersions('v2.0.0', '2.0.1')).toBe(-1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.2')).toBe(1)
  })

  test('tells available, installed and outdated mods apart', () => {
    const mod = (name: string) => catalog.mods.find(one => one.name === name)!
    expect(statusOf(mod('cost-meter'), installed).kind).toBe('available')
    expect(statusOf(mod('secret-shield'), installed).kind).toBe('update')
    expect(statusOf(mod('git-status-line'), installed)).toEqual({
      kind: 'installed',
      install: { version: '2.0.0', scope: 'project', isEnabled: false },
    })
    expect(statusOf(mod('secret-shield'), { isKnown: false, error: 'no claude' }).kind).toBe('available')
    expect(countsOf(catalog, installed)).toEqual({ mods: 6, installed: 2, updates: 1 })
    expect(updatesOf(catalog, installed).map(one => one.name)).toEqual(['secret-shield'])
  })
})

describe('search and filter', () => {
  const names = (query: string, filter = FILTER_ALL) => matchMods(catalog, installed, query, filter).map(mod => mod.name)

  test('ranks name matches above keyword and description matches', () => {
    expect(names('guard')).toEqual(['rm-rf-guard', 'secret-shield'])
    expect(names('cost')).toEqual(['cost-meter'])
    expect(names('secrets')).toEqual(['secret-shield'])
    expect(names('ENV')).toEqual(['secret-shield'])
  })

  test('needs every word to match, and matches category titles', () => {
    expect(names('guard shell')).toEqual(['rm-rf-guard'])
    expect(names('guardrails')).toEqual(['secret-shield', 'rm-rf-guard'].sort())
    expect(names('guard nothing-like-this')).toEqual([])
  })

  test('filters by category, installed and updates; no query keeps category order', () => {
    expect(names('')).toEqual(['mod-store', 'secret-shield', 'rm-rf-guard', 'git-status-line', 'cost-meter', 'lab-thing'])
    expect(names('', 'security')).toEqual(['secret-shield', 'rm-rf-guard'])
    expect(names('', FILTER_INSTALLED)).toEqual(['secret-shield', 'git-status-line'])
    expect(names('', FILTER_UPDATES)).toEqual(['secret-shield'])
    expect(names('git', FILTER_UPDATES)).toEqual([])
  })

  test('offers every category with its count in the picker', () => {
    expect(filterOptions(catalog, installed).map(option => option.label)).toEqual([
      'All categories (6)',
      'Installed (2)',
      'Updates (1)',
      'Core (1)',
      'Security & Guardrails (2)',
      'Git & Versioning (1)',
      'Cost, Tokens & Context (1)',
      'Labs (1)',
    ])
  })
})

describe('list layout', () => {
  test('groups under headings and repeats a heading on a page that opens mid-category', () => {
    const rows = rowsOf(matchMods(catalog, installed, '', FILTER_ALL), catalog, true)
    expect(rows.filter(row => row.kind === 'heading')).toHaveLength(5)
    const pages = paginate(rows, 4)
    const shape = pages.map(page =>
      page.map(row => (row.kind === 'heading' ? `#${row.category.id}${row.isContinued ? '+' : ''}` : row.mod.name)),
    )
    expect(shape).toEqual([
      ['#core', 'mod-store', '#security', 'secret-shield'],
      ['#security+', 'rm-rf-guard', '#git', 'git-status-line'],
      ['#cost', 'cost-meter', '#labs', 'lab-thing'],
    ])
    for (const page of pages) {
      expect(page[page.length - 1]?.kind).toBe('mod')
    }
  })

  test('a search is one flat ranked list', () => {
    const rows = rowsOf(matchMods(catalog, installed, 'guard', FILTER_ALL), catalog, false)
    expect(rows.every(row => row.kind === 'mod')).toBe(true)
    expect(paginate(rows, 1)).toHaveLength(1)
  })
})

describe('commands and links', () => {
  test('reads /mods arguments', () => {
    expect(parseArgs('')).toEqual({ kind: 'open' })
    expect(parseArgs('search git status')).toEqual({ kind: 'open', query: 'git status' })
    expect(parseArgs('refresh')).toEqual({ kind: 'refresh' })
    expect(parseArgs('update-all')).toEqual({ kind: 'update-all' })
    expect(parseArgs('install cost-meter')).toEqual({ kind: 'install', name: 'cost-meter' })
    expect(parseArgs('remove cost-meter')).toEqual({ kind: 'uninstall', name: 'cost-meter' })
    expect(parseArgs('update').kind).toBe('usage')
    expect(parseArgs('install --scope').kind).toBe('usage')
    expect(parseArgs('secrets')).toEqual({ kind: 'open', query: 'secrets' })
  })

  test('builds the install line, the README links and a trimmed README', () => {
    const mod = catalog.mods.find(one => one.name === 'cost-meter')!
    expect(installLine('cost-meter', 'plagemes/claude-mods')).toBe('/plugin install cost-meter --marketplace plagemes/claude-mods')
    expect(readmeUrl(catalog, mod)).toBe('https://github.com/plagemes/claude-mods/blob/main/mods/cost-meter/README.md')
    expect(readmeRawUrl(catalog, mod)).toBe('https://raw.githubusercontent.com/plagemes/claude-mods/main/mods/cost-meter/README.md')
    expect(trimReadme('\n# cost-meter\n> Live session cost.\n\n## What it does\nShows it.\n', mod)).toBe('## What it does\nShows it.')
    expect(formatAge(30_000)).toBe('just now')
    expect(formatAge(5 * 60_000)).toBe('5 min ago')
    expect(formatAge(3 * 3_600_000)).toBe('3 h ago')
    expect(formatAge(50 * 3_600_000)).toBe('2 d ago')
  })
})

describe('claude plugin CLI', () => {
  test('builds argument vectors for every operation, never a shell line', () => {
    expect(argv.list('claude')).toEqual(['claude', 'plugin', 'list', '--json'])
    expect(argv.addMarketplace('claude', 'plagemes/claude-mods')).toEqual(['claude', 'plugin', 'marketplace', 'add', 'plagemes/claude-mods', '--json'])
    expect(argv.refreshMarketplace('claude', 'claude-mods')).toEqual(['claude', 'plugin', 'marketplace', 'update', 'claude-mods', '--json'])
    expect(argv.install('claude', 'cost-meter', 'claude-mods')).toEqual(['claude', 'plugin', 'install', 'cost-meter@claude-mods', '--scope', 'user', '--json'])
    expect(argv.update('claude', 'secret-shield', 'claude-mods', 'project')).toEqual(['claude', 'plugin', 'update', 'secret-shield@claude-mods', '--scope', 'project', '--json'])
    expect(argv.uninstall('claude', 'secret-shield', 'claude-mods', 'local')).toEqual(['claude', 'plugin', 'uninstall', 'secret-shield@claude-mods', '--scope', 'local', '--json'])
  })

  test('runs the session’s own claude binary only when the path names one', () => {
    expect(claudeBinary('/opt/claude-code/bin/claude')).toBe('/opt/claude-code/bin/claude')
    expect(claudeBinary('C:\\Program Files\\Claude\\claude.exe')).toBe('C:\\Program Files\\Claude\\claude.exe')
    expect(claudeBinary('/usr/bin/node')).toBe('claude')
    expect(claudeBinary(undefined)).toBe('claude')
  })

  test('reads --json outcomes, failures and plain-text errors', () => {
    const updated = run('{"command":"update","outcome":"ok","message":"updated","updateOutcome":"updated","oldVersion":"1.0.0","newVersion":"1.2.0"}\n')
    expect(parseOutcome(updated)).toEqual({ isOk: true, message: 'updated', updateOutcome: 'updated', oldVersion: '1.0.0', newVersion: '1.2.0' })
    const missing = run('{"command":"install","outcome":"failed","message":"Plugin \\"x\\" not found","failureCode":"not_found"}', 1, '× Failed to install')
    expect(parseOutcome(missing)).toMatchObject({ isOk: false, failureCode: 'not_found', message: 'Plugin "x" not found' })
    expect(parseOutcome(run('', 127, 'claude: command not found\n'))).toEqual({ isOk: false, message: 'claude: command not found' })
  })

  test('reads the installed mods of this marketplace only', () => {
    const listed = JSON.stringify([
      { id: 'secret-shield@claude-mods', version: '1.0.0', scope: 'user', enabled: true },
      { id: 'git-status-line@claude-mods', version: '2.0.0', scope: 'project', enabled: false },
      { id: 'figma@anthropic-plugin-directory', version: '2.2.0', scope: 'user', enabled: true },
      { id: 'broken' },
    ])
    expect(parseInstalled(listed, 'claude-mods')).toEqual(installed.isKnown ? installed.mods : {})
    expect(() => parseInstalled('{}', 'claude-mods')).toThrow()
    expect(parseMarketplaceNames('[{"name":"claude-mods","source":"github"},{"name":"other"}]')).toEqual(['claude-mods', 'other'])
  })
})
