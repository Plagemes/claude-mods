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

export const handoffPrompt = (facts: GitFacts | undefined, note: string): string =>
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
