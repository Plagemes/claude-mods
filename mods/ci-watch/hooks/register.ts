import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

const MOD = 'ci-watch'
const RUN_FIELDS = 'databaseId,status,conclusion,name,workflowName,event,url,headSha'
const RUN_LIMIT = 30
const DEFAULT_POLL_SEC = 30
const MIN_POLL_SEC = 10
const GH_TIMEOUT_MS = 20_000
const GIT_TIMEOUT_MS = 5_000
const MAX_POLL_FAILURES = 3
const WAIT_FOR_RUN_MS = 5 * 60_000
const MAX_WATCH_MS = 3 * 60 * 60_000
const TOAST_MS = 8_000
const SHORT_SHA = 7
const FAILING = new Set(['failure', 'timed_out', 'startup_failure', 'action_required'])
const CANCELLED = new Set(['cancelled', 'stale'])
const SOUNDS = { passed: 'assets/pass.wav', failed: 'assets/fail.wav', cancelled: 'assets/fail.wav' } as const

type Run = {
  databaseId: number
  status: string
  conclusion: string
  name: string
  workflowName: string
  event: string
  url: string
  headSha: string
}
type Verdict = keyof typeof SOUNDS
type Snapshot =
  | { kind: 'none' }
  | { kind: 'running'; total: number; done: number; current: string }
  | { kind: 'done'; verdict: Verdict; runs: Run[]; culprit: Run | undefined }
type Settings = { pollMs: number; autoFix: boolean; sound: boolean }
type Watch = {
  branch: string
  sha: string | undefined
  startedAt: number
  failures: number
  isPolling: boolean
  timer: Timer | undefined
}
/** The one watch of this load; a new /ci-watch replaces it. */
type Watcher = { current: Watch | undefined }

function readSettings(options: PluginOptions): Settings {
  const seconds = typeof options.pollSec === 'number' ? options.pollSec : DEFAULT_POLL_SEC

  return {
    pollMs: Math.max(MIN_POLL_SEC, seconds) * 1000,
    autoFix: options.autoFix === true,
    sound: options.sound !== false,
  }
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function isRun(value: unknown): value is Run {
  if (typeof value !== 'object' || value === null) return false
  const run = value as Record<string, unknown>
  return typeof run.status === 'string' && typeof run.headSha === 'string' && typeof run.url === 'string'
}

/** Runs git in the session's directory; undefined when it fails. */
async function git($: EngineInterface, args: readonly string[]): Promise<string | undefined> {
  try {
    const out = await $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })
    return out.exitCode === 0 ? out.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

/** The branch's runs, newest first, as `gh run list` reports them; rejects with a readable reason. */
async function listRuns($: EngineInterface, branch: string): Promise<Run[]> {
  const argv = ['gh', 'run', 'list', '--branch', branch, '--limit', String(RUN_LIMIT), '--json', RUN_FIELDS]
  let out
  try {
    out = await $.process.run(argv, { timeoutMs: GH_TIMEOUT_MS })
  } catch (error) {
    const reason = messageOf(error)
    throw new Error(
      /ENOENT|not found|no such file/i.test(reason)
        ? 'the GitHub CLI (gh) is not installed; get it from https://cli.github.com'
        : `could not run gh (${reason})`,
    )
  }
  if (out.exitCode !== 0) throw new Error(firstLine(out.stderr) || `gh exited with code ${out.exitCode}`)
  const parsed: unknown = JSON.parse(out.stdout || '[]')

  return Array.isArray(parsed) ? parsed.filter(isRun) : []
}

/** Reduces the runs of one commit (the target, or the newest run's) to a single state. */
function snapshotOf(runs: readonly Run[], sha: string | undefined): Snapshot {
  const head = sha ?? runs[0]?.headSha
  const latest = new Map<string, Run>()
  for (const run of runs) {
    const key = `${run.workflowName || run.name}:${run.event}`
    if (run.headSha === head && !latest.has(key)) latest.set(key, run)
  }
  const mine = [...latest.values()]
  if (mine.length === 0) return { kind: 'none' }

  const pending = mine.filter(run => run.status !== 'completed')
  if (pending.length > 0) {
    const current = pending[0]
    return { kind: 'running', total: mine.length, done: mine.length - pending.length, current: current?.workflowName || current?.name || '' }
  }
  const failed = mine.find(run => FAILING.has(run.conclusion))
  const cancelled = mine.find(run => CANCELLED.has(run.conclusion))
  const verdict: Verdict = failed ? 'failed' : cancelled ? 'cancelled' : 'passed'

  return { kind: 'done', verdict, runs: mine, culprit: failed ?? cancelled }
}

function statusLine(watch: Watch, snapshot: Snapshot): string {
  const at = watch.sha ? ` @ ${watch.sha.slice(0, SHORT_SHA)}` : ''
  if (snapshot.kind === 'running') {
    return `⏳ CI running on ${watch.branch}${at} · ${snapshot.done}/${snapshot.total} done · ${snapshot.current}`
  }
  return `🕒 CI: waiting for a run on ${watch.branch}${at}`
}

function verdictLine(branch: string, snapshot: Extract<Snapshot, { kind: 'done' }>): string {
  const culprit = snapshot.culprit
  if (snapshot.verdict === 'failed' && culprit) {
    return `❌ CI failed on ${branch}: ${culprit.workflowName || culprit.name} (${culprit.conclusion})`
  }
  if (snapshot.verdict === 'cancelled' && culprit) {
    return `⛔ CI cancelled on ${branch}: ${culprit.workflowName || culprit.name}`
  }
  const only = snapshot.runs.length === 1 ? snapshot.runs[0] : undefined
  const what = only ? only.workflowName || only.name : `${snapshot.runs.length} workflows`

  return `✅ CI passed on ${branch} · ${what}`
}

function stop($: EngineInterface, watcher: Watcher): Watch | undefined {
  const watch = watcher.current
  watch?.timer?.cancel()
  watcher.current = undefined
  $.ui.status(undefined)

  return watch
}

async function announce($: EngineInterface, watch: Watch, snapshot: Extract<Snapshot, { kind: 'done' }>, settings: Settings): Promise<void> {
  const line = verdictLine(watch.branch, snapshot)
  const link = (snapshot.culprit ?? snapshot.runs[0])?.url
  $.ui.toast(line, { timeoutMs: TOAST_MS })
  $.ui.log(link ? `${line} · ${link}` : line)
  if (settings.sound) {
    await $.audio.play({ asset: SOUNDS[snapshot.verdict] }).catch(() => undefined)
  }
  const culprit = snapshot.culprit
  if (settings.autoFix && snapshot.verdict === 'failed' && culprit) {
    await $.prompt.submit({
      text:
        `CI failed: investigate. The GitHub Actions workflow "${culprit.workflowName || culprit.name}" failed on branch ` +
        `${watch.branch} (${culprit.url}). Read the failing logs with \`gh run view ${culprit.databaseId} --log-failed\`, ` +
        'find the root cause and fix it.',
    })
  }
}

/** One poll: updates the status line, or announces the verdict and ends the watch. */
async function tick($: EngineInterface, watcher: Watcher, watch: Watch, settings: Settings): Promise<void> {
  if (watcher.current !== watch || watch.isPolling) return
  watch.isPolling = true
  try {
    const snapshot = snapshotOf(await listRuns($, watch.branch), watch.sha)
    if (watcher.current !== watch) return
    watch.failures = 0
    const elapsed = (await $.clock.now()) - watch.startedAt
    if (snapshot.kind === 'done') {
      stop($, watcher)
      await announce($, watch, snapshot, settings)
    } else if (snapshot.kind === 'none' && elapsed > WAIT_FOR_RUN_MS) {
      stop($, watcher)
      $.ui.toast(`${MOD}: no CI run appeared for ${watch.branch}; stopped watching.`, { timeoutMs: TOAST_MS })
    } else if (elapsed > MAX_WATCH_MS) {
      stop($, watcher)
      $.ui.toast(`${MOD}: CI on ${watch.branch} still running after 3 h; stopped watching.`, { timeoutMs: TOAST_MS })
    } else {
      $.ui.status(statusLine(watch, snapshot))
    }
  } catch (error) {
    watch.failures += 1
    if (watch.failures >= MAX_POLL_FAILURES && watcher.current === watch) {
      stop($, watcher)
      $.ui.toast(`${MOD}: stopped, gh keeps failing: ${messageOf(error)}`, { timeoutMs: TOAST_MS })
    }
  } finally {
    watch.isPolling = false
  }
}

/** `/ci-watch [branch|stop]`: resolves the line printed as the command's output. */
async function runCommand($: EngineInterface, args: string, watcher: Watcher, settings: Settings): Promise<string> {
  const arg = args.trim()
  if (arg === 'stop') {
    const stopped = stop($, watcher)
    return stopped ? `${MOD}: stopped watching ${stopped.branch}.` : `${MOD}: nothing is being watched.`
  }
  if ((await $.session.repo().catch(() => null)) === null) return `${MOD}: this folder is not a git repository.`

  const current = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = arg || current
  if (!branch || branch === 'HEAD') return `${MOD}: detached HEAD; name a branch: /ci-watch <branch>`
  const sha = (await git($, ['rev-parse', '--verify', '--quiet', `origin/${branch}`])) ?? (await git($, ['rev-parse', '--verify', '--quiet', branch]))

  let runs: Run[]
  try {
    runs = await listRuns($, branch)
  } catch (error) {
    return `${MOD}: ${messageOf(error)}`
  }
  stop($, watcher)
  const snapshot = snapshotOf(runs, sha)
  if (snapshot.kind === 'done') {
    const link = (snapshot.culprit ?? snapshot.runs[0])?.url

    return `${verdictLine(branch, snapshot)} (already finished)${link ? ` · ${link}` : ''}`
  }
  const watch: Watch = { branch, sha, startedAt: await $.clock.now(), failures: 0, isPolling: false, timer: undefined }
  watcher.current = watch
  watch.timer = $.clock.every(settings.pollMs, () => void tick($, watcher, watch, settings))
  $.ui.status(statusLine(watch, snapshot))

  return `👀 ${MOD}: watching CI on ${branch}${sha ? ` @ ${sha.slice(0, SHORT_SHA)}` : ''} every ${settings.pollMs / 1000}s. /ci-watch stop to cancel.`
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const watcher: Watcher = { current: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci-watch',
      description: 'Follow the GitHub Actions run of a branch until it passes or fails',
      argumentHint: '[branch|stop]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'ci-watch' }, async ($, e) => ({ text: await runCommand($, e.args, watcher, settings) }))
}
