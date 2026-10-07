// Pure parts of the handoff note: the request to the fork, the file name and the note itself. No `$` here.

export type GitFacts = { branch: string; status: string; diffStat: string; commits: string }

export const SECTIONS = ['Goal', 'Status', 'What changed', 'Next steps', 'Gotchas', 'How to verify'] as const

const pad = (n: number): string => String(n).padStart(2, '0')

/** `2026-10-07-1342`, in the session's local time. */
export const stampOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** `2026-10-07 13:42` */
export const readableStamp = (ms: number): string => stampOf(ms).replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})$/, '$1 $2:$3')

/** A decision somebody recorded (the hub's `decision.recorded`), as the handoff lists it. */
export type Decision = { title: string; summary?: string }

const DECISION_CLIP = 200
const MAX_DECISIONS = 8
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const clip = (text: string): string => {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > DECISION_CLIP ? `${line.slice(0, DECISION_CLIP - 1)}…` : line
}

/** The `decision.recorded` events in a list of bus events (this session's, and other sessions' from sessions.json) since `sinceMs`, oldest first, each title once. */
export const decisionsOf = (events: readonly unknown[], sinceMs: number): Decision[] => {
  const found: { at: number; decision: Decision }[] = []
  for (const event of events) {
    if (!isRecord(event) || event.topic !== 'decision.recorded' || typeof event.at !== 'number' || event.at < sinceMs || !isRecord(event.data)) continue
    const { title, summary } = event.data
    if (typeof title !== 'string' || title.trim() === '') continue
    found.push({ at: event.at, decision: { title: clip(title), ...(typeof summary === 'string' && summary.trim() !== '' ? { summary: clip(summary) } : {}) } })
  }
  const titles = new Set<string>()
  return found
    .sort((a, b) => a.at - b.at)
    .map(one => one.decision)
    .filter(decision => !titles.has(decision.title) && (titles.add(decision.title), true))
    .slice(-MAX_DECISIONS)
}

export const handoffPrompt = (facts: GitFacts | undefined, note: string, decisions: readonly Decision[] = []): string =>
  [
    'Write a handoff note so a teammate can pick up exactly where this session leaves off.',
    'Be specific and factual: real file paths, commands, decisions and the reasons for them. No filler, no',
    'mention of "this conversation" or of the assistant. Write TODO where you do not know something.',
    ...(note === '' ? [] : ['', `The author adds: ${note}`]),
    ...(facts === undefined
      ? []
      : [
          '',
          'Repository facts from git, accurate right now:',
          `Branch: ${facts.branch}`,
          'Uncommitted changes:',
          facts.status === '' ? '(none)' : facts.status,
          ...(facts.diffStat === '' ? [] : ['Diff stat:', facts.diffStat]),
          'Recent commits:',
          facts.commits === '' ? '(none)' : facts.commits,
        ]),
    ...(decisions.length === 0
      ? []
      : ['', 'Decisions recorded for this project (mention the ones that matter, with their reasons):', ...decisions.map(one => `- ${one.title}${one.summary === undefined ? '' : `: ${one.summary}`}`)]),
    '',
    'Answer in Markdown with exactly these sections, in this order, and nothing before the first:',
    '## Goal',
    '(what we are trying to achieve, and why)',
    '## Status',
    '(done, in progress, not started)',
    '## What changed',
    '(each file touched and what changed in it)',
    '## Next steps',
    '(numbered, in the order to do them)',
    '## Gotchas',
    '(traps, open questions, things that look wrong but are intended)',
    '## How to verify',
    '(commands to run and what to check)',
  ].join('\n')

/** Keeps the reply from its first `## ` heading on, so chatter before it is dropped. */
export const sectionsOf = (reply: string): string => {
  const at = reply.search(/^##\s/m)
  return (at === -1 ? reply : reply.slice(at)).trim()
}

export const composeNote = (sections: string, meta: { when: number; branch?: string; sessionId?: string }): string =>
  [
    `# Handoff · ${readableStamp(meta.when)}`,
    '',
    [meta.branch === undefined ? undefined : `Branch \`${meta.branch}\``, meta.sessionId === undefined ? undefined : `session \`${meta.sessionId}\``]
      .filter(Boolean)
      .join(' · '),
    '',
    sections,
    '',
    ...(meta.sessionId === undefined ? [] : ['---', `Resume the original session on its machine: \`claude --resume ${meta.sessionId}\``, '']),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')

/** Which of the six sections the note lacks. */
export const missingSections = (sections: string): string[] =>
  SECTIONS.filter(name => !new RegExp(`^##\\s+${name}\\b`, 'im').test(sections))
