/** Pure helpers: the model's instructions, cleaning its answer, and checking it against the rules. */

export type Rules = {
  types: readonly string[]
  headerMaxLength: number
  scopes: readonly string[]
  /** The commitlint configuration file's text, handed to the model as is. */
  configText: string | undefined
  configName: string | undefined
}

export type DiffContext = {
  nameStatus: string
  stat: string
  diff: string
  recentSubjects: string
}

export const DEFAULT_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']
export const DEFAULT_HEADER_MAX = 72
export const DIFF_LIMIT = 16_000
const CONFIG_LIMIT = 3_000

export const COMMITLINT_FILES = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
  '.commitlintrc.ts',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
]

const quotedWords = (list: string): string[] => [...list.matchAll(/["'`]([\w-]+)["'`]/g)].map(match => match[1] as string)

/**
 * Reads the rules commitlint would enforce from a config's text (JSON, YAML or JS alike,
 * by pattern): `type-enum`, `scope-enum` and `header-max-length`.
 */
export const rulesFrom = (name: string | undefined, text: string | undefined): Rules => {
  const source = text ?? ''
  const typeList = /["']?type-enum["']?\s*:\s*\[\s*\d\s*,\s*["']always["']\s*,\s*\[([^\]]*)\]/.exec(source)?.[1]
  const scopeList = /["']?scope-enum["']?\s*:\s*\[\s*\d\s*,\s*["']always["']\s*,\s*\[([^\]]*)\]/.exec(source)?.[1]
  const headerMax = /["']?header-max-length["']?\s*:\s*\[\s*[12]\s*,\s*["']always["']\s*,\s*(\d+)/.exec(source)?.[1]
  const types = typeList === undefined ? [] : quotedWords(typeList)
  return {
    types: types.length > 0 ? types : DEFAULT_TYPES,
    scopes: scopeList === undefined ? [] : quotedWords(scopeList),
    headerMaxLength: headerMax === undefined ? DEFAULT_HEADER_MAX : Math.min(DEFAULT_HEADER_MAX, Number(headerMax)),
    configText: text === undefined ? undefined : text.slice(0, CONFIG_LIMIT),
    configName: name,
  }
}

export const systemPrompt = (rules: Rules): string =>
  [
    'You write git commit messages that follow Conventional Commits 1.0.0.',
    'Format exactly:',
    '<type>(<optional scope>): <subject>',
    '',
    '- <what changed and why>',
    '- <another point>',
    '',
    `Rules: <type> is one of ${rules.types.join(', ')}.` +
      (rules.scopes.length > 0 ? ` <scope>, when used, is one of ${rules.scopes.join(', ')}.` : ' The scope is optional: a short noun for the area touched.') +
      ` The whole first line is at most ${rules.headerMaxLength} characters, the subject in the imperative mood, lower case, with no trailing period.`,
    'Then a blank line and 2 to 5 short bullet points wrapped at 72 columns, saying what changed and why; no file-by-file listing.',
    'Add a `BREAKING CHANGE: <what>` footer only when the diff breaks a public interface.',
    'Answer with the commit message only: no code fences, no quotes, no commentary.',
    ...(rules.configText === undefined
      ? []
      : ['', `The project's commitlint configuration (${rules.configName}) applies; follow its rules:`, rules.configText]),
  ].join('\n')

export const userPrompt = (context: DiffContext, instruction: string | undefined): string => {
  const diff = context.diff.length > DIFF_LIMIT ? `${context.diff.slice(0, DIFF_LIMIT)}\n[diff truncated]` : context.diff
  return [
    ...(context.recentSubjects.trim() === '' ? [] : ['Recent commit subjects here (match their style and scopes):', context.recentSubjects.trim(), '']),
    'Staged files:',
    context.nameStatus.trim(),
    '',
    'Diff stat:',
    context.stat.trim(),
    '',
    'Staged diff:',
    diff,
    ...(instruction === undefined || instruction.trim() === '' ? [] : ['', `Revise the message as the user asks: ${instruction.trim()}`]),
  ].join('\n')
}

/** Strips fences, labels and quotes a model may add, and puts a blank line after the subject. */
export const cleanMessage = (text: string): string => {
  const lines = text
    .replace(/^\s*```[\w-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^\s*(?:commit message|message)\s*:\s*/i, '')
    .trim()
    .replace(/^["'](.*)["']$/s, '$1')
    .split('\n')
    .map(line => line.trimEnd())
  const [subject = '', ...body] = lines
  while (body[0]?.trim() === '') body.shift()
  return body.length === 0 ? subject.trim() : `${subject.trim()}\n\n${body.join('\n')}`
}

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s][^()]*)\))?(?<breaking>!)?: (?<subject>\S.*)$/

/** What a commitlint run would likely complain about: shown in the pane, never blocking. */
export const problemsOf = (message: string, rules: Rules): string[] => {
  const header = message.split('\n')[0] ?? ''
  const problems: string[] = []
  if (header.trim() === '') return ['the message is empty']
  if (header.length > rules.headerMaxLength) problems.push(`the first line is ${header.length} characters (max ${rules.headerMaxLength})`)
  const match = HEADER.exec(header)
  if (match?.groups === undefined) return [...problems, 'the first line is not `type(scope): subject`']
  const { type = '', scope, subject = '' } = match.groups
  if (!rules.types.includes(type)) problems.push(`"${type}" is not one of ${rules.types.join(', ')}`)
  if (scope !== undefined && rules.scopes.length > 0 && !rules.scopes.includes(scope)) problems.push(`scope "${scope}" is not one of ${rules.scopes.join(', ')}`)
  if (/\.$/.test(subject)) problems.push('the subject ends with a period')
  const lines = message.split('\n')
  if (lines.length > 1 && lines[1] !== '') problems.push('the body is not separated from the subject by a blank line')
  return problems
}

/** Replaces the first line of a message, keeping its body. */
export const withSubject = (message: string, subject: string): string => {
  const [, ...rest] = message.split('\n')
  return [subject.trim(), ...rest].join('\n')
}
