type Masked = { text: string; isUnsure: boolean }

const AGGREGATES = [
  'count', 'sum', 'avg', 'min', 'max', 'total', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
  'bool_and', 'bool_or', 'every', 'string_agg', 'array_agg', 'json_agg', 'jsonb_agg', 'group_concat', 'median',
]
const AGGREGATE_CALL = new RegExp(`\\b(?:${AGGREGATES.join('|')})\\s*\\(`)
const DML_IN_CTE = /\b(?:insert|update|delete|merge|into|call|truncate)\b/
const LOCKING = /\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b|\block\s+in\s+share\s+mode\b/
const ALREADY_BOUNDED = /\b(?:limit|top|offset|fetch)\b/
const SET_OPERATOR = /\b(?:union|intersect|except)\b/
const DOLLAR_TAG = /^\$(?:[A-Za-z_]\w*)?\$/

/**
 * The SQL with string literals, quoted identifiers and comments blanked out (same length), so keywords can be
 * searched for without being fooled by 'limit' in a string. isUnsure flags text whose meaning depends on the
 * dialect or that ends inside a comment, where a LIMIT would be swallowed.
 */
export const maskSql = (sql: string): Masked => {
  let text = ''
  let isUnsure = false
  let index = 0

  const blank = (end: number, keepEnds: boolean): void => {
    const slice = sql.slice(index, end)
    text += keepEnds && slice.length >= 2 ? `${slice[0]}${' '.repeat(slice.length - 2)}${slice.at(-1)}` : ' '.repeat(slice.length)
    index = end
  }

  while (index < sql.length) {
    const char = sql[index] ?? ''
    const head = sql.slice(index, index + 64)
    if (char === "'" || char === '"' || char === '`') {
      let end = index + 1
      while (end < sql.length) {
        if (char === "'" && sql[end] === '\\' && sql[end + 1] === "'") isUnsure = true
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            end += 2
            continue
          }
          break
        }
        end += 1
      }
      if (end >= sql.length) isUnsure = true
      blank(Math.min(end + 1, sql.length), true)
    } else if (head.startsWith('--')) {
      const newline = sql.indexOf('\n', index)
      if (newline < 0) isUnsure = true
      blank(newline < 0 ? sql.length : newline, false)
    } else if (head.startsWith('/*')) {
      const close = sql.indexOf('*/', index + 2)
      if (close < 0) isUnsure = true
      blank(close < 0 ? sql.length : close + 2, false)
    } else if (char === '$' && DOLLAR_TAG.test(head)) {
      const tag = DOLLAR_TAG.exec(head)?.[0] ?? '$$'
      const close = sql.indexOf(tag, index + tag.length)
      if (close < 0) isUnsure = true
      blank(close < 0 ? sql.length : close + tag.length, false)
    } else {
      // "#" starts a comment in MySQL and is an operator in PostgreSQL: not worth guessing.
      // A backslash ends the query with a client command (mysql `\G`, psql `\gx`): a LIMIT after it breaks it.
      if (char === '#' || char === '\\') isUnsure = true
      text += char
      index += 1
    }
  }
  return { text, isUnsure }
}

/** The text with everything inside parentheses blanked, so only the top level of the query is left. */
const topLevel = (text: string): string => {
  let depth = 0
  return [...text]
    .map(char => {
      if (char === '(') depth += 1
      const kept = depth === 0 ? char : ' '
      if (char === ')') depth = Math.max(0, depth - 1)
      return kept
    })
    .join('')
}

const isAggregateOnly = (lower: string, flat: string): boolean => {
  if (SET_OPERATOR.test(flat) || /\bgroup\s+by\b/.test(flat)) return false
  const select = /\bselect\b(?:\s+(?:distinct|all)\b)?/.exec(flat)
  const from = /\bfrom\b/.exec(flat)
  if (select === null || from === null || from.index < select.index) return false

  const start = select.index + select[0].length
  const items: string[] = []
  let itemStart = start
  for (let index = start; index <= from.index; index += 1) {
    if (index === from.index || flat[index] === ',') {
      items.push(lower.slice(itemStart, index))
      itemStart = index + 1
    }
  }
  return items.length > 0 && items.every(item => AGGREGATE_CALL.test(item) && !/\bover\s*\(/.test(item))
}

/** True for a plain SELECT (or WITH ... SELECT) that returns many rows and has no bound of its own. */
export const isCappable = (sql: string): boolean => {
  const { text, isUnsure } = maskSql(sql)
  if (isUnsure || /\bnocap\b/i.test(sql)) return false

  const statement = text.trim().replace(/;\s*$/, '').toLowerCase()
  if (statement.includes(';') || !/^(?:select|with)\b/.test(statement)) return false
  if (statement.startsWith('with') && DML_IN_CTE.test(statement)) return false
  if (/\binto\b/.test(statement) || LOCKING.test(statement) || ALREADY_BOUNDED.test(statement)) return false

  const flat = topLevel(statement)
  // No top-level FROM: SELECT 1, SELECT now() and friends answer one row.
  return /\bfrom\b/.test(flat) && !isAggregateOnly(statement, flat)
}
