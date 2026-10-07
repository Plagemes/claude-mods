// Pure parts of the explanation: the request to the model and reading its answer. No `$` here.

import type { ExplainChange, ExplainFileNote, ExplainLevel } from '../types'

const REQUEST_CHARS = 3_000
const ANSWER_CHARS = 3_000
/** The most diff text sent in one request; files past it are named with their counts only. */
const DIFF_BUDGET = 60_000
const NOTE_CHARS = 1_200

const LEVEL_GUIDE: Record<ExplainLevel, string> = {
  beginner:
    'The reader is new to this codebase and to programming jargon. Use plain words and short sentences, explain any technical term the first time it appears, say what each file is for, and prefer a concrete example to an abstraction.',
  expert:
    'The reader is an experienced engineer. Be terse and technical: behaviour changes, contracts, edge cases, performance and failure modes. Skip what the diff makes obvious.',
}

export const SYSTEM =
  'You explain code changes to a developer who is reviewing them. Be accurate: describe only what the diffs show, and when you infer intent say so ("probably", "it looks like"). Never invent files, functions or test commands that do not appear in the material.'

const cut = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars)} […]` : text)

/** The request for an explanation of `change` at `level`. */
export function explainPrompt(change: ExplainChange, level: ExplainLevel): string {
  let budget = DIFF_BUDGET
  const sections: string[] = []
  for (const file of change.files) {
    const head = `=== ${file.path} (${file.status}, +${file.added} -${file.removed})`
    if (file.diff === '' || file.diff.length > budget) {
      sections.push(`${head}\n(diff not included: ${file.diff === '' ? 'too large to diff' : 'over the size budget'})`)
      continue
    }
    budget -= file.diff.length
    sections.push(`${head}\n${file.diff}`)
  }
  return [
    LEVEL_GUIDE[level],
    '',
    'The request that led to these changes:',
    '"""',
    cut(change.request.trim() || '(no request recorded)', REQUEST_CHARS),
    '"""',
    '',
    "Claude's own summary when it finished:",
    '"""',
    cut(change.answer.trim() || '(none)', ANSWER_CHARS),
    '"""',
    '',
    'The changes, as unified diffs:',
    ...sections,
    '',
    'Reply with JSON only, no prose and no code fence:',
    '{"summary": "2-4 sentences: what changed overall and why",',
    ' "files": [{"path": "exactly as given above", "what": "what changed in this file", "why": "why it was needed",',
    '            "risks": "what could break or deserves a second look (\\"none\\" if nothing)", "test": "how to check it works"}]}',
    'One entry per file above, in the same order. Markdown (inline code, short lists) is welcome inside the strings.',
  ].join('\n')
}

export type ParsedExplanation = { summary: string; notes: Record<string, ExplainFileNote> }

const text = (value: unknown): string => (typeof value === 'string' ? cut(value.trim(), NOTE_CHARS) : '')

/** The model's answer read defensively; a reply that is no JSON becomes the summary as it stands. */
export function parseExplanation(reply: string, paths: readonly string[]): ParsedExplanation {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  let parsed: unknown
  try {
    parsed = start >= 0 && end > start ? JSON.parse(reply.slice(start, end + 1)) : undefined
  } catch {
    parsed = undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return { summary: reply.trim(), notes: {} }
  const { summary, files } = parsed as { summary?: unknown; files?: unknown }
  const notes: Record<string, ExplainFileNote> = {}
  if (Array.isArray(files)) {
    files.forEach((entry: unknown, index) => {
      if (typeof entry !== 'object' || entry === null) return
      const note = entry as Record<string, unknown>
      const named = typeof note.path === 'string' ? note.path.trim() : ''
      const path = paths.includes(named) ? named : paths.find(one => named !== '' && one.endsWith(named)) ?? paths[index]
      if (path !== undefined && notes[path] === undefined) {
        notes[path] = { what: text(note.what), why: text(note.why), risks: text(note.risks), test: text(note.test) }
      }
    })
  }
  return { summary: text(summary) || reply.trim().slice(0, NOTE_CHARS), notes }
}

/** One file's note as Markdown for the pane. */
export function noteMarkdown(note: ExplainFileNote): string {
  return [
    note.what && `**What changed:** ${note.what}`,
    note.why && `**Why:** ${note.why}`,
    note.risks && !/^none\.?$/i.test(note.risks) && `**Watch out:** ${note.risks}`,
    note.test && `**How to check:** ${note.test}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
