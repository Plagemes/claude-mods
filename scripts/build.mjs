#!/usr/bin/env node
// Regenerates everything derived from catalog.json and the mods' manifests:
//   .claude-plugin/marketplace.json  the marketplace Claude Code installs from
//   docs/data/mods.json              the data the showcase site renders
//   README.md                        the catalog between the CATALOG markers
// Usage: node scripts/build.mjs [--check]   (--check fails if anything is stale)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'plagemes/claude-mods'
const MARKETPLACE = 'claude-mods'
const AUTHOR = { name: 'Plagemes', url: 'https://github.com/plagemes' }
const CATALOG_START = '<!-- CATALOG:START -->'
const CATALOG_END = '<!-- CATALOG:END -->'

const isCheck = process.argv.includes('--check')
const readJson = path => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
const catalog = readJson('catalog.json')
const categoryById = new Map(catalog.categories.map(c => [c.id, c]))

const problems = []
const mods = catalog.mods.map(entry => {
  const manifestPath = `mods/${entry.name}/.claude-plugin/plugin.json`
  if (!existsSync(join(ROOT, manifestPath))) {
    problems.push(`missing ${manifestPath}`)
    return null
  }
  const manifest = readJson(manifestPath)
  if (manifest.name !== entry.name) problems.push(`${manifestPath}: name is ${manifest.name}`)
  if (!categoryById.has(entry.category)) problems.push(`${entry.name}: unknown category ${entry.category}`)
  return { ...entry, version: manifest.version, keywords: manifest.keywords ?? [], commands: entry.commands ?? commandsOf(entry.name) }
}).filter(Boolean)

// Slash commands a mod registers, read from its source for the site and README;
// a catalog entry's own `commands` wins where a mod registers names dynamically.
function commandsOf(name) {
  for (const file of ['hooks/register.ts', 'hooks/register.tsx']) {
    const path = join(ROOT, 'mods', name, file)
    if (!existsSync(path)) continue
    const source = readFileSync(path, 'utf8')
    const constants = new Map([...source.matchAll(/const\s+([A-Z_]+)\s*=\s*['"`]([a-z0-9][a-z0-9:-]*)['"`]/g)].map(m => [m[1], m[2]]))
    const registered = [...source.matchAll(/(?:command\.register\(|registerCommand\(\s*\$,)\s*\{\s*name:\s*(?:['"`]([a-z0-9][a-z0-9:-]*)['"`]|([A-Z_]+)\b)/g)]
    const names = registered.map(m => m[1] ?? constants.get(m[2])).filter(Boolean)
    return [...new Set(names.map(name => `/${name}`))]
  }
  return []
}

// Packs: curated bundles the store offers in place of a bare "Install all"; every member must be a mod.
const packs = (catalog.packs ?? []).map(pack => {
  for (const name of pack.mods) {
    if (!catalog.mods.some(m => m.name === name)) problems.push(`pack ${pack.id}: unknown mod ${name}`)
  }
  return { id: pack.id, title: pack.title, tagline: pack.tagline, mods: pack.mods }
})

// What the store scores a project with (mod-store /mods profile): files, dependencies, always-on, and the few
// intents specific enough to tell (a phrase or a long word, at most six), so the site's data stays small.
const INTENTS_KEPT = 6
const isTellingIntent = intent => (intent.includes(' ') && intent.length >= 6) || intent.length >= 8
function signalsOf(signals = {}) {
  const intents = (signals.intents ?? []).map(i => i.trim().toLowerCase()).filter(isTellingIntent).slice(0, INTENTS_KEPT)
  const kept = {
    ...(signals.files?.length ? { files: signals.files } : {}),
    ...(signals.deps?.length ? { deps: signals.deps } : {}),
    ...(intents.length ? { intents } : {}),
    ...(signals.always === true ? { always: true } : {}),
  }
  return Object.keys(kept).length === 0 ? undefined : kept
}

const marketplace = {
  name: MARKETPLACE,
  owner: AUTHOR,
  metadata: {
    description: 'A curated collection of Claude Code mods: guardrails, git, cost, productivity, quality, dashboards and more.',
    version: catalog.version ?? '1.0.0',
  },
  plugins: mods.map(m => ({
    name: m.name,
    source: `./mods/${m.name}`,
    description: m.description,
    version: m.version,
    author: AUTHOR,
    category: m.category,
    keywords: m.keywords,
    homepage: `https://plagemes.github.io/claude-mods/#${m.name}`,
  })),
}

const siteData = {
  version: catalog.version ?? '1.0.0',
  repository: REPO,
  marketplace: MARKETPLACE,
  categories: catalog.categories.map(c => ({ ...c, count: mods.filter(m => m.category === c.id).length })),
  ...(packs.length === 0 ? {} : { packs }),
  mods: mods.map(({ name, category, tier, description, version, keywords, commands, since = '1.0.0', signals }) => {
    const kept = signalsOf(signals)
    return { name, category, tier, description, version, keywords, commands, since, ...(kept === undefined ? {} : { signals: kept }) }
  }),
}

// Each category is a heading (the README's jump index links to it) over a
// collapsed table; Core stays open. GitHub needs the blank lines around the table.
const release = catalog.version ?? '1.0.0'
const readmeCatalog = [
  CATALOG_START,
  ...catalog.categories.flatMap(c => {
    const inCategory = mods.filter(m => m.category === c.id)
    if (inCategory.length === 0) return []
    const count = `${inCategory.length} ${inCategory.length === 1 ? 'mod' : 'mods'}`
    const isNew = inCategory.every(m => m.since === release) && release !== '1.0.0'
    return [
      '',
      `### ${c.title}`,
      `<sub>${c.tagline} &middot; ${count}${isNew ? ` &middot; new in v${release}` : ''}</sub>`,
      '',
      `<details${c.id === 'core' ? ' open' : ''}>`,
      `<summary>Show the ${count}</summary>`,
      '<br>',
      '',
      '| Mod | What it does | Commands |',
      '| --- | --- | --- |',
      ...inCategory.map(m =>
        `| [**${m.name}**](mods/${m.name}) | ${m.description} | ${m.commands.map(x => `\`${x}\``).join(' ') || '—'} |`),
      '',
      '</details>',
    ]
  }),
  '',
  CATALOG_END,
].join('\n')

const outputs = [
  ['.claude-plugin/marketplace.json', JSON.stringify(marketplace, null, 2) + '\n'],
  ['docs/data/mods.json', JSON.stringify(siteData, null, 2) + '\n'],
]
const readmePath = join(ROOT, 'README.md')
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8')
  const start = readme.indexOf(CATALOG_START)
  const end = readme.indexOf(CATALOG_END)
  if (start !== -1 && end > start) {
    outputs.push(['README.md', readme.slice(0, start) + readmeCatalog + readme.slice(end + CATALOG_END.length)])
  }
}

let stale = 0
for (const [path, content] of outputs) {
  const full = join(ROOT, path)
  const current = existsSync(full) ? readFileSync(full, 'utf8') : null
  if (current === content) continue
  stale += 1
  if (isCheck) {
    problems.push(`${path} is out of date: run node scripts/build.mjs`)
  } else {
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
    console.log(`wrote ${path}`)
  }
}

console.log(`${mods.length}/${catalog.mods.length} mods, ${stale} file(s) ${isCheck ? 'stale' : 'updated'}`)
if (problems.length > 0) {
  console.error(problems.map(p => `  ✗ ${p}`).join('\n'))
  process.exit(1)
}
