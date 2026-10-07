/**
 * Turns what happened (commits, journal notes, hub events) into the email: sections of plain-language bullets, a
 * subject, a text body and an HTML body. The tone (client / manager / technical) decides how much detail and
 * jargon, the language (en / it) the words. Pure: the same input always gives the same digest.
 */
import type { Commit, DigestEvent, Journal } from './sources'
import { unresolved } from './sources'
import { epochToWall } from './zones'

export type Tone = 'client' | 'manager' | 'technical'
export type Language = 'en' | 'it'
export type Period = 'daily' | 'weekly'

export type DigestInput = {
  project: string
  period: Period
  from: number
  to: number
  zone: string
  commits: readonly Commit[]
  events: readonly DigestEvent[]
  journals: readonly Journal[]
  /** What the AI cost in the period, when known; shown only when the options ask for it. */
  costUsd?: number
  costScope?: 'project' | 'all'
  /** One-off note written for this digest. */
  note?: string
}

export type DigestOptions = { tone: Tone; language: Language; includeCost: boolean; signature: string }

export type SectionId = 'done' | 'shipped' | 'health' | 'next' | 'blockers' | 'alerts' | 'cost' | 'note'

export type Section = { id: SectionId; title: string; items: string[]; paragraph?: string }

export type Digest = {
  subject: string
  text: string
  html: string
  sections: Section[]
  /** Nothing happened worth an email: the scheduler skips these. */
  isEmpty: boolean
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────────

type Words = {
  months: string[]
  weekdays: string[]
  daily: string
  weekly: string
  greeting: Record<Tone, string>
  intro: (tone: Tone, project: string, period: Period, when: string) => string
  titles: Record<SectionId, string>
  categories: Record<Category, string>
  noBlockers: Record<Tone, string>
  empty: string
  changes: (n: number) => string
  more: (n: number) => string
  behindTheScenes: (n: number) => string
  checksFailing: string
  releaseFailed: (what: string) => string
  question: string
  builds: (passed: number, failed: number) => string
  tests: string
  deployed: string
  inReview: string
  alertsLine: (n: number, critical: number) => string
  cost: (usd: string, scope: 'project' | 'all') => string
}

const EN: Words = {
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  daily: 'Daily update',
  weekly: 'Weekly update',
  greeting: { client: 'Hello,', manager: 'Hi,', technical: 'Hi team,' },
  intro: (tone, project, period, when) =>
    tone === 'client'
      ? `Here is a short update on ${project} for ${period === 'daily' ? 'today,' : 'the week'} ${when}.`
      : tone === 'manager'
        ? `${project}: summary for ${when}.`
        : `${project} — activity ${when}.`,
  titles: { done: 'What was done', shipped: 'Shipped and in review', health: 'Health', next: "What's next", blockers: 'Blockers and questions', alerts: 'Alerts', cost: 'Cost', note: 'Note' },
  categories: { new: 'New', fix: 'Fixed', improved: 'Improved', docs: 'Docs', maintenance: 'Maintenance', other: 'Other' },
  noBlockers: { client: 'Nothing is blocking us right now.', manager: 'No blockers.', technical: 'No blockers.' },
  empty: 'No activity was recorded in this period.',
  changes: n => `${n} ${n === 1 ? 'change' : 'changes'}`,
  more: n => `…and ${n} more`,
  behindTheScenes: n => `Plus ${n} behind-the-scenes ${n === 1 ? 'change' : 'changes'} (tests, tooling, documentation).`,
  checksFailing: 'Some automated checks are failing; we are looking into it.',
  releaseFailed: what => `A release did not go through (${what}); we are looking into it.`,
  question: 'Open question',
  builds: (passed, failed) => `Builds: ${passed} passed, ${failed} failed`,
  tests: 'Latest tests',
  deployed: 'Deployed',
  inReview: 'In review',
  alertsLine: (n, critical) => `${n} ${n === 1 ? 'alert needed' : 'alerts needed'} attention${critical > 0 ? ` (${critical} critical)` : ''}.`,
  cost: (usd, scope) => `AI usage cost: ${usd}${scope === 'all' ? ' (all projects)' : ''}`,
}

const IT: Words = {
  months: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  weekdays: ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'],
  daily: 'Aggiornamento giornaliero',
  weekly: 'Aggiornamento settimanale',
  greeting: { client: 'Buongiorno,', manager: 'Ciao,', technical: 'Ciao team,' },
  intro: (tone, project, period, when) =>
    tone === 'client'
      ? `Ecco un breve aggiornamento su ${project} per ${period === 'daily' ? 'oggi,' : 'la settimana'} ${when}.`
      : tone === 'manager'
        ? `${project}: riepilogo ${when}.`
        : `${project} — attività ${when}.`,
  titles: { done: 'Cosa è stato fatto', shipped: 'Rilasciato e in revisione', health: 'Stato tecnico', next: 'Prossimi passi', blockers: 'Blocchi e domande', alerts: 'Avvisi', cost: 'Costi', note: 'Nota' },
  categories: { new: 'Novità', fix: 'Correzioni', improved: 'Miglioramenti', docs: 'Documentazione', maintenance: 'Manutenzione', other: 'Altro' },
  noBlockers: { client: 'Al momento nulla ci blocca.', manager: 'Nessun blocco.', technical: 'Nessun blocco.' },
  empty: 'Nessuna attività registrata in questo periodo.',
  changes: n => `${n} ${n === 1 ? 'modifica' : 'modifiche'}`,
  more: n => `…e altre ${n}`,
  behindTheScenes: n => `Più ${n} ${n === 1 ? 'intervento' : 'interventi'} dietro le quinte (test, strumenti, documentazione).`,
  checksFailing: 'Alcuni controlli automatici falliscono; stiamo verificando.',
  releaseFailed: what => `Un rilascio non è andato a buon fine (${what}); stiamo verificando.`,
  question: 'Domanda aperta',
  builds: (passed, failed) => `Build: ${passed} riuscite, ${failed} fallite`,
  tests: 'Ultimi test',
  deployed: 'Rilasciato',
  inReview: 'In revisione',
  alertsLine: (n, critical) => `${n} ${n === 1 ? 'avviso ha richiesto' : 'avvisi hanno richiesto'} attenzione${critical > 0 ? ` (${critical} critici)` : ''}.`,
  cost: (usd, scope) => `Costo d'uso dell'AI: ${usd}${scope === 'all' ? ' (tutti i progetti)' : ''}`,
}

const WORDS: Record<Language, Words> = { en: EN, it: IT }

// ── Commits in plain language ──────────────────────────────────────────────────────────────────────

export type Category = 'new' | 'fix' | 'improved' | 'docs' | 'maintenance' | 'other'

const CONVENTIONAL = /^(feat|feature|fix|bugfix|hotfix|perf|refactor|docs|doc|test|tests|chore|build|ci|style|revert)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i
const TYPE_CATEGORY: Record<string, Category> = {
  feat: 'new',
  feature: 'new',
  fix: 'fix',
  bugfix: 'fix',
  hotfix: 'fix',
  perf: 'improved',
  refactor: 'improved',
  docs: 'docs',
  doc: 'docs',
  test: 'maintenance',
  tests: 'maintenance',
  chore: 'maintenance',
  build: 'maintenance',
  ci: 'maintenance',
  style: 'maintenance',
  revert: 'fix',
}

const capital = (text: string): string => (text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`)

/** A subject without the noise a reader does not care about: PR numbers, CI tags, a trailing full stop. */
export function tidy(subject: string): string {
  return subject
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/\s*\[(?:skip ci|ci skip|no ci)\]\s*/gi, ' ')
    .replace(/^(?:wip|WIP)[:\s-]+/, '')
    .replace(/[.\s]+$/, '')
    .trim()
}

/** What a commit is (new, fixed, improved…) and how to say it, from a conventional prefix or its first word. */
export function classifyCommit(subject: string): { category: Category; text: string } {
  const clean = tidy(subject)
  const match = CONVENTIONAL.exec(clean)
  if (match !== null) {
    const category = TYPE_CATEGORY[(match[1] ?? '').toLowerCase()] ?? 'other'
    const scope = (match[2] ?? '').trim()
    const body = tidy(match[4] ?? '')
    return { category, text: capital(scope === '' ? body : `${scope}: ${body}`) }
  }
  const first = (clean.split(/\s+/)[0] ?? '').toLowerCase()
  const byVerb: [RegExp, Category][] = [
    [/^(add|adds|added|implement|implements|implemented|create|created|introduce|introduced|new|support|enable)$/, 'new'],
    [/^(fix|fixes|fixed|resolve|resolved|correct|corrected|patch|patched|repair|handle)$/, 'fix'],
    [/^(improve|improved|optimi[sz]e|optimi[sz]ed|speed|simplify|simplified|clean|cleanup|refactor|refactored|tweak|polish)$/, 'improved'],
    [/^(doc|docs|document|documented|readme)$/, 'docs'],
    [/^(test|tests|bump|merge|lint|format|chore|update|upgrade|release|wip|revert)$/, 'maintenance'],
  ]
  const category = byVerb.find(([pattern]) => pattern.test(first))?.[1] ?? 'other'
  return { category, text: capital(clean) }
}

type Change = { category: Category; text: string; sha: string; author: string; at: number }

/** The commits as changes, the same wording said once. */
export function changesOf(commits: readonly Commit[]): Change[] {
  const seen = new Set<string>()
  const changes: Change[] = []
  for (const commit of commits) {
    const { category, text } = classifyCommit(commit.subject)
    const key = text.toLowerCase()
    if (text === '' || seen.has(key)) continue
    seen.add(key)
    changes.push({ category, text, sha: commit.sha, author: commit.author, at: commit.at })
  }
  return changes
}

// ── Dates ────────────────────────────────────────────────────────────────────────────────────────────

type Wall = ReturnType<typeof epochToWall>

const dayText = (wall: Wall, words: Words, withYear: boolean, withMonth = true): string =>
  `${wall.d}${withMonth ? ` ${words.months[wall.m - 1] ?? ''}` : ''}${withYear ? ` ${wall.y}` : ''}`

/** `7 Oct 2026` for a day, `5–11 Oct 2026` or `28 Sep – 4 Oct 2026` for a week. */
export function periodLabel(period: Period, from: number, to: number, zone: string, language: Language): string {
  const words = WORDS[language]
  const start = epochToWall(from, zone)
  if (period === 'daily') return dayText(start, words, true)
  const end = epochToWall(Math.max(from, to - 1), zone)
  if (start.y === end.y && start.m === end.m) return `${start.d}–${dayText(end, words, true)}`
  return start.y === end.y ? `${dayText(start, words, false)} – ${dayText(end, words, true)}` : `${dayText(start, words, true)} – ${dayText(end, words, true)}`
}

/** The subject line: project, kind of update, period. */
export const subjectOf = (input: Pick<DigestInput, 'project' | 'period' | 'from' | 'to' | 'zone'>, language: Language): string =>
  `${input.project} · ${WORDS[language][input.period]} · ${periodLabel(input.period, input.from, input.to, input.zone, language)}`

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────────

const MAX_CLIENT_ITEMS = 10
const MAX_MANAGER_ITEMS = 8
const MAX_TECH_ITEMS = 40
const MAX_NEXT = 6
const MAX_QUESTIONS = 5
const ORDER: Category[] = ['new', 'fix', 'improved', 'other', 'docs', 'maintenance']

const unique = (items: readonly string[]): string[] => {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = item.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const link = (text: string, url: string | undefined, isShown: boolean): string => (isShown && url !== undefined ? `${text} <${url}>` : text)

const STOP = new Set(['that', 'with', 'from', 'this', 'have', 'been', 'were', 'into', 'their', 'when', 'then', 'also', 'more', 'some'])

/** The words that carry a sentence's meaning, cut to five letters so "fixed" and "fix" meet. */
const stems = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(word => word.length >= 4 && !STOP.has(word))
      .map(word => word.slice(0, 5)),
  )

/** Whether two sentences say mostly the same thing (a journal line and the commit it describes). */
export function isSimilar(a: string, b: string): boolean {
  const left = stems(a)
  const right = stems(b)
  const smaller = Math.min(left.size, right.size)
  if (smaller < 2) return false
  let shared = 0
  for (const stem of left) if (right.has(stem)) shared += 1
  return shared / smaller >= 0.6
}

function doneSection(input: DigestInput, options: DigestOptions, words: Words): Section {
  const { tone } = options
  const journalDone = unique(input.journals.flatMap(journal => journal.done))
  const all = changesOf(input.commits)
  const items: string[] = []
  if (tone === 'technical') {
    for (const note of journalDone.slice(0, 10)) items.push(note)
    for (const category of ORDER) {
      for (const change of all.filter(one => one.category === category).slice(0, MAX_TECH_ITEMS)) items.push(`${change.sha} [${words.categories[category]}] ${change.text} (${change.author})`)
    }
    return { id: 'done', title: words.titles.done, items: items.slice(0, MAX_TECH_ITEMS) }
  }
  // A commit a journal line already describes is not said twice.
  const uncovered = all.filter(change => !journalDone.some(note => isSimilar(note, change.text)))
  const visible = uncovered.filter(change => change.category !== 'docs' && change.category !== 'maintenance')
  const quiet = all.filter(change => change.category === 'docs' || change.category === 'maintenance').length
  const limit = tone === 'client' ? MAX_CLIENT_ITEMS : MAX_MANAGER_ITEMS
  const lines = [...journalDone, ...ORDER.flatMap(category => visible.filter(change => change.category === category).map(change => (tone === 'manager' ? `${words.categories[category]}: ${change.text}` : change.text)))]
  items.push(...unique(lines).slice(0, limit))
  if (lines.length > limit) items.push(words.more(lines.length - limit))
  if (quiet > 0) items.push(words.behindTheScenes(quiet))
  if (tone === 'manager' && input.commits.length > 0) {
    const counts = ORDER.map(category => ({ category, n: all.filter(change => change.category === category).length })).filter(entry => entry.n > 0)
    items.unshift(`${words.changes(all.length)}: ${counts.map(entry => `${entry.n} ${words.categories[entry.category].toLowerCase()}`).join(', ')}`)
  }
  return { id: 'done', title: words.titles.done, items }
}

function shippedSection(input: DigestInput, options: DigestOptions, words: Words): Section {
  const isLinked = options.tone === 'technical'
  const deploys = input.events.filter(event => event.kind === 'deploy' && event.outcome === 'ok')
  const reviews = input.events.filter(event => event.kind === 'pr')
  const decisions = input.events.filter(event => event.kind === 'decision')
  const items = [
    ...unique(deploys.map(event => link(`${words.deployed}: ${event.text}`, event.url, isLinked))),
    ...unique(reviews.map(event => link(`${words.inReview}: ${event.text}`, event.url, isLinked))),
    ...(options.tone === 'client' ? [] : unique(decisions.map(event => event.text))),
  ]
  return { id: 'shipped', title: words.titles.shipped, items: items.slice(0, options.tone === 'technical' ? 20 : 8) }
}

function healthSection(input: DigestInput, options: DigestOptions, words: Words): Section {
  if (options.tone === 'client') return { id: 'health', title: words.titles.health, items: [] }
  const builds = input.events.filter(event => event.kind === 'ci')
  const items: string[] = []
  if (builds.length > 0) items.push(words.builds(builds.filter(event => event.outcome === 'ok').length, builds.filter(event => event.outcome === 'failed').length))
  const tests = input.events.filter(event => event.kind === 'test').sort((a, b) => a.at - b.at)
  const last = tests[tests.length - 1]
  if (last !== undefined && options.tone === 'technical') items.push(`${words.tests}: ${last.text}${last.outcome === 'failed' ? ' ✗' : ' ✓'}`)
  return { id: 'health', title: words.titles.health, items }
}

function nextSection(input: DigestInput, words: Words): Section {
  const dated = [...input.journals].sort((a, b) => b.date.localeCompare(a.date))
  const items = unique(dated.flatMap(journal => journal.todos)).slice(0, MAX_NEXT)
  return { id: 'next', title: words.titles.next, items }
}

function blockersSection(input: DigestInput, options: DigestOptions, words: Words): Section {
  const { tone } = options
  const items: string[] = []
  const ci = unresolved(input.events, 'ci')
  const deploys = unresolved(input.events, 'deploy')
  if (tone === 'client') {
    if (ci.length > 0) items.push(words.checksFailing)
    for (const deploy of deploys.slice(0, 2)) items.push(words.releaseFailed(deploy.text.split(':')[0] ?? deploy.text))
  } else {
    for (const event of ci) items.push(link(`CI: ${event.text}`, event.url, tone === 'technical'))
    for (const event of deploys) items.push(link(`${words.deployed}: ${event.text}`, event.url, tone === 'technical'))
  }
  for (const question of unique(input.journals.flatMap(journal => journal.questions)).slice(0, MAX_QUESTIONS)) items.push(`${words.question}: ${question}`)
  return { id: 'blockers', title: words.titles.blockers, items, ...(items.length === 0 ? { paragraph: words.noBlockers[tone] } : {}) }
}

function alertsSection(input: DigestInput, options: DigestOptions, words: Words): Section {
  const loud = input.events.filter(event => event.kind === 'notice' && (event.level === 'error' || event.level === 'critical'))
  const repeated = input.events.filter(event => event.kind === 'error')
  if (options.tone === 'client' || loud.length + repeated.length === 0) return { id: 'alerts', title: words.titles.alerts, items: [] }
  if (options.tone === 'manager') return { id: 'alerts', title: words.titles.alerts, items: [words.alertsLine(loud.length + repeated.length, loud.filter(event => event.level === 'critical').length)] }
  const items = [...loud.map(event => link(`[${event.level}] ${event.text}`, event.url, true)), ...repeated.map(event => event.text)]
  return { id: 'alerts', title: words.titles.alerts, items: unique(items).slice(0, 8) }
}

const usdText = (usd: number): string => `$${usd.toFixed(usd >= 100 ? 0 : 2)}`

/** Builds the digest. */
export function composeDigest(input: DigestInput, options: DigestOptions): Digest {
  const words = WORDS[options.language]
  const done = doneSection(input, options, words)
  const sections: Section[] = [done, shippedSection(input, options, words), healthSection(input, options, words), nextSection(input, words), blockersSection(input, options, words), alertsSection(input, options, words)]
  if (options.includeCost && input.costUsd !== undefined && input.costUsd > 0) {
    sections.push({ id: 'cost', title: words.titles.cost, items: [words.cost(usdText(input.costUsd), input.costScope ?? 'project')] })
  }
  const note = (input.note ?? '').trim()
  if (note !== '') sections.push({ id: 'note', title: words.titles.note, items: [], paragraph: note })
  const kept = sections.filter(section => section.items.length > 0 || section.paragraph !== undefined)
  const isEmpty = input.commits.length === 0 && input.journals.every(journal => journal.done.length === 0 && journal.todos.length === 0 && journal.questions.length === 0) && input.events.every(event => event.kind === 'session' || event.kind === 'notice')
  const subject = subjectOf(input, options.language)
  const when = periodLabel(input.period, input.from, input.to, input.zone, options.language)
  const greeting = words.greeting[options.tone]
  const intro = words.intro(options.tone, input.project, input.period, when)
  const signature = options.signature.trim()
  const visible = isEmpty && note === '' ? [{ id: 'done' as const, title: words.titles.done, items: [], paragraph: words.empty }] : kept
  return {
    subject,
    text: renderText(greeting, intro, visible, signature),
    html: renderHtml(greeting, intro, visible, signature),
    sections: visible,
    isEmpty: isEmpty && note === '',
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────────

function renderText(greeting: string, intro: string, sections: readonly Section[], signature: string): string {
  const blocks = [greeting, intro]
  for (const section of sections) {
    const lines = [section.title, ...(section.paragraph === undefined ? [] : [section.paragraph]), ...section.items.map(item => `- ${item}`)]
    blocks.push(lines.join('\n'))
  }
  if (signature !== '') blocks.push(signature)
  return `${blocks.join('\n\n')}\n`
}

export const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Text with `<https://…>` markers (from `link`) as anchors, everything else escaped. */
const htmlItem = (item: string): string => {
  const match = /^(.*) <(https?:\/\/[^\s>]+)>$/.exec(item)
  return match === null ? escapeHtml(item) : `${escapeHtml(match[1] ?? '')} (<a href="${escapeHtml(match[2] ?? '')}">link</a>)`
}

function renderHtml(greeting: string, intro: string, sections: readonly Section[], signature: string): string {
  const paragraph = (text: string): string => `<p style="margin:0 0 12px">${escapeHtml(text)}</p>`
  const parts = [paragraph(greeting), paragraph(intro)]
  for (const section of sections) {
    parts.push(`<h3 style="margin:18px 0 6px;font-size:15px">${escapeHtml(section.title)}</h3>`)
    if (section.paragraph !== undefined) parts.push(paragraph(section.paragraph))
    if (section.items.length > 0) parts.push(`<ul style="margin:0 0 12px;padding-left:20px">${section.items.map(item => `<li style="margin:2px 0">${htmlItem(item)}</li>`).join('')}</ul>`)
  }
  if (signature !== '') parts.push(`<p style="margin:18px 0 0;white-space:pre-line">${escapeHtml(signature)}</p>`)
  return `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:640px">${parts.join('')}</div>`
}
