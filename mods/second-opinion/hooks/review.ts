// Pure parts of second-opinion: finding the last answered turn in the transcript, the reviewer's
// brief and prompt, reading its verdict, and the texts sent back to Claude. No `$` here.

import type { SessionMessage } from 'claude-code'

import type { SecondOpinionAgreement, SecondOpinionVerdict } from '../types'

export type Verdict = SecondOpinionVerdict

const MAX_QUESTION_CHARS = 8_000
const MAX_ANSWER_CHARS = 20_000
const MAX_CHANGE_CHARS = 3_000
const MAX_CHANGES_CHARS = 12_000
const MAX_COMMANDS = 12
const MAX_CONCERNS = 6
const MAX_SUGGESTIONS = 5

export const REVIEWER_SYSTEM = `You are a senior engineer giving an independent second opinion on another AI assistant's answer to a user. Be rigorous and candid. Look for factual errors, wrong assumptions, bugs in the code or the changes, security problems, missed requirements, risky or irreversible steps in a plan, and clearly simpler alternatives. Do not nitpick style or wording. If the answer is sound, say so plainly; do not invent problems.

Reply with JSON only, nothing before or after it, in exactly this shape:
{"agreement": "agree" | "partly" | "disagree", "summary": "one or two sentences: your overall view", "concerns": [{"severity": "high" | "medium" | "low", "text": "what is wrong and why it matters"}], "suggestions": ["a concrete improvement"]}

At most ${MAX_CONCERNS} concerns and ${MAX_SUGGESTIONS} suggestions, most important first, each one or two sentences, concrete (name the file, function, command or step). Use empty lists when there is nothing to say.`

/** The last answered turn: the prompt that opened it, the final answer, and what it changed and ran. */
export type Turn = { question: string; answer: string; changes: string[]; commands: string[] }

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters left out)` : text)

const isPrompt = (message: SessionMessage): boolean => message.role === 'user' && message.text.trim() !== '' && (message.toolResults?.length ?? 0) === 0

/** A file change of a tool call as a small diff, or undefined for any other tool. */
const changeOf = (tool: string, input: Record<string, unknown>): string | undefined => {
  const path = String(input.file_path ?? input.notebook_path ?? '')
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const lines = [
      `--- ${path}${input.replace_all === true ? ' (every occurrence)' : ''}`,
      ...input.old_string.split('\n').map(line => `- ${line}`),
      ...input.new_string.split('\n').map(line => `+ ${line}`),
    ]
    return cut(lines.join('\n'), MAX_CHANGE_CHARS)
  }
  if (tool === 'Write' && typeof input.content === 'string') return cut(`+++ ${path} (whole file written)\n${input.content}`, MAX_CHANGE_CHARS)
  if (tool === 'NotebookEdit' && typeof input.new_source === 'string') return cut(`--- ${path} (notebook cell)\n${input.new_source}`, MAX_CHANGE_CHARS)
  return undefined
}

/** Finds the last turn that ended in an answer; undefined when Claude has not answered yet. */
export const lastTurn = (messages: readonly SessionMessage[]): Turn | undefined => {
  const answerAt = messages.findLastIndex(message => message.role === 'assistant' && message.text.trim() !== '')
  if (answerAt === -1) return undefined
  const promptAt = messages.slice(0, answerAt).findLastIndex(isPrompt)
  const turn = messages.slice(promptAt + 1, answerAt + 1)
  const changes: string[] = []
  const commands: string[] = []
  for (const message of turn) {
    for (const use of message.toolUses) {
      const change = changeOf(use.tool, use.input)
      if (change !== undefined) changes.push(change)
      if (use.tool === 'Bash' && typeof use.input.command === 'string' && commands.length < MAX_COMMANDS) {
        commands.push(`${use.input.command}${use.isError === true ? '   # failed' : ''}`)
      }
    }
  }
  // The answer is the turn's last assistant text; earlier assistant texts in the turn are its narration.
  const answer = turn.filter(message => message.role === 'assistant' && message.text.trim() !== '').map(message => message.text.trim()).join('\n\n')
  return { question: promptAt === -1 ? '' : (messages[promptAt] as SessionMessage).text.trim(), answer, changes, commands }
}

/** The reviewer's prompt: the request, the answer, the changes and commands of the turn, and the focus. */
export const reviewPrompt = (turn: Turn, focus: string): string => {
  let changes = ''
  for (const [index, change] of turn.changes.entries()) {
    if (changes.length + change.length > MAX_CHANGES_CHARS) {
      changes += `\n… (${turn.changes.length - index} more changes left out)`
      break
    }
    changes += `${changes === '' ? '' : '\n\n'}${change}`
  }
  return [
    '<user_request>',
    cut(turn.question === '' ? '(the request is not in the transcript)' : turn.question, MAX_QUESTION_CHARS),
    '</user_request>',
    '',
    '<assistant_answer>',
    cut(turn.answer, MAX_ANSWER_CHARS),
    '</assistant_answer>',
    ...(changes === '' ? [] : ['', '<file_changes_made_in_that_turn>', changes, '</file_changes_made_in_that_turn>']),
    ...(turn.commands.length === 0 ? [] : ['', '<commands_run_in_that_turn>', ...turn.commands, '</commands_run_in_that_turn>']),
    '',
    focus === '' ? 'Review the answer.' : `Review the answer, focusing especially on: ${focus}`,
  ].join('\n')
}

const AGREEMENTS: readonly SecondOpinionAgreement[] = ['agree', 'partly', 'disagree']
const SEVERITIES = ['high', 'medium', 'low'] as const

/** Reads the reviewer's JSON verdict (tolerating a fence or prose around it); undefined when there is none. */
export const parseVerdict = (reply: string): Verdict | undefined => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  let json: Record<string, unknown>
  try {
    json = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const agreement = AGREEMENTS.find(value => value === String(json.agreement).toLowerCase()) ?? 'unclear'
  const concerns = (Array.isArray(json.concerns) ? json.concerns : [])
    .map(item => {
      if (typeof item === 'string') return { severity: 'medium' as const, text: item }
      const record = item as Record<string, unknown>
      const severity = SEVERITIES.find(value => value === String(record.severity).toLowerCase()) ?? 'medium'
      return { severity, text: String(record.text ?? '').trim() }
    })
    .filter(concern => concern.text !== '')
    .slice(0, MAX_CONCERNS)
  const suggestions = (Array.isArray(json.suggestions) ? json.suggestions : [])
    .map(item => String(item).trim())
    .filter(Boolean)
    .slice(0, MAX_SUGGESTIONS)
  return { agreement, summary: String(json.summary ?? '').trim(), concerns, suggestions }
}

/** The reviewing model: the configured one, else the other tier of the session's (opus ↔ sonnet). */
export const reviewerFor = (configured: string, sessionModel: string): string => {
  const wanted = configured.trim()
  if (wanted !== '' && wanted !== 'auto') return wanted
  return /opus/i.test(sessionModel) ? 'sonnet' : 'opus'
}

export const AGREEMENT_LABELS: Record<SecondOpinionAgreement, string> = {
  agree: '✓ Agrees',
  partly: '◐ Partly agrees',
  disagree: '✗ Disagrees',
  unclear: '? No clear verdict',
}

const AGREEMENT_WORDS: Record<SecondOpinionAgreement, string> = { agree: 'agrees', partly: 'partly agrees', disagree: 'disagrees', unclear: 'gave no clear verdict' }

/** `partly agrees · 2 concerns (1 high)` */
export const verdictLine = (verdict: Verdict): string => {
  const high = verdict.concerns.filter(concern => concern.severity === 'high').length
  const concerns = verdict.concerns.length === 0 ? 'no concerns' : `${verdict.concerns.length} concern${verdict.concerns.length === 1 ? '' : 's'}${high > 0 ? ` (${high} high)` : ''}`
  return `${AGREEMENT_WORDS[verdict.agreement]} · ${concerns}`
}

/** The review as Markdown, for the clipboard and for Claude. */
export const verdictMarkdown = (verdict: Verdict, model: string): string =>
  [
    `**Second opinion (${model}): ${AGREEMENT_WORDS[verdict.agreement]}.** ${verdict.summary}`,
    ...(verdict.concerns.length === 0 ? [] : ['', 'Concerns:', ...verdict.concerns.map(concern => `- [${concern.severity}] ${concern.text}`)]),
    ...(verdict.suggestions.length === 0 ? [] : ['', 'Suggestions:', ...verdict.suggestions.map(suggestion => `- ${suggestion}`)]),
  ].join('\n')

/** What "Send to Claude" submits. */
export const messageForClaude = (review: string): string =>
  [
    'I asked another model for a second opinion on your last answer. Here is what it said:',
    '',
    review,
    '',
    'Weigh these points on their merits: say which you agree with and why, push back where the reviewer is wrong, and revise your answer, plan or changes where its points hold up.',
  ].join('\n')
