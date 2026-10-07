/**
 * Embedding-free features of a text: normalised word stems (English and Italian, light stemming that maps
 * `decisione`/`decision`, `convenzione`/`convention` together), bigrams of neighbouring stems, file paths
 * (`path:src/db.ts`, `file:db.ts`) and code symbols (`sym:createuser`). Pure: no `$`.
 */

const STOPWORDS = new Set(
  (
    // English
    'a an and are as at be been being but by can could did do does doing done for from had has have having he her here ' +
    'him his how i if in into is it its just me more most my no nor not now of off on once only or other our ours out over ' +
    'own same she should so some such than that the their them then there these they this those through to too under until ' +
    'up very was we were what when where which while who whom why will with would you your yours also any all each few both ' +
    'about above after again against below between down during further before because let lets use ok okay yes please thanks ' +
    'always never every one two get got make made like want need see look new now still yet ' +
    // Italian
    'il lo la i gli le un uno una di da del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli ' +
    'dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle con per tra fra su e ed o od ma se che chi cui non ' +
    'come dove quando quanto quale quali questo questa questi queste quello quella quelli quelle sono sei siamo siete era ' +
    'erano essere stato stata stati state ho hai ha abbiamo avete hanno avere anche ancora gia piu meno molto poco tutto tutti ' +
    'sempre mai ogni mio mia miei mie tuo tua suo sua nostro nostra loro lui lei noi voi io tu ci vi ne si mi ti fa fare fatto ' +
    'cosa perche pero quindi allora poi ora qui qua li la grazie ok si no'
  ).split(' '),
)

const PATH = /(?:\.{0,2}\/)?(?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b|\b[A-Za-z0-9_-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cpp|hpp|cs|php|sql|md|json|ya?ml|toml|css|scss|html|vue|svelte|sh|prisma|graphql|proto)\b/g
const SYMBOL = /\b(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+|[A-Za-z_][A-Za-z0-9_]{2,}(?=\())/g
const WORD = /[a-z0-9]+/g
const MAX_NUMBER_LENGTH = 4

/** Lower-cased, accents folded (`perché` → `perche`). */
export const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Suffix rules applied once each, in order; a rule fires only when it leaves at least three letters. */
const SUFFIXES: readonly (readonly [RegExp, string])[] = [
  // Italian ↔ English: -zione/-zioni → -tion, -sione → -sion, -mente/-ly dropped.
  [/zion[ei]$/, 'tion'],
  [/sion[ei]$/, 'sion'],
  [/mente$/, ''],
  // English inflections.
  [/ies$/, 'y'],
  [/sses$/, 'ss'],
  [/ations?$/, 'ate'],
  [/ings?$/, ''],
  [/ed$/, ''],
  [/ly$/, ''],
  [/ments?$/, ''],
  [/ness$/, ''],
  [/(?<![su])s$/, ''],
  // Italian verbs and participles.
  [/(?:iamo|iate|ando|endo|are|ere|ire|ato|ata|ati|ate|ito|ita|iti|ite|uto|uta|uti|ute|ano|ono)$/, ''],
]
const MIN_STEM = 3

/** A light stem: the same for `decided`/`decide`/`decisions` and for `usiamo`/`using`/`used`. */
export function stem(word: string): string {
  if (word.length <= MIN_STEM || /^\d+$/.test(word)) return word
  let out = word
  for (const [pattern, replacement] of SUFFIXES) {
    const next = out.replace(pattern, replacement)
    if (next !== out && next.length >= MIN_STEM) out = next
  }
  if (out.length > MIN_STEM) out = out.replace(/[aeiouy]$/, '')
  if (out.length > MIN_STEM) out = out.replace(/([bdfgmnprt])\1$/, '$1')
  return out
}

/** File paths mentioned in a text, `./` dropped. */
export function extractPaths(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(PATH)) {
    const path = match[0].replace(/^\.\//, '')
    if (!/^\d+(?:\.\d+)+$/.test(path) && !/^https?:/.test(path)) found.add(path)
  }
  return [...found]
}

/** Identifiers that look like code (camelCase, PascalCase with two humps, snake_case, called with `(`). */
export function extractSymbols(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(SYMBOL)) if (match[0].length >= 4) found.add(match[0])
  return [...found]
}

const splitIdentifier = (word: string): string => word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ')

/** The stems of a text's words, in order, stopwords and long numbers left out. */
export function stems(text: string): string[] {
  const out: string[] = []
  for (const match of fold(splitIdentifier(text)).matchAll(WORD)) {
    const word = match[0]
    if (word.length < 2 || STOPWORDS.has(word)) continue
    if (/^\d+$/.test(word) && word.length > MAX_NUMBER_LENGTH) continue
    out.push(stem(word))
  }
  return out
}

/**
 * Every feature of a text, repeated as often as it occurs (term frequency): stems, bigrams (`a_b`, within a
 * sentence), `path:`/`file:` for paths and `sym:` for symbols. `extra` adds paths and symbols known from elsewhere.
 */
export function featuresOf(text: string, extra: { paths?: readonly string[]; symbols?: readonly string[] } = {}): string[] {
  const paths = [...new Set([...extractPaths(text), ...(extra.paths ?? [])])]
  const withoutPaths = text.replace(PATH, ' ')
  const symbols = [...new Set([...extractSymbols(withoutPaths), ...(extra.symbols ?? [])])]
  const out: string[] = []
  for (const sentence of withoutPaths.split(/[.!?;:\n]+/)) {
    const words = stems(sentence)
    out.push(...words)
    for (let i = 1; i < words.length; i += 1) out.push(`${words[i - 1]}_${words[i]}`)
  }
  for (const path of paths) {
    const lower = fold(path)
    const base = lower.slice(lower.lastIndexOf('/') + 1)
    out.push(`path:${lower}`, `file:${base}`)
    const name = base.replace(/\.[^.]+$/, '')
    out.push(...stems(name))
  }
  for (const symbol of symbols) out.push(`sym:${fold(symbol)}`)
  return out
}

/** Distinct features. */
export const featureSet = (features: readonly string[]): Set<string> => new Set(features)

/** Jaccard overlap of two feature sets, 0..1. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const feature of small) if (large.has(feature)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** Rough tokens of a text for budgeting (about four characters each). */
export const approxTokens = (text: string): number => Math.ceil(text.length / 4)

/** A stable short hash (FNV-1a, base 36) for node ids. */
export function hashKey(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** The identity of a free text: folded, whitespace and punctuation collapsed. */
export const normalizeKey = (text: string): string =>
  fold(text)
    .replace(/[^a-z0-9/._@-]+/g, ' ')
    .trim()
    .slice(0, 200)
