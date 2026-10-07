/**
 * Turning what happens into memories: sentences that state decisions, conventions and lessons (English and
 * Italian), code symbols an edit declares, the signature of a failing build or test, the project's existing
 * knowledge files (CLAUDE.md, ADRs, glossary, journal, CODEOWNERS), the background model's JSON, and whether
 * Claude's answer and edits used a recalled memory. Pure: no `$`.
 */
import { extractPaths, extractSymbols, featuresOf } from './features'
import type { NodeKind } from './graph'

export type Extracted = { kind: NodeKind; text: string; files?: string[]; ref?: string; key?: string; date?: string }

const MIN_SENTENCE = 12
const MAX_SENTENCE = 280
const MAX_PER_TEXT = 6

const PATTERNS: readonly (readonly [NodeKind, RegExp])[] = [
  [
    'decision',
    /\b(?:we|i)(?:'ve| have)? (?:decided|agreed|chose|settled on|went with|picked)\b|\blet'?s (?:use|go with|switch to|keep|adopt|stick with)\b|\bwe(?:'ll| will) (?:use|go with|switch to|adopt)\b|\bdecision\s*:|\b(?:abbiamo|ho) (?:deciso|scelto|optato|concordato)\b|\b(?:usiamo|useremo|adottiamo|passiamo a|scegliamo|teniamo)\b|\bdecisione\s*:/i,
  ],
  [
    'convention',
    /\b(?:always|never) (?:use|run|call|write|put|add|commit|import|prefer|keep|name|avoid|push|test|log)\b|\bfrom now on\b|\b(?:convention|rule|style guide)\s*:|\bmake sure (?:to|you)\b|\bprefer\b.+\bover\b|\bdon'?t (?:ever )?(?:use|call|commit|import|push)\b|\b(?:usa|usare|esegui|scrivi|metti|chiama|committa|importa|evita) sempre\b|\bsempre (?:usare|eseguire|scrivere|mettere|chiamare|evitare)\b|\bnon (?:usare|chiamare|committare|importare|pushare|scrivere) mai\b|\bmai (?:usare|chiamare|committare)\b|\bd'ora in (?:poi|avanti)\b|\b(?:convenzione|regola)\s*:|\bricorda(?:ti)? (?:di|che)\b/i,
  ],
  [
    'lesson',
    /\bthe (?:fix|problem|issue|bug|cause|root cause|culprit) (?:was|is)\b|\b(?:turns out|it turned out)\b|\blessons? (?:learned|learnt)?\s*:|\bfixed (?:it |this |the \w+ )?by\b|\b(?:il problema|l'errore|la causa|il bug|la soluzione) (?:era|e|è|stava)\b|\b(?:risolto|sistemato|corretto) (?:\w+ )?(?:con|usando|aggiungendo|cambiando|rimuovendo)\b|\blezione\s*:|\bin realta\b|\bin realtà\b/i,
  ],
  ['task', /^\s*(?:todo|to do|da fare)\s*[:-]|\bnext step\s*:|\bprossimo passo\s*:/i],
]

/** Plain sentences of a text: code blocks, inline code marks, markdown bullets and emphasis removed. */
export function sentences(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`\n]{1,80})`/g, '$1')
  const out: string[] = []
  for (const line of prose.split(/\n+/)) {
    const clean = line.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '').replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1').replace(/^#+\s*/, '').trim()
    if (clean === '') continue
    for (const part of clean.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý"'(])/)) {
      const sentence = part.trim()
      if (sentence.length >= MIN_SENTENCE && sentence.length <= MAX_SENTENCE) out.push(sentence)
    }
  }
  return out
}

/** Sentences that state a decision, a convention, a lesson or a task, by phrasing (English and Italian). */
export function heuristicExtract(text: string): Extracted[] {
  const out: Extracted[] = []
  for (const sentence of sentences(text)) {
    if (/\?\s*$/.test(sentence)) continue
    const match = PATTERNS.find(([, pattern]) => pattern.test(sentence))
    if (match === undefined) continue
    const files = extractPaths(sentence)
    out.push({ kind: match[0], text: sentence, ...(files.length > 0 ? { files } : {}) })
    if (out.length >= MAX_PER_TEXT) break
  }
  return out
}

// ── Code ───────────────────────────────────────────────────────────────────────────────────────────

const DECLARATION =
  /\b(?:function\*?|class|interface|type|enum|def|fn|func|struct|trait|module|const|let|var)\s+([A-Za-z_$][\w$]{2,})|^\s*(?:export\s+)?(?:async\s+)?([A-Za-z_$][\w$]{2,})\s*(?:=\s*(?:async\s*)?\(|\([^)]*\)\s*\{)/gm
const COMMON = new Set(['constructor', 'render', 'default', 'props', 'state', 'self', 'this', 'main', 'init', 'test', 'describe', 'expect', 'index', 'value', 'result', 'data', 'error'])
const MAX_SYMBOLS = 8

/** Names a piece of code declares (functions, classes, types, constants), the first few. */
export function declaredSymbols(code: string): string[] {
  const found: string[] = []
  for (const match of code.matchAll(DECLARATION)) {
    const name = match[1] ?? match[2]
    if (name === undefined || COMMON.has(name.toLowerCase()) || found.includes(name)) continue
    found.push(name)
    if (found.length >= MAX_SYMBOLS) break
  }
  return found
}

const IMPORT = /\b(?:import\s[^'"]*?from\s*|import\s*\(?\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g

/** Relative modules an edit imports, resolved against the edited file's folder (no extension guessing). */
export function relativeImports(filePath: string, code: string): string[] {
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
  const out = new Set<string>()
  for (const match of code.matchAll(IMPORT)) {
    const parts = [...(dir === '' ? [] : dir.split('/')), ...(match[1] ?? '').split('/')]
    const resolved: string[] = []
    for (const part of parts) {
      if (part === '.' || part === '') continue
      if (part === '..') resolved.pop()
      else resolved.push(part)
    }
    out.add(resolved.join('/'))
  }
  return [...out]
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────

const BUILD = /\b(?:tsc|build|compile|cargo (?:build|check|clippy)|go (?:build|vet)|mvn|gradle|make|webpack|vite build|next build|esbuild|rollup|swiftc|javac|gcc|clang|eslint|ruff|mypy|pyright|lint|typecheck|check)\b/i

export const isBuildCommand = (command: string): boolean => BUILD.test(command)

const KEY_WORDS = 3

/** What identifies a command across runs: its first words, with flags, paths and env assignments left out. */
export function commandKey(command: string): string {
  const first = command.split(/&&|\|\||;|\|/)[0] ?? command
  const words: string[] = []
  for (const word of first.trim().split(/\s+/)) {
    if (/^-/.test(word)) continue
    if (/^\w+=/.test(word) || /[/\\]|^\.|\.\w+$/.test(word)) continue
    words.push(word)
    if (words.length === KEY_WORDS) break
  }
  return words.join(' ')
}

/** Lines that name the error itself, then lines that only say something failed. */
const ERROR_LINES: readonly RegExp[] = [
  /\b\w*(?:Error|Exception)\b|\bpanic(?:ked)?\b|\berror(?:\[\w+\])?:|\bTS\d{4}\b|\bE\d{3,4}\b|cannot find|not found|undefined is not|expected .+ (?:to|but)/,
  /\bfailed\b|\bfailure\b|✗|×|\bFAIL\b|\berror\b/i,
]

/** The line of the output that best names the error, trimmed; undefined when none does. */
export function errorLine(output: string): string | undefined {
  const lines = output.split('\n').map(raw => raw.replace(/\u001b\[[0-9;]*m/g, '').trim()).filter(line => line.length >= 8 && !/^(?:at |\d+ passed\b)/.test(line))
  for (const pattern of ERROR_LINES) {
    const line = lines.find(one => pattern.test(one))
    if (line !== undefined) return line.slice(0, 200)
  }
  return undefined
}

/** An error's identity across runs: numbers, quoted values, hex and line:column positions blurred. */
export const errorSignature = (line: string): string =>
  line
    .replace(/:\d+(?::\d+)?/g, ':N')
    .replace(/0x[0-9a-f]+/gi, 'HEX')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, 'N')
    .replace(/(['"`])[^'"`]{1,60}\1/g, 'Q')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)

// ── Existing knowledge files ───────────────────────────────────────────────────────────────────────

/** CLAUDE.md: each rule-like line becomes a convention (already in the system prompt: never injected). */
export function parseClaudeMd(text: string): Extracted[] {
  const out: Extracted[] = []
  for (const line of text.replace(/```[\s\S]*?```/g, '').split('\n')) {
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.{10,280})$/)
    if (bullet?.[1] === undefined) continue
    const clean = bullet[1].replace(/[*_`]/g, '').trim()
    const files = extractPaths(clean)
    out.push({ kind: /\b(?:decid|chose|decis|scelt)/i.test(clean) ? 'decision' : 'convention', text: clean, ...(files.length > 0 ? { files } : {}) })
  }
  return out.slice(0, 200)
}

/** An ADR: its title and the first sentence of its Decision section (status kept when said). */
export function parseAdr(path: string, text: string): Extracted | undefined {
  const title = text.match(/^#\s+(?:\d+[.:]?\s*)?(.+)$/m)?.[1]?.trim()
  if (title === undefined) return undefined
  const status = text.match(/^##\s*Status\s*\n+\s*(\w+)/im)?.[1] ?? text.match(/^Status:\s*(\w+)/im)?.[1]
  const decisionBody = text.match(/^##\s*(?:Decision|Decisione)\s*\n([\s\S]*?)(?:\n##\s|$)/im)?.[1] ?? ''
  const decision = sentences(decisionBody)[0] ?? ''
  const date = text.match(/\b(20\d\d-\d\d-\d\d)\b/)?.[1]
  const body = decision === '' || decision.toLowerCase().includes(title.toLowerCase()) ? title : `${title}: ${decision}`
  const files = extractPaths(`${decisionBody}`).slice(0, 6)
  return {
    kind: 'decision',
    text: status !== undefined && /superseded|deprecated|rejected/i.test(status) ? `${body} (${status.toLowerCase()})` : body,
    ref: path,
    key: `adr:${path}`,
    ...(date === undefined ? {} : { date }),
    ...(files.length > 0 ? { files } : {}),
  }
}

/** A glossary: `**Term**: definition`, `Term — definition`, table rows `| Term | definition |`. */
export function parseGlossary(text: string): Extracted[] {
  const out: Extracted[] = []
  for (const line of text.split('\n')) {
    const row = line.match(/^\s*\|\s*([^|]{1,60}?)\s*\|\s*([^|]{3,240}?)\s*\|/)
    const pair = line.match(/^\s*(?:[-*]\s+)?\**([A-Za-zÀ-ÿ0-9][^:*—–]{0,59}?)\**\s*(?::|—|–| - )\s*(.{3,240})$/)
    const match = row ?? pair
    if (match?.[1] === undefined || match[2] === undefined) continue
    const term = match[1].replace(/[*_`]/g, '').trim()
    if (/^-+$/.test(term) || /^term|^termine/i.test(term)) continue
    out.push({ kind: 'term', text: `${term}: ${match[2].replace(/[*_`]/g, '').trim()}`, key: `term:${term.toLowerCase()}` })
  }
  return out.slice(0, 300)
}

/** CODEOWNERS: one person memory per owner and pattern (`@team/api owns src/api/**`). */
export function parseCodeowners(text: string): Extracted[] {
  const out: Extracted[] = []
  for (const line of text.split('\n')) {
    const clean = line.replace(/#.*$/, '').trim()
    if (clean === '') continue
    const [pattern, ...owners] = clean.split(/\s+/)
    if (pattern === undefined || owners.length === 0) continue
    for (const owner of owners.filter(name => name.startsWith('@') || name.includes('@'))) {
      out.push({ kind: 'person', text: `${owner} owns ${pattern}`, ref: pattern, key: `owner:${owner}|${pattern}` })
    }
  }
  return out.slice(0, 200)
}

/** Whether a file path falls under a CODEOWNERS pattern (`*`, `**`, directory and extension patterns). */
export function ownerPatternMatches(pattern: string, path: string): boolean {
  if (pattern === '*') return true
  const anchored = pattern.startsWith('/')
  const body = pattern.replace(/^\//, '')
  const source = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  const regex = new RegExp(`${anchored ? '^' : '(?:^|/)'}${source}${body.endsWith('/') ? '' : '(?:$|/)'}`)
  return regex.test(path)
}

/** A journal: sentences that read as decisions, conventions or lessons; other bullet lines as notes. */
export function parseJournal(text: string): Extracted[] {
  const found = heuristicExtract(text)
  const date = text.match(/\b(20\d\d-\d\d-\d\d)\b/)?.[1]
  return found.map(item => ({ ...item, ...(date === undefined ? {} : { date }) }))
}

// ── The background model ───────────────────────────────────────────────────────────────────────────

export type TurnDigest = { turn: number; prompt: string; answer: string; files: string[]; fixes: string[] }

export const EXTRACTION_SYSTEM =
  "You maintain a software project's long-term memory. From the conversation excerpts, extract only durable knowledge " +
  'worth remembering in future sessions: decisions (what was chosen, and why), conventions (rules the project follows), ' +
  'lessons (a mistake and its fix), terms (project vocabulary), people (who owns what), tasks (open follow-ups). Skip ' +
  'anything ephemeral, obvious, or only about this one change. Write each item as one self-contained sentence in the ' +
  'language of the excerpt (English or Italian), at most 200 characters, naming files or symbols when relevant. ' +
  'Reply with JSON only: {"items":[{"kind":"decision","text":"…","files":["src/db.ts"]}]}, at most 6 items, ' +
  'or {"items":[]} when nothing qualifies.'

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/** The prompt for one batch of finished turns. */
export function extractionPrompt(batch: readonly TurnDigest[]): string {
  return batch
    .map(turn =>
      [
        `### Turn ${turn.turn}`,
        `User: ${clip(turn.prompt, 1500)}`,
        `Assistant: ${clip(turn.answer, 2500)}`,
        ...(turn.files.length > 0 ? [`Files edited: ${turn.files.slice(0, 12).join(', ')}`] : []),
        ...turn.fixes.map(fix => `Fix: ${fix}`),
      ].join('\n'),
    )
    .join('\n\n')
}

const MODEL_KINDS = new Set<NodeKind>(['decision', 'convention', 'lesson', 'term', 'person', 'task', 'note'])

/** The model's items, validated; anything malformed is dropped. */
export function parseExtraction(reply: string): Extracted[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const items = (parsed as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: Extracted[] = []
  for (const item of items.slice(0, 8)) {
    const { kind, text, files } = (item ?? {}) as { kind?: unknown; text?: unknown; files?: unknown }
    if (typeof kind !== 'string' || !MODEL_KINDS.has(kind as NodeKind) || typeof text !== 'string' || text.trim().length < 8) continue
    const paths = Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string').slice(0, 6) : []
    out.push({ kind: kind as NodeKind, text: text.trim().slice(0, MAX_SENTENCE), ...(paths.length > 0 ? { files: paths } : {}) })
  }
  return out
}

export const SUMMARY_SYSTEM =
  'You summarise related project memories. Reply with one sentence (at most 200 characters, same language as the ' +
  'memories) stating the common thread a developer should remember. No preamble.'

export const summaryPrompt = (texts: readonly string[]): string => texts.map(text => `- ${text}`).join('\n')

// ── Was it used? ───────────────────────────────────────────────────────────────────────────────────

export type Evidence = { text: string; files: ReadonlySet<string>; symbols: ReadonlySet<string> }

/**
 * Whether Claude's answer or edits reference a memory: one of its files was edited, one of its symbols was
 * written, or the answer shares enough of its distinctive (high-idf) words.
 */
export function wasUsed(memory: { text: string; ref: string | null; features: readonly string[] }, evidence: Evidence, idf: (term: string) => number): boolean {
  const paths = [...extractPaths(memory.text), ...(memory.ref === null ? [] : [memory.ref])].map(path => path.toLowerCase())
  const edited = [...evidence.files].map(path => path.toLowerCase())
  if (paths.some(path => edited.some(file => file === path || file.endsWith(`/${path}`) || path.endsWith(`/${file}`)))) return true
  const symbols = new Set([...evidence.symbols].map(symbol => symbol.toLowerCase()))
  if (extractSymbols(memory.text).some(symbol => symbols.has(symbol.toLowerCase()) || evidence.text.includes(symbol))) return true
  const answer = new Set(featuresOf(evidence.text))
  const terms = [...new Set(memory.features)].filter(term => !term.startsWith('path:') && !term.startsWith('file:'))
  if (terms.length === 0) return false
  let shared = 0
  let sharedWeight = 0
  let total = 0
  for (const term of terms) {
    const weight = idf(term) * (term.includes('_') ? 2 : 1)
    total += weight
    if (answer.has(term)) {
      shared += 1
      sharedWeight += weight
    }
  }
  return shared >= 2 && sharedWeight / total >= 0.3
}
