/** Counters that add up across sessions. */
export const SUM_COUNTERS = [
  'prompts',
  'commits',
  'greenRuns',
  'redToGreen',
  'prs',
  'pushes',
  'branches',
  'tools',
  'subagents',
  'checklists',
  'mods',
] as const
/** Counters that keep their highest value: a best, or a 0/1 flag. */
export const MAX_COUNTERS = ['sessionFiles', 'deepWork', 'nightOwl', 'earlyBird', 'weekend', 'bestStreak'] as const

export type SumCounter = (typeof SUM_COUNTERS)[number]
export type MaxCounter = (typeof MAX_COUNTERS)[number]
/** What an achievement measures: a stored counter, or one derived from the progress. */
export type Stat = SumCounter | MaxCounter | 'languages' | 'streak' | 'flawless' | 'unlocked'

export type Group = 'start' | 'git' | 'tests' | 'craft' | 'habits'

export type Achievement = {
  id: string
  icon: string
  title: string
  description: string
  group: Group
  stat: Stat
  goal: number
}

export const GROUPS: Record<Group, string> = {
  start: 'Getting started',
  git: 'Git',
  tests: 'Tests',
  craft: 'Craft',
  habits: 'Habits',
}

/** Every achievement, in the order the pane shows them. */
export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'first-prompt', icon: '👋', title: 'Hello, Claude', description: 'Send your first prompt', group: 'start', stat: 'prompts', goal: 1 },
  { id: 'prompts-100', icon: '💬', title: 'Regular', description: 'Send 100 prompts', group: 'start', stat: 'prompts', goal: 100 },
  { id: 'first-subagent', icon: '🤝', title: 'Delegator', description: 'Claude starts its first subagent', group: 'start', stat: 'subagents', goal: 1 },
  { id: 'first-mod', icon: '🧩', title: 'Collector', description: 'Install a mod, from the mod store or the CLI', group: 'start', stat: 'mods', goal: 1 },
  { id: 'first-commit', icon: '📝', title: 'First commit', description: 'Claude makes its first git commit', group: 'git', stat: 'commits', goal: 1 },
  { id: 'commits-10', icon: '📚', title: 'Committed', description: '10 commits made by Claude', group: 'git', stat: 'commits', goal: 10 },
  { id: 'commits-100', icon: '🏛', title: 'Centurion', description: '100 commits made by Claude', group: 'git', stat: 'commits', goal: 100 },
  { id: 'first-pr', icon: '🚀', title: 'Pull request', description: 'Open a pull request with gh pr create', group: 'git', stat: 'prs', goal: 1 },
  { id: 'pushes-10', icon: '📦', title: 'Shipper', description: 'Push 10 times', group: 'git', stat: 'pushes', goal: 10 },
  { id: 'branches-5', icon: '🌿', title: 'Branching out', description: 'Create 5 branches', group: 'git', stat: 'branches', goal: 5 },
  { id: 'green-1', icon: '🟢', title: 'Green light', description: 'A test run that passes', group: 'tests', stat: 'greenRuns', goal: 1 },
  { id: 'green-100', icon: '🌳', title: 'Evergreen', description: '100 green test runs', group: 'tests', stat: 'greenRuns', goal: 100 },
  { id: 'bug-squasher', icon: '🐛', title: 'Bug squasher', description: 'Turn a failing test run green 10 times', group: 'tests', stat: 'redToGreen', goal: 10 },
  { id: 'refactor-20', icon: '🔧', title: 'Refactorer', description: 'Edit 20 different files in one session', group: 'craft', stat: 'sessionFiles', goal: 20 },
  { id: 'polyglot', icon: '🌐', title: 'Polyglot', description: 'Edit code in 5 programming languages', group: 'craft', stat: 'languages', goal: 5 },
  { id: 'tools-1000', icon: '🧰', title: 'Toolsmith', description: '1,000 tool calls', group: 'craft', stat: 'tools', goal: 1000 },
  { id: 'checklist', icon: '✅', title: 'Checklist', description: 'Finish a todo list of 5 or more items', group: 'craft', stat: 'checklists', goal: 1 },
  { id: 'deep-work', icon: '🧠', title: 'Deep work', description: 'A single turn that runs 10 minutes or more', group: 'craft', stat: 'deepWork', goal: 1 },
  { id: 'flawless-day', icon: '💎', title: 'Flawless day', description: 'A day with 25 or more tool calls and none failing', group: 'craft', stat: 'flawless', goal: 1 },
  { id: 'night-owl', icon: '🦉', title: 'Night owl', description: 'Send a prompt between midnight and 4 a.m.', group: 'habits', stat: 'nightOwl', goal: 1 },
  { id: 'early-bird', icon: '🐦', title: 'Early bird', description: 'Send a prompt between 5 and 7 a.m.', group: 'habits', stat: 'earlyBird', goal: 1 },
  { id: 'weekend', icon: '🏖', title: 'Weekend warrior', description: 'Work with Claude on a Saturday or Sunday', group: 'habits', stat: 'weekend', goal: 1 },
  { id: 'streak-3', icon: '🔥', title: 'On a roll', description: 'Work with Claude 3 days in a row', group: 'habits', stat: 'streak', goal: 3 },
  { id: 'streak-7', icon: '📅', title: 'Week-long streak', description: 'Work with Claude 7 days in a row', group: 'habits', stat: 'streak', goal: 7 },
  { id: 'streak-30', icon: '🏅', title: 'Habit', description: 'Work with Claude 30 days in a row', group: 'habits', stat: 'streak', goal: 30 },
  { id: 'hunter-10', icon: '🎖', title: 'Achievement hunter', description: 'Unlock 10 achievements', group: 'habits', stat: 'unlocked', goal: 10 },
]

/** The programming language of a file extension, for Polyglot; config, docs and data count for none. */
const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
  rb: 'Ruby', php: 'PHP', cs: 'C#', fs: 'F#', swift: 'Swift', m: 'Objective-C', mm: 'Objective-C',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++',
  dart: 'Dart', lua: 'Lua', zig: 'Zig', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell',
  clj: 'Clojure', ml: 'OCaml', r: 'R', jl: 'Julia', pl: 'Perl', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  ps1: 'PowerShell', sql: 'SQL', vue: 'Vue', svelte: 'Svelte', css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS',
  html: 'HTML', sol: 'Solidity', tf: 'Terraform',
}

export function languageOf(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? undefined : LANGUAGES[base.slice(dot + 1).toLowerCase()]
}

/** What one successful Bash command counts toward. */
export type BashCounts = Partial<Record<'commits' | 'pushes' | 'branches' | 'prs' | 'mods', number>>

const COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b(?![^|;&\n]*--dry-run)/g
const PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b(?![^|;&\n]*--dry-run)/g
const BRANCH = /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout\s+-[bB]|switch\s+(?:-c|-C|--create))\s+[\w./-]|\bgit\s+(?:-C\s+\S+\s+)?branch\s+(?!-)[\w./-]+(?:\s+[\w./-]+)?\s*(?:$|[|;&\n])/g
const PULL_REQUEST = /\bgh\s+pr\s+create\b/g
const PLUGIN_INSTALL = /\bclaude\s+plugin\s+(?:install|i)\s+[\w@./-]/g
/** A runner as the command a shell segment runs, after env assignments and launchers (`npx`, `python -m`, `poetry run`, ...). */
const TEST_RUNNER = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:python3?|py)\s+-m\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
    String.raw`(?:[\w.~-]*\/)*` +
    String.raw`(jest|vitest|pytest|py\.test|mocha|rspec|phpunit|tox|ctest|go test|cargo (?:test|nextest)|deno test|bun test|dotnet test|mvn test|gradle test|(?:npm|yarn|pnpm)(?: run)? test)(?![\w./])`,
)
const SEGMENTS = /&&|\|\||[;|&\n(){}]/
const FAILURE_REPORT = /\b[1-9]\d* (?:failed|failing|failures?)\b|^FAIL\b|\bFAILED\b/m

const count = (pattern: RegExp, text: string): number => [...text.matchAll(pattern)].length

/** What a Bash command that succeeded counts toward: commits, pushes, branches, pull requests, installs. */
export function bashCounts(command: string): BashCounts {
  const counts: BashCounts = {
    commits: count(COMMIT, command),
    pushes: count(PUSH, command),
    branches: count(BRANCH, command),
    prs: count(PULL_REQUEST, command),
    mods: count(PLUGIN_INSTALL, command),
  }
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0))
}

/** The test runner a command runs (`npm run test` and `npm test` alike), or undefined; `cat jest.config.js` or `pip install pytest` runs none. */
export function testRunnerOf(command: string): string | undefined {
  for (const segment of command.split(SEGMENTS)) {
    const runner = TEST_RUNNER.exec(segment)?.[1]
    if (runner !== undefined) return runner.replace(' run ', ' ')
  }
  return undefined
}

/** Whether a test run's output reports failures even though the command exited 0. */
export const reportsFailure = (output: string): boolean => FAILURE_REPORT.test(output)

/** Whether an argv another plugin ran (the mod store) installed a plugin and succeeded. */
export function isPluginInstall(argv: readonly string[], exitCode: number): boolean {
  const [bin = '', verb, action] = argv
  return exitCode === 0 && /(^|[\\/])claude(\.exe)?$/i.test(bin) && verb === 'plugin' && (action === 'install' || action === 'i')
}
