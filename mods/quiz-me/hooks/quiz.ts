// Pure parts of the quiz: reading /quiz arguments, the material and the request, checking the questions, stats. No `$` here.

import type { QuizQuestion, QuizScore } from '../types'

export const MIN_QUESTIONS = 1
export const MAX_QUESTIONS = 10
const MATERIAL_CHARS = 40_000
const SNIPPET_CHARS = 8_000
const REQUEST_CHARS = 1_500
const TEXT_CHARS = 600

export type QuizArgs = { kind: 'stats' } | { kind: 'quiz'; count: number | undefined; file: string | undefined }

/** `/quiz`, `/quiz 3`, `/quiz src/cart.ts`, `/quiz 3 src/cart.ts`, `/quiz stats`. */
export function parseQuizArgs(args: string): QuizArgs {
  const words = args.trim().split(/\s+/).filter(Boolean)
  if (words.length === 1 && words[0]?.toLowerCase() === 'stats') return { kind: 'stats' }
  const number = words.find(word => /^\d+$/.test(word))
  const file = words.filter(word => word !== number).join(' ') || undefined
  const count = number === undefined ? undefined : Math.max(MIN_QUESTIONS, Math.min(MAX_QUESTIONS, Number(number)))
  return { kind: 'quiz', count, file }
}

/** One edit Claude made: an Edit's before and after, or a whole file written. */
export type Change = { path: string; kind: 'edit' | 'write'; before: string; after: string }

const cut = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars)}\n[…cut]` : text)

/** A change as it is kept (in memory and the store): only as much text as a quiz can ever show. */
export const keptChange = (change: Change): Change => ({ ...change, before: cut(change.before, SNIPPET_CHARS), after: cut(change.after, SNIPPET_CHARS) })

/** The changes of a turn as the material of a quiz, within a size budget. */
export function materialOf(changes: readonly Change[]): string {
  const parts: string[] = []
  let budget = MATERIAL_CHARS
  for (const change of changes) {
    const body =
      change.kind === 'write'
        ? `=== ${change.path} (whole file written)\n${cut(change.after, SNIPPET_CHARS)}`
        : `=== ${change.path} (edited)\n--- before\n${cut(change.before, SNIPPET_CHARS)}\n+++ after\n${cut(change.after, SNIPPET_CHARS)}`
    if (body.length > budget) break
    budget -= body.length
    parts.push(body)
  }
  return parts.join('\n\n')
}

export const SYSTEM =
  'You are a patient senior engineer checking that a developer really understands code they are about to own. ' +
  'You write multiple-choice questions strictly about the code you are given; never about anything it does not show.'

export function quizPrompt(count: number, material: string, request: string): string {
  return [
    `Write ${count} multiple-choice question${count === 1 ? '' : 's'} about the code below${request ? ', which was written for this request:' : '.'}`,
    ...(request ? ['"""', cut(request.trim(), REQUEST_CHARS), '"""'] : []),
    '',
    'Guidelines:',
    '- Test understanding, not trivia: what the code does for a given input, why a line is needed, what would break if it changed, edge cases, how the pieces fit together.',
    '- Exactly 4 options per question, exactly one of them correct; wrong options must be plausible to someone who only skimmed.',
    '- Name concrete functions, variables and files from the code; short code in backticks is welcome.',
    '- "why" explains the right answer in 1-3 sentences.',
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"questions": [{"q": "question", "options": ["A", "B", "C", "D"], "answer": 0, "why": "explanation"}]}',
    '"answer" is the index (0-3) of the correct option.',
    '',
    'The code:',
    material,
  ].join('\n')
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim().slice(0, TEXT_CHARS) : '')

/** The questions of the model's reply that are well formed, options shuffled (so the answer is not always first). */
export function parseQuestions(reply: string, count: number, random: () => number): QuizQuestion[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const raw = (parsed as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  const questions: QuizQuestion[] = []
  for (const entry of raw) {
    const item = (entry ?? {}) as { q?: unknown; options?: unknown; answer?: unknown; why?: unknown }
    const options = Array.isArray(item.options) ? item.options.map(clean) : []
    const answer = Number(item.answer)
    const q = clean(item.q)
    if (q === '' || options.length !== 4 || options.some(option => option === '') || new Set(options).size !== 4) continue
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) continue
    const order = [0, 1, 2, 3]
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      const swap = order[i] ?? i
      order[i] = order[j] ?? j
      order[j] = swap
    }
    questions.push({ q, options: order.map(index => options[index] ?? ''), answer: order.indexOf(answer), why: clean(item.why) })
    if (questions.length === count) break
  }
  return questions
}

export const percent = (correct: number, total: number): number => (total === 0 ? 0 : Math.round((correct / total) * 100))

const dateOf = (ms: number): string => {
  const day = new Date(ms)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

/** `/quiz stats` as text. */
export function statsText(history: readonly QuizScore[]): string {
  if (history.length === 0) return 'No quizzes yet. Run /quiz after Claude writes some code.'
  const correct = history.reduce((sum, score) => sum + score.correct, 0)
  const total = history.reduce((sum, score) => sum + score.total, 0)
  const perfect = history.filter(score => score.correct === score.total).length
  const recent = history.slice(-5).reverse().map(score => `- ${dateOf(score.at)} · ${score.correct}/${score.total} · ${score.source}`)
  return [
    `🎓 ${history.length} quiz${history.length === 1 ? '' : 'zes'} · ${correct}/${total} right (${percent(correct, total)}%) · ${perfect} perfect`,
    'Latest:',
    ...recent,
  ].join('\n')
}
