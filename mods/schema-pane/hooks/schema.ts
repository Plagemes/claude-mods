import type { SchemaPaneColumn as Column, SchemaPaneTable as Table } from '../types'
import type { DbTarget } from './db'

/*
 * Each query tags its rows: C a column, K a key (primary, foreign, unique), I an index.
 * C: schema, table, column, type, nullable (YES/NO), default
 * K: schema, table, column, kind, referenced schema, table, column
 * I: schema, table, index name, definition
 */
const POSTGRES = [
  `SELECT 'C', c.table_schema, c.table_name, c.column_name,
     CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
          WHEN c.data_type = 'ARRAY' THEN substr(c.udt_name, 2) || '[]'
          WHEN c.character_maximum_length IS NOT NULL THEN c.data_type || '(' || c.character_maximum_length || ')'
          ELSE c.data_type END,
     c.is_nullable, coalesce(c.column_default, '')
   FROM information_schema.columns c
   JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg_toast%'
   ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  `SELECT 'K', kcu.table_schema, kcu.table_name, kcu.column_name, tc.constraint_type,
     coalesce(rk.table_schema, ''), coalesce(rk.table_name, ''), coalesce(rk.column_name, '')
   FROM information_schema.table_constraints tc
   JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
   LEFT JOIN information_schema.referential_constraints rc ON rc.constraint_schema = tc.constraint_schema AND rc.constraint_name = tc.constraint_name
   LEFT JOIN information_schema.key_column_usage rk ON rk.constraint_schema = rc.unique_constraint_schema
     AND rk.constraint_name = rc.unique_constraint_name AND rk.ordinal_position = kcu.position_in_unique_constraint
   WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE') AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
   ORDER BY kcu.table_schema, kcu.table_name, kcu.ordinal_position`,
  `SELECT 'I', schemaname, tablename, indexname, indexdef FROM pg_indexes
   WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename, indexname`,
]

const MYSQL = [
  `SELECT 'C', c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, coalesce(c.COLUMN_DEFAULT, '')
   FROM information_schema.COLUMNS c
   JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
   WHERE t.TABLE_TYPE = 'BASE TABLE' AND c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
  `SELECT 'K', k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, tc.CONSTRAINT_TYPE,
     coalesce(k.REFERENCED_TABLE_SCHEMA, ''), coalesce(k.REFERENCED_TABLE_NAME, ''), coalesce(k.REFERENCED_COLUMN_NAME, '')
   FROM information_schema.KEY_COLUMN_USAGE k
   JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
     AND tc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND tc.TABLE_NAME = k.TABLE_NAME
   WHERE k.TABLE_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
   ORDER BY k.TABLE_NAME, k.ORDINAL_POSITION`,
  `SELECT 'I', s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME,
     concat(IF(s.NON_UNIQUE = 0, 'UNIQUE ', ''), 'INDEX ', s.INDEX_NAME, ' (', group_concat(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX SEPARATOR ', '), ')')
   FROM information_schema.STATISTICS s WHERE s.TABLE_SCHEMA = DATABASE()
   GROUP BY s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME, s.NON_UNIQUE ORDER BY s.TABLE_NAME, s.INDEX_NAME`,
]

const SQLITE = [
  `SELECT 'C', '', m.name, p.name, p.type, CASE WHEN p."notnull" THEN 'NO' ELSE 'YES' END, coalesce(p.dflt_value, '')
   FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`,
  `SELECT 'K', '', m.name, p.name, 'PRIMARY KEY', '', '', ''
   FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND p.pk > 0 ORDER BY m.name, p.pk`,
  `SELECT 'K', '', m.name, f."from", 'FOREIGN KEY', '', f."table", coalesce(f."to", '')
   FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
  `SELECT 'K', '', m.name, x.name, 'UNIQUE', '', '', ''
   FROM sqlite_master m JOIN pragma_index_list(m.name) i JOIN pragma_index_info(i.name) x
   WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND i.origin = 'u' AND (SELECT count(*) FROM pragma_index_info(i.name)) = 1`,
  `SELECT 'I', '', m.name, i.name,
     CASE WHEN i."unique" THEN 'UNIQUE ' ELSE '' END || 'INDEX ' || i.name || ' (' || coalesce((SELECT group_concat(x.name, ', ') FROM pragma_index_info(i.name) x), '') || ')'
   FROM sqlite_master m JOIN pragma_index_list(m.name) i WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND i.origin <> 'pk'`,
]

export const schemaQueries = (kind: DbTarget['kind']): string[] =>
  (kind === 'postgres' ? POSTGRES : kind === 'mysql' ? MYSQL : SQLITE).map(sql => sql.replace(/\s+/g, ' ').trim())

const SHORT_TYPES: [RegExp, string][] = [
  [/^character varying/, 'varchar'],
  [/^character\b/, 'char'],
  [/^timestamp with time zone$/, 'timestamptz'],
  [/^timestamp without time zone$/, 'timestamp'],
  [/^time with time zone$/, 'timetz'],
  [/^time without time zone$/, 'time'],
  [/^double precision$/, 'float8'],
]

export const shortType = (type: string): string => SHORT_TYPES.reduce((text, [pattern, short]) => text.replace(pattern, short), type)

/** A default as people write it: casts and sequence plumbing gone. */
export const shortDefault = (value: string): string => {
  if (/^nextval\(/i.test(value)) return 'autoincrement'
  return value.replace(/::[a-z ]+(?:\[\])?/gi, '').replace(/^'(.*)'$/, "'$1'")
}

/** An index as one short line: what it covers, not how CREATE INDEX spells it. */
export const shortIndex = (definition: string): string =>
  definition
    .replace(/^CREATE /i, '')
    .replace(/ ON [^\s]+(?: USING btree)?/i, '')
    .replace(/ USING (\w+)/i, ' $1')
    .replace(/\(\((\w+)\)::\w+\)/g, '($1)')

/** `orders` in the default schema, `billing.invoices` elsewhere. */
const qualified = (kind: DbTarget['kind'], schema: string, table: string): string =>
  kind === 'postgres' && schema !== 'public' && schema !== '' ? `${schema}.${table}` : table

const isPrimaryIndex = (name: string): boolean => /_pkey$|^PRIMARY$/.test(name)

/** Builds the tables from the tagged rows the queries print. */
export const buildTables = (kind: DbTarget['kind'], rows: readonly string[][]): Table[] => {
  const tables = new Map<string, Table>()
  const tableOf = (schema: string, name: string): Table => {
    const key = qualified(kind, schema, name)
    let table = tables.get(key)
    if (table === undefined) {
      table = { name: key, columns: [], indexes: [] }
      tables.set(key, table)
    }
    return table
  }
  for (const [tag, schema = '', table = '', ...rest] of rows) {
    if (tag === 'C') {
      const [name = '', type = '', nullable = 'YES', defaultValue = ''] = rest
      const column: Column = { name, type: shortType(type), isNullable: nullable === 'YES', defaultValue: shortDefault(defaultValue), isPrimary: false, isUnique: false, references: null }
      tableOf(schema, table).columns.push(column)
    }
  }
  for (const [tag, schema = '', table = '', ...rest] of rows) {
    const owner = tables.get(qualified(kind, schema, table))
    if (owner === undefined) continue
    if (tag === 'K') {
      const [name = '', constraint = '', refSchema = '', refTable = '', refColumn = ''] = rest
      const column = owner.columns.find(entry => entry.name === name)
      if (column === undefined) continue
      if (constraint === 'PRIMARY KEY') column.isPrimary = true
      else if (constraint === 'UNIQUE') column.isUnique = true
      else if (refTable !== '') column.references = `${qualified(kind, refSchema === '' ? schema : refSchema, refTable)}${refColumn === '' ? '' : `.${refColumn}`}`
    } else if (tag === 'I') {
      const [name = '', definition = ''] = rest
      if (!isPrimaryIndex(name)) owner.indexes.push(shortIndex(definition))
    }
  }
  for (const table of tables.values()) {
    // A one-column unique index is already said by the column's UNIQUE.
    table.indexes = table.indexes.filter(index => {
      const single = /^UNIQUE INDEX \S+ \((\w+)\)$/.exec(index)
      return single === null || table.columns.find(column => column.name === single[1])?.isUnique !== true
    })
  }
  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** One column as the compact schema writes it: `email varchar(255) NOT NULL UNIQUE`. */
export const columnText = (column: Column): string =>
  [
    column.name,
    column.type,
    column.isPrimary ? 'PK' : '',
    !column.isNullable && !column.isPrimary ? 'NOT NULL' : '',
    column.isUnique ? 'UNIQUE' : '',
    column.references === null ? '' : `→ ${column.references}`,
    column.defaultValue === '' ? '' : `default ${column.defaultValue}`,
  ]
    .filter(part => part !== '')
    .join(' ')

export const tableText = (table: Table): string => {
  const head = `${table.name}(${table.columns.map(columnText).join(', ')})`
  return table.indexes.length === 0 ? head : `${head}\n  indexes: ${table.indexes.join('; ')}`
}

/**
 * The tables as compact text for Claude, cut at a table boundary to stay
 * within `maxChars`, saying how many were left out.
 */
export const compactSchema = (label: string, tables: readonly Table[], maxChars: number): string => {
  const head = `Database schema (${label}), ${tables.length} table${tables.length === 1 ? '' : 's'}:`
  const lines: string[] = [head]
  let used = head.length
  let shown = 0
  for (const table of tables) {
    const text = tableText(table)
    if (used + text.length + 1 > maxChars && shown > 0) break
    lines.push(text)
    used += text.length + 1
    shown += 1
  }
  if (shown < tables.length) lines.push(`… ${tables.length - shown} more table${tables.length - shown === 1 ? '' : 's'} not shown.`)
  return lines.join('\n')
}

/** Tables whose name holds every word of the filter, case-insensitively. */
export const filterTables = (tables: readonly Table[], filter: string): Table[] => {
  const words = filter.toLowerCase().split(/\s+/).filter(word => word !== '')
  return words.length === 0 ? [...tables] : tables.filter(table => words.every(word => table.name.toLowerCase().includes(word)))
}
