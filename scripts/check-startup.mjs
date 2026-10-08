#!/usr/bin/env node
// Flags slow work a `session.start` hook waits for before it returns.
//
// All mods share one hooks worker, and session.start runs every mod's hook in one chain: a hook that waits on a
// process, the network, a model, the hub or a directory scan holds up every hook below it, and with ~200 mods
// installed the chain runs past the engine's 10 s budget ("session.start hook skipped: ran past its 10s budget").
//
// The rule: a session.start hook registers commands and reads small state (`$.store`, `$.state`, `$.fs.read` of
// its own file), and returns in well under 100 ms. Everything else is deferred with `$.clock.after(<small staggered
// delay>, ...)` or done lazily on first use.
//
// This script finds, inside each `on('session.start', ...)` handler, every `await` whose expression calls
//   $.process.* · $.http.* · $.model.* · $.agent.* (not register) · $.mcp.* · $.mods.* · $.fs.list · $.fs.ancestors · $.clock.sleep
// directly, or calls a function of the same hooks file that (transitively) awaits one of them (the vendored
// hub-client functions, a `greetHub`, a `scan`). Work inside a `$.clock.after` / `$.clock.every` / `afterStart` callback, or
// started without `await` (`void work($)`), does not count.
//
// Usage: node scripts/check-startup.mjs [mods/<name> ...]      exit 1 when a handler waits on slow work
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

/** typescript, from the repository's node_modules or the global install (it ships with `tsc`). */
function loadTypescript() {
  for (const base of [ROOT, (() => { try { return execSync('npm root -g', { encoding: 'utf8' }).trim() + '/' } catch { return undefined } })()]) {
    if (base === undefined) continue
    try {
      return createRequire(join(base, 'noop.js'))('typescript')
    } catch {}
  }
  console.error('check-startup: the typescript package is needed (npm i -g typescript)')
  process.exit(2)
}
const ts = loadTypescript()

const SLOW_CALL = /^\$\.(?:(?:process|http|model|mcp|mods)\.\w+|agent\.(?!register$)\w+|fs\.(?:list|ancestors)|clock\.sleep)$/
const DEFERRERS = /^(?:\$\.clock\.(?:after|every)|afterStart)$/

const calleeText = (call, file) => call.expression.getText(file).replace(/\?\./g, '.').replace(/\s+/g, '')

/** Every call under `node`, skipping callbacks handed to $.clock.after / $.clock.every. */
function callsUnder(node, file, out = []) {
  const visit = n => {
    if (ts.isCallExpression(n)) {
      const callee = calleeText(n, file)
      if (DEFERRERS.test(callee)) return
      out.push({ call: n, callee })
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

function awaitsUnder(node) {
  const out = []
  const visit = n => {
    if (ts.isCallExpression(n) && DEFERRERS.test(n.expression.getText().replace(/\?\./g, '.'))) return
    if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** Top-level functions of the file, by name: `function f() {}` and `const f = (...) => ...`. */
function topLevelFunctions(file) {
  const fns = new Map()
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) fns.set(statement.name.text, statement.body)
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          fns.set(d.name.text, d.initializer.body)
        }
      }
    }
  }
  return fns
}

/** Why an awaited expression is slow, or undefined. */
function slowReason(expression, file, isSlowFn) {
  for (const { callee } of callsUnder(expression, file)) {
    if (SLOW_CALL.test(callee)) return callee
    if (/^[A-Za-z_$][\w$]*$/.test(callee) && isSlowFn(callee)) return `${callee}() → ${isSlowFn(callee)}`
  }
  return undefined
}

function checkFile(path) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const fns = topLevelFunctions(file)
  const memo = new Map()
  const isSlowFn = name => {
    if (!fns.has(name)) return undefined
    if (memo.has(name)) return memo.get(name)
    memo.set(name, undefined) // recursion guard
    let reason
    for (const a of awaitsUnder(fns.get(name))) {
      reason = slowReason(a, file, isSlowFn)
      if (reason !== undefined) break
    }
    memo.set(name, reason)
    return reason
  }

  const problems = []
  const visit = n => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.arguments.length >= 2 &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      n.arguments[0].text === 'session.start'
    ) {
      let handler = n.arguments[n.arguments.length - 1]
      if (ts.isIdentifier(handler)) handler = fns.get(handler.text)
      if (handler !== undefined) {
        for (const a of awaitsUnder(handler)) {
          const reason = slowReason(a, file, isSlowFn)
          if (reason === undefined) continue
          const { line } = file.getLineAndCharacterOfPosition(a.getStart(file))
          problems.push(`line ${line + 1}: ${a.getText(file).replace(/\s+/g, ' ').slice(0, 80)}  [${reason}]`)
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(file)
  return problems
}

const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : readdirSync(join(ROOT, 'mods')).map(name => join('mods', name))
let count = 0
let mods = 0
for (const dir of dirs) {
  const hooks = resolve(ROOT, dir, 'hooks')
  if (!existsSync(hooks)) continue
  let flagged = false
  for (const name of readdirSync(hooks).filter(f => /\.(m|c)?[jt]sx?$/.test(f) && !f.endsWith('.d.ts'))) {
    const problems = checkFile(join(hooks, name))
    if (problems.length === 0) continue
    flagged = true
    count += problems.length
    console.log(`✗ ${dir}/hooks/${name}: session.start waits on slow work\n    ${problems.join('\n    ')}`)
  }
  if (flagged) mods += 1
}
console.log(
  count === 0
    ? '✓ no session.start hook waits on a process, the network, a model, the hub or a directory scan'
    : `${count} slow wait(s) in ${mods} mod(s): defer them with $.clock.after or do them on first use`,
)
process.exit(count === 0 ? 0 : 1)
