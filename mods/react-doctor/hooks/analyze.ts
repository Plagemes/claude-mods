import { lineAt, matchBackward, matchBracket, scan } from './scan'
import type { JsxTag } from './scan'

/** One problem found, at a 1-based line. */
export type Issue = { line: number; rule: Rule; message: string }

export type Rule =
  | 'conditional-hook'
  | 'hook-in-loop'
  | 'hook-in-callback'
  | 'hook-after-return'
  | 'missing-deps'
  | 'no-deps-array'
  | 'set-state-in-render'
  | 'missing-key'
  | 'async-effect'

/** A component or custom hook: its name and the offsets of its parameters and body. */
type Fn = { name: string; params: string; bodyStart: number; bodyEnd: number }

type BlockKind = 'if' | 'loop' | 'function' | 'other'

const DEPS_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useMemo', 'useCallback', 'useImperativeHandle'])
const NEEDS_DEPS = new Set(['useMemo', 'useCallback'])
const EFFECTS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect'])
const KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'async', 'of', 'as', 'satisfies',
])
const COMPONENT_NAME = /^(?:[A-Z][\w$]*|use[A-Z0-9][\w$]*)$/
const HOOK_CALL = /\b(use[A-Z0-9][\w$]*)\s*(?:<[^()]*?>)?\s*\(/g
const WRAPPERS = /^\s*(?:React\s*\.\s*)?(?:memo|forwardRef|observer|styled\s*\.\s*\w+)\s*(?:<[^()]*?>)?\s*\(/

/** Splits at commas outside brackets. */
const splitTop = (text: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if ('{([<'.includes(char)) depth += 1
    else if ('})]>'.includes(char) && !(char === '>' && text[i - 1] === '=')) depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(from, i))
      from = i + 1
    }
  }
  parts.push(text.slice(from))
  return parts
}

/** The text before a top-level `=` (a default value), if any. */
const beforeDefault = (text: string): string => {
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if ('{([<'.includes(char)) depth += 1
    else if ('})]>'.includes(char)) depth -= 1
    else if (char === '=' && depth === 0 && text[i + 1] !== '>' && text[i + 1] !== '=') return text.slice(0, i)
  }
  return text
}

/** Identifiers a destructuring pattern or a parameter list binds: `{ a, b: c, ...d }: Props`, `[e, f = 1]`, `g: string`. */
export const boundNames = (pattern: string): string[] => {
  const names: string[] = []
  const visit = (element: string) => {
    const text = beforeDefault(element).trim().replace(/^\.\.\./, '').trim()
    if (text.startsWith('{') || text.startsWith('[')) {
      let depth = 0
      let end = 0
      for (; end < text.length; end += 1) {
        if ('{['.includes(text[end] ?? '')) depth += 1
        else if ('}]'.includes(text[end] ?? '') && --depth === 0) break
      }
      for (const inner of splitTop(text.slice(1, end))) {
        if (text.startsWith('[')) visit(inner)
        else {
          const colon = beforeDefault(inner).search(/:(?!:)/)
          visit(colon >= 0 ? inner.slice(colon + 1) : inner)
        }
      }
      return
    }
    const name = /^([A-Za-z_$][\w$]*)/.exec(text)?.[1]
    if (name !== undefined && !KEYWORDS.has(name)) names.push(name)
  }
  for (const element of splitTop(pattern)) visit(element)
  return [...new Set(names)]
}

/** The arguments of a call whose `(` is at `open`, split at top-level commas: offsets and text. */
const callArgs = (code: string, open: number): { start: number; end: number; text: string }[] => {
  const close = matchBracket(code, open)
  if (close < 0) return []
  const args: { start: number; end: number; text: string }[] = []
  let from = open + 1
  let depth = 0
  for (let i = open + 1; i < close; i += 1) {
    const char = code[i] ?? ''
    if ('{(['.includes(char)) depth += 1
    else if ('})]'.includes(char)) depth -= 1
    else if (char === ',' && depth === 0) {
      args.push({ start: from, end: i, text: code.slice(from, i) })
      from = i + 1
    }
  }
  if (code.slice(from, close).trim() !== '') args.push({ start: from, end: close, text: code.slice(from, close) })
  return args
}

/** Where a function's parameter list and block body are, from the offset just after its name's `=` or at `function`. */
const functionAt = (code: string, from: number): { params: string; bodyStart: number } | undefined => {
  let i = from
  const wrapped = WRAPPERS.exec(code.slice(i, i + 200))
  if (wrapped !== null) i += wrapped[0].length
  const rest = code.slice(i, i + 400)
  const fnKeyword = /^\s*(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*(?:<[^()]*?>)?\s*\(/.exec(rest)
  const arrowParen = fnKeyword === null ? /^\s*(?:async\s+)?(?:<[^()]*?>\s*)?\(/.exec(rest) : null
  const opener = fnKeyword ?? arrowParen
  let params: string
  let after: number
  if (opener !== null) {
    const open = i + opener[0].length - 1
    const close = matchBracket(code, open)
    if (close < 0) return undefined
    params = code.slice(open + 1, close)
    after = close + 1
  } else {
    const arrowIdent = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?==>)/.exec(rest)
    if (arrowIdent === null) return undefined
    params = arrowIdent[1] ?? ''
    after = i + arrowIdent[0].length
  }
  // A return type, then the arrow (for an arrow function), then the body's brace.
  const tail = (fnKeyword !== null ? /^\s*(?::\s*[^{;]*?)?\s*\{/ : /^\s*(?::\s*[^={;]*?)?\s*=>\s*\{/).exec(code.slice(after, after + 300))
  return tail === null ? undefined : { params, bodyStart: after + tail[0].length - 1 }
}

/** Components (capitalized) and custom hooks (`use…`) declared with `function` or as arrow/function constants. */
export const findFunctions = (code: string): Fn[] => {
  const found: Fn[] = []
  const add = (name: string, from: number) => {
    const at = functionAt(code, from)
    if (at === undefined) return
    const bodyEnd = matchBracket(code, at.bodyStart)
    if (bodyEnd > 0) found.push({ name, params: at.params, bodyStart: at.bodyStart, bodyEnd })
  }
  for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) {
    const name = match[1] ?? ''
    if (COMPONENT_NAME.test(name)) add(name, match.index ?? 0)
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?!=)/g)) {
    const name = match[1] ?? ''
    if (COMPONENT_NAME.test(name)) add(name, (match.index ?? 0) + match[0].length)
  }
  for (const match of code.matchAll(/\bexport\s+default\s+(?=(?:async\s+)?function\s*\(|\(|(?:React\s*\.\s*)?(?:memo|forwardRef)\s*\()/g)) {
    add('default export', (match.index ?? 0) + match[0].length)
  }
  return found.sort((a, b) => a.bodyStart - b.bodyStart)
}

/** What opened the block whose `{` is at `open`: an if/else/switch, a loop, a function, or something else. */
const blockKind = (code: string, open: number): BlockKind => {
  const start = Math.max(0, open - 300)
  const before = code.slice(start, open).trimEnd()
  if (before.endsWith('=>')) return 'function'
  if (/\belse$/.test(before)) return 'if'
  if (/\bdo$/.test(before)) return 'loop'
  const typed = /\)\s*:\s*[^;{}()=]*$/.exec(before)
  const closeAt = before.endsWith(')') ? before.length - 1 : typed !== null ? typed.index : -1
  if (closeAt < 0) return 'other'
  const paren = matchBackward(code, start + closeAt)
  if (paren < 0) return 'other'
  const head = code.slice(Math.max(0, paren - 120), paren).trimEnd()
  if (/\b(?:if|switch)$/.test(head)) return 'if'
  if (/\b(?:for|while)$/.test(head) || /\bfor\s+await$/.test(head)) return 'loop'
  if (/\bcatch$/.test(head)) return 'other'
  return 'function'
}

/**
 * Whether `index` lies in an arrow function's expression body (`x => f(x)`)
 * that starts after `from`: such a body runs later, not during render.
 */
const inArrowBody = (code: string, from: number, index: number): boolean => {
  for (const arrow of code.slice(from, index).matchAll(/=>/g)) {
    let i = from + (arrow.index ?? 0) + 2
    while (/\s/.test(code[i] ?? '')) i += 1
    if (code[i] === '{') continue
    let depth = 0
    let end = i
    for (; end < code.length; end += 1) {
      const char = code[end] ?? ''
      if ('{(['.includes(char)) depth += 1
      else if ('})]'.includes(char)) {
        if (depth === 0) break
        depth -= 1
      } else if ((char === ',' || char === ';') && depth === 0) break
      else if (char === '\n' && depth === 0 && endsStatement(code, i, end)) break
    }
    if (index >= i && index < end) return true
  }
  return false
}

/** The blocks around `index` inside a function's body, innermost last. */
const enclosing = (code: string, fn: Fn, index: number): { open: number; kind: BlockKind }[] => {
  const blocks: { open: number; kind: BlockKind }[] = []
  for (let i = fn.bodyStart + 1; i < index; i += 1) {
    if (code[i] !== '{') continue
    const close = matchBracket(code, i)
    if (close > index) blocks.push({ open: i, kind: blockKind(code, i) })
    else if (close > i) i = close
  }
  return blocks
}

/** Whether the newline at `index` ends a statement begun at `start` (no operator carries it to the next line). */
const endsStatement = (code: string, start: number, index: number): boolean => {
  const lineBefore = code.slice(start, index).trimEnd()
  const lineAfter = code.slice(index + 1, index + 80).trimStart()
  return !(/(?:[=([{,:?&|+\-*/<>!]|=>)$/.test(lineBefore) || /^(?:[.?:&|+\-*/]|\?\?)/.test(lineAfter))
}

/** The text of the statement `index` is in, from its start up to `index`. */
const statementBefore = (code: string, start: number, index: number): string => {
  let depth = 0
  for (let i = index - 1; i > start; i -= 1) {
    const char = code[i] ?? ''
    if ('})]'.includes(char)) depth += 1
    else if ('{(['.includes(char)) {
      if (depth === 0) return code.slice(i + 1, index)
      depth -= 1
    } else if (char === ';' && depth === 0) return code.slice(i + 1, index)
    else if (char === '\n' && depth === 0 && endsStatement(code, start, i)) return code.slice(i + 1, index)
  }
  return code.slice(start + 1, index)
}

const isConditionalStatement = (statement: string): 'if' | 'loop' | undefined => {
  const text = statement.trim()
  if (/^(?:if|else)\b/.test(text) || /&&|\|\||\?\?|\?(?![.:])/.test(text.replace(/\?\.|\?:/g, ''))) return 'if'
  if (/^(?:for|while)\b/.test(text)) return 'loop'
  return undefined
}

/** What the component's top-level declarations bind, and which of them React keeps stable. */
const scopeOf = (code: string, fn: Fn): { names: Set<string>; stable: Set<string>; setters: Set<string> } => {
  const names = new Set(boundNames(fn.params))
  const stable = new Set<string>()
  const setters = new Set<string>()
  const body = code.slice(fn.bodyStart + 1, fn.bodyEnd)
  for (const match of body.matchAll(/\b(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:React\s*\.\s*)?(\w+)?/g)) {
    const bound = boundNames(match[1] ?? '')
    for (const name of bound) names.add(name)
    const hook = match[2] ?? ''
    const second = (match[1] ?? '').startsWith('[') ? bound[1] : undefined
    if ((hook === 'useState' || hook === 'useReducer') && second !== undefined) {
      stable.add(second)
      setters.add(second)
    }
    if (hook === 'useTransition' && second !== undefined) stable.add(second)
    if ((hook === 'useRef' || hook === 'useEffectEvent') && bound.length === 1) stable.add(bound[0] ?? '')
  }
  for (const match of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1] ?? '')
  return { names, stable, setters }
}

/** The identifiers a callback reads, minus those it declares itself, in order of first use. */
const readsOf = (code: string, start: number, end: number): string[] => {
  const text = code.slice(start, end)
  const own = new Set<string>()
  const params = /^\s*(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]*)?=>/.exec(text) ?? /^\s*(?:async\s+)?function\s*\w*\s*\(([^)]*)\)/.exec(text)
  for (const name of boundNames(params?.[1] ?? params?.[2] ?? '')) own.add(name)
  for (const match of text.matchAll(/\b(?:const|let|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/g)) for (const name of boundNames(match[1] ?? '')) own.add(name)
  for (const match of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) own.add(match[1] ?? '')
  for (const match of text.matchAll(/\(([^()]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/g)) for (const name of boundNames(match[1] ?? match[2] ?? '')) own.add(name)

  const reads: string[] = []
  for (const match of text.matchAll(/(?<![\w$])(?<![^.]\.)(?<!^\.)([A-Za-z_$][\w$]*)/g)) {
    const name = match[1] ?? ''
    const at = match.index ?? 0
    const after = text.slice(at + name.length, at + name.length + 3)
    const before = text.slice(0, at).trimEnd().at(-1)
    if (/^\s*:/.test(after) && (before === '{' || before === ',')) continue // an object key
    if (/^\s*=(?![=>])/.test(after)) continue // assigned, or a JSX attribute's name
    if (own.has(name) || KEYWORDS.has(name) || reads.includes(name)) continue
    reads.push(name)
  }
  return reads
}

const hookIssues = (source: string, code: string, fn: Fn, inner: readonly Fn[]): Issue[] => {
  const issues: Issue[] = []
  const scope = scopeOf(code, fn)
  const body = code.slice(fn.bodyStart, fn.bodyEnd)

  for (const call of body.matchAll(HOOK_CALL)) {
    const hook = call[1] ?? ''
    const at = fn.bodyStart + (call.index ?? 0)
    if (inner.some(other => at > other.bodyStart && at < other.bodyEnd)) continue
    const line = lineAt(source, at)
    const blocks = enclosing(code, fn, at)
    const statement = statementBefore(code, fn.bodyStart, at)
    const isInFunction = blocks.some(block => block.kind === 'function') || inArrowBody(code, fn.bodyStart + 1, at)
    const returns = [...body.slice(0, at - fn.bodyStart).matchAll(/\breturn\b/g)].filter(match => {
      const offset = fn.bodyStart + (match.index ?? 0)
      return !enclosing(code, fn, offset).some(block => block.kind === 'function') && !inArrowBody(code, fn.bodyStart + 1, offset)
    })

    if (isInFunction) {
      issues.push({ line, rule: 'hook-in-callback', message: `${hook} is called inside a nested function in ${fn.name}; call hooks only at the top level of a component or hook` })
      continue
    }
    if (blocks.some(block => block.kind === 'loop') || isConditionalStatement(statement) === 'loop') {
      issues.push({ line, rule: 'hook-in-loop', message: `${hook} is called inside a loop in ${fn.name}; hooks must run the same number of times on every render` })
      continue
    }
    if (blocks.some(block => block.kind === 'if') || isConditionalStatement(statement) === 'if') {
      issues.push({ line, rule: 'conditional-hook', message: `${hook} is called conditionally in ${fn.name}; hooks must run in the same order on every render` })
      continue
    }
    if (returns.length > 0) {
      issues.push({ line, rule: 'hook-after-return', message: `${hook} is called after an early return in ${fn.name}, so it does not run on every render` })
      continue
    }

    if (!DEPS_HOOKS.has(hook)) continue
    const args = callArgs(code, code.indexOf('(', at + hook.length))
    const callback = args[hook === 'useImperativeHandle' ? 1 : 0]
    if (callback === undefined) continue
    if (EFFECTS.has(hook) && /^\s*async\b/.test(callback.text)) {
      issues.push({ line, rule: 'async-effect', message: `${hook} gets an async function, which returns a promise instead of a cleanup; call an async function from inside the effect` })
    }
    const last = args.at(-1)
    const deps = last !== undefined && last !== callback && last.text.trim().startsWith('[') ? last : undefined
    if (deps === undefined) {
      if (NEEDS_DEPS.has(hook)) issues.push({ line, rule: 'no-deps-array', message: `${hook} has no dependency array, so it recomputes on every render` })
      continue
    }
    const listed = new Set(
      deps.text
        .trim()
        .slice(1, -1)
        .split(',')
        .map(entry => /^\s*([A-Za-z_$][\w$]*)/.exec(entry)?.[1])
        .filter(name => name !== undefined),
    )
    const missing = readsOf(code, callback.start, callback.end).filter(
      name => scope.names.has(name) && !scope.stable.has(name) && !listed.has(name) && name !== fn.name,
    )
    if (missing.length > 0) {
      issues.push({ line, rule: 'missing-deps', message: `${hook} in ${fn.name} is missing ${missing.length === 1 ? 'a dependency' : 'dependencies'}: ${missing.join(', ')}` })
    }
  }

  for (const setter of scope.setters) {
    for (const call of body.matchAll(new RegExp(`(?<![.\\w$])${setter.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))) {
      const at = fn.bodyStart + (call.index ?? 0)
      if (inner.some(other => at > other.bodyStart && at < other.bodyEnd)) continue
      const blocks = enclosing(code, fn, at)
      if (blocks.some(block => block.kind !== 'other') || inArrowBody(code, fn.bodyStart + 1, at)) continue
      if (isConditionalStatement(statementBefore(code, fn.bodyStart, at)) !== undefined) continue
      const isProp = /=\s*\{\s*$/.test(code.slice(Math.max(0, at - 20), at))
      issues.push({
        line: lineAt(source, at),
        rule: 'set-state-in-render',
        message: isProp
          ? `${setter}(…) is called while ${fn.name} renders (a prop like onClick={${setter}(…)}); pass a function instead: () => ${setter}(…)`
          : `${setter}(…) is called while ${fn.name} renders, which re-renders it again and again; move it into an effect or an event handler`,
      })
    }
  }
  return issues
}

/** `.map(…)` callbacks that return a JSX element without a `key`. */
const keyIssues = (source: string, code: string, tags: readonly JsxTag[]): Issue[] => {
  const issues: Issue[] = []
  const tagAt = new Map(tags.map(tag => [tag.start, tag]))
  const returnedTag = (from: number): JsxTag | undefined => {
    let i = from
    while (/[\s(]/.test(code[i] ?? '')) i += 1
    return tagAt.get(i)
  }
  for (const match of code.matchAll(/\.map\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const callback = callArgs(code, open)[0]
    if (callback === undefined) continue
    const arrow = /^\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>\s*/.exec(callback.text) ?? /^\s*function\s*\w*\s*\([^)]*\)\s*/.exec(callback.text)
    if (arrow === null) continue
    const bodyAt = callback.start + arrow[0].length
    const found: JsxTag[] = []
    if (code[bodyAt] === '{') {
      const end = matchBracket(code, bodyAt)
      for (const ret of code.slice(bodyAt, end).matchAll(/\breturn\b/g)) {
        const between = code.slice(bodyAt + 1, bodyAt + (ret.index ?? 0))
        if (between.split('{').length !== between.split('}').length) continue // a nested function's return
        const tag = returnedTag(bodyAt + (ret.index ?? 0) + 'return'.length)
        if (tag !== undefined) found.push(tag)
      }
    } else {
      const tag = returnedTag(bodyAt)
      if (tag !== undefined) found.push(tag)
    }
    for (const tag of found) {
      if (/(?:^|\s)key\s*=/.test(tag.attrs) || /\{\s*\.\.\./.test(tag.attrs)) continue
      issues.push({
        line: lineAt(source, tag.start),
        rule: 'missing-key',
        message: tag.isFragment
          ? 'a fragment <>…</> returned from .map() cannot take a key; use <Fragment key={…}>'
          : `<${tag.name}> returned from .map() has no key prop`,
      })
    }
  }
  return issues
}

/** The line spans an edit of lines `from`..`to` reaches: the components and hooks it touches, and the edit itself. */
export const affectedSpans = (source: string, range: { from: number; to: number }): { from: number; to: number }[] => {
  const { code } = scan(source)
  const spans = findFunctions(code)
    .map(fn => ({ from: lineAt(source, fn.bodyStart), to: lineAt(source, fn.bodyEnd) }))
    .filter(span => span.from <= range.to && span.to >= range.from)
  return [...spans, range]
}

/**
 * The React mistakes in a file, limited to the components, hooks and `.map`
 * calls that overlap lines `from`..`to` when given (what an edit changed).
 */
export const analyze = (source: string, range?: { from: number; to: number }): Issue[] => {
  const { code, tags } = scan(source)
  const fns = findFunctions(code)
  const touches = (start: number, end: number) =>
    range === undefined || (lineAt(source, start) <= range.to && lineAt(source, end) >= range.from)

  const issues: Issue[] = []
  for (const fn of fns) {
    if (!touches(fn.bodyStart, fn.bodyEnd)) continue
    const inner = fns.filter(other => other !== fn && other.bodyStart > fn.bodyStart && other.bodyEnd < fn.bodyEnd)
    issues.push(...hookIssues(source, code, fn, inner))
  }
  const changed = fns.filter(fn => touches(fn.bodyStart, fn.bodyEnd))
  for (const issue of keyIssues(source, code, tags)) {
    const isInChanged = range === undefined || (issue.line >= range.from && issue.line <= range.to)
    const offsetLine = issue.line
    if (isInChanged || changed.some(fn => lineAt(source, fn.bodyStart) <= offsetLine && lineAt(source, fn.bodyEnd) >= offsetLine)) issues.push(issue)
  }
  const seen = new Set<string>()
  return issues
    .filter(issue => {
      const key = `${issue.line}:${issue.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.line - b.line)
}
