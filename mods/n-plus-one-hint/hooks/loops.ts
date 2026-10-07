export type Kind = 'prisma' | 'orm' | 'django' | 'sqlalchemy' | 'activerecord' | 'eloquent' | 'repository' | 'sql'

export type Hit = {
  /** Line of the query, counting from 1. */
  line: number
  /** The call that queries, such as `prisma.post.findMany`. */
  call: string
  kind: Kind
  /** The query's line with its indentation trimmed; how a hit is told from one the file already had. */
  text: string
}

type Family = 'js' | 'jvm' | 'go' | 'py' | 'rb' | 'php'
type Query = { kind: Kind; pattern: RegExp }

const FAMILIES: Readonly<Record<string, Family>> = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js', vue: 'js', svelte: 'js',
  java: 'jvm', kt: 'jvm', kts: 'jvm', scala: 'jvm', cs: 'jvm',
  go: 'go', py: 'py', rb: 'rb', php: 'php',
}

/** Whether a file of this extension is looked at. */
export function isScanned(extension: string): boolean {
  return extension in FAMILIES
}

const CHAIN = '[\\w$]+(?:\\.[\\w$]+)*'
const REPOSITORY: Query = {
  kind: 'repository',
  pattern: /\b([\w$.]*[rR]epo(?:sitory)?\.(?:find\w*|get\w*|count\w*|exist\w*|load\w*))\s*\(/,
}
const FINDERS: Query = {
  kind: 'orm',
  pattern: new RegExp(`\\b(${CHAIN}\\.(?:findOne|findById|findByPk|findAll|findOneBy|findBy|findOneOrFail|findOrFail))\\s*\\(`),
}
const MODEL_FINDERS: Query = {
  kind: 'orm',
  pattern: /\b([A-Z]\w*\.(?:find|where|findAndCountAll)|\w*[mM]odel\w*\.(?:find|where|countDocuments))\s*\(/,
}

const QUERIES: Readonly<Record<Family, readonly Query[]>> = {
  js: [
    { kind: 'prisma', pattern: new RegExp(`\\b(${CHAIN}\\.(?:findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany))\\s*\\(`) },
    FINDERS,
    MODEL_FINDERS,
    REPOSITORY,
    { kind: 'sql', pattern: /\b((?:db|DB|conn|connection|pool|trx|tx|database|sqlite)\.(?:query|queryRow|queryOne|execute|exec|raw|all|one|oneOrNone|any|many|none|select|selectOne))\s*\(/ },
    { kind: 'sql', pattern: /\b(knex)\s*\(/ },
    { kind: 'sql', pattern: /\b(sql)\s*`/ },
  ],
  jvm: [
    FINDERS,
    REPOSITORY,
    { kind: 'sql', pattern: /\b((?:entityManager|em|session|jdbcTemplate|jdbc)\.(?:find|createQuery|createNativeQuery|get|load|query\w*|queryFor\w*))\s*\(/ },
    { kind: 'orm', pattern: /\b([\w.]*[cC]ontext\.\w+\.(?:Find|FindAsync|FirstOrDefault\w*|SingleOrDefault\w*|Where|Any\w*|Count\w*))\s*\(/ },
  ],
  go: [
    REPOSITORY,
    { kind: 'sql', pattern: /\b((?:db|DB|conn|tx|pool)\.(?:Query\w*|Exec\w*|Get\w*|Select\w*|First|Find|Where|Take|Last|Raw|Scan))\s*\(/ },
  ],
  py: [
    { kind: 'django', pattern: /\b([\w.]+\.objects\.(?:get|filter|exclude|count|exists|first|last|aggregate|in_bulk|get_or_create))\b/ },
    { kind: 'sqlalchemy', pattern: /\b([\w.]*session\.(?:query|execute|scalars?))\s*\(/ },
    { kind: 'sqlalchemy', pattern: /\b([\w.]+\.query\.(?:filter|filter_by|get|first|one|all|count))\b/ },
    REPOSITORY,
    { kind: 'sql', pattern: /\b((?:cursor|cur|conn|connection|db|database)\.(?:execute|executemany|fetch\w*|query))\s*\(/ },
  ],
  rb: [
    { kind: 'activerecord', pattern: /\b([A-Z]\w*(?:::\w+)*\.(?:find|find_by!?|where|find_or_create_by|exists\?|first|last|count|pluck))\b/ },
    { kind: 'activerecord', pattern: /([\w.@]+\.(?:find_by!?|where))\b/ },
    { kind: 'sql', pattern: /\b(\w*connection\.(?:execute|exec_query|select_\w+))\b/ },
  ],
  php: [
    {
      kind: 'eloquent',
      pattern: /\b(?!(?:Arr|Str|Cache|Config|Collection|Carbon|Hash|Route|Log|Auth|Session)::)([A-Z]\w*::(?:find|findOrFail|where|first|firstWhere|firstOrFail|count|query|all))\b/,
    },
    { kind: 'sql', pattern: /\b(DB::(?:table|select|selectOne|statement|raw))\b/ },
    { kind: 'sql', pattern: /\$(\w*(?:pdo|db|conn|connection|stmt|statement)\w*->(?:query|prepare|execute|exec))\s*\(/i },
    REPOSITORY,
  ],
}

/** What to do instead, by kind of query. */
export const ADVICE: Readonly<Record<Kind, string>> = {
  prisma: 'fetch the rows together: include/select on the outer query, or one findMany({ where: { id: { in: ids } } }) before the loop',
  orm: 'load all the rows in one query (where id in ids) or eager-load the relation, before the loop',
  django: 'use select_related/prefetch_related, or one filter(id__in=ids) or in_bulk(ids) before the loop',
  sqlalchemy: 'use joinedload/selectinload, or one query with .in_(ids) before the loop',
  activerecord: 'use includes/preload/eager_load, or one where(id: ids) before the loop',
  eloquent: 'use with() to eager-load, or whereIn(\'id\', $ids) before the loop',
  repository: 'add a batch method (findAllById(ids)) and call it once before the loop',
  sql: 'run one query with WHERE id IN (...) or a JOIN before the loop, and group the rows in memory',
}

type Lang = { comments: readonly ('slash' | 'hash')[]; hasHeredoc: boolean }

const LANGS: Readonly<Record<Family, Lang>> = {
  js: { comments: ['slash'], hasHeredoc: false },
  jvm: { comments: ['slash'], hasHeredoc: false },
  go: { comments: ['slash'], hasHeredoc: false },
  py: { comments: ['hash'], hasHeredoc: false },
  rb: { comments: ['hash'], hasHeredoc: true },
  php: { comments: ['slash', 'hash'], hasHeredoc: true },
}

/** One regex that finds comments and string literals, whichever comes first. */
function tokenPattern({ comments, hasHeredoc }: Lang): RegExp {
  const parts = [
    ...(hasHeredoc ? ['<<<?[-~]?[\'"]?([A-Za-z_]+)[\'"]?[ \\t]*\\n[\\s\\S]*?\\n[ \\t]*\\1\\b'] : []),
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

const blankOut = (text: string): string => text.replace(/[^\n]/g, ' ')

/** The source with comments and the insides of strings turned into spaces (newlines kept, so lines still line up). */
function blankLiterals(source: string, lang: Lang): string {
  return source.replace(tokenPattern(lang), token => {
    const isLiteral = /^["'`]/.test(token)
    return isLiteral ? `${token[0]}${blankOut(token.slice(1, -1))}${token.slice(-1)}` : blankOut(token)
  })
}

const MARKERS: Readonly<Record<Family, RegExp>> = {
  js: /(?:\.)(?:forEach|map|flatMap|filter|reduce|reduceRight|some|every|each)\s*\(/,
  jvm: /(?:\.)(?:forEach|map|flatMap|filter|reduce|forEachIndexed|mapNotNull|mapIndexed|each)\s*\(/,
  go: /(?!)/,
  py: /(?!)/,
  rb: /\.(?:each|each_with_index|each_with_object|each_slice|each_cons|each_pair|map|collect|flat_map|filter_map|select|reject|times|upto|downto|find_each|in_batches|inject|reduce|group_by|sort_by)\b/,
  php: /(?:->|\b)(?:each|map|filter|transform|array_map|array_filter)\s*\(/,
}

/** Where on the line a query would run once per iteration, or undefined when the line starts no loop. */
function loopStart(line: string, family: Family): number | undefined {
  if (family === 'py') {
    if (/^\s*(?:async\s+)?(?:for|while)\b/.test(line)) return afterColon(line)
    return /\bfor\s+[\w,\s()*]+\s+in\s+/.test(line) ? 0 : undefined
  }
  if (family === 'rb' && /^\s*(?:for\s+\w+\s+in|while|until|loop\s+do)\b/.test(line)) return line.length
  const callback = MARKERS[family].exec(line)
  if (callback !== null) return callback.index + callback[0].length
  if (family === 'rb') return undefined
  if (/(?:^|[;{}\s])(?:for|foreach|while)\s*(?:await\s*)?\(/.test(line)) return afterParentheses(line)
  if (/^\s*do\s*\{?\s*$/.test(line) || (family === 'go' && /^\s*for\b/.test(line))) return line.length
  return undefined
}

/** Index after the first top-level `:` of a Python loop header: what follows is a body on the same line. */
function afterColon(line: string): number {
  let depth = 0
  for (const [index, char] of [...line].entries()) {
    if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) depth -= 1
    else if (char === ':' && depth === 0) return index + 1
  }
  return line.length
}

/** Index after the `)` that closes the loop header's `(`; the line's end when it does not close here. */
function afterParentheses(line: string): number {
  const open = line.search(/(?:for|foreach|while)\s*(?:await\s*)?\(/)
  let depth = 0
  for (let index = line.indexOf('(', open); index >= 0 && index < line.length; index += 1) {
    if (line[index] === '(') {
      depth += 1
    } else if (line[index] === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return line.length
}

function indentOf(line: string): number {
  let width = 0
  for (const char of line) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 4
    else break
  }
  return width
}

function queryIn(line: string, from: number, family: Family): { call: string; kind: Kind } | undefined {
  const tail = line.slice(from)
  for (const { kind, pattern } of QUERIES[family]) {
    const match = pattern.exec(tail)
    if (match !== null) return { call: match[1] ?? match[0], kind }
  }
  return undefined
}

/** Database queries inside the body of a loop (for, while, forEach, map, each ...); reads text, runs nothing. */
export function findLoopQueries(source: string, extension: string): Hit[] {
  const family = FAMILIES[extension]
  if (family === undefined) return []
  const rawLines = source.split('\n')
  const lines = blankLiterals(source, LANGS[family]).split('\n')
  const hits = new Map<number, Hit>()
  const check = (index: number, from: number) => {
    const found = queryIn(lines[index] ?? '', from, family)
    if (found !== undefined && !hits.has(index)) hits.set(index, { line: index + 1, ...found, text: (rawLines[index] ?? '').trim() })
  }

  for (const [index, line] of lines.entries()) {
    const from = loopStart(line, family)
    if (from === undefined) continue
    check(index, from)
    const isSingleLineComprehension = family === 'py' && from === 0
    if (isSingleLineComprehension) continue
    const indent = indentOf(line)
    let bodyIndex = index + 1
    if ((lines[bodyIndex] ?? '').trim() === '{') bodyIndex += 1
    for (; bodyIndex < lines.length; bodyIndex += 1) {
      const body = lines[bodyIndex] ?? ''
      if (body.trim() === '') continue
      if (indentOf(body) <= indent) break
      check(bodyIndex, 0)
    }
  }
  return [...hits.values()].sort((a, b) => a.line - b.line)
}

const keyOf = (hit: Hit): string => hit.text

/** The hits of `after` whose line `before` did not already hold in a loop (counted by the line's text). */
export function introduced(before: readonly Hit[], after: readonly Hit[]): Hit[] {
  const available = new Map<string, number>()
  for (const hit of before) available.set(keyOf(hit), (available.get(keyOf(hit)) ?? 0) + 1)
  return after.filter(hit => {
    const left = available.get(keyOf(hit)) ?? 0
    available.set(keyOf(hit), left - 1)
    return left <= 0
  })
}
