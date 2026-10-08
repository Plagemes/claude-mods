#!/usr/bin/env node
// Static name-collision audit across every mod: names that only clash when mods are installed together.
//   node scripts/check-collisions.mjs          exits 1 on a duplicate, a built-in name or an unresolved name
//   node scripts/check-collisions.mjs --list   also prints every name per mod
// Checked: slash commands ($.command.register, against each other and Claude Code's built-ins), pane ids ($.ui.open),
// hub tab ids and orders and channel ids ($.mods.registerTab/registerChannel), the ~/.claude/claude-mods/<dir> folders mods
// own, state atoms (a mod keeps its state under its own plugin name) and plugin names. Tools ($.tool.register) and agent
// types ($.agent.register) are namespaced by the engine (mcp__<plugin>__<name>, <plugin>:<name>), so they only appear in --list.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIST = process.argv.includes('--list')

// Claude Code's own slash commands, their aliases and its bundled skills (a mod registering one of these is refused).
// Refresh with: grep -a -c 'name:"<cmd>"' "$(command -v claude)" (a hit that is a CLI argument or a type name is no command).
const BUILT_INS = new Set(`add-dir advisor agents allowed-tools android app artifacts auto-mode-setup autocompact autofix-pr
  background bashes batch bg branch brief btw bug cd checkpoint checkup claude-api clear cloud-plugins code-review color compact
  config context copy cost daemon debug desktop diff doctor downtime effort exit export extra-usage fast feedback
  fewer-permission-prompts focus fork goal heapdump help hooks ide import init insights install install-github-app
  install-slack-app ios keybindings keybindings-help list-agents login logout loop loops marketplace mcp memory memory-pause
  mobile model name output-style passes pause-memory peers permissions plan plugin plugins powerup privacy-settings quit radio
  rate-limit-options rc recap release-notes reload-plugins reload-skills remote remote-control remote-env rename restart resume
  review rewind routines run sandbox schedule scroll-speed security-review session session-start-hook settings setup-bedrock
  setup-vertex simplify skill-doctor skills stats status statusline stickers stop subtask tasks team-onboarding teleport
  terminal-setup theme toggle-memory tui ultraplan ultrareview undo update update-config upgrade usage usage-credits version
  vim voice web-setup wellbeing workflows`.split(/\s+/))

// Built-ins a mod still registers on purpose: the registration is refused and caught, and the mod hooks the built-in command
// (review-agent adds diff reviews to /review) or has a second name of its own (session-stats also registers /session-stats).
const TOLERATED_BUILT_INS = new Map([['review', 'review-agent'], ['stats', 'session-stats']])

// Mods that register commands without the registerCommand helper: they catch a refused name themselves
// (commit-composer tries a fallback name, recall and project-brain run their steps one by one) or share a built-in
// on purpose. mods-hub and mod-store still call $.command.register bare and are to be moved onto the helper.
const OWN_GUARD = new Set(['commit-composer', 'review-agent', 'session-stats', 'recall', 'project-brain', 'mod-store', 'mod-maker'])

const problems = []
// Tools are 'mcp__<plugin>__<name>' and agent types '<plugin>:<name>': the same short name in two mods is no clash.
const NAMESPACED = new Set(['tool', 'agent'])
const fallbacks = []
const claims = { command: new Map(), tool: new Map(), agent: new Map(), pane: new Map(), tab: new Map(), channel: new Map(), dir: new Map() }
const perMod = new Map()

const claim = (kind, name, mod, where) => {
  const map = claims[kind]
  if (!map.has(name)) map.set(name, [])
  map.get(name).push({ mod, where })
  if (!perMod.has(mod)) perMod.set(mod, [])
  perMod.get(mod).push(`${kind}:${name}`)
}

/** The text of the `{ ... }` starting at `open` (an index of `{`), strings and templates skipped. */
function balanced(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

/** The value of top-level key `key` in an object literal text, up to the next top-level comma. */
function valueOf(object, key) {
  let depth = 0
  for (let i = 0; i < object.length; i++) {
    const c = object[i]
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < object.length && object[i] !== c; i++) if (object[i] === '\\') i++
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if (depth === 1 && object.startsWith(key, i) && /[\s,{]/.test(object[i - 1] ?? '') && /^\s*:/.test(object.slice(i + key.length))) {
      const start = object.indexOf(':', i) + 1
      let d = 0
      for (let j = start; j < object.length; j++) {
        const ch = object[j]
        if (ch === "'" || ch === '"' || ch === '`') {
          for (j++; j < object.length && object[j] !== ch; j++) if (object[j] === '\\') j++
          continue
        }
        if (ch === '{' || ch === '(' || ch === '[') d++
        else if (ch === '}' || ch === ')' || ch === ']') { if (d === 0) return object.slice(start, j).trim(); d-- }
        else if (ch === ',' && d === 0) return object.slice(start, j).trim()
      }
    }
  }
  return undefined
}

const strings = text => [...text.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2])

/** The text of the array literal assigned to top-level const `name`, in any of the mod's sources. */
function arrayOf(name, sources) {
  for (const source of sources) {
    const m = source.match(new RegExp(`\\bconst\\s+${name}\\b[^=\\n]*=\\s*(?:\\[|Object\\.freeze\\(\\[)`))
    if (!m) continue
    const open = m.index + m[0].length - 1
    let depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '[') depth++
      else if (source[i] === ']' && --depth === 0) return source.slice(open, i + 1)
    }
  }
  return undefined
}

/**
 * Names an expression can take: a literal, a constant (or array of them), or 'item.name' of a 'for (const item of LIST)'.
 * 'first' is set for a loop variable alone: its names are candidates tried in turn, of which one registers.
 */
function resolve(expr, source, sources) {
  if (expr === undefined) return undefined
  const literal = expr.match(/^(['"`])([^'"`$]*)\1$/)
  if (literal) return { names: [literal[2]] }
  const ident = expr.match(/^[A-Za-z_$][\w$]*$/)
  if (ident) {
    const decl = source.match(new RegExp(`\\bconst\\s+${ident[0]}\\b[^=]*=\\s*(\\[[^\\]]*\\]|(['"'])[^'"'$]*\\2)`))
    if (decl) return { names: strings(decl[1]) }
    const loop = source.match(new RegExp(`for\\s*\\(\\s*const\\s+${ident[0]}\\s+of\\s+([A-Za-z_$][\\w$]*)`))
    const list = loop && arrayOf(loop[1], sources)
    if (list) return { names: strings(list), first: true }
  }
  const member = expr.match(/^([A-Za-z_$][\w$]*)\.name$/)
  if (member) {
    const loop = source.match(new RegExp(`for\\s*\\(\\s*const\\s+${member[1]}\\s+of\\s+([A-Za-z_$][\\w$]*)`)) ??
      source.match(new RegExp(`([A-Za-z_$][\\w$]*)\\.(?:map|forEach)\\(\\s*\\(?${member[1]}\\b`))
    const list = loop && arrayOf(loop[1], sources)
    if (list) return { names: [...list.matchAll(/\bname:\s*(['"`])([^'"`$]+)\1/g)].map(x => x[2]) }
  }
  return undefined
}

const mods = readdirSync(join(ROOT, 'mods'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
const tabOrders = new Map()
for (const mod of mods) {
  const manifest = join(ROOT, 'mods', mod, '.claude-plugin', 'plugin.json')
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name !== mod) problems.push(`mods/${mod}: plugin.json names it ${JSON.parse(readFileSync(manifest, 'utf8')).name}`)
  const hooks = join(ROOT, 'mods', mod, 'hooks')
  if (!existsSync(hooks)) continue
  // Vendored shared copies are libraries, not claims.
  const files = readdirSync(hooks).filter(f => /\.tsx?$/.test(f)).map(file => ({
    file,
    own: readFileSync(join(hooks, file), 'utf8').replace(/\/\/ #region @vendored[\s\S]*?\/\/ #endregion @vendored[^\n]*/g, ''),
  }))
  const sources = files.map(f => f.own)
  for (const { file, own } of files) {
    const where = `mods/${mod}/hooks/${file}`
    const calls = [
      ['command', /(?:\$\.command\.register\(|\bregisterCommand\(\s*\$,)\s*(?=\{)/g, 'name'],
      ['tool', /\$\.tool\.register\(\s*(?=\{)/g, 'name'],
      ['agent', /\$\.agent\.register\(\s*(?=\{)/g, 'name'],
      ['pane', /\$\.ui\.open\(\s*(?=\{)/g, 'id'],
      ['channel', /\$\.mods\.registerChannel\(\s*(?=\{)/g, 'id'],
    ]
    for (const [kind, re, key] of calls) {
      for (const m of own.matchAll(re)) {
        const object = balanced(own, m.index + m[0].length)
        let expr = valueOf(object, key)
        if (expr === undefined && new RegExp(`[{,]\\s*${key}\\s*[,}]`).test(object.replace(/\s+/g, ' '))) expr = key // shorthand
        if (expr !== undefined && /\$\{/.test(expr)) continue // a template that generates other mods (mod-maker)
        const found = resolve(expr, own, sources)
        if (found === undefined) {
          if (/\$\{/.test(object)) continue
          problems.push(`${where}: cannot resolve the ${kind} ${key} '${expr}' statically; use a literal or a top-level const`)
          continue
        }
        // Candidates tried in turn (the first free one wins) claim only their first name.
        for (const name of found.first ? found.names.slice(0, 1) : found.names) claim(kind, name, mod, where)
        if (found.first && kind === 'command') for (const name of found.names.slice(1)) fallbacks.push({ name, mod, where })
      }
    }
    // A bare $.command.register throws when the name is refused and would skip the rest of session.start.
    if (!OWN_GUARD.has(mod) && /\$\.command\.register\(\s*\{/.test(own)) {
      problems.push(`${where}: registers a command bare; use the registerCommand($, spec) helper so a refused name is a notice, not a throw`)
    }
    // State: an atom lives under the plugin it names, which must be this mod (reading another mod's value is $.state.get).
    const keys = new Set()
    for (const m of own.matchAll(/\batom\(\s*\{\s*plugin:\s*'([^'$]+)'\s*,\s*key:\s*'([^']+)'/g)) {
      if (m[1] !== mod) problems.push(`${where}: state atom ${m[1]}/${m[2]} is declared under another mod's name`)
      if (keys.has(m[2])) problems.push(`${where}: state key ${m[2]} is declared twice`)
      keys.add(m[2])
    }
    // Tabs: an object with id, title and order is a hub tab.
    for (const m of own.matchAll(/\{\s*id:\s*([^,}]+),\s*title:[^{}]*?order:\s*(\d+)/g)) {
      const found = resolve(m[1].trim(), own, sources)
      if (found === undefined) problems.push(`${where}: cannot resolve the tab id '${m[1].trim()}'`)
      else for (const name of found.names) {
        claim('tab', name, mod, where)
        tabOrders.set(m[2], [...(tabOrders.get(m[2]) ?? []), { mod, name }])
      }
    }
    // Folders under ~/.claude/claude-mods/<dir> a mod owns (assigned to a *DIR constant or an rt.dir), not files of another mod it reads.
    for (const m of own.matchAll(/\b\w*(?:DIR|dir)\s*=\s*[`'"][^`'"\n]*\.claude\/claude-mods\/([a-z][\w-]*)/g)) claim('dir', m[1], mod, where)
  }
}

const dedupe = list => [...new Map(list.map(c => [c.mod, c])).values()]
for (const [kind, map] of Object.entries(claims)) {
  for (const [name, list] of map) {
    const owners = dedupe(list)
    if (owners.length > 1 && !NAMESPACED.has(kind)) problems.push(`${kind} '${name}' is claimed by ${owners.map(o => o.mod).join(', ')}`)
    if (kind === 'command' && BUILT_INS.has(name) && TOLERATED_BUILT_INS.get(name) !== owners[0].mod) {
      problems.push(`command /${name} (${owners.map(o => o.mod).join(', ')}) is a Claude Code built-in`)
    }
  }
}
for (const { name, mod, where } of fallbacks) {
  if (BUILT_INS.has(name)) problems.push(`${where}: fallback /${name} of ${mod} is a Claude Code built-in`)
  if (claims.command.has(name) && !claims.command.get(name).every(c => c.mod === mod)) problems.push(`${where}: fallback /${name} of ${mod} is another mod's command`)
}
for (const [order, list] of tabOrders) {
  if (new Set(list.map(t => t.name)).size > 1) problems.push(`hub tab order ${order} is used by ${list.map(t => `${t.mod} (${t.name})`).join(', ')}`)
}

if (LIST) for (const [mod, names] of [...perMod].sort()) console.log(`${mod}: ${names.join(' ')}`)
const total = Object.values(claims).reduce((n, map) => n + map.size, 0)
if (problems.length > 0) {
  console.error(`check-collisions: ${problems.length} problem(s)\n` + problems.map(p => `  - ${p}`).join('\n'))
  process.exit(1)
}
console.log(`check-collisions: ${total} names across ${mods.length} mods, no collisions`)
