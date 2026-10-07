/** Pure helpers: what the model is asked, and reading its answer back. */

export type BranchContext = {
  branch: string
  base: string
  commits: string
  stat: string
  diff: string
  template: { name: string; text: string } | undefined
}

export const DIFF_LIMIT = 24_000
const TEMPLATE_LIMIT = 6_000
const TITLE_LIMIT = 72

export const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/PULL_REQUEST_TEMPLATE/pull_request_template.md',
  'docs/pull_request_template.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
]

/** Bases tried, in order, when none is given and origin/HEAD is not set. */
export const FALLBACK_BASES = ['origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop']

export const systemPrompt = (template: BranchContext['template']): string =>
  [
    'You write pull request descriptions for code reviewers: concrete, scannable, no filler, no marketing tone.',
    'Answer in exactly this shape and nothing else:',
    'TITLE: <one line, imperative mood, at most 72 characters, no trailing period>',
    '---',
    '<the description in GitHub Markdown>',
    '',
    template === undefined
      ? [
          'The description has these sections, as `##` headings, in order:',
          '## Summary: 1-3 sentences on what the change does and why.',
          '## Changes: bullet points grouped by area; name files or modules only when it helps.',
          '## Testing: how it was or can be verified (commands, cases); say plainly when the diff adds no tests.',
          '## Risks: what could break, migrations, config or rollout notes; "Low" with a reason when there is little.',
        ].join('\n')
      : [
          `The repository has a pull request template (${template.name}). Fill it in: keep its headings, order and checklists,`,
          'replace its placeholder comments with real content, and tick a checkbox only when the diff shows it is done.',
          'Template:',
          template.text.slice(0, TEMPLATE_LIMIT),
        ].join('\n'),
  ].join('\n')

export const userPrompt = (context: BranchContext): string => {
  const diff = context.diff.length > DIFF_LIMIT ? `${context.diff.slice(0, DIFF_LIMIT)}\n[diff truncated]` : context.diff
  return [
    `Branch \`${context.branch}\` into \`${context.base}\`.`,
    '',
    'Commits (oldest first):',
    context.commits.trim(),
    '',
    'Diff stat:',
    context.stat.trim(),
    '',
    'Diff:',
    diff,
  ].join('\n')
}

/** Splits the model's answer into a title and a Markdown body; tolerant of a missing marker or fences. */
export const parseDescription = (text: string): { title: string; body: string } => {
  const cleaned = text.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim()
  const titled = /^\s*(?:\*\*)?TITLE:?(?:\*\*)?\s*(.+)\n+(?:-{3,}\s*\n)?([\s\S]*)$/i.exec(cleaned)
  if (titled !== null) return { title: tidyTitle(titled[1] as string), body: (titled[2] as string).trim() }
  const [first = '', ...rest] = cleaned.split('\n')
  return { title: tidyTitle(first.replace(/^#+\s*/, '')), body: rest.join('\n').replace(/^-{3,}\s*\n/, '').trim() }
}

const tidyTitle = (title: string): string => {
  const plain = title.trim().replace(/^["'`]|["'`]$/g, '').replace(/\.$/, '')
  return plain.length > TITLE_LIMIT ? `${plain.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : plain
}

/** What goes in the prompt box for Claude to open the PR with. */
export const promptText = (title: string, body: string, branch: string, base: string): string =>
  `Open a pull request from \`${branch}\` into \`${base.replace(/^origin\//, '')}\` with this title and description:\n\nTitle: ${title}\n\n${body}\n`
