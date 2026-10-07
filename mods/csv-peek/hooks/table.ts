export type Kind = 'csv' | 'jsonl'
export type ColumnType = 'int' | 'float' | 'bool' | 'date' | 'datetime' | 'string' | 'object' | 'array' | 'mixed' | 'empty'

export type Column = { name: string; type: ColumnType; emptyPercent: number; example: string }

export type Table = {
  kind: Kind
  /** CSV only: the field separator. */
  delimiter: string
  hasHeader: boolean
  columns: Column[]
  /** The sampled records, as the table of text cells that is shown. */
  rows: string[][]
  /** Records the sample was read from. */
  sampledRows: number
  /** JSONL lines that were not a JSON object. */
  skippedLines: number
}

const DELIMITERS = [',', ';', '\t', '|']
const NULL_TOKENS = new Set(['', 'null', '\\n', 'nan', 'n/a', 'na', 'none'])
const INT = /^[+-]?(?:0|[1-9]\d*)$/
const FLOAT = /^[+-]?(?:\d+\.\d*|\.\d+|\d+(?=[eE]))(?:[eE][+-]?\d+)?$/
const BOOL = /^(?:true|false|yes|no)$/i
const DATE = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[/.]\d{1,2}[/.]\d{4}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/

export const isNullToken = (value: string): boolean => NULL_TOKENS.has(value.trim().toLowerCase())

export const typeOfText = (value: string): ColumnType => {
  const text = value.trim()
  if (INT.test(text)) return 'int'
  if (FLOAT.test(text)) return 'float'
  if (BOOL.test(text)) return 'bool'
  if (DATETIME.test(text)) return 'datetime'
  return DATE.test(text) ? 'date' : 'string'
}

/** The type that covers every observed type: ints widen to floats, dates to datetimes, anything else is mixed. */
const mergeTypes = (seen: ReadonlySet<ColumnType>): ColumnType => {
  if (seen.size === 0) return 'empty'
  if (seen.size === 1) return [...seen][0] ?? 'empty'
  if (seen.size === 2 && seen.has('int') && seen.has('float')) return 'float'
  if (seen.size === 2 && seen.has('date') && seen.has('datetime')) return 'datetime'
  return 'mixed'
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Splits text into records of fields: quotes, doubled quotes, newlines inside quotes, CRLF. */
export const parseCsv = (text: string, delimiter: string): { rows: string[][]; isLastOpen: boolean } => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let isQuoted = false
  let isOpen = false

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    isOpen = true
    if (isQuoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        isQuoted = false
      } else {
        field += char
      }
    } else if (char === '"' && field === '') {
      isQuoted = true
    } else if (char === delimiter) {
      endField()
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      endRow()
      isOpen = false
    } else {
      field += char
    }
  }
  if (isOpen || isQuoted) endRow()
  return { rows, isLastOpen: isOpen || isQuoted }
}

const countOutsideQuotes = (line: string, delimiter: string): number => {
  let count = 0
  let isQuoted = false
  for (const char of line) {
    if (char === '"') isQuoted = !isQuoted
    else if (char === delimiter && !isQuoted) count += 1
  }
  return count
}

/** The delimiter that splits the first lines into the same number of fields, most fields winning; a comma when nothing fits. */
export const sniffDelimiter = (text: string, isCut = false): string => {
  const all = text.split(/\r?\n/)
  // The last line of a sample cut mid-file is half a record and would look inconsistent.
  const lines = (isCut ? all.slice(0, -1) : all).filter(line => line.trim() !== '').slice(0, 20)
  let best = { delimiter: ',', score: 0 }
  for (const delimiter of DELIMITERS) {
    const counts = lines.map(line => countOutsideQuotes(line, delimiter))
    const first = counts[0] ?? 0
    const consistent = counts.filter(count => count === first).length
    const score = first > 0 && consistent >= Math.ceil(counts.length * 0.8) ? first * consistent : 0
    if (score > best.score) best = { delimiter, score }
  }
  return best.delimiter
}

const looksLikeData = (cell: string): boolean => {
  const type = typeOfText(cell)
  return type === 'int' || type === 'float' || type === 'date' || type === 'datetime' || isNullToken(cell)
}

/** A first row is a header unless every cell in it reads like data (numbers, dates, nothing). */
const hasHeaderRow = (rows: readonly string[][]): boolean => {
  const first = rows[0]
  return first !== undefined && !first.every(looksLikeData)
}

/** Whole percent, but never a rounded-down 0% for something that does occur. */
const percentOf = (part: number, total: number): number => (part === 0 || total === 0 ? 0 : Math.max(1, Math.round((part / total) * 100)))

const summarize = (names: readonly string[], values: (index: number) => string[]): Column[] =>
  names.map((name, index) => {
    const cells = values(index)
    const present = cells.filter(cell => !isNullToken(cell))
    const type = mergeTypes(new Set(present.map(typeOfText)))
    return {
      name,
      type,
      emptyPercent: percentOf(cells.length - present.length, cells.length),
      example: present[0] ?? '',
    }
  })

export const tableFromCsv = (text: string, isCut: boolean, sampleRows: number): Table => {
  const delimiter = sniffDelimiter(text, isCut)
  const parsed = parseCsv(text, delimiter)
  // A sample cut mid-file ends in half a record: leave it out.
  const rows = isCut && parsed.isLastOpen ? parsed.rows.slice(0, -1) : parsed.rows
  const hasHeader = hasHeaderRow(rows)
  const body = hasHeader ? rows.slice(1) : rows
  const width = Math.max(0, ...rows.slice(0, 200).map(row => row.length))
  const names = Array.from({ length: width }, (_, index) => {
    const header = hasHeader ? rows[0]?.[index]?.trim() : undefined
    return header === undefined || header === '' ? `col${index + 1}` : header
  })

  return {
    kind: 'csv',
    delimiter,
    hasHeader,
    columns: summarize(names, index => body.map(row => row[index] ?? '')),
    rows: body.slice(0, sampleRows).map(row => names.map((_, index) => row[index] ?? '')),
    sampledRows: body.length,
    skippedLines: 0,
  }
}

// ── JSON Lines ──────────────────────────────────────────────────────────────

const typeOfJson = (value: unknown): ColumnType => {
  if (value === null || value === '') return 'empty'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (typeof value === 'boolean') return 'bool'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  const type = typeOfText(String(value))
  // A string that only looks like a number is still a string in JSON.
  return type === 'date' || type === 'datetime' ? type : 'string'
}

const showJson = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value))

export const tableFromJsonl = (text: string, isCut: boolean, sampleRows: number): Table => {
  const lines = text.split(/\r?\n/)
  // The last line of a cut sample is only part of a record.
  if (isCut) lines.pop()
  const records: Record<string, unknown>[] = []
  let skippedLines = 0
  for (const line of lines.filter(line => line.trim() !== '')) {
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) records.push(value as Record<string, unknown>)
      else skippedLines += 1
    } catch {
      skippedLines += 1
    }
  }
  const names = [...new Set(records.flatMap(record => Object.keys(record)))]
  const columns = names.map((name): Column => {
    const values = records.map(record => record[name])
    const present = values.filter(value => value !== undefined && value !== null && value !== '')
    return {
      name,
      type: mergeTypes(new Set(present.map(typeOfJson))),
      emptyPercent: percentOf(values.length - present.length, values.length),
      example: showJson(present[0]),
    }
  })

  return {
    kind: 'jsonl',
    delimiter: '',
    hasHeader: false,
    columns,
    rows: records.slice(0, sampleRows).map(record => names.map(name => showJson(record[name]))),
    sampledRows: records.length,
    skippedLines,
  }
}

/** JSON Lines by name, or by content when the name says nothing: every line starts a JSON object. */
export const detectKind = (path: string, sample: string): Kind => {
  if (/\.(?:jsonl|ndjson)$/i.test(path)) return 'jsonl'
  if (/\.(?:csv|tsv|tab|txt)$/i.test(path)) return 'csv'
  const lines = sample.split(/\r?\n/).filter(line => line.trim() !== '').slice(0, 5)
  return lines.length > 0 && lines.every(line => line.trimStart().startsWith('{')) ? 'jsonl' : 'csv'
}

// ── The report ──────────────────────────────────────────────────────────────

const MAX_CELL_CHARS = 32
const MAX_COLUMNS_LISTED = 40
const MAX_COLUMNS_IN_ROWS = 10

const cell = (value: string): string => {
  const flat = value.replace(/\s*[\r\n]+\s*/g, ' ⏎ ').replace(/\|/g, '\\|').replace(/`/g, "'")
  return flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 1)}…` : flat
}

const markdownTable = (header: readonly string[], body: readonly (readonly string[])[]): string[] => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...body.map(row => `| ${row.join(' | ')} |`),
]

export type Facts = {
  name: string
  bytes: number
  /** Newlines in the whole file, when counted. */
  lines: number | undefined
  /** The sample covered the whole file. */
  isWhole: boolean
  sampleBytes: number
  rowsShown: number
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

const formatCount = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export const formatReport = (table: Table, facts: Facts): string => {
  const kind = table.kind === 'csv' ? `${table.delimiter === '\t' ? 'TSV' : 'CSV'}, delimiter ${table.delimiter === '\t' ? 'tab' : `\`${table.delimiter}\``}` : 'JSON Lines'
  const records =
    facts.isWhole
      ? `${formatCount(table.sampledRows)} rows`
      : facts.lines === undefined
        ? 'row count not counted'
        : `~${formatCount(Math.max(0, facts.lines - (table.hasHeader ? 1 : 0)))} rows`
  const headline = [`**${facts.name}**`, formatBytes(facts.bytes), records, `${table.columns.length} columns`, kind, table.hasHeader ? 'header row' : table.kind === 'csv' ? 'no header row' : '']
    .filter(part => part !== '')
    .join(' · ')
  const sampled = facts.isWhole
    ? 'The whole file was read.'
    : `Types come from the first ${formatCount(table.sampledRows)} rows (${formatBytes(facts.sampleBytes)}); the rest of the file was not read.`
  const skipped = table.skippedLines > 0 ? ` ${table.skippedLines} line(s) in the sample were not JSON objects.` : ''

  const columns = markdownTable(
    ['#', 'Column', 'Type', 'Empty', 'Example'],
    table.columns.slice(0, MAX_COLUMNS_LISTED).map((column, index) => [String(index + 1), `\`${cell(column.name)}\``, column.type, `${column.emptyPercent}%`, cell(column.example)]),
  )
  const hidden = table.columns.length - MAX_COLUMNS_LISTED
  const shownColumns = table.columns.slice(0, MAX_COLUMNS_IN_ROWS)
  const rows = markdownTable(
    [...shownColumns.map(column => cell(column.name)), ...(table.columns.length > MAX_COLUMNS_IN_ROWS ? ['…'] : [])],
    table.rows.slice(0, facts.rowsShown).map(row => [...row.slice(0, MAX_COLUMNS_IN_ROWS).map(cell), ...(table.columns.length > MAX_COLUMNS_IN_ROWS ? ['…'] : [])]),
  )

  return [
    headline,
    `${sampled}${skipped}`,
    '',
    ...columns,
    ...(hidden > 0 ? [`… and ${hidden} more columns`] : []),
    '',
    `First ${Math.min(facts.rowsShown, table.rows.length)} rows${table.columns.length > MAX_COLUMNS_IN_ROWS ? ` (first ${MAX_COLUMNS_IN_ROWS} columns)` : ''}`,
    '',
    ...rows,
  ].join('\n')
}
