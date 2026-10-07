import type { QueryExplainFinding as Finding, QueryExplainMode as Mode } from '../types'
import { RECORD, UNIT, parseRows } from './client'
import type { DbTarget } from './db'

type Kind = DbTarget['kind']

/**
 * The SQL with comments and quoted text blanked out (same length, so offsets
 * hold): what keyword checks read, never what is run.
 */
export const codeOnly = (sql: string): string => {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const rest = sql.slice(i)
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(rest)
    let end: number
    if (rest.startsWith('--')) end = sql.indexOf('\n', i) === -1 ? sql.length : sql.indexOf('\n', i)
    else if (rest.startsWith('/*')) end = sql.indexOf('*/', i + 2) === -1 ? sql.length : sql.indexOf('*/', i + 2) + 2
    else if (dollar !== null) {
      const close = sql.indexOf(dollar[0], i + dollar[0].length)
      end = close === -1 ? sql.length : close + dollar[0].length
    } else if (rest[0] === "'" || rest[0] === '"' || rest[0] === '`') {
      const quote = rest[0]
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '\\' && quote === "'") j += 2
        else if (sql[j] === quote && sql[j + 1] === quote) j += 2
        else if (sql[j] === quote) break
        else j += 1
      }
      end = Math.min(j + 1, sql.length)
    } else {
      out += sql[i]
      i += 1
      continue
    }
    out += ' '.repeat(end - i)
    i = end
  }
  return out
}

export type Checked = { ok: true; sql: string; isRead: boolean } | { ok: false; reason: string }

const WRITE_WORDS = /\b(?:insert|update|delete|merge|upsert|replace(?!\s*\()|truncate|drop|alter|create|grant|revoke|call|do|copy|lock|vacuum|analyze|refresh|reindex|cluster|set|into|for\s+(?:update|share|no\s+key\s+update|key\s+share))\b/i

/**
 * MySQL text on one line, its comments gone: the mysql client reads some words
 * at the start of a line (`delimiter`, `source`) as its own commands.
 */
export const mysqlOneLine = (sql: string): string => {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const char = sql[i] ?? ''
    if (char === "'" || char === '"' || char === '`') {
      let j = i + 1
      while (j < sql.length && !(sql[j] === char && sql[j + 1] !== char)) j += sql[j] === char ? 2 : 1
      out += sql.slice(i, j + 1)
      i = j + 1
    } else if (char === '#' || (sql.startsWith('--', i) && /^--(?:\s|$)/.test(sql.slice(i, i + 3)))) {
      const eol = sql.indexOf('\n', i)
      out += ' '
      i = eol === -1 ? sql.length : eol + 1
    } else {
      out += /\s/.test(char) ? ' ' : char
      i += 1
    }
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/**
 * One statement, ready to wrap in EXPLAIN: code fences and a leading EXPLAIN
 * dropped, the trailing `;` gone. Any other `;` is refused, wherever it stands,
 * since dialects disagree on what quotes and comments hide it. `isRead` is true
 * for a plain query that changes nothing, the only kind ANALYZE may run.
 */
export const checkStatement = (input: string, kind: Kind): Checked => {
  let sql = input.trim().replace(/^```\w*\s*|\s*```$/g, '').trim()
  sql = sql.replace(/^explain(?:\s+query\s+plan|\s+analy[sz]e|\s+verbose|\s*\([^)]*\))*\s+/i, '')
  sql = sql.replace(/[\s;]+$/, '')
  if (sql === '') return { ok: false, reason: 'There is no query to explain.' }
  if (sql.includes(';')) return { ok: false, reason: "The query holds a ';': EXPLAIN takes exactly one statement." }
  if (sql.startsWith('\\')) return { ok: false, reason: 'Client meta-commands (\\d, \\i …) cannot be explained.' }
  if (kind === 'mysql') {
    if (sql.includes('\\')) return { ok: false, reason: 'Backslashes are refused for MySQL, whose client reads them as its own commands.' }
    sql = mysqlOneLine(sql)
  }
  const body = codeOnly(sql)
  const first = /^[\s(]*([A-Za-z]+)/.exec(body)?.[1]?.toLowerCase() ?? ''
  const isRead = ['select', 'with', 'table', 'values'].includes(first) && !WRITE_WORDS.test(body)
  return { ok: true, sql, isRead }
}

/** Table names the query reads, plain identifiers only (they go into a catalog lookup). */
export const referencedTables = (sql: string): string[] => {
  const names = new Set<string>()
  const code = codeOnly(sql.replace(/["`]([A-Za-z_][\w$]*)["`]/g, '$1'))
  for (const match of code.matchAll(/\b(?:from|join|update|into)\s+((?:[A-Za-z_][\w$]*\.)?[A-Za-z_][\w$]*)/gi)) {
    const name = (match[1] ?? '').split('.').pop() ?? ''
    if (!/^(?:select|lateral|unnest|generate_series|only)$/i.test(name)) names.add(name)
  }
  return [...names].filter(name => name !== '').slice(0, 12)
}

export const modeOf = (kind: Kind, analyze: boolean): Mode =>
  kind === 'sqlite' ? 'EXPLAIN QUERY PLAN' : analyze ? 'EXPLAIN ANALYZE' : 'EXPLAIN'

/** The statements that print the plan; ANALYZE runs the query, so its time is capped. */
export const explainStatements = (kind: Kind, sql: string, mode: Mode, fallback = false): string[] => {
  if (kind === 'sqlite') return [`EXPLAIN QUERY PLAN ${sql}`]
  if (kind === 'postgres') {
    return mode === 'EXPLAIN ANALYZE'
      ? ["SET statement_timeout = '60s'", `EXPLAIN (ANALYZE, BUFFERS) ${sql}`]
      : [`EXPLAIN ${sql}`]
  }
  if (mode === 'EXPLAIN ANALYZE' && !fallback) return ['SET SESSION max_execution_time = 60000', `EXPLAIN ANALYZE ${sql}`]
  return [fallback ? `EXPLAIN FORMAT=JSON ${sql}` : `EXPLAIN FORMAT=TREE ${sql}`]
}

/** Whether a MySQL error means the server is too old for the tree format (MariaDB, MySQL < 8.0.18). */
export const needsFallback = (error: string): boolean => /FORMAT|ANALYZE|syntax|max_execution_time|Unknown system variable/i.test(error)

/** The plan as text from a client's output. */
export const planText = (kind: Kind, stdout: string): string => {
  if (kind === 'mysql') return parseRows('mysql', stdout).map(fields => fields.join('\t')).join('\n').trim()
  const rows = stdout.split(RECORD).map(row => row.replace(/\n$/, '')).filter(row => row !== '')
  if (kind === 'postgres') return rows.join('\n').trim()
  // sqlite3 prints EXPLAIN QUERY PLAN rows (id, parent, notused, detail) or its own tree.
  const fields = rows.map(row => row.split(UNIT))
  if (!fields.every(parts => parts.length === 4)) return rows.join('\n').replace(new RegExp(UNIT, 'g'), ' ').trim()
  const depth = new Map<string, number>()
  const lines = fields.map(([id = '', parent = '', , detail = '']) => {
    const level = (depth.get(parent) ?? -1) + 1
    depth.set(id, level)
    return `${'  '.repeat(level + 1)}${detail}`
  })
  return ['QUERY PLAN', ...lines].join('\n')
}

const numberIn = (text: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(text)
  return match === null ? undefined : Number(match[1])
}

const rowsText = (rows: number): string => `~${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'}`

/** Many rows: worth an index. */
const BIG_TABLE = 1000

/**
 * What a plan shows at a glance, before any model reads it. `sizes` holds the
 * catalog's row count per table, which says whether a full scan matters.
 */
export const findings = (kind: Kind, plan: string, sizes: Readonly<Record<string, number>>): Finding[] => {
  const found: Finding[] = []
  const seen = new Set<string>()
  const add = (finding: Finding) => {
    if (seen.has(finding.text) || found.length >= 6) return
    seen.add(finding.text)
    found.push(finding)
  }
  const fullScan = (table: string, what: string) => {
    const rows = sizes[table]
    add({ level: rows === undefined || rows >= BIG_TABLE ? 'warn' : 'info', text: `${what} on ${table}${rows === undefined ? '' : ` (${rowsText(rows)} in the table)`}` })
  }
  let mysqlTable = 'a table'
  for (const line of plan.split('\n')) {
    if (kind === 'postgres') {
      const seq = /Seq Scan on (\w+)/.exec(line)
      if (seq !== null) fullScan(seq[1] ?? '', 'Sequential scan')
      if (/Sort Method: external/.test(line)) add({ level: 'warn', text: 'A sort spills to disk (work_mem is too small for it)' })
      const removed = numberIn(line, /Rows Removed by Filter: (\d+)/)
      if (removed !== undefined && removed >= BIG_TABLE) add({ level: 'warn', text: `A filter reads and throws away ${removed.toLocaleString('en-US')} rows` })
      const estimate = /rows=(\d+) width=\d+\) \(actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/.exec(line)
      if (estimate !== null) {
        const [planned, actual] = [Number(estimate[1]), Number(estimate[2])]
        if (Math.max(planned, actual) >= BIG_TABLE && Math.max(planned, actual) / Math.max(1, Math.min(planned, actual)) >= 10) {
          add({ level: 'info', text: 'Row estimates are off by 10× or more: statistics may be stale (run ANALYZE)' })
        }
      }
    } else if (kind === 'mysql') {
      // The tree format names the scan; the JSON format names the table a few lines above its access type.
      mysqlTable = /"table_name": "(\w+)"/.exec(line)?.[1] ?? mysqlTable
      const scan = /Table scan on (\w+)/.exec(line)?.[1] ?? (/"access_type": "ALL"/.test(line) ? mysqlTable : undefined)
      if (scan !== undefined) fullScan(scan, 'Full table scan')
      if (/filesort|"using_filesort": true/i.test(line)) add({ level: 'info', text: 'Sorts rows without an index (filesort)' })
      if (/temporary|"using_temporary_table": true/i.test(line)) add({ level: 'info', text: 'Builds a temporary table' })
    } else {
      const scan = /\bSCAN (?:TABLE )?(\w+)(.*)$/.exec(line)
      if (scan !== null && !/USING (?:COVERING )?INDEX/.test(scan[2] ?? '')) fullScan(scan[1] ?? '', 'Full table scan')
      const temp = /USE TEMP B-TREE FOR (ORDER BY|GROUP BY|DISTINCT)/.exec(line)
      if (temp !== null) add({ level: 'info', text: `${temp[1]} without a matching index (temp B-tree)` })
    }
  }
  return found
}

/** Catalog lookups for the indexes (and row counts) of the tables a query reads: tagged I and S rows. */
export const contextQueries = (kind: Kind, tables: readonly string[]): string[] => {
  if (tables.length === 0) return []
  const list = tables.map(name => `'${name}'`).join(', ')
  if (kind === 'postgres') {
    return [
      `SELECT 'I', schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE tablename IN (${list}) ORDER BY tablename, indexname`,
      `SELECT 'S', relname, reltuples::bigint FROM pg_class WHERE relkind IN ('r', 'p') AND relname IN (${list})`,
    ]
  }
  if (kind === 'mysql') {
    return [
      `SELECT 'I', TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, concat(IF(NON_UNIQUE = 0, 'UNIQUE ', ''), 'INDEX ', INDEX_NAME, ' ON ', TABLE_NAME, ' (', group_concat(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), ')') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${list}) GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
      `SELECT 'S', TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${list})`,
    ]
  }
  return [`SELECT 'I', '', tbl_name, name, coalesce(sql, 'automatic index ' || name) FROM sqlite_master WHERE type = 'index' AND tbl_name IN (${list})`]
}

export type TableContext = { indexes: string[]; sizes: Record<string, number> }

/** Index definitions and row counts from the tagged rows; a count below zero means never analysed. */
export const readContext = (rows: readonly string[][]): TableContext => ({
  indexes: rows.filter(row => row[0] === 'I').map(row => row[4] ?? '').filter(text => text !== ''),
  sizes: Object.fromEntries(rows.filter(row => row[0] === 'S' && Number(row[2]) >= 0).map(row => [row[1] ?? '', Number(row[2])])),
})

export const SYSTEM_PROMPT = [
  'You are a database performance engineer explaining a query plan to an application developer.',
  'Answer in Markdown with exactly these sections:',
  '**In short**: one or two plain sentences on how the database runs the query and whether it is fine.',
  '**Bottlenecks**: bullets naming the expensive steps (sequential or full scans on big tables, sorts or hashes spilling, nested loops over many rows, bad row estimates). Say "None worth fixing." when the plan is fine.',
  '**Suggestions**: bullets, each with the exact SQL to run (CREATE INDEX … with a sensible name, or a rewrite of the query). Never suggest an index that already exists in the list given. Say "None." when nothing would help.',
  'Use plain words, explain any jargon in passing, quote numbers from the plan, and stay under 220 words. Tiny tables are fine to scan.',
].join('\n')

export const userPrompt = (input: { kind: Kind; mode: Mode; sql: string; plan: string } & TableContext): string =>
  [
    `Database: ${input.kind}. Plan from ${input.mode}${input.mode === 'EXPLAIN ANALYZE' ? ' (the query really ran: these are measured times and rows)' : ' (estimates only; the query did not run)'}.`,
    '',
    'Query:',
    '```sql',
    input.sql,
    '```',
    '',
    'Plan:',
    '```',
    input.plan.slice(0, 12_000),
    '```',
    '',
    `Existing indexes on these tables: ${input.indexes.length === 0 ? 'none found' : ''}`,
    ...input.indexes.map(index => `- ${index}`),
    ...(Object.keys(input.sizes).length === 0
      ? []
      : ['', `Table sizes (catalog estimates): ${Object.entries(input.sizes).map(([table, rows]) => `${table} ${rowsText(rows)}`).join('; ')}`]),
  ].join('\n')
