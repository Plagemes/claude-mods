// Pure search: markdown → chunks → BM25 ranking. No `$` here, so tests can call it directly.

export type Chunk = {
  /** Where the text came from: a relative path, or `memory`. */
  source: string
  /** The heading the chunk sits under, or the file's name. */
  title: string
  /** 1-based line the chunk starts on (0 for a memory). */
  line: number
  text: string
}

export type Hit = Chunk & { score: number; snippet: string }

/** What a result shows: a hit without its whole text. */
export type ShownHit = Pick<Hit, 'source' | 'title' | 'line' | 'snippet' | 'score'>

const K1 = 1.2
const B = 0.75
const TITLE_WEIGHT = 2
const PHRASE_BONUS = 1.5
const CHUNK_TARGET = 900
const SNIPPET_CHARS = 280

const STOPWORDS = new Set(
  ('a an and are as at be but by can did do does for from had has have how i if in into is it its ' +
    'me my no not of on or our so than that the their them then there these they this to too us was ' +
    'we were what when where which who why will with you your about after all also any just more ' +
    'some such use used using').split(' '),
)

const stem = (word: string): string => {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter(word => word.length > 1 && !STOPWORDS.has(word))
    .map(stem)

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Splits markdown under its headings; long sections become paragraph windows. */
export const chunkMarkdown = (source: string, markdown: string): Chunk[] => {
  const chunks: Chunk[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let title = fileName(source)
  let start = 1
  let body: string[] = []

  const flush = (): void => {
    const text = body.join('\n').trim()
    if (text !== '') {
      let window: string[] = []
      let windowStart = start
      let size = 0
      body.forEach((line, offset) => {
        if (size > CHUNK_TARGET && line.trim() === '') {
          chunks.push({ source, title, line: windowStart, text: window.join('\n').trim() })
          window = []
          size = 0
          windowStart = start + offset + 1
          return
        }
        window.push(line)
        size += line.length + 1
      })
      const rest = window.join('\n').trim()
      if (rest !== '') chunks.push({ source, title, line: windowStart, text: rest })
    }
    body = []
  }

  lines.forEach((line, index) => {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading?.[1] !== undefined) {
      flush()
      title = heading[1]
      start = index + 2
      return
    }
    if (body.length === 0 && line.trim() === '') {
      start = index + 2
      return
    }
    body.push(line)
  })
  flush()
  return chunks
}

const snippetOf = (text: string, terms: ReadonlySet<string>): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= SNIPPET_CHARS) return flat
  const words = flat.split(' ')
  let offset = 0
  let at = 0
  for (const word of words) {
    if (tokenize(word).some(token => terms.has(token))) {
      at = offset
      break
    }
    offset += word.length + 1
  }
  const from = Math.max(0, Math.min(at - 60, flat.length - SNIPPET_CHARS))
  const cut = flat.slice(from, from + SNIPPET_CHARS)
  return `${from > 0 ? '…' : ''}${cut}${from + SNIPPET_CHARS < flat.length ? '…' : ''}`
}

/** Ranks chunks for the query with Okapi BM25 (titles count double, exact phrases get a bonus). */
export const search = (chunks: readonly Chunk[], query: string, limit: number): Hit[] => {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0 || chunks.length === 0) return []
  const docs = chunks.map(chunk => {
    const tokens = [...tokenize(chunk.text), ...Array.from({ length: TITLE_WEIGHT }, () => tokenize(chunk.title)).flat()]
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    return { chunk, counts, length: tokens.length }
  })
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const idf = new Map(
    terms.map(term => {
      const n = docs.filter(doc => doc.counts.has(term)).length
      return [term, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))]
    }),
  )
  const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const termSet = new Set(terms)

  return docs
    .map(doc => {
      let score = 0
      for (const term of terms) {
        const tf = doc.counts.get(term) ?? 0
        if (tf === 0) continue
        score += (idf.get(term) ?? 0) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / averageLength)))
      }
      if (score > 0 && phrase.includes(' ') && doc.chunk.text.toLowerCase().replace(/\s+/g, ' ').includes(phrase)) {
        score += PHRASE_BONUS
      }
      return { ...doc.chunk, score, snippet: '' }
    })
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(hit => ({ ...hit, snippet: snippetOf(hit.text, termSet) }))
}

/** The tool's answer: numbered matches with where each came from. */
export const formatHits = (query: string, hits: readonly ShownHit[], searched: string): string => {
  if (hits.length === 0) return `No matches for "${query}" (${searched}).`
  const lines = hits.map((hit, index) => {
    const where = hit.source === 'memory' ? `memory · ${hit.title}` : `${hit.source} › ${hit.title} (line ${hit.line})`
    return `${index + 1}. ${where} — score ${hit.score.toFixed(1)}\n   ${hit.snippet}`
  })
  return [`${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}" (${searched}):`, '', lines.join('\n\n')].join('\n')
}
