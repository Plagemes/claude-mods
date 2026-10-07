export type Rule = 'update-without-where' | 'delete-without-where' | 'drop' | 'truncate'

export type Finding = {
  rule: Rule
  /** Line in the text that was scanned, counting from 1. */
  line: number
  /** The statement with its whitespace collapsed. */
  statement: string
}

type Lang = { comments: readonly ('slash' | 'hash')[]; hasHeredoc: boolean }

const SLASH: Lang = { comments: ['slash'], hasHeredoc: false }
const HASH: Lang = { comments: ['hash'], hasHeredoc: false }
const LANGUAGES: Readonly<Record<string, Lang>> = {
  js: SLASH, jsx: SLASH, ts: SLASH, tsx: SLASH, mjs: SLASH, cjs: SLASH, java: SLASH, kt: SLASH, kts: SLASH, go: SLASH,
  cs: SLASH, rs: SLASH, scala: SLASH, swift: SLASH, dart: SLASH,
  py: HASH, ex: HASH, exs: HASH,
  rb: { comments: ['hash'], hasHeredoc: true },
  php: { comments: ['slash', 'hash'], hasHeredoc: true },
}
const SQL_FILE = 'sql'

/** Whether a file of this extension is scanned: `.sql` files, and code that holds SQL in strings. */
export function isScanned(extension: string): boolean {
  return extension === SQL_FILE || extension in LANGUAGES
}

const IDENTIFIER = '[\\w."`\\[\\]]+'
const DROP = /^drop\s+(?:temporary\s+)?(?:table|database|schema)\b/i
const TRUNCATE = new RegExp(`^truncate\\s+(?:table\\s+)?(?:only\\s+)?${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*(?:\\s+(?:restart|continue)\\s+identity)?(?:\\s+(?:cascade|restrict))?$`, 'i')
const UPDATE = new RegExp(`^update\\s+(?:(?:only|low_priority|ignore)\\s+)*${IDENTIFIER}(?:\\s+(?:as\\s+)?\\w+)?\\s+set\\s+${IDENTIFIER}\\s*=`, 'i')
const DELETE = new RegExp(`^delete\\s+(?:${IDENTIFIER}\\s+)?from\\s+${IDENTIFIER}(?:\\s+(?:as\\s+)?\\w+)?(?:\\s+(?:where|using|returning|order|limit|join|inner|left)\\b.*|\\s*)$`, 'i')
const WHERE = /\bwhere\b/i
/** "Delete from cache failed": a sentence, not SQL, which is all upper or all lower case. */
const SENTENCE_CASE = /^[A-Z][a-z]/
const INTERPOLATED_END = /[}]\s*$/

function classify(statement: string, isDynamic: boolean): Rule | undefined {
  if (DROP.test(statement)) return 'drop'
  if (TRUNCATE.test(statement)) return 'truncate'
  if (isDynamic || INTERPOLATED_END.test(statement) || WHERE.test(statement)) return undefined
  if (UPDATE.test(statement)) return 'update-without-where'
  if (DELETE.test(statement)) return 'delete-without-where'
  return undefined
}

type Piece = { text: string; line: number; isDynamic: boolean; isCode: boolean }

const countLines = (text: string): number => text.split('\n').length - 1

/** Splits one piece of text on `;` into statements, with the line each starts on. */
function statementsOf({ text, line, isDynamic, isCode }: Piece): Finding[] {
  const findings: Finding[] = []
  let partStart = 0
  for (const part of text.split(';')) {
    const lead = part.length - part.trimStart().length
    const statementLine = line + countLines(text.slice(0, partStart + lead))
    partStart += part.length + 1
    const statement = part.replace(/\s+/g, ' ').trim().replace(/^\(\s*/, '')
    if (statement === '' || (isCode && SENTENCE_CASE.test(statement))) continue
    const rule = classify(statement, isDynamic)
    if (rule !== undefined) findings.push({ rule, statement, line: statementLine })
  }
  return findings
}

/** `.sql` text with `--` and block comments blanked (newlines kept), as one piece. */
function sqlPiece(source: string): Piece {
  const text = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
  return { text, line: 1, isDynamic: false, isCode: false }
}

/** One regex that finds comments and string literals, whichever comes first; a heredoc is group 1 (tag) and 2 (body). */
function tokenPattern({ comments, hasHeredoc }: Lang): RegExp {
  const parts = [
    ...(hasHeredoc ? ['<<<?[-~]?[\'"]?([A-Za-z_]+)[\'"]?[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*\\1\\b'] : []),
    ...(comments.includes('slash') ? ['//[^\\n]*', '/\\*[\\s\\S]*?\\*/'] : []),
    ...(comments.includes('hash') ? ['#[^\\n]*'] : []),
    '"""[\\s\\S]*?"""',
    "'''[\\s\\S]*?'''",
    '`(?:\\\\[\\s\\S]|[^`\\\\])*`',
    '"(?:\\\\.|[^"\\\\\\n])*"',
    "'(?:\\\\.|[^'\\\\\\n])*'",
  ]
  return new RegExp(parts.join('|'), 'g')
}

type Literal = { content: string; start: number; end: number }

const isComment = (token: string): boolean => token.startsWith('//') || token.startsWith('/*') || token.startsWith('#')

function contentOf(token: string, body: string | undefined): string {
  if (body !== undefined) return body
  const isTriple = token.length >= 6 && (token.startsWith('"""') || token.startsWith("'''"))
  return token.slice(isTriple ? 3 : 1, isTriple ? -3 : -1)
}

/** String literals of code, with literals joined by `+` or by plain adjacency (`"a " "b"`) merged into one. */
function literalsOf(source: string, lang: Lang): Literal[] {
  const merged: Literal[] = []
  for (const match of source.matchAll(tokenPattern(lang))) {
    const token = match[0]
    if (isComment(token)) continue
    const start = match.index ?? 0
    const literal = { content: contentOf(token, match[2]), start, end: start + token.length }
    const previous = merged.at(-1)
    const gap = previous === undefined ? '' : source.slice(previous.end, start)
    if (previous !== undefined && /^[\s+\\.]*$/.test(gap)) {
      previous.content += literal.content
      previous.end = literal.end
    } else {
      merged.push(literal)
    }
  }
  return merged
}

/** SQL statements that can destroy data, found in `source` (a `.sql` file or code with SQL in strings). */
export function findSql(source: string, extension: string): Finding[] {
  if (extension === SQL_FILE) return statementsOf(sqlPiece(source))
  const lang = LANGUAGES[extension]
  if (lang === undefined) return []
  return literalsOf(source, lang).flatMap(literal => {
    const isDynamic = /^\s*(?:\+|\.\s*[$\w(])/.test(source.slice(literal.end, literal.end + 40))
    return statementsOf({ text: literal.content, line: 1 + countLines(source.slice(0, literal.start)), isDynamic, isCode: true })
  })
}

const keyOf = (finding: Finding): string => `${finding.rule}|${finding.statement}`

/** The findings of `after` that `before` did not already have (same statement text, counted). */
export function introduced(before: readonly Finding[], after: readonly Finding[]): Finding[] {
  const available = new Map<string, number>()
  for (const finding of before) available.set(keyOf(finding), (available.get(keyOf(finding)) ?? 0) + 1)
  return after.filter(finding => {
    const left = available.get(keyOf(finding)) ?? 0
    available.set(keyOf(finding), left - 1)
    return left <= 0
  })
}

export const ADVICE: Readonly<Record<Rule, string>> = {
  'update-without-where': 'UPDATE without WHERE changes every row',
  'delete-without-where': 'DELETE without WHERE removes every row',
  drop: 'DROP removes the table or database and its data',
  truncate: 'TRUNCATE empties the table',
}
