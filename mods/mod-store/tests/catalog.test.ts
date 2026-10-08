import { describe, expect, test } from 'claude-code/testing'

import {
  buildCatalog,
  compareVersions,
  countsOf,
  categoryOptions,
  clip,
  FILTER_ALL,
  formatAge,
  installLine,
  isCatalogOf,
  isNewMod,
  matchMods,
  paginate,
  parseArgs,
  parseCatalogMeta,
  parseConfig,
  parseMarketplace,
  readmeRawUrl,
  readmeUrl,
  relatedOf,
  releaseLabel,
  rowsOf,
  STATUS_INSTALLED,
  STATUS_NEW,
  STATUS_UPDATES,
  statusOf,
  statusOptions,
  tierLabel,
  trimReadme,
  updatesOf,
} from '../hooks/catalog'
import { barCells, glyphOf, iconSvg, toBase64 } from '../hooks/icons'
import { argv, claudeBinary, desktopRoots, isClaudeFile, joinPath, parseInstalled, parseMarketplaceNames, parseOutcome, versionOrder } from '../hooks/cli'
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
    { name: 'mod-store', category: 'core', tier: 'complex', since: '1.0.0', commands: ['/mods', 'not a command'] },
    { name: 'secret-shield', category: 'security', tier: 'simple', since: '1.0.0' },
    { name: 'rm-rf-guard', category: 'security', since: '2.0.0' },
    { name: 'cost-meter', category: 'cost', since: '2.0.0' },
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
  const names = (query: string, category = FILTER_ALL, status = FILTER_ALL) =>
    matchMods(catalog, installed, query, category, status).map(mod => mod.name)

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
    expect(names('', FILTER_ALL, STATUS_INSTALLED)).toEqual(['secret-shield', 'git-status-line'])
    expect(names('', FILTER_ALL, STATUS_UPDATES)).toEqual(['secret-shield'])
    expect(names('git', FILTER_ALL, STATUS_UPDATES)).toEqual([])
    expect(names('', FILTER_ALL, STATUS_NEW)).toEqual(['rm-rf-guard', 'cost-meter'])
    expect(names('', 'security', STATUS_NEW)).toEqual(['rm-rf-guard'])
  })

  test('offers every category with a count that follows the status, and every status with a count in the category', () => {
    expect(categoryOptions(catalog, installed, FILTER_ALL).map(option => option.label)).toEqual([
      'All categories (6)',
      'Core (1)',
      'Security & Guardrails (2)',
      'Git & Versioning (1)',
      'Cost, Tokens & Context (1)',
      'Labs (1)',
    ])
    expect(categoryOptions(catalog, installed, STATUS_NEW).map(option => option.label)).toEqual([
      'All categories (2)',
      'Core (0)',
      'Security & Guardrails (1)',
      'Git & Versioning (0)',
      'Cost, Tokens & Context (1)',
      'Labs (0)',
    ])
    expect(statusOptions(catalog, installed, FILTER_ALL).map(option => option.label)).toEqual(['All (6)', 'Installed (2)', 'Updates (1)', 'New in v2 (2)'])
    expect(statusOptions(catalog, installed, 'security').map(option => option.label)).toEqual(['All (2)', 'Installed (1)', 'Updates (1)', 'New in v2 (1)'])
  })

  test('new is the newest release in the data, and nothing is new when every mod or none says', () => {
    expect(catalog.newest).toBe('2.0.0')
    expect(isNewMod(catalog, catalog.mods.find(mod => mod.name === 'cost-meter')!)).toBe(true)
    expect(isNewMod(catalog, catalog.mods.find(mod => mod.name === 'mod-store')!)).toBe(false)
    expect(buildCatalog(parseMarketplace(MARKETPLACE), undefined, SOURCE, 1).newest).toBeUndefined()
    const allNew = JSON.stringify({ categories: [], mods: catalog.mods.map(mod => ({ name: mod.name, since: '2.0.0' })) })
    expect(buildCatalog(parseMarketplace(MARKETPLACE), parseCatalogMeta(allNew), SOURCE, 1).newest).toBeUndefined()
    expect(statusOptions(buildCatalog(parseMarketplace(MARKETPLACE), undefined, SOURCE, 1), installed, FILTER_ALL)).toHaveLength(3)
    expect(releaseLabel('2.0.0')).toBe('v2')
    expect(releaseLabel('2.1.0')).toBe('v2.1')
    expect(tierLabel('simple')).toBe('Essential')
    expect(tierLabel('complex')).toBe('Advanced')
    expect(tierLabel(undefined)).toBeUndefined()
  })

  test('keeps only slash commands from the data', () => {
    expect(catalog.mods.find(mod => mod.name === 'mod-store')?.commands).toEqual(['/mods'])
    expect(catalog.mods.find(mod => mod.name === 'cost-meter')?.commands).toBeUndefined()
  })

  test('reads a manifest\'s settings, and nothing from what is not one', () => {
    const manifest = JSON.stringify({
      name: 'x',
      userConfig: {
        repository: { type: 'string', description: 'Where from.', default: 'plagemes/claude-mods' },
        checkForUpdates: { type: 'boolean', title: 'Check', default: true },
        long: { type: 'string', default: 'x'.repeat(60) },
      },
    })
    expect(parseConfig(manifest)).toEqual([
      { key: 'repository', default: 'plagemes/claude-mods', description: 'Where from.' },
      { key: 'checkForUpdates', default: 'true', description: 'Check' },
      { key: 'long', default: `${'x'.repeat(39)}…`, description: '' },
    ])
    expect(parseConfig('{"name":"x"}')).toEqual([])
    expect(parseConfig('<html>')).toEqual([])
  })

  test('related mods are the category\'s others, the ones not installed first', () => {
    const shield = catalog.mods.find(mod => mod.name === 'rm-rf-guard')!
    expect(relatedOf(catalog, installed, shield, 5).map(mod => mod.name)).toEqual(['secret-shield'])
    expect(relatedOf(catalog, installed, catalog.mods.find(mod => mod.name === 'cost-meter')!, 5)).toEqual([])
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 4)).toBe('abc')
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
    expect(parseArgs('stop')).toEqual({ kind: 'stop' })
    expect(parseArgs('cancel')).toEqual({ kind: 'stop' })
    expect(parseArgs('update-all')).toEqual({ kind: 'update-all' })
    expect(parseArgs('update all')).toEqual({ kind: 'update-all' })
    expect(parseArgs('install-all')).toEqual({ kind: 'install-all' })
    expect(parseArgs('install all')).toEqual({ kind: 'install-all' })
    expect(parseArgs('install *')).toEqual({ kind: 'install-all' })
    expect(parseArgs('install cost-meter')).toEqual({ kind: 'install', name: 'cost-meter' })
    expect(parseArgs('remove cost-meter')).toEqual({ kind: 'uninstall', name: 'cost-meter' })
    expect(parseArgs('update').kind).toBe('usage')
    expect(parseArgs('install --scope').kind).toBe('usage')
    expect(parseArgs('secrets')).toEqual({ kind: 'open', query: 'secrets' })
  })

  test('builds the install line, the README links and a trimmed README', () => {
    const mod = catalog.mods.find(one => one.name === 'cost-meter')!
    expect(installLine('cost-meter', 'claude-mods')).toBe('/plugin install cost-meter@claude-mods')
    expect(readmeUrl(catalog, mod)).toBe('https://github.com/plagemes/claude-mods/blob/main/mods/cost-meter/README.md')
    expect(readmeRawUrl(catalog, mod)).toBe('https://raw.githubusercontent.com/plagemes/claude-mods/main/mods/cost-meter/README.md')
    expect(trimReadme('\n# cost-meter\n> Live session cost.\n\n## What it does\nShows it.\n', mod)).toBe('## What it does\nShows it.')
    const full = '# cost-meter\n> Tag.\n\n**Category:** Cost · **Version:** 1.0.0\n\n## What it does\nShows it.\n\n## Install\n```\n## not a heading\n/plugin install x\n```\n\n## Configuration\n| a | b |\n\n## How it works\nLike so.\n'
    expect(trimReadme(full, mod)).toBe('## What it does\nShows it.\n\n## Configuration\n| a | b |\n\n## How it works\nLike so.')
    expect(trimReadme(full, mod, true)).toBe('## What it does\nShows it.\n\n## How it works\nLike so.')
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

  test('looks for the desktop app’s claude under %APPDATA% on Windows and Application Support on macOS', () => {
    expect(desktopRoots('C:\\Users\\me\\AppData\\Roaming', undefined)).toEqual(['C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code'])
    expect(desktopRoots(undefined, '/Users/me')).toEqual(['/Users/me/Library/Application Support/Claude/claude-code'])
    expect(desktopRoots('', '')).toEqual([])
    expect(joinPath('C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code', '2.1.286', '635c', 'claude.exe'))
      .toBe('C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.286\\635c\\claude.exe')
    expect(joinPath('/Users/me/Library/Application Support/Claude/claude-code', '2.1.286', 'claude'))
      .toBe('/Users/me/Library/Application Support/Claude/claude-code/2.1.286/claude')
    expect(isClaudeFile('claude.exe')).toBe(true)
    expect(isClaudeFile('Claude')).toBe(true)
    expect(isClaudeFile('claude-helper.exe')).toBe(false)
    expect(versionOrder(['2.1.284', '2.1.290', '2.1.286'], '2.1.286', compareVersions)).toEqual(['2.1.286', '2.1.290', '2.1.284'])
    expect(versionOrder(['2.1.284', '2.1.290'], '2.1.286', compareVersions)).toEqual(['2.1.290', '2.1.284'])
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

describe('icons and the progress bar', () => {
  test('every category has an icon with one lit element, and an unknown one falls back to the Slot', () => {
    const svg = iconSvg('security', 16)
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24" width="16" height="16"/)
    expect(svg).toContain('stroke="#ee8a4f"')
    expect(svg).not.toContain('LIT')
    expect(iconSvg('no-such-category')).toBe(iconSvg('core'))
    expect(glyphOf('git')).toBe('⑂')
    expect(glyphOf('no-such-category')).toBe('▦')
  })

  test('encodes base64 as the standard does, and a bar as Ember cells then quiet ones', () => {
    expect(toBase64(new Uint8Array([102, 111, 111, 98, 97]))).toBe('Zm9vYmE=')
    expect(toBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v')
    expect(toBase64(new Uint8Array([102]))).toBe('Zg==')
    const decode = (text: string) => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      const bytes: number[] = []
      for (let index = 0; index < text.length; index += 4) {
        const chunk = text.slice(index, index + 4)
        const value = [...chunk].reduce((sum, char) => sum * 64 + Math.max(0, alphabet.indexOf(char)), 0)
        bytes.push((value >> 16) & 255, (value >> 8) & 255, value & 255)
        if (chunk.endsWith('==')) bytes.splice(-2)
        else if (chunk.endsWith('=')) bytes.splice(-1)
      }
      return new Uint32Array(new Uint8Array(bytes).buffer)
    }
    const words = decode(barCells(0.5, 4))
    expect([...words]).toEqual([0x2501, 0xee8a4f, 0x01000000, 0x2501, 0xee8a4f, 0x01000000, 0x2500, 0x5c564d, 0x01000000, 0x2500, 0x5c564d, 0x01000000])
  })
})
