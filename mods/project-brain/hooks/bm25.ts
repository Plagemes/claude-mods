/**
 * An incremental inverted index with BM25 scoring over node features. Pure: no `$`.
 */

const K1 = 1.2
const B = 0.75

export class TextIndex {
  /** term → (doc → term frequency) */
  private readonly postings = new Map<string, Map<string, number>>()
  private readonly lengths = new Map<string, number>()
  private totalLength = 0

  get size(): number {
    return this.lengths.size
  }

  add(doc: string, features: readonly string[]): void {
    if (this.lengths.has(doc)) this.remove(doc)
    const counts = new Map<string, number>()
    for (const feature of features) counts.set(feature, (counts.get(feature) ?? 0) + 1)
    for (const [term, tf] of counts) {
      let list = this.postings.get(term)
      if (list === undefined) {
        list = new Map()
        this.postings.set(term, list)
      }
      list.set(doc, tf)
    }
    this.lengths.set(doc, features.length)
    this.totalLength += features.length
  }

  remove(doc: string): void {
    const length = this.lengths.get(doc)
    if (length === undefined) return
    for (const [term, list] of this.postings) {
      if (list.delete(doc) && list.size === 0) this.postings.delete(term)
    }
    this.lengths.delete(doc)
    this.totalLength -= length
  }

  /** Removes a doc whose features are known (no full scan). */
  removeKnown(doc: string, features: Iterable<string>): void {
    const length = this.lengths.get(doc)
    if (length === undefined) return
    for (const term of features) {
      const list = this.postings.get(term)
      if (list !== undefined && list.delete(doc) && list.size === 0) this.postings.delete(term)
    }
    this.lengths.delete(doc)
    this.totalLength -= length
  }

  /** How many docs hold the term. */
  df(term: string): number {
    return this.postings.get(term)?.size ?? 0
  }

  /** Inverse document frequency (BM25's, always positive). */
  idf(term: string): number {
    const n = this.lengths.size
    const df = this.df(term)
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  /** Docs holding the term. */
  docs(term: string): ReadonlyMap<string, number> | undefined {
    return this.postings.get(term)
  }

  /** BM25 score of every doc that shares a term with the query, plus which query terms each matched. */
  search(query: readonly string[], limit = Number.POSITIVE_INFINITY): { doc: string; score: number; matched: string[] }[] {
    const n = this.lengths.size
    if (n === 0) return []
    const average = this.totalLength / n || 1
    const scores = new Map<string, { score: number; matched: string[] }>()
    for (const term of new Set(query)) {
      const list = this.postings.get(term)
      if (list === undefined) continue
      const idf = this.idf(term)
      for (const [doc, tf] of list) {
        const length = this.lengths.get(doc) ?? average
        const score = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / average))
        const entry = scores.get(doc)
        if (entry === undefined) scores.set(doc, { score, matched: [term] })
        else {
          entry.score += score
          entry.matched.push(term)
        }
      }
    }
    const ranked = [...scores].map(([doc, entry]) => ({ doc, score: entry.score, matched: entry.matched }))
    ranked.sort((a, b) => b.score - a.score)
    return Number.isFinite(limit) ? ranked.slice(0, limit) : ranked
  }
}
