#!/usr/bin/env node
// Vendors the shared libraries into the mods that use them, and checks the copies are in sync.
//
// A mod cannot import from another plugin's folder at run time, so code shared by several mods lives once in
// shared/ and is COPIED into each mod that needs it, with a header naming its source and the source's hash:
//
//   shared/<lib>.ts                    → mods/<mod>/hooks/shared/<lib>.ts      (shell, test-runners, prices, secrets, line-index)
//   mods/mods-hub/types/index.d.ts     → mods/<mod>/types/mods-hub.d.ts         (hub-types: the hub's contract, for `$.mods`)
//   shared/hub-client.ts  (its region) → a region of mods/<mod>/hooks/<entry>  (hub-client: functions taking `$` must
//                                         live in the hooks file itself, so they are pasted between markers)
//   shared/testing/hub.ts              → mods/<mod>/tests/hub.ts                (fake-hub: the stand-in for mods-hub in
//                                         tests; it imports ../types/mods-hub, so vendor hub-client first)
//
// Usage:
//   node scripts/sync-shared.mjs                     rewrite every vendored copy from its source
//   node scripts/sync-shared.mjs --check             exit 1 if a copy is stale or was edited by hand (CI)
//   node scripts/sync-shared.mjs add <mod> <lib...>  vendor libraries into a mod (hub-client adds hub-types too)
//   node scripts/sync-shared.mjs list                which mod vendors what
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODS = join(ROOT, 'mods')
const HUB = 'mods-hub'

/** The libraries, by name: where each comes from and where a mod keeps its copy. */
const LIBS = {
  shell: { kind: 'file', source: 'shared/shell.ts', target: 'hooks/shared/shell.ts' },
  'test-runners': { kind: 'file', source: 'shared/test-runners.ts', target: 'hooks/shared/test-runners.ts' },
  prices: { kind: 'file', source: 'shared/prices.ts', target: 'hooks/shared/prices.ts' },
  secrets: { kind: 'file', source: 'shared/secrets.ts', target: 'hooks/shared/secrets.ts' },
  'line-index': { kind: 'file', source: 'shared/line-index.ts', target: 'hooks/shared/line-index.ts' },
  'hub-types': { kind: 'file', source: `mods/${HUB}/types/index.d.ts`, target: 'types/mods-hub.d.ts' },
  'hub-client': { kind: 'region', source: 'shared/hub-client.ts', region: 'hub-client' },
  'fake-hub': { kind: 'file', source: 'shared/testing/hub.ts', target: 'tests/hub.ts' },
}

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12)
const read = path => readFileSync(join(ROOT, path), 'utf8')
const fileHeader = (lib, text) =>
  `// @vendored ${LIBS[lib].source} sha256:${sha(text)} by scripts/sync-shared.mjs: edit the source, then run \`node scripts/sync-shared.mjs\`; never this copy.\n`
const regionOpen = lib => `// #region @vendored ${LIBS[lib].source}`
const regionClose = lib => `// #endregion @vendored ${LIBS[lib].source}`

/** The region's body in its source file, between `// #region <name>` and `// #endregion <name>`. */
function regionBody(lib) {
  const source = read(LIBS[lib].source)
  const name = LIBS[lib].region
  const start = source.indexOf(`// #region ${name}\n`)
  const end = source.indexOf(`// #endregion ${name}`)
  if (start === -1 || end === -1) throw new Error(`${LIBS[lib].source}: no "// #region ${name}" ... "// #endregion ${name}"`)
  return source.slice(start + `// #region ${name}\n`.length, end)
}

/** What a vendored copy of `lib` must contain. */
function expected(lib) {
  if (LIBS[lib].kind === 'region') {
    const body = regionBody(lib)
    return `${regionOpen(lib)} sha256:${sha(body)}: edit the source, then run \`node scripts/sync-shared.mjs\`.\n${body}${regionClose(lib)}`
  }
  const text = read(LIBS[lib].source)
  return fileHeader(lib, text) + text
}

/** A mod's hooks entry file (hooks.json `modules[0]`). */
function entryOf(mod) {
  const hooksJson = join(MODS, mod, 'hooks', 'hooks.json')
  if (!existsSync(hooksJson)) return undefined
  const first = JSON.parse(readFileSync(hooksJson, 'utf8')).modules?.[0]
  return typeof first === 'string' ? join(MODS, mod, 'hooks', first) : undefined
}

const regionPattern = lib =>
  new RegExp(`${regionOpen(lib).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n[\\s\\S]*?${regionClose(lib).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

/** Every vendored copy in the repository: { mod, lib, path }. */
function copies() {
  const found = []
  for (const mod of readdirSync(MODS).sort()) {
    for (const [lib, spec] of Object.entries(LIBS)) {
      if (spec.kind === 'file') {
        if (lib === 'hub-types' && mod === HUB) continue
        const path = join(MODS, mod, spec.target)
        if (existsSync(path) && readFileSync(path, 'utf8').startsWith(`// @vendored ${spec.source} `)) found.push({ mod, lib, path })
      } else {
        const path = entryOf(mod)
        if (path !== undefined && existsSync(path) && readFileSync(path, 'utf8').includes(regionOpen(lib))) found.push({ mod, lib, path })
      }
    }
  }
  return found
}

/** The copy's file content as it should be, given its current content. */
function synced(copy, current) {
  if (LIBS[copy.lib].kind === 'file') return expected(copy.lib)
  return current.replace(regionPattern(copy.lib), () => expected(copy.lib))
}

function sync({ isCheck }) {
  const problems = []
  let written = 0
  const all = copies()
  for (const copy of all) {
    const current = readFileSync(copy.path, 'utf8')
    const want = synced(copy, current)
    if (current === want) continue
    if (isCheck) {
      const header = LIBS[copy.lib].kind === 'file' ? current.split('\n', 1)[0] : (current.match(regionPattern(copy.lib))?.[0].split('\n', 1)[0] ?? '')
      const isStale = !header.includes(`sha256:${sha(LIBS[copy.lib].kind === 'file' ? read(LIBS[copy.lib].source) : regionBody(copy.lib))}`)
      problems.push(`${relative(ROOT, copy.path)}: ${isStale ? `stale (its source ${LIBS[copy.lib].source} changed)` : 'edited by hand'}`)
    } else {
      writeFileSync(copy.path, want)
      written += 1
    }
  }
  if (isCheck) {
    for (const problem of problems) console.log(`✗ ${problem}`)
    console.log(problems.length === 0 ? `✓ ${all.length} vendored copies in sync` : `${problems.length} vendored copies out of sync: run node scripts/sync-shared.mjs`)
    process.exit(problems.length === 0 ? 0 : 1)
  }
  console.log(`${written} of ${all.length} vendored copies rewritten`)
}

function add(mod, libs) {
  if (!existsSync(join(MODS, mod, '.claude-plugin', 'plugin.json'))) throw new Error(`no mod ${mod}`)
  const wanted = new Set(libs)
  if (wanted.has('hub-client')) wanted.add('hub-types')
  for (const lib of wanted) {
    const spec = LIBS[lib]
    if (spec === undefined) throw new Error(`unknown library ${lib}; one of ${Object.keys(LIBS).join(', ')}`)
    if (spec.kind === 'file') {
      if (lib === 'hub-types' && mod === HUB) continue
      const path = join(MODS, mod, spec.target)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, expected(lib))
      console.log(`+ ${relative(ROOT, path)}`)
    } else {
      const path = entryOf(mod)
      if (path === undefined) throw new Error(`${mod} has no hooks entry in hooks/hooks.json`)
      const current = readFileSync(path, 'utf8')
      if (current.includes(regionOpen(lib))) continue
      writeFileSync(path, `${current.replace(/\n*$/, '\n')}\n${expected(lib)}\n`)
      console.log(`+ ${relative(ROOT, path)} (region ${lib}: it needs \`import type { EngineInterface } from 'claude-code'\`)`)
    }
  }
}

function list() {
  const byMod = new Map()
  for (const copy of copies()) byMod.set(copy.mod, [...(byMod.get(copy.mod) ?? []), copy.lib])
  for (const [mod, libs] of byMod) console.log(`${mod}: ${libs.join(', ')}`)
  if (byMod.size === 0) console.log('no mod vendors a shared library yet')
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === undefined || command === '--write') sync({ isCheck: false })
  else if (command === '--check') sync({ isCheck: true })
  else if (command === 'add' && rest.length >= 2) add(rest[0], rest.slice(1))
  else if (command === 'list') list()
  else {
    console.log('Usage: node scripts/sync-shared.mjs [--check] | add <mod> <lib...> | list')
    process.exit(2)
  }
} catch (error) {
  console.error(`sync-shared: ${error.message}`)
  process.exit(1)
}
