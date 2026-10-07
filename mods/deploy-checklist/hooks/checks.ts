import type { DeployChecklistItem as Item } from '../types'

/** One known deploy command: what to call it and how to spot it in a shell line. */
type Deploy = { label: string; pattern: RegExp }

// `[^|;&]*` keeps a flag inside the same simple command as the tool it belongs to.
const DEPLOYS: readonly Deploy[] = [
  { label: 'vercel --prod', pattern: /\bvercel\b(?:\s+deploy)?[^|;&]*\s--prod(?:uction)?(?=[\s=]|$)/ },
  { label: 'netlify deploy --prod', pattern: /\bnetlify\s+deploy\b[^|;&]*\s--prod(?:IfUnlocked)?(?=[\s=]|$)/ },
  { label: 'fly deploy', pattern: /\bfly(?:ctl)?\s+deploy\b/ },
  { label: 'firebase deploy', pattern: /\bfirebase\s+deploy\b/ },
  { label: 'gcloud app deploy', pattern: /\bgcloud\s+app\s+deploy\b/ },
  { label: 'kubectl rollout', pattern: /\bkubectl\b[^|;&]*\srollout\s+(?!status\b|history\b)[a-z]/ },
  { label: 'cap production deploy', pattern: /\bcap\s+production\s+deploy\b/ },
  { label: 'npm publish', pattern: /\b(?:npm|pnpm|yarn(?:\s+npm)?|bun)\s+publish\b(?![^|;&]*\s--dry-run\b)/ },
]

/**
 * A test runner as the command one shell segment runs, past env assignments, launchers (`npx`, `poetry run`, `bundle exec`...),
 * `sh -c` and a path: `cd web && npx jest` runs tests; `cat jest.config.js`, `npm i -D vitest` or `echo pytest` only name a runner.
 */
const TEST_COMMAND = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+|["']|(?:ba|z|da)?sh\s+-[a-zA-Z]*c[a-zA-Z]*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
    String.raw`(?:[\w.~-]*\/)*(?:` +
    [
      String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?`,
      'vitest|jest|mocha|ava|pytest|phpunit|rspec|tox|nox',
      String.raw`playwright\s+test|cypress\s+run`,
      String.raw`(?:go|cargo|deno|bun|mix|dotnet|swift)\s+test`,
      String.raw`rails\s+test|(?:php\s+)?artisan\s+test|python[\d.]*\s+-m\s+(?:pytest|unittest)`,
      String.raw`make\s+(?:test|check)`,
      String.raw`(?:gradlew?|mvnw?)\b[^|;&]*\s(?:test|check|verify)`,
    ].join('|') +
    String.raw`)(?![\w./-])`,
)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/

export const CHANGELOG_NAMES = ['CHANGELOG.md', 'CHANGELOG', 'CHANGELOG.txt', 'CHANGES.md', 'HISTORY.md', 'changelog.md']

/**
 * The text a command matcher reads: quoted text blanked, so `git commit -m "fly deploy"` runs
 * nothing, except where a shell runs the quoted text (`bash -c "…"`, `sh -lc '…'`, `eval`, `ssh host "…"`).
 */
const matchText = (command: string): string =>
  /(?:^|\s)(?:-c|eval|ssh)\s|\b(?:ba|z|da|k)?sh\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c[a-zA-Z]*\s/.test(command) ? command.replace(/["']/g, ' ') : command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, quoted => `"${' '.repeat(quoted.length - 2)}"`)

/** The kind of deploy a shell line runs, or undefined when it deploys nothing this mod knows. */
export const deployKind = (command: string, extra: RegExp | undefined): string | undefined => {
  const code = matchText(command)
  const known = DEPLOYS.find(deploy => deploy.pattern.test(code))
  if (known !== undefined) return known.label
  return extra?.test(command) === true ? 'custom deploy' : undefined
}

export const isTestCommand = (command: string): boolean => {
  const code = matchText(command)
  return code.split(SEGMENTS).some(segment => TEST_COMMAND.test(segment))
}

/** True when the line runs a test command and only then (`&&`) the deploy. */
export const testsRunFirst = (command: string, extra: RegExp | undefined): boolean => {
  const steps = command.split('&&')
  const deployAt = steps.findIndex(step => deployKind(step, extra) !== undefined)
  return deployAt > 0 && steps.slice(0, deployAt).some(isTestCommand)
}

/** A user pattern, or undefined when it is empty or does not compile. */
export const compileExtra = (source: unknown): RegExp | undefined => {
  if (typeof source !== 'string' || source.trim() === '') return undefined
  try {
    return new RegExp(source)
  } catch {
    return undefined
  }
}

export const branchList = (value: unknown): string[] => {
  const list = (typeof value === 'string' ? value : '')
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
  return list.length > 0 ? list : ['main', 'master']
}

/** `git status --porcelain` lines, as paths. */
export const changedPaths = (porcelain: string): string[] =>
  porcelain
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))

export const ago = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return `${hours} h ago`
}

export const listShort = (paths: readonly string[], max = 3): string =>
  paths.length <= max ? paths.join(', ') : `${paths.slice(0, max).join(', ')} +${paths.length - max} more`

export const GLYPH: Record<Item['status'], string> = { pass: '✓', fail: '✗', warn: '!', skip: '–' }

export const isAllClear = (items: readonly Item[]): boolean => items.every(item => item.status === 'pass' || item.status === 'skip')

/** The checklist as plain lines, for the model and the command output. */
export const checklistText = (items: readonly Item[]): string =>
  items.map(item => `${GLYPH[item.status]} ${item.label}: ${item.detail}`).join('\n')
