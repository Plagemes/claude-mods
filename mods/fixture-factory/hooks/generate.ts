import type { FixtureFactoryKind as Kind } from '../types'

export const DEFAULT_COUNT = 10
export const MAX_COUNT = 200
const TOKENS_PER_FIELD = 18
const MIN_TOKENS = 1024
const MAX_TOKENS = 32_000

/** `/fixtures User 25` → name and count; undefined when the name is no identifier. */
export const parseArgs = (args: string, fallbackCount: number): { name: string; count: number } | undefined => {
  const [name = '', countText] = args.trim().split(/\s+/)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined
  const count = countText === undefined ? fallbackCount : Number(countText)
  return { name, count: Number.isInteger(count) && count > 0 ? Math.min(count, MAX_COUNT) : fallbackCount }
}

/** A rough count of the fields a definition declares: lines that look like `name: type`, `name Type` or `name TYPE,`. */
export const fieldCount = (definition: string): number =>
  Math.max(1, definition.split('\n').filter(line => /^\s*[A-Za-z_][\w?]*\s*[:\s]\s*\S/.test(line) && !/^\s*(?:model|interface|type|class|create|enum|@@|\/\/|#|--|\}|\))/i.test(line)).length)

export const tokenBudget = (count: number, fields: number): number => Math.min(MAX_TOKENS, Math.max(MIN_TOKENS, count * fields * TOKENS_PER_FIELD + 400))

export const SYSTEM_PROMPT = [
  'You generate realistic test fixtures for a software project.',
  'Reply with one JSON array of objects and nothing else: no prose, no code fence, no comments.',
  'Each object is one record with exactly the fields of the definition, named as written there (snake_case stays snake_case).',
  'Respect every type, nullability, enum, length and uniqueness rule. Use null only where the field is optional or nullable.',
  'Make values realistic and varied, but fake: people with plausible names, emails at example.com/example.org, phone numbers in the 555 range, ISO 8601 dates and times, prices with two decimals.',
  'Ids: sequential integers from 1 for integer keys, valid random UUIDs for uuid/cuid-like keys. Foreign keys point to small plausible ids (1 to 10) so related fixtures can be generated the same way.',
  'Leave out relation fields that hold other records (Prisma relation fields, back-references); keep their scalar foreign keys.',
].join('\n')

export const userPrompt = (input: { name: string; count: number; kind: Kind; path: string; definition: string; related: readonly string[] }): string =>
  [
    `Generate ${input.count} records for \`${input.name}\`, defined in ${input.path} (${input.kind}):`,
    '',
    '```',
    input.definition,
    '```',
    ...(input.related.length === 0 ? [] : ['', 'Related definitions from the same file (enums and models it refers to):', '```', input.related.join('\n\n'), '```']),
    '',
    `Answer with the JSON array of ${input.count} objects only.`,
  ].join('\n')

export type Parsed = { ok: true; records: Record<string, unknown>[] } | { ok: false; error: string }

/** The array of records in a reply, fences and chatter around it ignored. */
export const parseRecords = (reply: string): Parsed => {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start === -1 || end <= start) return { ok: false, error: 'the reply holds no JSON array' }
  let value: unknown
  try {
    value = JSON.parse(reply.slice(start, end + 1))
  } catch (error) {
    return { ok: false, error: `the JSON does not parse (${error instanceof Error ? error.message : String(error)})` }
  }
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'the JSON is not a non-empty array' }
  const records = value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
  if (records.length !== value.length) return { ok: false, error: 'some items of the array are not objects' }
  return { ok: true, records }
}

/** Field names that not every record has, for the pane to warn about. */
export const unevenFields = (records: readonly Record<string, unknown>[]): string[] => {
  const all = new Set(records.flatMap(record => Object.keys(record)))
  return [...all].filter(field => !records.every(record => field in record))
}

/** As many whole records as fit in `maxChars` of pretty JSON, and how many were left out. */
export const previewOf = (records: readonly Record<string, unknown>[], maxChars: number): string => {
  let shown = records.length
  let text = JSON.stringify(records, null, 2)
  while (text.length > maxChars && shown > 1) {
    shown -= 1
    text = JSON.stringify(records.slice(0, shown), null, 2)
  }
  return shown === records.length ? text : `${text.slice(0, -2)}\n  … ${records.length - shown} more\n]`
}

/** `UserProfile` → `user-profile.json`. */
export const fileNameFor = (name: string): string =>
  `${name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()}.json`
