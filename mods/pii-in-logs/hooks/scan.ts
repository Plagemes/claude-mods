import { findSecrets } from './shared/secrets'

/** A log statement that prints something that looks personal or secret. */
export type Finding = {
  /** Line of the statement in the text that was scanned, from 1. */
  line: number
  /** The statement, on one line and cut short. */
  call: string
  /** What it prints: `password`, `user.email`, `user (the whole object)` ... */
  reasons: string[]
}

export const ALLOW_MARKER = 'pii-in-logs: allow'

const MAX_CALL_LINES = 8
/** Longer lines are minified or generated code: not read. */
const MAX_LINE_CHARS = 2000
const MAX_SHOWN_CHARS = 110
const MAX_REASONS = 3
const FILE_PATTERN = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kts?|scala|swift|php|cs|rs|dart|lua|sh|bash|zsh|c|cc|cpp|cxx|h|hpp|m|mm|ipynb)$/i
const TEST_PATTERN = /(?:^|[/\\])(?:tests?|__tests__|specs?|fixtures?|mocks?|e2e)[/\\]|\.(?:test|spec)\.[a-z]+$|_test\.(?:go|py|rb)$|(?:Test|Tests|IT)\.(?:java|kt)$/i

/** Code files worth scanning: no docs, no tests (a fake password in a test is not a leak). */
export const isScannedFile = (path: string): boolean => FILE_PATTERN.test(path) && !TEST_PATTERN.test(path)

const LEVELS =
  'log|info|warn|warning|error|err|debug|trace|fatal|critical|exception|verbose|notice|print|printf|println|infof|warnf|errorf|debugf|fatalf|panic|panicf|infow|warnw|errorw|debugw'

/** Where a log call starts, in a line whose strings and comments are blanked; the match ends right after the name. */
const LOG_CALL = new RegExp(
  [
    `(?<![\\w$.])console\\.(?:log|info|warn|error|debug|trace|dir|table)`,
    `(?<![\\w$])(?:[\\w$]+(?:\\.|->|::))*(?:logger|log|logging|_logger|_log)(?:\\.|->|::)(?:${LEVELS})(?![\\w$])`,
    `(?<![\\w$.])fmt\\.(?:Print|Printf|Println|Fprint|Fprintf|Fprintln)`,
    `(?<![\\w$.])slog\\.(?:Info|Warn|Error|Debug)`,
    `(?<![\\w$.])System\\.(?:out|err)\\.(?:print|println|printf)`,
    `(?<![\\w$.])Console\\.(?:Write|WriteLine)`,
    `(?<![\\w$.])Log\\.(?:d|e|i|v|w|wtf)(?![\\w$])`,
    `(?<![\\w$.])Timber\\.[a-z]+`,
    `(?<![\\w$.])(?:dbg!|println!|eprintln!|print!|eprint!|(?:info|warn|error|debug|trace)!|print|println|printf|puts|echo|error_log|var_dump|print_r|NSLog)(?![\\w$])`,
  ].join('|'),
  'gi',
)

/** Blanks the inside of strings and drops comments, keeping every other character at its place. */
export const maskLine = (line: string): string => {
  let out = ''
  let quote = ''
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string
    if (quote !== '') {
      if (char === '\\') {
        out += '  '
        i += 1
      } else if (char === quote) {
        quote = ''
        out += char
      } else {
        out += ' '
      }
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
    } else if ((char === '/' && line[i + 1] === '/') || (char === '#' && (i === 0 || /\s/.test(line[i - 1] as string)))) {
      break
    } else {
      out += char
    }
  }
  return out
}

const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|--|;|%)/

const BLOCK_OPENERS = ['"""', "'''", '/*'] as const

/** The first block opener on a line: Python triple quotes anywhere, `/*` only as the first thing on the line. */
const firstOpener = (line: string): { at: number; closer: string } | undefined => {
  const found = BLOCK_OPENERS.map(opener => ({ at: line.indexOf(opener), closer: opener === '/*' ? '*/' : opener }))
    .filter(({ at, closer }) => at !== -1 && (closer !== '*/' || line.slice(0, at).trim() === ''))
    .sort((a, b) => a.at - b.at)
  return found[0]
}

/** The lines with block comments and docstrings blanked: prose in them is not code. */
export const withoutBlocks = (lines: readonly string[]): string[] => {
  const out: string[] = []
  let closer = ''
  for (const line of lines) {
    let rest = line
    let kept = ''
    for (;;) {
      if (closer !== '') {
        const end = rest.indexOf(closer)
        if (end === -1) break
        rest = rest.slice(end + closer.length)
        closer = ''
      }
      const opener = firstOpener(rest)
      if (opener === undefined) {
        kept += rest
        break
      }
      kept += rest.slice(0, opener.at)
      rest = rest.slice(opener.at + opener.closer.length)
      closer = opener.closer
    }
    out.push(kept)
  }
  return out
}

type Call = { line: number; name: string; args: string; text: string; key: string; isAllowed: boolean }

/** The arguments of the call whose name ends at `from` in `masked[index]`: the balanced parentheses, across lines if need be. */
const argumentsOf = (lines: readonly string[], masked: readonly string[], index: number, from: number): string => {
  const first = masked[index] as string
  const open = first.slice(from).search(/\S/)
  if (open === -1 || first[from + open] !== '(') return (lines[index] as string).slice(from)
  let depth = 0
  let collected = ''
  for (let row = index; row < Math.min(lines.length, index + MAX_CALL_LINES); row += 1) {
    const mask = masked[row] as string
    const original = lines[row] as string
    for (let col = row === index ? from + open : 0; col < mask.length; col += 1) {
      const char = mask[col]
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      if (depth === 0 && (row > index || col > from + open)) return collected + original.slice(row === index ? from + open + 1 : 0, col)
    }
    collected += `${original.slice(row === index ? from + open + 1 : 0)}\n`
  }
  return collected
}

const squash = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** Every log call in a piece of code, with its arguments as written. */
const callsIn = (text: string): Call[] => {
  const original = text.split('\n')
  const lines = withoutBlocks(original)
  const masked = lines.map(maskLine)
  const calls: Call[] = []
  lines.forEach((line, index) => {
    if (line.length > MAX_LINE_CHARS || COMMENT_LINE.test(line)) return
    for (const match of (masked[index] as string).matchAll(LOG_CALL)) {
      const args = argumentsOf(lines, masked, index, match.index + match[0].length)
      const isAllowed = (original[index] as string).includes(ALLOW_MARKER) || (original[index - 1] ?? '').includes(ALLOW_MARKER)
      const text = squash(`${match[0]}(${args})`)
      calls.push({ line: index + 1, name: match[0], args, text, key: text.replace(/\s+/g, ''), isAllowed })
    }
  })
  return calls
}

const NAME_SAFE_FIRST = new Set(['is', 'has', 'can', 'should', 'was', 'will', 'needs', 'validate', 'check', 'verify', 'mask', 'redact', 'hide', 'strip', 'sanitize', 'sanitise'])
const NAME_SAFE_LAST = new Set([
  'count', 'length', 'len', 'size', 'limit', 'max', 'min', 'total', 'type', 'kind', 'valid', 'validity', 'verified', 'exists', 'enabled',
  'required', 'regex', 'pattern', 'field', 'label', 'placeholder', 'hint', 'error', 'errors', 'message', 'msg', 'input', 'strength',
  'policy', 'rules', 'ttl', 'expiry', 'expires', 'usage', 'budget', 'masked', 'redacted', 'hidden',
])
const NAME_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'apikey', 'ssn', 'cvv', 'cvc', 'email', 'phone', 'dob', 'birthdate',
  'birthday', 'dateofbirth', 'creditcard', 'cardnumber', 'privatekey', 'accesskey', 'secretkey', 'sessionid', 'socialsecurity',
  'passport', 'iban', 'authorization', 'cookie', 'cookies',
])
const NAME_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'], ['credit', 'card'], ['card', 'number'], ['private', 'key'], ['access', 'key'], ['secret', 'key'],
  ['session', 'id'], ['social', 'security'],
]
const WHOLE_OBJECTS = new Set(['user', 'users', 'customer', 'customers', 'account', 'profile', 'person'])
/** Words that may stand before one of those and still name the whole object: `currentUser`, `userProfile`, `updatedAccount`. */
const OBJECT_QUALIFIERS = new Set([
  'current', 'logged', 'auth', 'authed', 'authenticated', 'signed', 'new', 'old', 'existing', 'target', 'session', 'request', 'req', 'ctx',
  'admin', 'owner', 'my', 'the', 'found', 'loaded', 'fetched', 'saved', 'updated', 'created', 'deleted', 'user', 'customer',
])
const REQUEST_PARTS = new Set(['body', 'headers', 'cookies'])
const REQUEST_NAMES = new Set(['req', 'request', 'ctx', 'event'])

/** `apiKey`, `API_KEY` and `api-key` as ['api', 'key']. */
const wordsOf = (segment: string): string[] =>
  segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(word => word !== '')
    .map(word => word.toLowerCase())

const isSensitiveName = (segment: string): boolean => {
  const words = wordsOf(segment)
  const [first = ''] = words
  if (NAME_SAFE_FIRST.has(first) || NAME_SAFE_LAST.has(words.at(-1) ?? '')) return false
  if (words.some(word => NAME_WORDS.has(word)) || words.includes('birth')) return true
  return words.some((word, at) => NAME_PAIRS.some(([a, b]) => word === a && words[at + 1] === b))
}

const CHAIN = /[A-Za-z_$][\w$]*(?:(?:\?\.|\.|->|::)[A-Za-z_$][\w$]*)*/g

/** What the chain prints that is sensitive, if anything: undefined when it is fine. */
const reasonFor = (chain: string): string | undefined => {
  const parts = chain.split(/\?\.|\.|->|::/)
  const segments = parts.length > 1 && /^(?:this|self)$/.test(parts[0] as string) ? parts.slice(1) : parts
  const last = segments.at(-1) ?? ''
  const lastWords = wordsOf(last)
  if (segments.length > 1 && REQUEST_PARTS.has(last.toLowerCase()) && segments.some(segment => REQUEST_NAMES.has(segment.toLowerCase()))) {
    return `${chain} (the whole request ${last.toLowerCase()})`
  }
  if (NAME_SAFE_LAST.has(lastWords.at(-1) ?? '')) return undefined
  if (segments.length === 1 && WHOLE_OBJECTS.has(lastWords.at(-1) ?? '') && lastWords.slice(0, -1).every(word => OBJECT_QUALIFIERS.has(word))) {
    return `${chain} (the whole object)`
  }
  return segments.some(isSensitiveName) ? chain : undefined
}

/** `{name}` and `{name:?}` inside a format string: the expressions that get printed. */
const braceExpressions = (body: string): string[] =>
  [...body.matchAll(/(?<!\{)\{([^{}:!]+)(?:[:!][^{}]*)?\}(?!\})/g)].map(found => (found[1] as string).trim()).filter(expr => !/^\d*$/.test(expr))

/** The expressions inside a string that get printed: `${x}`, `#{x}`, `\(x)`, `$x` (not in single quotes) and, in format strings, `{x}`. */
const interpolations = (body: string, hasBraces: boolean, quote: string): string[] => [
  ...[...body.matchAll(/\$\{([^}]*)\}|#\{([^}]*)\}|\\\(([^)]*)\)/g)].map(found => found[1] ?? found[2] ?? found[3] ?? ''),
  ...(quote === "'" ? [] : [...body.replace(/\$\{[^}]*\}/g, '').matchAll(/\$([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g)].map(found => found[1] as string)),
  ...(hasBraces ? braceExpressions(body) : []),
]

const FORMAT_MACRO = /(?:println|print|eprintln|eprint|format|panic|write|writeln|info|warn|error|debug|trace)!$/

/**
 * The code a call prints from: its arguments with each string reduced to `""`, plus whatever the string interpolates.
 * `x['key']` becomes `x.key`, so a dictionary lookup reads like a property.
 */
const codeOf = (args: string, isFormatMacro: boolean): string => {
  let out = ''
  let i = 0
  while (i < args.length) {
    const char = args[i] as string
    if (char !== '"' && char !== "'" && char !== '`') {
      out += char
      i += 1
      continue
    }
    let end = i + 1
    let body = ''
    while (end < args.length && args[end] !== char) {
      if (args[end] === '\\') {
        body += args.slice(end, end + 2)
        end += 2
      } else {
        body += args[end]
        end += 1
      }
    }
    const isFormat = /(?:^|[^\w$])[fF]$/.test(out) || /\$@?$/.test(out)
    if (out.endsWith('[') && args[end + 1] === ']') {
      out = `${out.slice(0, -1)}.${body}`
      i = end + 2
      continue
    }
    out += `"" ${interpolations(body, char === '`' || isFormat || isFormatMacro, char).join(' ')} `
    i = end + 1
  }
  return out
}

/** Wrappers that print a measure of a value, not the value: `len(password)`, `typeof token`. */
const MEASURE = /(?<![\w$.])(?:len|length|count|size|bool|Boolean|type|typeof)\b\s*(?:\([^()]*\)|[\w$.?]+)/g

/** The sensitive things a log call prints: identifiers, whole objects and request parts, but not text that only mentions them. */
const sensitiveIn = (args: string, isFormatMacro: boolean): string[] => {
  const code = codeOf(args, isFormatMacro).replace(MEASURE, ' ')
  const reasons: string[] = []
  for (const match of code.matchAll(CHAIN)) {
    // A key of an object literal or a keyword argument (`{ user: x }`, `f(token=x)`) names a value, it is not the value.
    if (/^\s*(?::(?!:)|=(?![=>]))/.test(code.slice(match.index + match[0].length))) continue
    const reason = reasonFor(match[0])
    if (reason !== undefined && !reasons.includes(reason)) reasons.push(reason)
  }
  return reasons.slice(0, MAX_REASONS)
}

const SECRETS_ONLY = new Set(['secrets'] as const)

/** Keys and tokens written into the call itself (`console.log("using ghp_…")`), by the shared secret rules. */
const literalSecretsIn = (args: string): string[] => [...new Set(findSecrets(args, { enabled: SECRETS_ONLY }).map(found => `a hard-coded ${found.kind}`))]

const show = (call: string): string => (call.length > MAX_SHOWN_CHARS ? `${call.slice(0, MAX_SHOWN_CHARS - 1)}…` : call)

/** The log statements `after` has that `before` does not, as a multiset, and what each prints that is sensitive. */
export const findPii = (before: string, after: string): Finding[] => {
  const known = new Map<string, number>()
  for (const call of callsIn(before)) known.set(call.key, (known.get(call.key) ?? 0) + 1)
  const findings: Finding[] = []
  for (const call of callsIn(after)) {
    const left = known.get(call.key) ?? 0
    if (left > 0) {
      known.set(call.key, left - 1)
      continue
    }
    if (call.isAllowed) continue
    const reasons = [...new Set([...sensitiveIn(call.args, FORMAT_MACRO.test(call.name)), ...literalSecretsIn(call.args)])].slice(0, MAX_REASONS)
    if (reasons.length > 0) findings.push({ line: call.line, call: show(call.text), reasons })
  }
  return findings
}
