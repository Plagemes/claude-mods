#!/usr/bin/env node
// Flags `ui.render` hooks that can leave a pane blank.
//
// In Claude Code Desktop a Pane the engine draws itself (no hook answered, the answer was refused, or the hook threw)
// shows only "Nothing to show yet — <plugin> has not drawn in this pane"; in the terminal the pane is empty or closes.
// The engine draws its own when:
//   - a tree holds the engine's own drawing (`await next(e)` at the bottom of the chain is `{ type: 'engine' }`) under a
//     Box with a size, position, display or overflow prop: the WHOLE tree is refused (debug log: `ui.render (Pane): a
//     hook returned a tree that does not validate (engine node under a Box with prop "minWidth"); drawing the
//     engine's own`). This blanked the Claude Mods panel on every tab whose owner composed with `{await next(e)}`;
//   - a Pane tree holds an engine node at all: on the desktop it draws as that placeholder;
//   - the hook returns nothing (the wrong shape), falls through to `next(e)` for its own pane, or throws;
//   - the hook outruns its budget waiting on slow work.
//
// Rules, for every `on('ui.render', ...)` hook in mods/*/hooks (the handler, and the top-level functions it calls):
//   engine-node  A Pane tree embeds what `next(e)` returned without `hubTabBelow(...)` (shared/render-safe.ts), or any
//                tree embeds it under a Box with one of SIZED_PROPS.
//   no-answer    A hook returns nothing (`return`, `return null`, `return undefined`, or falls off the end), or a hook on
//                the mod's own pane (not the hub's `claude-mods`) passes to `next(e)` instead of drawing.
//   pane-id      A pane id the file opens (`$.ui.open({ id })`) is matched by none of its Pane render hooks, or a hub tab
//                id the file reads (`hubTabIs($, id)`) is none it registers (`hubHello(..., tab)` / `registerTab`).
//   unguarded    A Pane hook has neither a `.catch(...)` handler nor a try/catch around its whole body.
//   slow-await   A render path awaits slow work: $.process · $.http · $.model · $.agent (not register) · $.mcp ·
//                $.mods · $.fs · $.clock.sleep. Awaiting `$.state` (`read`, `hubTabIs`) is how a drawing subscribes to
//                its values and is fine; so is `next(e)`. Closures a drawing hands to a Button (`onPress`, ...) do not
//                count: they run on a press, not while drawing.
//
// Usage: node scripts/check-render.mjs [mods/<name> ...]      exit 1 when a hook is flagged
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const HUB_PANE = 'claude-mods'

/** typescript, from the repository's node_modules or the global install (it ships with `tsc`). */
function loadTypescript() {
  for (const base of [ROOT, (() => { try { return execSync('npm root -g', { encoding: 'utf8' }).trim() + '/' } catch { return undefined } })()]) {
    if (base === undefined) continue
    try {
      return createRequire(join(base, 'noop.js'))('typescript')
    } catch {}
  }
  console.error('check-render: the typescript package is needed (npm i -g typescript)')
  process.exit(2)
}
const ts = loadTypescript()

/** Box props under which the engine refuses an engine node (the engine's own list, 2.1.294). */
const SIZED_PROPS = new Set(['display', 'overflow', 'position', 'width', 'height', 'minWidth', 'minHeight', 'top', 'left', 'right', 'bottom'])
const SLOW_CALL = /^\$\.(?:(?:process|http|model|mcp|mods|fs)\.\w+|agent\.(?!register$)\w+|clock\.sleep)$/
/** Calls whose argument is made safe to embed: the engine node is dropped. */
const CLEANERS = new Set(['hubTabBelow', 'paneFailure'])
/** Object keys whose function values run on a person's act, not while drawing. */
const HANDLER_KEY = /^on[A-Z]/

const calleeText = (call, file) => call.expression.getText(file).replace(/\?\./g, '.').replace(/\s+/g, '')
const lineOf = (file, node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
const isFunctionLike = n => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)

/** A function a drawing hands on to run later: a JSX `onX={...}` attribute or an `onX: ...` property. */
function isDeferredHandler(fn) {
  const parent = fn.parent
  if (parent === undefined) return false
  if (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) return HANDLER_KEY.test(parent.parent.name.getText())
  if (ts.isPropertyAssignment(parent)) return HANDLER_KEY.test(parent.name.getText())
  return false
}

/** Top-level functions and string/object constants of a file. */
function topLevel(file) {
  const fns = new Map()
  const consts = new Map()
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) fns.set(statement.name.text, statement)
    if (!ts.isVariableStatement(statement)) continue
    for (const d of statement.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue
      let init = d.initializer
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init) || ts.isParenthesizedExpression(init)) init = init.expression
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fns.set(d.name.text, init)
      else consts.set(d.name.text, init)
    }
  }
  return { fns, consts }
}

/** The string (or RegExp) an expression stands for, when the file says it plainly; undefined otherwise. */
function valueOf(expr, consts, depth = 0) {
  if (expr === undefined || depth > 5) return undefined
  while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression
  if (ts.isStringLiteralLike(expr)) return expr.text
  if (ts.isRegularExpressionLiteral(expr)) {
    const text = expr.text
    const end = text.lastIndexOf('/')
    return new RegExp(text.slice(1, end), text.slice(end + 1))
  }
  if (ts.isTemplateExpression(expr)) return expr.head.text + expr.templateSpans.map(span => `x${span.literal.text}`).join('')
  if (ts.isIdentifier(expr)) return valueOf(consts.get(expr.text), consts, depth + 1)
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const object = consts.get(expr.expression.text)
    const obj = object && unwrap(object)
    if (obj && ts.isObjectLiteralExpression(obj)) {
      const prop = obj.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === expr.name.text)
      return prop ? valueOf(prop.initializer, consts, depth + 1) : undefined
    }
  }
  return undefined
}
const unwrap = expr => {
  while (expr && (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr))) expr = expr.expression
  return expr
}
const propOf = (obj, name) => {
  obj = unwrap(obj)
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined
  const prop = obj.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === name)
  return prop?.initializer
}

/** Whether a block can run past its end (no return or throw on every path), approximately. */
function canFallThrough(statement) {
  if (statement === undefined) return true
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false
  if (ts.isBlock(statement)) return statement.statements.length === 0 || canFallThrough(statement.statements.at(-1)) && !statement.statements.some(s => ts.isReturnStatement(s) || ts.isThrowStatement(s))
  if (ts.isIfStatement(statement)) return statement.elseStatement === undefined || canFallThrough(statement.thenStatement) || canFallThrough(statement.elseStatement)
  if (ts.isTryStatement(statement)) {
    if (statement.finallyBlock && !canFallThrough(statement.finallyBlock)) return false
    return canFallThrough(statement.tryBlock) || (statement.catchClause !== undefined && canFallThrough(statement.catchClause.block))
  }
  if (ts.isSwitchStatement(statement)) {
    const clauses = statement.caseBlock.clauses
    if (!clauses.some(c => ts.isDefaultClause(c))) return true
    return clauses.some(c => c.statements.length > 0 && canFallThrough(ts.factory.createBlock(c.statements)))
  }
  return true
}

function checkFile(path) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const { fns, consts } = topLevel(file)
  const problems = []
  const flag = (rule, node, text) => problems.push(`line ${lineOf(file, node)}: ${rule}: ${text}`)

  /** The body of a function-like node, or of the top-level function an identifier names. */
  const bodyOf = handler => {
    if (handler === undefined) return undefined
    if (ts.isIdentifier(handler)) return bodyOf(fns.get(handler.text))
    return isFunctionLike(handler) ? handler : undefined
  }

  // Slow work, transitively through top-level functions (as scripts/check-startup.mjs does).
  const slowMemo = new Map()
  const slowIn = (node, seen = new Set()) => {
    let reason
    const visit = n => {
      if (reason !== undefined) return
      // A function defined while drawing runs when it is called (a press, a copy), not while drawing.
      if (n !== node && isFunctionLike(n)) return
      if (ts.isAwaitExpression(n)) {
        const inner = n.expression
        const calls = []
        const collect = c => {
          if (c !== inner && isFunctionLike(c)) return
          if (ts.isCallExpression(c)) calls.push(c)
          ts.forEachChild(c, collect)
        }
        collect(inner)
        for (const call of calls) {
          const callee = calleeText(call, file)
          if (SLOW_CALL.test(callee)) { reason = callee; return }
          if (/^[A-Za-z_$][\w$]*$/.test(callee) && fns.has(callee) && !seen.has(callee)) {
            const deeper = slowOfFn(callee, seen)
            if (deeper !== undefined) { reason = `${callee}() → ${deeper}`; return }
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(node)
    return reason
  }
  const slowOfFn = (name, seen) => {
    if (slowMemo.has(name)) return slowMemo.get(name)
    slowMemo.set(name, undefined)
    const reason = slowIn(fns.get(name), new Set([...seen, name]))
    slowMemo.set(name, reason)
    return reason
  }

  /** Engine nodes embedded in JSX inside `fn` and the top-level functions it reaches with `next` in hand. */
  const engineEmbeds = (fn, isPane, seen = new Set()) => {
    const nextVars = new Set()
    const visitVars = n => {
      // `const below = await next(e)` / `below = await next(e)`
      const isNextCall = x => { x = unwrap(x); if (x && ts.isAwaitExpression(x)) x = unwrap(x.expression); return x && ts.isCallExpression(x) && x.expression.getText(file) === 'next' }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isNextCall(n.initializer)) nextVars.add(n.name.text)
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isNextCall(n.right)) nextVars.add(n.left.text)
      ts.forEachChild(n, visitVars)
    }
    visitVars(fn)
    const embedsNext = expr => {
      let found = false
      const visit = n => {
        if (found) return
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && CLEANERS.has(n.expression.text)) return
        if (ts.isCallExpression(n) && n.expression.getText(file) === 'next') found = true
        if (ts.isIdentifier(n) && nextVars.has(n.text) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) found = true
        if (!found) ts.forEachChild(n, visit)
      }
      visit(expr)
      return found
    }
    const sizedAncestor = node => {
      for (let p = node.parent; p !== undefined && p !== fn; p = p.parent) {
        if (ts.isJsxElement(p)) {
          for (const attr of p.openingElement.attributes.properties) {
            if (ts.isJsxAttribute(attr) && SIZED_PROPS.has(attr.name.getText())) return `${p.openingElement.tagName.getText()} ${attr.name.getText()}`
          }
        }
      }
      return undefined
    }
    const visit = n => {
      if (n !== fn && isFunctionLike(n) && isDeferredHandler(n)) return
      if (ts.isJsxExpression(n) && n.expression !== undefined && !(n.parent && ts.isJsxAttribute(n.parent)) && embedsNext(n.expression)) {
        const sized = sizedAncestor(n)
        if (sized !== undefined) flag('engine-node', n, `what next(e) drew sits under ${sized}: the engine refuses the whole tree; wrap it in hubTabBelow(...)`)
        else if (isPane) flag('engine-node', n, 'a Pane tree embeds what next(e) drew: on the desktop the engine node is the "has not drawn" placeholder; wrap it in hubTabBelow(...)')
      }
      // A top-level drawing function handed `next` draws under the same rule.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && fns.has(n.expression.text) && !seen.has(n.expression.text) && n.arguments.some(a => a.getText(file) === 'next')) {
        engineEmbeds(fns.get(n.expression.text), isPane, new Set([...seen, n.expression.text]))
      }
      ts.forEachChild(n, visit)
    }
    visit(fn)
  }

  const renderPanes = [] // { requestId, node }
  const opened = [] // { id, node }
  const tabsRead = []
  const tabsRegistered = []

  // The panes this file opens are its own: a hook on one of them draws it, never passes it on.
  const collectOpened = n => {
    if (ts.isCallExpression(n) && /^\$\.ui\.open$/.test(calleeText(n, file)) && n.arguments[0]) {
      opened.push({ id: valueOf(propOf(n.arguments[0], 'id'), consts), expr: propOf(n.arguments[0], 'id'), node: n })
    }
    ts.forEachChild(n, collectOpened)
  }
  collectOpened(file)
  // A RegExp requestId in a file that opens panes under computed ids (`log-tail-${n}`) is that family of its own.
  const isOwnPane = requestId =>
    requestId !== undefined &&
    opened.some(({ id }) => (typeof id === 'string' ? (requestId instanceof RegExp ? requestId.test(id) : requestId === id) : requestId instanceof RegExp))

  const visit = n => {
    if (ts.isCallExpression(n)) {
      const callee = calleeText(n, file)
      if (callee === 'hubTabIs' && n.arguments[1]) tabsRead.push({ id: valueOf(n.arguments[1], consts), node: n })
      if (callee === 'hubHello' && n.arguments[2]) tabsRegistered.push(valueOf(propOf(ts.isIdentifier(n.arguments[2]) ? consts.get(n.arguments[2].text) : n.arguments[2], 'id'), consts))
      if (/^\$\.mods\.registerTab$/.test(callee) && n.arguments[0]) tabsRegistered.push(valueOf(propOf(ts.isIdentifier(n.arguments[0]) ? consts.get(n.arguments[0].text) : n.arguments[0], 'id'), consts))
      if (ts.isIdentifier(n.expression) && n.expression.text === 'on' && n.arguments.length >= 2 && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === 'ui.render') {
        checkHook(n)
      }
    }
    ts.forEachChild(n, visit)
  }

  function checkHook(call) {
    const matcher = call.arguments.length >= 3 ? call.arguments[1] : undefined
    const component = valueOf(propOf(matcher, 'component'), consts)
    const requestId = valueOf(propOf(matcher, 'requestId'), consts)
    const isPane = component === 'Pane'
    const isHubPane = requestId === HUB_PANE
    if (isPane) renderPanes.push({ requestId, node: call })
    const handler = bodyOf(call.arguments[call.arguments.length - 1])
    if (handler === undefined) return
    const hasCatch = ts.isPropertyAccessExpression(call.parent) && call.parent.name.text === 'catch' && ts.isCallExpression(call.parent.parent)

    // no-answer: returns that carry nothing; a block that can run off its end; an own pane passed to next(e).
    const body = handler.body
    if (ts.isBlock(body)) {
      const returns = []
      const collect = n => {
        if (n !== handler && isFunctionLike(n)) return
        if (ts.isReturnStatement(n)) returns.push(n)
        ts.forEachChild(n, collect)
      }
      collect(body)
      for (const r of returns) {
        const value = r.expression && unwrap(r.expression)
        if (value === undefined || value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined')) {
          flag('no-answer', r, `returns ${value === undefined ? 'nothing' : value.getText(file)}: the hook is skipped and the engine draws its own`)
        } else if (isPane && !isHubPane && isOwnPane(requestId) && ts.isCallExpression(value) && value.expression.getText(file) === 'next') {
          flag('no-answer', r, `its own pane "${requestId}" passes to next(e): the engine draws the blank pane; draw an empty state instead`)
        }
      }
      if (canFallThrough(body)) flag('no-answer', handler, 'the hook can end without returning a tree')
    } else {
      const value = unwrap(body)
      if (value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined')) flag('no-answer', body, 'returns nothing')
    }

    // engine-node
    engineEmbeds(handler, isPane)

    // unguarded: a Pane hook with no .catch and no try/catch around its body (inline, or in the one function it returns).
    if (isPane && !hasCatch) {
      const isWrapped = fnNode => {
        const b = fnNode?.body
        if (b === undefined) return false
        if (ts.isBlock(b)) return b.statements.length === 1 && ts.isTryStatement(b.statements[0]) && b.statements[0].catchClause !== undefined
        let inner = unwrap(b)
        if (ts.isAwaitExpression(inner)) inner = unwrap(inner.expression)
        return ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && isWrapped(fns.get(inner.expression.text))
      }
      if (!isWrapped(handler)) flag('unguarded', call, `a Pane hook ("${requestId ?? '?'}") with no .catch(...) and no try/catch: a throw leaves the engine's blank pane (paneFailure in shared/render-safe.ts)`)
    }

    // slow-await
    const slow = slowIn(handler)
    if (slow !== undefined) flag('slow-await', call, `the drawing waits on ${slow}: keep slow work out of render and draw from state`)
  }

  visit(file)

  // pane-id: every pane the file opens is drawn by one of its Pane render hooks.
  for (const { id, expr, node } of opened) {
    if (id === undefined) continue // computed at run time: nothing to compare statically
    const isDrawn = renderPanes.some(({ requestId }) => requestId === undefined || (requestId instanceof RegExp ? requestId.test(id) : requestId === id))
    if (!isDrawn) flag('pane-id', node, `opens pane "${id}" (${expr?.getText(file)}) but no ui.render hook here matches requestId "${id}"`)
  }
  const registered = tabsRegistered.filter(id => typeof id === 'string')
  if (registered.length > 0) {
    for (const { id, node } of tabsRead) {
      if (typeof id === 'string' && !registered.includes(id)) flag('pane-id', node, `draws hub tab "${id}" but registers ${registered.map(t => `"${t}"`).join(', ')}`)
    }
  }
  return problems
}

const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : readdirSync(join(ROOT, 'mods')).map(name => join('mods', name))
let count = 0
let mods = 0
let hooked = 0
for (const dir of dirs) {
  const hooks = resolve(ROOT, dir, 'hooks')
  if (!existsSync(hooks)) continue
  let flagged = false
  for (const name of readdirSync(hooks).filter(f => /\.(m|c)?[jt]sx?$/.test(f) && !f.endsWith('.d.ts'))) {
    const path = join(hooks, name)
    if (!readFileSync(path, 'utf8').includes("'ui.render'")) continue
    hooked += 1
    const problems = checkFile(path)
    if (problems.length === 0) continue
    flagged = true
    count += problems.length
    console.log(`✗ ${dir}/hooks/${name}\n    ${problems.join('\n    ')}`)
  }
  if (flagged) mods += 1
}
console.log(
  count === 0
    ? `✓ ${hooked} hooks files with ui.render: every pane draws a tree of its own, guarded, without the engine's node or slow waits`
    : `${count} problem(s) in ${mods} mod(s): see the rules at the top of scripts/check-render.mjs`,
)
process.exit(count === 0 ? 0 : 1)
