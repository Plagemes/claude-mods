// Pure parts of parallel-explore: the angles and the prompts for planning, exploring and merging.
// The explorers' read-only rule lives in ./readonly. No `$` here.

import type { ParallelExploreAngle } from '../types'

export type Angle = Pick<ParallelExploreAngle, 'title' | 'focus'>

export const ANGLE_COUNT = 3
const MAX_TITLE_CHARS = 40
const MAX_REPORT_CHARS = 12_000

/** The angles used when planning is off or fails. */
export const FIXED_ANGLES: readonly Angle[] = [
  { title: 'Implementation', focus: 'Where it is implemented: entry points, the core logic and how data flows through it.' },
  { title: 'Usage & tests', focus: 'How it is used and tested: callers, call sites, tests and examples.' },
  { title: 'Config & docs', focus: 'Related configuration, environment variables, build or deploy settings, and documentation.' },
]

export const PLANNER_SYSTEM =
  'You plan code investigations. Given a question about a codebase, you split it into distinct, non-overlapping angles that three explorers can investigate in parallel.'

export const planPrompt = (question: string): string =>
  [
    `Question about the codebase: ${question}`,
    '',
    `Give exactly ${ANGLE_COUNT} distinct angles to investigate it in parallel, each covering a different part of the code (for example where it is implemented, how it is used or tested, related configuration). Reply with JSON only:`,
    '[{"title": "2-4 words", "focus": "one sentence: what to look for and where"}]',
  ].join('\n')

/** Reads the planner's JSON angles; undefined unless it gave exactly three usable ones. */
export const parseAngles = (reply: string): Angle[] | undefined => {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return undefined
    const angles = parsed
      .map(item => ({ title: String((item as Angle).title ?? '').trim().slice(0, MAX_TITLE_CHARS), focus: String((item as Angle).focus ?? '').trim() }))
      .filter(angle => angle.title !== '' && angle.focus !== '')
    return angles.length >= ANGLE_COUNT ? angles.slice(0, ANGLE_COUNT) : undefined
  } catch {
    return undefined
  }
}

/** The task each explorer is given. */
export const explorerPrompt = (question: string, angle: Angle, index: number): string =>
  [
    `You are explorer ${index + 1} of ${ANGLE_COUNT}, investigating this codebase in parallel with the others.`,
    '',
    `The question: ${question}`,
    '',
    `Your angle: ${angle.title}. ${angle.focus}`,
    '',
    'Stay on your angle; the other explorers cover the rest. Work read-only: search broadly first (file names, symbols, strings), then read the most relevant parts. Report, in under 500 words:',
    '- Findings: concise bullet points, each with file references as path:line.',
    '- Key files: the 3-8 files that matter most for your angle, one line each on why.',
    '- Open questions: what you could not settle.',
  ].join('\n')

export const SCOUT_PROMPT = `You are a read-only code explorer. You investigate a codebase to answer one question from one angle, then report what you found with precise file references (path:line).

You never modify anything. Use Read, and Grep/Glob where available; in Bash use only read commands (ls, find, grep, rg, cat, head, tail, wc, git log/show/diff/grep/ls-files), with patterns in quotes. Commands that write files, redirect output to a file, use variables, or run other programs are refused.`

export const MERGER_SYSTEM = 'You merge the findings of several code explorers into one accurate, well-organised answer for a developer.'

const cut = (text: string): string => (text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS)}\n… (cut)` : text)

/** The merge request: the question and every report (a failed angle says why). */
export const mergePrompt = (question: string, angles: readonly ParallelExploreAngle[]): string =>
  [
    `Question: ${question}`,
    '',
    `${angles.length} explorers investigated this codebase in parallel, each from one angle. Their reports:`,
    ...angles.flatMap((angle, index) => [
      '',
      `## Explorer ${index + 1}: ${angle.title} (${angle.focus})`,
      angle.status === 'done' && angle.report !== undefined ? cut(angle.report) : `(no report: ${angle.error ?? 'it did not finish'})`,
    ]),
    '',
    'Write one answer to the question:',
    '- Start with a direct answer in 2-4 sentences.',
    '- Then the details, organised by topic (not by explorer), with file references as path:line taken from the reports. Never invent a path or a line number.',
    '- End with what the reports disagree on or left open, and what to check next (skip this when there is nothing).',
    'Use Markdown. Keep it under 600 words.',
  ].join('\n')

/** The reports side by side, for when merging fails. */
export const unmergedAnswer = (angles: readonly ParallelExploreAngle[]): string =>
  angles
    .map(angle => `## ${angle.title}\n\n${angle.status === 'done' && angle.report !== undefined ? angle.report : `_No report: ${angle.error ?? 'it did not finish'}._`}`)
    .join('\n\n')

/** What "Send to Claude" submits. */
export const messageForClaude = (question: string, answer: string): string =>
  [
    `I had three agents explore the codebase in parallel for: ${question}`,
    '',
    'Their merged findings:',
    '',
    answer,
    '',
    'Use this as context for what we do next. Check a file reference before you rely on it.',
  ].join('\n')

/** `1:05` */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
