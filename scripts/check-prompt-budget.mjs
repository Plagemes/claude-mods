#!/usr/bin/env node
// Static prompt-budget audit: every tool ($.tool.register) and agent ($.agent.register) a mod registers puts its description
// (and, for tools, its input schema) into every model request. This measures them without running the mods.
//   node scripts/check-prompt-budget.mjs              exits 1 when a description or a mod's total is over its cap, or can't be measured
//   node scripts/check-prompt-budget.mjs --list       also prints every registration with its size
//   node scripts/check-prompt-budget.mjs --markdown   prints the inventory as a markdown table (sorted by size)
//   node scripts/check-prompt-budget.mjs mods/<name>  only the mods named
// Sizes are characters; tokens are approximated as chars / 4. Tool names are namespaced by the engine and not counted.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_DESCRIPTION = 300 // chars of one tool or agent description
const MAX_SCHEMA = 500 // chars of one tool's JSON input schema
const MAX_MOD_TOTAL = 1800 // chars of everything one mod registers (descriptions + schemas)
const SKIP = new Set(['mod-store', 'mods-hub']) // owned and budgeted separately
const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const named = args.filter(a => !a.startsWith('--')).map(a => resolve(a).split('/').pop())
const tokens = chars => Math.ceil(chars / 4)

// ── Reading top-level constants out of a hooks folder ──────────────────────────────────────────────────

/** Index of the closing quote of the string starting at `i`. Understands template literals with ${...}. */
function skipString(src, i) {
  const quote = src[i]
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (quote === '`' && src[j] === '$' && src[j + 1] === '{') j = skipBalanced(src, j + 1)
    else if (src[j] === quote) return j
  }
  return src.length
}
/** Index of the bracket closing the one at `i`. */
function skipBalanced(src, i) {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === "'" || c === '"' || c === '`') j = skipString(src, j)
    else if (c === '/' && src[j + 1] === '/') j = lineEnd(src, j)
    else if (c === '/' && src[j + 1] === '*') j = src.indexOf('*/', j) + 1
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c) && --depth === 0) return j
  }
  return src.length
}
const lineEnd = (src, j) => (src.indexOf('\n', j) === -1 ? src.length : src.indexOf('\n', j) - 1)

/** The text of the expression starting at `start`: up to the end of the statement or of the property. */
function expressionAt(src, start, stopAtComma = false) {
  let j = start
  while (j < src.length) {
    const c = src[j]
    if (c === "'" || c === '"' || c === '`') j = skipString(src, j)
    else if (c === '/' && src[j + 1] === '/') j = lineEnd(src, j)
    else if (c === '/' && src[j + 1] === '*') j = src.indexOf('*/', j) + 1
    else if ('([{'.includes(c)) j = skipBalanced(src, j)
    else if (stopAtComma && c === ',') break
    else if (c === '\n' && !stopAtComma) {
      const before = src.slice(start, j).trimEnd().slice(-1)
      const after = src.slice(j).match(/^\s*(\S)/)?.[1] ?? ''
      if (!'+,=(&|?:'.includes(before) && !'+.?:|&'.includes(after)) break
    }
    j++
  }
  return src.slice(start, j).trim().replace(/;$/, '')
}

/** The top-level `key: expression` pairs of an object literal's text (shorthand `key` maps to itself). */
function propertiesOf(literal) {
  const body = literal.slice(1, -1)
  const props = {}
  let i = 0
  while (i < body.length) {
    const rest = body.slice(i)
    const key = rest.match(/^\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_$][\w$]*)\s*(:|,|$)/)
    if (key) {
      let valueStart = i + key[0].length
      while (key[2] === ':' && /\s/.test(body[valueStart] ?? '')) valueStart++
      const value = key[2] === ':' ? expressionAt(body, valueStart, true) : key[1]
      props[key[1]] = value
      i = valueStart + (key[2] === ':' ? value.length : 0)
    } else {
      i += expressionAt(body, i, true).length || 1
    }
    while (i < body.length && /[\s,]/.test(body[i])) i++
  }
  return props
}

/** Drop the TypeScript that matters for evaluation: `as` assertions and `satisfies`. */
const plain = text => text
  .replace(/\s+as\s+const\b/g, '')
  .replace(/\s+as\s+unknown\s+as\s+[A-Za-z_$][\w$]*(?:<[^>()]*>)?/g, '')
  .replace(/\s+as\s+(?:readonly\s+)?[A-Za-z_$][\w$]*(?:<[^>()]*>)?(?:\[\])?/g, '')
  .replace(/\s+satisfies\s+[A-Za-z_$][\w$<>]*/g, '')

const hookFiles = dir => (existsSync(join(dir, 'hooks')) ? readdirSync(join(dir, 'hooks')).filter(f => /\.tsx?$/.test(f)) : [])

function constantsOf(dir) {
  const found = new Map()
  for (const file of hookFiles(dir)) {
    const src = readFileSync(join(dir, 'hooks', file), 'utf8')
    for (const m of src.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/gm)) {
      const text = expressionAt(src, m.index + m[0].length)
      if (!/^(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/.test(text)) found.set(m[1], { text })
    }
  }
  return found
}

/** Evaluates an expression, resolving the top-level constants it names. Throws on anything it can't resolve. */
function evaluate(text, constants, cache = new Map(), trail = []) {
  const sandbox = {}
  const code = plain(text)
  for (const name of new Set(code.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '').match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    if (!constants.has(name) || trail.includes(name)) continue
    if (!cache.has(name)) cache.set(name, evaluate(constants.get(name).text, constants, cache, [...trail, name]))
    sandbox[name] = cache.get(name)
  }
  return vm.runInNewContext(`(${code})`, vm.createContext(sandbox), { timeout: 1000 })
}

// ── Finding registrations ──────────────────────────────────────────────────────────────────────────────

function registrationsOf(dir) {
  const constants = constantsOf(dir)
  const out = []
  for (const file of hookFiles(dir)) {
    const src = readFileSync(join(dir, 'hooks', file), 'utf8')
    for (const m of src.matchAll(/\.(tool|agent)\.register\(\s*(?=\{)/g)) {
      const kind = m[1]
      const start = m.index + m[0].length
      const fields = propertiesOf(plain(src.slice(start, skipBalanced(src, start) + 1)))
      const where = `${file}:${src.slice(0, m.index).split('\n').length}`
      // A registration inside `for (const spec of LIST)` registers one entry per item of LIST.
      const loop = src.slice(Math.max(0, m.index - 400), m.index).match(/for\s*\(\s*const\s+([\w$]+)\s+of\s+([\w$]+)\s*\)[^]*$/)
      try {
        const items = loop ? evaluate(loop[2], constants) : [undefined]
        for (const item of items) {
          const known = new Map(constants)
          if (loop) known.set(loop[1], { text: JSON.stringify(item) })
          const value = key => (fields[key] === undefined ? undefined : evaluate(fields[key], known))
          const description = String(value('description') ?? '')
          const schema = value('inputSchema')
          out.push({ kind, name: String(value('name') ?? '?'), where, description: description.length, schema: schema === undefined ? 0 : JSON.stringify(schema).length })
        }
      } catch (error) {
        out.push({ kind, name: '?', where, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return out
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────────────────

const mods = readdirSync(join(ROOT, 'mods')).filter(m => !SKIP.has(m) && (named.length === 0 || named.includes(m)))
const all = []
const problems = []
for (const mod of mods) {
  let total = 0
  for (const r of registrationsOf(join(ROOT, 'mods', mod))) {
    r.mod = mod
    if (r.error) { problems.push(`${mod}: ${r.where}: could not measure the ${r.kind} registration (${r.error})`); continue }
    total += r.description + r.schema
    all.push(r)
    if (r.description > MAX_DESCRIPTION) problems.push(`${mod}: ${r.kind} '${r.name}' description is ${r.description} chars (cap ${MAX_DESCRIPTION})`)
    if (r.schema > MAX_SCHEMA) problems.push(`${mod}: tool '${r.name}' input schema is ${r.schema} chars (cap ${MAX_SCHEMA})`)
  }
  if (total > MAX_MOD_TOTAL) problems.push(`${mod}: its tools and agents total ${total} chars (cap ${MAX_MOD_TOTAL})`)
}

const size = r => r.description + r.schema
const sum = all.reduce((n, r) => n + size(r), 0)
const bySize = [...all].sort((a, b) => size(b) - size(a))
if (flags.has('--markdown')) {
  console.log('| Mod | Kind | Name | Description (chars) | Schema (chars) | ~Tokens |\n|---|---|---|---:|---:|---:|')
  for (const r of bySize) console.log(`| ${r.mod} | ${r.kind} | ${r.name} | ${r.description} | ${r.schema} | ${tokens(size(r))} |`)
  console.log(`| **Total** | | ${all.length} registrations | | | **${tokens(sum)}** |`)
} else {
  if (flags.has('--list')) for (const r of bySize) console.log(`${String(tokens(size(r))).padStart(5)} tok  ${r.mod} ${r.kind} ${r.name}  (description ${r.description}, schema ${r.schema})`)
  console.log(`${all.length} tool/agent registrations in ${mods.length} mods, about ${tokens(sum)} tokens when all are registered`)
}
for (const p of problems) console.error(`✗ ${p}`)
process.exit(problems.length === 0 ? 0 : 1)
