// Pure parts of the issue draft: the request to the fork and reading its answer. No `$` here.

export type IssueKind = 'bug' | 'feature'
export type Draft = { kind: IssueKind; title: string; body: string }

const MAX_TITLE = 120
const KIND_WORDS: Record<string, IssueKind> = {
  bug: 'bug', fix: 'bug', defect: 'bug',
  feature: 'feature', feat: 'feature', enhancement: 'feature', idea: 'feature',
}

/** `/issue bug the login loop` → the kind, and what is left as a focus for the draft. */
export const parseArgs = (args: string): { kind?: IssueKind; focus: string } => {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const kind = KIND_WORDS[first.toLowerCase()]
  return kind === undefined ? { focus: args.trim() } : { kind, focus: rest.join(' ') }
}

/** `failures`: failures other mods reported this session (CI runs, a command failing again and again), offered as context. */
export const draftPrompt = (kind: IssueKind | undefined, focus: string, failures: readonly string[] = []): string =>
  [
    `Draft a GitHub issue from this conversation${kind === undefined ? '' : kind === 'bug' ? ' as a bug report' : ' as a feature request'}.`,
    ...(focus === '' ? [] : [`Focus on: ${focus}`]),
    ...(failures.length === 0 ? [] : ['Failures reported in this session (use them where they are what the issue is about; ignore them otherwise):', ...failures.map(failure => `- ${failure}`)]),
    'Write it for a teammate who has not seen the conversation: concrete and self-contained, never mentioning',
    '"this conversation", the assistant or Claude. Use the real file paths, commands, error messages and versions',
    'that came up. Never invent details: write TODO where something is unknown.',
    '',
    'Answer in exactly this shape and nothing else:',
    'TYPE: bug or feature',
    'TITLE: one line under 80 characters',
    'BODY:',
    '## Summary',
    '(two or three sentences)',
    '## Steps to reproduce   (for a bug; for a feature use "## Proposal" instead)',
    '1. ...',
    '## Expected',
    '(what should happen; for a feature, what success looks like)',
    '## Actual',
    '(what happens today)',
    '## Context',
    '(relevant files, environment, links, what was already tried)',
  ].join('\n')

const trimMarks = (text: string): string => text.replace(/^[#*_\s]+|[*_\s]+$/g, '')
const clean = (line: string): string => trimMarks(trimMarks(line).replace(/^title:/i, ''))

/** Reads the fork's answer; tolerates a missing TYPE, a heading-style title or extra chatter before it. */
export const parseDraft = (text: string, fallbackKind: IssueKind | undefined): Draft | undefined => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const typeLine = lines.find(line => /^\s*\**type:/i.test(line))
  const typed = typeLine === undefined ? undefined : /feature|enhancement/i.test(typeLine) ? 'feature' : /bug/i.test(typeLine) ? 'bug' : undefined
  const titleAt = lines.findIndex(line => /^\s*\**title:/i.test(line))
  const bodyAt = lines.findIndex(line => /^\s*\**body:\**\s*$/i.test(line))
  let title = titleAt === -1 ? '' : clean(lines[titleAt] ?? '')
  let bodyLines = bodyAt !== -1 ? lines.slice(bodyAt + 1) : titleAt !== -1 ? lines.slice(titleAt + 1) : lines
  if (title === '') {
    const first = bodyLines.findIndex(line => line.trim() !== '' && !/^\s*##\s/.test(line))
    if (first === -1) return undefined
    title = clean(bodyLines[first] ?? '')
    bodyLines = bodyLines.slice(first + 1)
  }
  const body = bodyLines.join('\n').trim()
  if (title === '' || body === '') return undefined
  const kind = typed ?? fallbackKind ?? (/^##\s+steps to reproduce/im.test(body) ? 'bug' : 'feature')
  return { kind, title: title.slice(0, MAX_TITLE), body }
}

/** The issue as one paste: title, a blank line, the body. */
export const asText = (draft: Pick<Draft, 'title' | 'body'>): string => `${draft.title}\n\n${draft.body}\n`

/** The created issue's URL from gh's output (its last https line). */
export const issueUrl = (stdout: string): string | undefined =>
  stdout.split('\n').map(line => line.trim()).filter(line => /^https?:\/\/\S+$/.test(line)).at(-1)
