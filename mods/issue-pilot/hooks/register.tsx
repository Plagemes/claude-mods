import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderSurface, Timer } from 'claude-code'

import type { IssuePilotActive, IssuePilotFilters, IssuePilotIssue, IssuePilotList, IssuePilotPhase, IssuePilotProvider, IssuePilotTestRun } from '../types'
import {
  NEVER_STAGE,
  PROJECT_FILES,
  REPORT_PROMPT,
  acceptanceCriteria,
  branchNameOf,
  commitMessageOf,
  finishCommentOf,
  parseReport,
  prBodyOf,
  prTitleOf,
  redact,
  startCommentOf,
  tailOf,
  testCommandFrom,
  workPrompt,
} from './compose'
import type { WorkReport } from './compose'
import { formatMinutes, parseLearnedRules } from './estimate'
import type { LearnedRule } from './estimate'
import {
  GH_MISSING,
  LINEAR_COMMENT,
  LINEAR_LINK,
  LINEAR_LIST,
  LINEAR_MOVE,
  LINEAR_STATES,
  LINEAR_URL,
  LINEAR_VIEW,
  explainGh,
  explainHttp,
  findTransition,
  ghListArgs,
  ghViewArgs,
  isGitHubRemote,
  jiraHeaders,
  jiraIsConfigured,
  jiraIssueUrl,
  jiraSearchUrl,
  linearAuthorization,
  linearData,
  linearFilter,
  linearIssue,
  linearIssues,
  linearRequest,
  linearStates,
  parseGhList,
  parseGhView,
  parseJiraIssue,
  parseJiraSearch,
  parseJiraTransitions,
  pickLinearState,
  pickProvider,
  prUrlIn,
  sized,
  textToAdf,
} from './providers'
import type { JiraConfig, RawIssue } from './providers'
import { formatUsd } from './shared/prices'
import { describeRun, summarizeRun } from './shared/test-runners'

const VERSION = '1.0.0'
const PANE = 'issue-pilot'
const PANE_TITLE = 'Issues'
const PANE_COLUMNS = 76
const TAB = 'issues'
const TAB_ORDER = 213
const GH_TIMEOUT_MS = 60_000
const GIT_TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 600_000
/** While an issue is being worked, how often the hub's latest task.finished / ci.result are looked at. */
const SIGNAL_POLL_MS = 20_000
const MAX_LOG = 12
const SHOWN_LOG = 4
const STORE_PREFIX = 'active:'
const RULES_FILE = '.claude/claude-mods/smart-router/rules.json'
const FALLBACK_BASES = ['origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop']
const PROVIDER_LABEL: Record<IssuePilotProvider, string> = { github: 'GitHub', jira: 'Jira', linear: 'Linear' }
const TIER_COLOR = { light: 'success', standard: 'suggestion', deep: 'warning' } as const
const PHASE_LABEL: Record<IssuePilotPhase, string> = {
  working: 'Claude is working on it',
  testing: 'running the tests…',
  ready: 'ready for a draft PR',
  shipping: 'opening the draft PR…',
  done: 'draft PR open',
  failed: 'stopped',
}
const USAGE = 'Usage: /issues [refresh | start <#n|KEY> | finish | pr | stop | github | jira | linear]'
const EMPTY_LIST: IssuePilotList = { status: 'idle', provider: null, available: [], items: [], error: null }

const listAtom = atom({ plugin: 'issue-pilot', key: 'list' } as const, EMPTY_LIST)
const filtersAtom = atom({ plugin: 'issue-pilot', key: 'filters' } as const, { isMine: true, label: '', milestone: '' })
const activeAtom = atom({ plugin: 'issue-pilot', key: 'active' } as const, null)
const selectedAtom = atom({ plugin: 'issue-pilot', key: 'selected' } as const, null)
const noteAtom = atom({ plugin: 'issue-pilot', key: 'note' } as const, '')
const HUB_LATEST = { plugin: 'mods-hub', key: 'latest' } as const

type Settings = {
  provider: string
  filters: IssuePilotFilters
  autoPR: boolean
  startComment: boolean
  finishComment: boolean
  inProgressLabel: string
  testCommand: string
  baseBranch: string
  jira: JiraConfig
  jiraStartStatus: string
  jiraReviewStatus: string
  linearKey: string
  linearReviewState: string
}

type Runtime = { settings: Settings; poller: Timer | undefined; isRestored: boolean; isFinishing: boolean }
type Ran = { ok: boolean; out: string; err: string; code: number; isMissing: boolean }
type PaneInput = RenderInput<'Pane'>

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)

function settingsOf(options: Readonly<Record<string, unknown>>): Settings {
  return {
    provider: str(options.provider, 'auto'),
    filters: { isMine: options.assignedToMe !== false, label: str(options.label).trim(), milestone: str(options.milestone).trim() },
    autoPR: options.autoPR === true,
    startComment: options.startComment === true,
    finishComment: options.finishComment !== false,
    inProgressLabel: str(options.inProgressLabel, 'in progress').trim(),
    testCommand: str(options.testCommand).trim(),
    baseBranch: str(options.baseBranch).trim(),
    jira: { baseUrl: str(options.jiraBaseUrl), email: str(options.jiraEmail), token: str(options.jiraApiToken), jql: str(options.jiraJql) },
    jiraStartStatus: str(options.jiraStartStatus, 'In Progress'),
    jiraReviewStatus: str(options.jiraReviewStatus, 'In Review'),
    linearKey: str(options.linearApiKey).trim(),
    linearReviewState: str(options.linearReviewState, 'In Review'),
  }
}

// ── Host commands ───────────────────────────────────────────────────────────────────────────────────

async function exec($: EngineInterface, argv: readonly string[], cwd: string | undefined, timeoutMs: number, stdin?: string): Promise<Ran> {
  try {
    const run = await $.process.run(argv, { ...(cwd === undefined ? {} : { cwd }), timeoutMs, ...(stdin === undefined ? {} : { stdin }) })
    return { ok: run.exitCode === 0, out: run.stdout, err: run.stderr, code: run.exitCode, isMissing: false }
  } catch (error) {
    const message = errorText(error)
    return { ok: false, out: '', err: message, code: -1, isMissing: /ENOENT|not found|failed to start/i.test(message) }
  }
}

const ghRun = ($: EngineInterface, root: string, args: readonly string[], stdin?: string): Promise<Ran> => exec($, ['gh', ...args], root, GH_TIMEOUT_MS, stdin)
const gitRun = ($: EngineInterface, root: string | undefined, args: readonly string[], stdin?: string): Promise<Ran> => exec($, ['git', ...args], root, GIT_TIMEOUT_MS, stdin)

/** What a failed gh call means. */
const ghProblem = (ran: Ran): string => (ran.isMissing ? GH_MISSING : explainGh(ran.err, ran.code))

async function repoRoot($: EngineInterface): Promise<string | undefined> {
  const ran = await gitRun($, undefined, ['rev-parse', '--show-toplevel'])
  return ran.ok && ran.out.trim() !== '' ? ran.out.trim() : undefined
}

async function remoteIsGitHub($: EngineInterface, root: string): Promise<boolean> {
  const ran = await gitRun($, root, ['remote', 'get-url', 'origin'])
  return ran.ok && isGitHubRemote(ran.out)
}

/** The trackers this project can use: GitHub from the remote, Jira and Linear from the configuration. */
async function providersFor($: EngineInterface, rt: Runtime, root: string | undefined): Promise<IssuePilotProvider[]> {
  const found: IssuePilotProvider[] = []
  if (root !== undefined && (await remoteIsGitHub($, root))) found.push('github')
  if (jiraIsConfigured(rt.settings.jira)) found.push('jira')
  if (rt.settings.linearKey !== '') found.push('linear')
  return found
}

// ── Jira and Linear over HTTP ───────────────────────────────────────────────────────────────────────

async function jiraCall($: EngineInterface, rt: Runtime, method: string, url: string, body?: unknown): Promise<{ text: string } | { error: string }> {
  try {
    const answer = await $.http.fetch(url, { method, headers: jiraHeaders(rt.settings.jira), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return answer.ok ? { text: answer.text } : { error: explainHttp('Jira', answer.status, answer.text) }
  } catch (error) {
    return { error: `could not reach Jira: ${errorText(error)}` }
  }
}

async function linearCall($: EngineInterface, rt: Runtime, query: string, variables: Record<string, unknown>): Promise<{ data: Record<string, unknown> } | { error: string }> {
  try {
    const answer = await $.http.fetch(LINEAR_URL, {
      method: 'POST',
      headers: { Authorization: linearAuthorization(rt.settings.linearKey), 'Content-Type': 'application/json' },
      body: linearRequest(query, variables),
    })
    if (!answer.ok && answer.status !== 400) return { error: explainHttp('Linear', answer.status, answer.text) }
    try {
      return linearData(answer.text)
    } catch {
      return { error: explainHttp('Linear', answer.status, answer.text) }
    }
  } catch (error) {
    return { error: `could not reach Linear: ${errorText(error)}` }
  }
}

// ── Listing and sizing ──────────────────────────────────────────────────────────────────────────────

/** smart-router's learned rules, when it keeps them in a file other mods can read. */
async function learnedRules($: EngineInterface): Promise<LearnedRule[]> {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (home === undefined || home === '') return []
    return parseLearnedRules(await $.fs.read(`${home.replace(/[\\/]+$/, '')}/${RULES_FILE}`))
  } catch {
    return []
  }
}

async function fetchList($: EngineInterface, rt: Runtime, provider: IssuePilotProvider, root: string | undefined, filters: IssuePilotFilters): Promise<RawIssue[] | string> {
  if (provider === 'github') {
    if (root === undefined) return 'not inside a git repository.'
    const ran = await ghRun($, root, ghListArgs(filters))
    if (!ran.ok) return ghProblem(ran)
    try {
      return parseGhList(ran.out)
    } catch {
      return 'gh answered something that is not JSON; is it up to date?'
    }
  }
  if (provider === 'jira') {
    const answer = await jiraCall($, rt, 'GET', jiraSearchUrl(rt.settings.jira, filters))
    if ('error' in answer) return answer.error
    try {
      return parseJiraSearch(answer.text, rt.settings.jira)
    } catch {
      return 'Jira answered something that is not JSON: check the Jira URL.'
    }
  }
  const answer = await linearCall($, rt, LINEAR_LIST, { filter: linearFilter(filters) })
  return 'error' in answer ? answer.error : linearIssues(answer.data)
}

/** Loads the open issues of the chosen tracker into the list, sized. */
async function loadIssues($: EngineInterface, rt: Runtime, wanted?: IssuePilotProvider): Promise<void> {
  await update($, listAtom, (current): IssuePilotList => ({ ...current, status: 'loading', error: null }))
  const root = await repoRoot($)
  const available = await providersFor($, rt, root)
  const previous = (await read($, listAtom)).provider
  const provider = pickProvider(wanted ?? previous ?? rt.settings.provider, available) ?? pickProvider(rt.settings.provider, available)
  if (provider === undefined) {
    const error = available.length === 0
      ? 'No tracker: the git remote is not on GitHub and neither Jira nor Linear is set up (see /config → issue-pilot).'
      : `${rt.settings.provider} is not set up here; available: ${available.map(one => PROVIDER_LABEL[one]).join(', ')}.`
    await update($, listAtom, (): IssuePilotList => ({ status: 'error', provider: null, available, items: [], error }))
    return
  }
  const filters = await read($, filtersAtom)
  const [listed, rules] = await Promise.all([fetchList($, rt, provider, root, filters), learnedRules($)])
  if (typeof listed === 'string') {
    await update($, listAtom, (): IssuePilotList => ({ status: 'error', provider, available, items: [], error: listed }))
    return
  }
  await update($, listAtom, (): IssuePilotList => ({ status: 'ready', provider, available, items: listed.map(raw => sized(raw, rules)), error: null }))
}

/** The issue as the tracker has it now (the list may be minutes old). */
async function viewIssue($: EngineInterface, rt: Runtime, listed: IssuePilotIssue, root: string): Promise<RawIssue | string> {
  try {
    return await readIssue($, rt, listed, root)
  } catch {
    // An answer that does not parse: the listed copy will do.
    return listed
  }
}

async function readIssue($: EngineInterface, rt: Runtime, listed: IssuePilotIssue, root: string): Promise<RawIssue | string> {
  if (listed.provider === 'github') {
    const ran = await ghRun($, root, ghViewArgs(listed.id))
    if (!ran.ok) return ghProblem(ran)
    return parseGhView(ran.out) ?? listed
  }
  if (listed.provider === 'jira') {
    const answer = await jiraCall($, rt, 'GET', jiraIssueUrl(rt.settings.jira, listed.id, '?fields=summary,description,labels,status,fixVersions,customfield_10016'))
    return 'error' in answer ? answer.error : (parseJiraIssue(answer.text, rt.settings.jira) ?? listed)
  }
  const answer = await linearCall($, rt, LINEAR_VIEW, { id: listed.id })
  return 'error' in answer ? answer.error : (linearIssue(answer.data.issue) ?? listed)
}

// ── Tracker updates ─────────────────────────────────────────────────────────────────────────────────

/** Marks the issue as being worked: a GitHub label, a Jira transition, a Linear "started" state. */
async function setInProgress($: EngineInterface, rt: Runtime, issue: IssuePilotIssue, root: string): Promise<string> {
  if (issue.provider === 'github') {
    const label = rt.settings.inProgressLabel
    if (label === '') return 'no in-progress label configured'
    const add = () => ghRun($, root, ['issue', 'edit', issue.id, '--add-label', label])
    let ran = await add()
    if (!ran.ok && /not found|could not add label/i.test(ran.err)) {
      await ghRun($, root, ['label', 'create', label, '--color', 'FBCA04', '--description', 'Being worked on (issue-pilot)'])
      ran = await add()
    }
    return ran.ok ? `labelled “${label}”` : `could not label it: ${ghProblem(ran)}`
  }
  if (issue.provider === 'jira') return jiraTransition($, rt, issue, rt.settings.jiraStartStatus)
  return linearMove($, rt, issue, 'start')
}

async function jiraTransition($: EngineInterface, rt: Runtime, issue: IssuePilotIssue, status: string): Promise<string> {
  if (status.trim() === '') return 'no Jira status configured'
  const listed = await jiraCall($, rt, 'GET', jiraIssueUrl(rt.settings.jira, issue.id, '/transitions'))
  if ('error' in listed) return `could not read the transitions: ${listed.error}`
  const transition = findTransition(parseJiraTransitions(listed.text), status)
  if (transition === undefined) return `no “${status}” transition from ${issue.state}`
  const moved = await jiraCall($, rt, 'POST', jiraIssueUrl(rt.settings.jira, issue.id, '/transitions'), { transition: { id: transition.id } })
  return 'error' in moved ? `could not move it to ${status}: ${moved.error}` : `moved to ${transition.to || status}`
}

async function linearMove($: EngineInterface, rt: Runtime, issue: IssuePilotIssue, phase: 'start' | 'review'): Promise<string> {
  const answer = await linearCall($, rt, LINEAR_STATES, { id: issue.id })
  if ('error' in answer) return `could not read the states: ${answer.error}`
  const state = pickLinearState(linearStates(answer.data), phase, rt.settings.linearReviewState)
  if (state === undefined) return phase === 'start' ? 'the team has no started state' : `the team has no “${rt.settings.linearReviewState}” state`
  const moved = await linearCall($, rt, LINEAR_MOVE, { id: issue.id, stateId: state.id })
  return 'error' in moved ? `could not move it: ${moved.error}` : `moved to ${state.name}`
}

/** Posts a comment on the issue, secrets masked. */
async function postComment($: EngineInterface, rt: Runtime, issue: IssuePilotIssue, root: string, body: string): Promise<string> {
  const safe = redact(body)
  if (issue.provider === 'github') {
    const ran = await ghRun($, root, ['issue', 'comment', issue.id, '--body-file', '-'], safe)
    return ran.ok ? 'commented' : `could not comment: ${ghProblem(ran)}`
  }
  if (issue.provider === 'jira') {
    const answer = await jiraCall($, rt, 'POST', jiraIssueUrl(rt.settings.jira, issue.id, '/comment'), { body: textToAdf(safe) })
    return 'error' in answer ? `could not comment: ${answer.error}` : 'commented'
  }
  const answer = await linearCall($, rt, LINEAR_COMMENT, { issueId: issue.id, body: safe })
  return 'error' in answer ? `could not comment: ${answer.error}` : 'commented'
}

/** Links the PR from the issue and moves it to review (Jira, Linear; GitHub links it from "Fixes #n"). */
async function trackerFinish($: EngineInterface, rt: Runtime, issue: IssuePilotIssue, prUrl: string, title: string): Promise<string[]> {
  if (issue.provider === 'jira') {
    const link = await jiraCall($, rt, 'POST', jiraIssueUrl(rt.settings.jira, issue.id, '/remotelink'), { object: { url: prUrl, title: redact(title) } })
    return ['error' in link ? `could not link the PR: ${link.error}` : 'linked the PR', await jiraTransition($, rt, issue, rt.settings.jiraReviewStatus)]
  }
  if (issue.provider === 'linear') {
    const link = await linearCall($, rt, LINEAR_LINK, { issueId: issue.id, url: prUrl, title: redact(title) })
    return ['error' in link ? `could not link the PR: ${link.error}` : 'linked the PR', await linearMove($, rt, issue, 'review')]
  }
  return []
}

// ── The active issue ────────────────────────────────────────────────────────────────────────────────

async function saveActive($: EngineInterface, active: IssuePilotActive | null): Promise<void> {
  await update($, activeAtom, () => active)
  $.ui.status(active === null || active.phase === 'done' ? undefined : `⚑ ${active.issue.ref} ${active.phase}`)
  try {
    const root = await repoRoot($)
    if (root !== undefined) await $.store.set(`${STORE_PREFIX}${root}`, active)
  } catch {
    // Remembering it across sessions is a convenience.
  }
}

async function changeActive($: EngineInterface, change: (active: IssuePilotActive) => Partial<IssuePilotActive>, step?: string): Promise<IssuePilotActive | null> {
  const current = await read($, activeAtom)
  if (current === null) return null
  const next = { ...current, ...change(current), log: step === undefined ? current.log : [...current.log, step].slice(-MAX_LOG) }
  await saveActive($, next)
  return next
}

/** Picks up the issue a previous session of this project was working on. */
async function restoreActive($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.isRestored) return
  rt.isRestored = true
  if ((await read($, activeAtom)) !== null) return
  try {
    const root = await repoRoot($)
    const kept = root === undefined ? undefined : await $.store.get(`${STORE_PREFIX}${root}`)
    if (kept !== null && kept !== undefined && typeof kept === 'object' && 'issue' in kept) {
      const active = kept as IssuePilotActive
      // A step that was cut off by the end of that session is not running any more.
      const phase: IssuePilotPhase = active.phase === 'testing' || active.phase === 'shipping' ? 'failed' : active.phase
      await saveActive($, { ...active, phase, error: phase === 'failed' && active.error === null ? 'the last session ended mid-step: try again.' : active.error })
      ensurePoller($, rt)
    }
  } catch {
    // Nothing kept.
  }
}

async function detectTestCommand($: EngineInterface, rt: Runtime, root: string): Promise<string | undefined> {
  if (rt.settings.testCommand !== '') return rt.settings.testCommand
  const files: Record<string, string | undefined> = {}
  await Promise.all(PROJECT_FILES.map(async name => {
    files[name] = await $.fs.read(`${root}/${name}`).catch(() => undefined)
  }))
  return testCommandFrom(files)
}

/** Watches the hub for autopilot's "done" while the issue is worked (pulled: issue-pilot does not depend on the hub). */
function ensurePoller($: EngineInterface, rt: Runtime): void {
  if (rt.poller !== undefined) return
  rt.poller = $.clock.every(SIGNAL_POLL_MS, () => void checkSignals($, rt))
}

function stopPoller(rt: Runtime): void {
  rt.poller?.cancel()
  rt.poller = undefined
}

/** autopilot's task.finished for this issue starts the finish; ci-watch's ci.result for its branch is shown. */
async function checkSignals($: EngineInterface, rt: Runtime): Promise<void> {
  await restoreActive($, rt)
  const active = await read($, activeAtom)
  if (active === null) return stopPoller(rt)
  if (active.phase === 'working' && !rt.isFinishing) {
    const { value: finished } = await $.state.get({ ...HUB_LATEST, id: 'task.finished' })
    const data = (finished?.data ?? {}) as { id?: unknown; title?: unknown; outcome?: unknown }
    // Ours: the task id issue-pilot published, or any autopilot run that finished in this session since Start.
    const isOurs = data.id === active.taskId || finished?.source === 'autopilot'
    if (finished != null && finished.at >= active.startedAt && isOurs && data.outcome === 'ok') {
      await finishIssue($, rt, 'autopilot')
      return
    }
  }
  if (active.phase === 'done') {
    const { value: ci } = await $.state.get({ ...HUB_LATEST, id: 'ci.result' })
    const data = (ci?.data ?? {}) as { branch?: unknown; outcome?: unknown; workflow?: unknown }
    if (ci != null && data.branch === active.branch && ci.at >= active.startedAt) {
      const line = `CI ${String(data.workflow ?? '')}: ${String(data.outcome ?? '')}`.replace('CI : ', 'CI: ')
      if (line !== active.ci) await changeActive($, () => ({ ci: line }))
    }
  }
}

async function submitWork($: EngineInterface, text: string): Promise<void> {
  try {
    await $.prompt.submit({ text })
  } catch (error) {
    await changeActive($, () => ({}), `could not send the prompt: ${errorText(error)}`)
  }
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────────

const isBusy = (active: IssuePilotActive | null): boolean => active !== null && active.phase !== 'done' && active.phase !== 'failed'

/** Branch, tracker status, optional comment, then the prompt Claude works from. */
async function startIssue($: EngineInterface, rt: Runtime, id: string): Promise<string> {
  const active = await read($, activeAtom)
  if (isBusy(active)) return `Finish or stop ${active?.issue.ref} first.`
  const listed = (await read($, listAtom)).items.find(one => one.id === id)
  if (listed === undefined) return 'That issue is not in the list: refresh it.'
  const root = await repoRoot($)
  if (root === undefined) return 'Not inside a git repository.'
  const fresh = await viewIssue($, rt, listed, root)
  if (typeof fresh === 'string') return `Could not read ${listed.ref}: ${fresh}`
  const issue = sized(fresh, await learnedRules($))
  const branch = branchNameOf(issue)

  let switched = await gitRun($, root, ['switch', '-c', branch])
  if (!switched.ok && /already exists/i.test(switched.err)) switched = await gitRun($, root, ['switch', branch])
  if (!switched.ok) return `Could not create branch ${branch}: ${firstLine(switched.err) || 'git failed'}`

  const log = [`on branch ${branch}`, await setInProgress($, rt, issue, root)]
  const dirty = await gitRun($, root, ['status', '--porcelain'])
  if (dirty.ok && dirty.out.trim() !== '') log.push('uncommitted changes were already in the working tree: they came along to this branch')
  if (rt.settings.startComment) log.push(await postComment($, rt, issue, root, startCommentOf(branch)))
  const testCommand = await detectTestCommand($, rt, root)
  const now = await $.clock.now()
  const taskId = `issue-pilot:${issue.provider}:${issue.ref}`
  await saveActive($, {
    issue, branch, taskId, startedAt: now, phase: 'working', log, signal: null, tests: null,
    prTitle: '', prBody: '', commitMessage: '', prUrl: null, error: null, ci: null,
  })
  await update($, noteAtom, () => '')
  ensurePoller($, rt)
  await hubPublish($, { topic: 'task.started', data: { id: taskId, title: `${issue.ref} ${issue.title}` } })
  // A prompt cannot be submitted from inside /issues (the command holds the turn it would wait on): next tick.
  const prompt = workPrompt(issue, branch, testCommand)
  $.clock.after(0, () => void submitWork($, prompt))
  await hubNotify($, { level: 'info', title: `Working on ${issue.ref}`, body: `${issue.title} · ${branch}`, url: issue.url, audience: 'terminal' })
  return `Started ${issue.ref} on ${branch}.`
}

// ── Finish: tests, the PR text, then (on a click or autoPR) commit, push, draft PR ─────────────────

async function runTests($: EngineInterface, rt: Runtime, root: string): Promise<IssuePilotTestRun> {
  const command = await detectTestCommand($, rt, root)
  if (command === undefined) return { command: '', outcome: 'skipped', passed: null, failed: null, summary: 'no test command found', tail: '' }
  const started = await $.clock.now()
  const ran = await exec($, ['sh', '-c', command], root, TEST_TIMEOUT_MS)
  const output = `${ran.out}\n${ran.err}`
  const summary = summarizeRun(command, output, !ran.ok)
  await hubPublish($, {
    topic: 'test.result',
    data: { runner: summary.runner ?? 'unknown', outcome: summary.outcome, passed: summary.passed, failed: summary.failed, durationMs: (await $.clock.now()) - started, command },
  })
  return { command, outcome: summary.outcome, passed: summary.passed, failed: summary.failed, summary: describeRun(summary), tail: summary.outcome === 'passed' ? '' : tailOf(output) }
}

/** The branch the PR goes into, as a ref git knows. */
async function baseRef($: EngineInterface, rt: Runtime, root: string): Promise<string | undefined> {
  const wanted = rt.settings.baseBranch
  const head = wanted === '' ? await gitRun($, root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']) : undefined
  const candidates = wanted !== '' ? [`origin/${wanted}`, wanted] : [...(head?.ok === true ? [head.out.trim()] : []), ...FALLBACK_BASES]
  for (const candidate of candidates) {
    if ((await gitRun($, root, ['rev-parse', '--verify', '-q', `${candidate}^{commit}`])).ok) return candidate
  }
  return undefined
}

/** What the session that did the work says it did: a fork over this conversation (no tools, served from cache). */
async function workReport($: EngineInterface): Promise<WorkReport | undefined> {
  try {
    const reply = await $.model.fork({ prompt: REPORT_PROMPT })
    return reply.isAnswered ? parseReport(reply.text) : undefined
  } catch {
    return undefined
  }
}

async function finishIssue($: EngineInterface, rt: Runtime, signal: 'click' | 'autopilot'): Promise<string> {
  const active = await read($, activeAtom)
  if (active === null) return 'No issue in progress: start one from /issues.'
  if (active.phase === 'done') return `${active.issue.ref} already has a draft PR: ${active.prUrl ?? ''}`
  if (rt.isFinishing || active.phase === 'testing' || active.phase === 'shipping') return `${active.issue.ref} is already finishing.`
  if (active.phase === 'ready' && signal === 'click') return shipIssue($, rt)
  rt.isFinishing = true
  try {
    const root = await repoRoot($)
    if (root === undefined) {
      await changeActive($, () => ({ phase: 'failed', error: 'not inside a git repository.' }))
      return 'Not inside a git repository.'
    }
    await changeActive($, () => ({ phase: 'testing', signal, error: null }), signal === 'autopilot' ? 'autopilot reported it done' : 'finish pressed')
    const tests = await runTests($, rt, root)
    const base = await baseRef($, rt, root)
    const mergeBase = base === undefined ? undefined : await gitRun($, root, ['merge-base', base, 'HEAD'])
    const from = mergeBase?.ok === true ? mergeBase.out.trim() : 'HEAD'
    const [stat, commits, report] = await Promise.all([
      gitRun($, root, ['diff', '--stat=100', from]),
      from === 'HEAD' ? Promise.resolve(undefined) : gitRun($, root, ['log', '--reverse', '--no-merges', '--format=- %s', `${from}..HEAD`]),
      workReport($),
    ])
    const prBody = redact(prBodyOf({ issue: active.issue, report, stat: stat.ok ? stat.out : '', commits: commits?.ok === true ? commits.out : '', tests }))
    const isGreen = tests.outcome === 'passed' || tests.outcome === 'skipped'
    await changeActive($, () => ({
      phase: 'ready',
      tests,
      prTitle: redact(prTitleOf(active.issue)),
      prBody,
      commitMessage: redact(commitMessageOf(active.issue, active.branch)),
      error: isGreen ? null : `tests: ${tests.summary}`,
    }), `tests: ${tests.summary}`)
    // autoPR never ships while the automatic work is stopped or paused through mods-hub (a STOP from the phone).
    const held = signal === 'autopilot' && rt.settings.autoPR ? await controlSince($, active.startedAt) : undefined
    if (isGreen && (signal === 'click' || (rt.settings.autoPR && held === undefined))) {
      rt.isFinishing = false
      return shipIssue($, rt)
    }
    const why = held !== undefined ? `autoPR held: ${held}; press Open draft PR to commit, push and open it` : isGreen ? 'press Open draft PR to commit, push and open it' : 'the tests did not pass: fix them, or press Open draft PR anyway'
    await hubNotify($, { level: isGreen ? 'success' : 'warning', title: isGreen ? `${active.issue.ref} is ready for a draft PR` : `${active.issue.ref}: the tests did not pass`, body: why, url: active.issue.url })
    return `${active.issue.ref}: ${tests.summary}; ${why}.`
  } finally {
    rt.isFinishing = false
  }
}

/** The hub's stop or pause in force, raised since `since` (no resume after it), in words; undefined otherwise or without the hub. */
async function controlSince($: EngineInterface, since: number): Promise<string | undefined> {
  try {
    const { value: control } = await $.state.get({ plugin: 'mods-hub', key: 'control' })
    if (control === null || control === undefined || control.at < since || control.action === 'resume') return undefined
    return `${control.action === 'stop' ? 'stopped' : 'paused'} by ${control.by || control.source}`
  } catch {
    return undefined
  }
}

async function failShip($: EngineInterface, active: IssuePilotActive, error: string): Promise<string> {
  await changeActive($, () => ({ phase: 'failed', error }), error)
  await hubNotify($, { level: 'error', title: `${active.issue.ref}: the draft PR did not open`, body: error, url: active.issue.url })
  return `${active.issue.ref}: ${error}`
}

/** Commit what is left, push the branch, open the draft PR, link it, move the issue, comment, notify. */
async function shipIssue($: EngineInterface, rt: Runtime): Promise<string> {
  const active = await read($, activeAtom)
  if (active === null) return 'No issue in progress.'
  if (active.prTitle === '' || (active.phase !== 'ready' && active.phase !== 'failed')) return `${active.issue.ref} is not ready: press Finish first.`
  const root = await repoRoot($)
  if (root === undefined) return failShip($, active, 'not inside a git repository.')
  if (!(await remoteIsGitHub($, root))) return failShip($, active, 'the origin remote is not on GitHub: push the branch and open the PR yourself.')
  await changeActive($, () => ({ phase: 'shipping', error: null }))

  const dirty = await gitRun($, root, ['status', '--porcelain'])
  if (dirty.ok && dirty.out.trim() !== '') {
    const staged = await gitRun($, root, ['add', '-A', '--', '.', ...NEVER_STAGE])
    const committed = staged.ok ? await gitRun($, root, ['commit', '-F', '-'], active.commitMessage) : staged
    if (!committed.ok) return failShip($, active, `could not commit: ${firstLine(committed.err) || firstLine(committed.out) || 'git failed'}`)
    const sha = (await gitRun($, root, ['rev-parse', '--short', 'HEAD'])).out.trim()
    const files = (await gitRun($, root, ['show', '--name-only', '--format=', 'HEAD'])).out.trim().split('\n').filter(line => line !== '').length
    await hubPublish($, { topic: 'git.commit', data: { sha, message: active.commitMessage, branch: active.branch, files } })
    await changeActive($, () => ({}), `committed ${sha}`)
  }
  const base = await baseRef($, rt, root)
  if (base !== undefined) {
    const ahead = await gitRun($, root, ['rev-list', '--count', `${base}..HEAD`])
    if (ahead.ok && Number(ahead.out.trim()) === 0) return failShip($, active, `no commits ahead of ${base}: nothing to open a PR for.`)
  }
  const pushed = await exec($, ['git', 'push', '-u', 'origin', active.branch], root, PUSH_TIMEOUT_MS)
  if (!pushed.ok) return failShip($, active, `could not push: ${firstLine(pushed.err) || 'git push failed'}`)
  await hubPublish($, { topic: 'git.push', data: { remote: 'origin', branch: active.branch, isForce: false } })

  const created = await ghRun($, root, [
    'pr', 'create', '--draft', '--title', active.prTitle, '--body-file', '-', '--head', active.branch,
    ...(rt.settings.baseBranch === '' ? [] : ['--base', rt.settings.baseBranch]),
  ], active.prBody)
  const prUrl = created.ok ? prUrlIn(created.out) : undefined
  if (prUrl === undefined) return failShip($, active, `gh pr create failed: ${ghProblem(created)}`)
  await hubPublish($, { topic: 'pr.opened', data: { url: prUrl, title: active.prTitle, branch: active.branch } })

  const steps = await trackerFinish($, rt, active.issue, prUrl, active.prTitle)
  if (rt.settings.finishComment) steps.push(await postComment($, rt, active.issue, root, finishCommentOf(prUrl, parseReport(`SUMMARY:\n${summaryOf(active.prBody)}\nRISKS:\n-`), active.tests)))
  await changeActive($, () => ({ phase: 'done', prUrl }), ['draft PR opened', ...steps].join(' · '))
  await hubPublish($, { topic: 'task.finished', data: { id: active.taskId, title: `${active.issue.ref} ${active.issue.title}`, outcome: 'ok' } })
  await hubNotify($, { level: 'success', title: `Draft PR for ${active.issue.ref}`, body: active.prTitle, url: prUrl })
  return `Opened the draft PR for ${active.issue.ref}: ${prUrl}`
}

/** The Summary section of a PR body, for the issue comment. */
const summaryOf = (body: string): string => /## Summary\n([\s\S]*?)\n\n## /.exec(body)?.[1]?.trim() ?? ''

async function stopIssue($: EngineInterface, rt: Runtime): Promise<string> {
  const active = await read($, activeAtom)
  if (active === null) return 'No issue in progress.'
  stopPoller(rt)
  await saveActive($, null)
  if (active.phase !== 'done') await hubPublish($, { topic: 'task.finished', data: { id: active.taskId, title: `${active.issue.ref} ${active.issue.title}`, outcome: 'cancelled' } })
  return `Stopped tracking ${active.issue.ref} (the branch ${active.branch} is kept).`
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────────

/** Opens the Issues tab in the Claude Mods panel, or this mod's own pane when the hub is not installed. */
async function showIssues($: EngineInterface): Promise<void> {
  if (!(await hubShowTab($, TAB))) await $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS }).catch(() => undefined)
}

const matchesRef = (issue: IssuePilotIssue, wanted: string): boolean => {
  const clean = wanted.trim().replace(/^#/, '').toLowerCase()
  return clean !== '' && (issue.number === clean || issue.ref.toLowerCase() === clean || issue.ref.toLowerCase() === `#${clean}` || issue.id === wanted.trim())
}

async function issuesCommand($: EngineInterface, rt: Runtime, args: string): Promise<string> {
  await restoreActive($, rt)
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const word = verb.toLowerCase()
  if (word === 'finish') return finishIssue($, rt, 'click')
  if (word === 'pr') return shipIssue($, rt)
  if (word === 'stop') return stopIssue($, rt)
  if (word === 'help') return USAGE
  await showIssues($)
  if (word === 'github' || word === 'jira' || word === 'linear') {
    await loadIssues($, rt, word)
  } else if (word === '' || word === 'refresh' || word === 'start') {
    if (word !== '' || (await read($, listAtom)).status !== 'ready') await loadIssues($, rt)
  } else {
    return USAGE
  }
  const list = await read($, listAtom)
  if (word === 'start') {
    const wanted = rest.join(' ')
    const issue = list.items.find(one => matchesRef(one, wanted))
    return issue === undefined ? `No open issue ${wanted} in the list.` : startIssue($, rt, issue.id)
  }
  if (list.status === 'error') return `${list.error ?? 'Could not load the issues.'}`
  return `${list.items.length} open issue${list.items.length === 1 ? '' : 's'} from ${list.provider === null ? '—' : PROVIDER_LABEL[list.provider]}.`
}

/** Runs a press's action and puts its outcome in the note line. */
async function pressed($: EngineInterface, action: Promise<string | void>): Promise<void> {
  try {
    const outcome = await action
    if (typeof outcome === 'string') await update($, noteAtom, () => outcome)
  } catch (error) {
    await update($, noteAtom, () => errorText(error))
  }
}

// ── Drawing (the Issues tab and the own pane share it) ──────────────────────────────────────────────

async function copyText($: EngineInterface, text: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? 'Copied' : `Could not copy (${copied.reason})`)
}

async function drawActive($: EngineInterface, rt: Runtime, e: PaneInput, active: IssuePilotActive): Promise<RenderElement> {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const { issue, phase } = active
  const canFinish = phase === 'working' || (phase === 'failed' && active.prTitle === '')
  const canShip = phase === 'ready' || (phase === 'failed' && active.prTitle !== '')
  return (
    <Box key="active" flexDirection="column" borderStyle="round" borderColor={phase === 'failed' ? 'error' : 'promptBorder'} paddingX={1}>
      <Box gap={1}>
        <Text bold>{issue.ref}</Text>
        <Text wrap="truncate-end">{issue.title}</Text>
      </Box>
      <Box key="phase"><Text dimColor>{`${active.branch} · ${PHASE_LABEL[phase]}`}</Text></Box>
      {active.tests !== null && <Box key="tests"><Text color={active.tests.outcome === 'failed' || active.tests.outcome === 'error' ? 'error' : undefined}>{`Tests: ${active.tests.summary}`}</Text></Box>}
      {phase === 'ready' && <Box key="pr-title"><Text>{`PR: ${active.prTitle}`}</Text></Box>}
      {active.error !== null && <Box key="error"><Text color="error">{active.error}</Text></Box>}
      {active.prUrl !== null && <Link href={active.prUrl} />}
      {active.ci !== null && <Box key="ci"><Text dimColor>{active.ci}</Text></Box>}
      {active.log.slice(-SHOWN_LOG).map((line, at) => <Box key={`log-${at}`}><Text dimColor>{`· ${line}`}</Text></Box>)}
      <Box gap={1} flexWrap="wrap">
        {canFinish && <Button key="finish" label="Finish" hotkey="f" variant="primary" onPress={() => void pressed($, finishIssue($, rt, 'click'))} />}
        {canShip && <Button key="ship" label={active.error === null ? 'Open draft PR' : 'Open draft PR anyway'} hotkey="o" variant="primary" onPress={() => void pressed($, shipIssue($, rt))} />}
        {phase === 'failed' && active.prTitle !== '' && <Button key="retest" label="Run tests again" onPress={() => void pressed($, changeActive($, () => ({ phase: 'working' })).then(() => finishIssue($, rt, 'click')))} />}
        {active.prUrl !== null && <Button key="copy-pr" label="Copy PR link" hotkey="c" onPress={press => void copyText($, active.prUrl ?? '', press.surface)} />}
        {phase !== 'testing' && phase !== 'shipping' && <Button key="stop" label={phase === 'done' ? 'Clear' : 'Stop'} onPress={() => void pressed($, stopIssue($, rt))} />}
      </Box>
    </Box>
  )
}

function drawIssue($: EngineInterface, rt: Runtime, e: PaneInput, issue: IssuePilotIssue, isOpen: boolean, canStart: boolean): RenderElement {
  const { Box, Text, Button } = $.ui.resolve(e)
  const { tier, size, minutes, usd, model, reason } = issue.estimate
  const criteria = isOpen ? acceptanceCriteria(issue.body) : []
  return (
    <Box key={`row-${issue.id}`} flexDirection="column">
      <Box gap={1}>
        <Button key={`pick-${issue.id}`} label={`${issue.ref} ${issue.title}`} plain onPress={() => void update($, selectedAtom, current => (current === issue.id ? null : issue.id))} />
      </Box>
      <Box gap={1} paddingLeft={2}>
        <Box key={`size-${issue.id}`}><Text color={TIER_COLOR[tier]}>{`${tier} · ${size}`}</Text></Box>
        <Text dimColor wrap="truncate-end">{`${formatMinutes(minutes)} · ~${formatUsd(usd)} on ${model}${issue.labels.length > 0 ? ` · ${issue.labels.join(', ')}` : ''}`}</Text>
        {canStart && <Button key={`start-${issue.id}`} label="Start" onPress={() => void pressed($, startIssue($, rt, issue.id))} />}
      </Box>
      {isOpen && (
        <Box key={`detail-${issue.id}`} flexDirection="column" paddingLeft={2}>
          <Text dimColor>{`Why ${tier}: ${reason}${issue.milestone === null ? '' : ` · milestone ${issue.milestone}`} · ${issue.state}`}</Text>
          {criteria.length === 0 ? <Text dimColor>No acceptance criteria listed.</Text> : criteria.slice(0, 8).map((one, at) => <Box key={`crit-${issue.id}-${at}`}><Text>{`${one.isDone ? '☑' : '☐'} ${one.text}`}</Text></Box>)}
        </Box>
      )}
    </Box>
  )
}

async function drawBody($: EngineInterface, rt: Runtime, e: PaneInput): Promise<RenderElement> {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const list = await read($, listAtom)
  const filters = await read($, filtersAtom)
  const active = await read($, activeAtom)
  const selected = await read($, selectedAtom)
  const note = await read($, noteAtom)
  const canStart = !isBusy(active)
  const setFilters = (change: Partial<IssuePilotFilters>) => void update($, filtersAtom, current => ({ ...current, ...change })).then(() => loadIssues($, rt))
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} flexWrap="wrap">
        {list.available.map(provider => (
          <Button key={`provider-${provider}`} label={PROVIDER_LABEL[provider]} variant={provider === list.provider ? 'primary' : undefined} onPress={() => void loadIssues($, rt, provider)} />
        ))}
        <Button key="mine" label={filters.isMine ? 'Assigned to me' : 'Everyone'} hotkey="m" onPress={() => setFilters({ isMine: !filters.isMine })} />
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void loadIssues($, rt)} />
        {(filters.label !== '' || filters.milestone !== '') && <Button key="clear-filters" label="Clear filters" onPress={() => setFilters({ label: '', milestone: '' })} />}
      </Box>
      {Input !== undefined && (
        <Box gap={1} flexWrap="wrap">
          <Input key="label" label="Label " value={filters.label} placeholder="any" submitLabel="filter" onSubmit={value => setFilters({ label: value.trim() })} />
          <Input key="milestone" label="Milestone " value={filters.milestone} placeholder="any" submitLabel="filter" onSubmit={value => setFilters({ milestone: value.trim() })} />
        </Box>
      )}
      {Input === undefined && (filters.label !== '' || filters.milestone !== '') && <Text dimColor>{`label: ${filters.label || 'any'} · milestone: ${filters.milestone || 'any'}`}</Text>}
      {note !== '' && <Box key="note"><Text color="suggestion">{note}</Text></Box>}
      {active !== null && (await drawActive($, rt, e, active))}
      {list.status === 'idle' && <Text dimColor>Press Refresh (or run /issues) to list your open issues.</Text>}
      {list.status === 'loading' && <Box key="loading"><Text color="suggestion">{`Loading issues${list.provider === null ? '' : ` from ${PROVIDER_LABEL[list.provider]}`}…`}</Text></Box>}
      {list.status === 'error' && <Box key="list-error"><Text color="error">{list.error ?? 'Could not load the issues.'}</Text></Box>}
      {list.status === 'ready' && list.items.length === 0 && <Text dimColor>No open issues match.</Text>}
      {list.status === 'ready' && list.items.length > 0 && (
        <Box key="list" flexDirection="column">
          <Text dimColor>{`${list.items.length} open · ${list.provider === null ? '' : PROVIDER_LABEL[list.provider]} · sized like smart-router`}</Text>
          {list.items.map(issue => drawIssue($, rt, e, issue, selected === issue.id, canStart))}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const rt: Runtime = { settings: settingsOf(options), poller: undefined, isRestored: false, isFinishing: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issues',
      description: 'List your open GitHub, Jira or Linear issues, sized; start one on its own branch, finish it as a draft PR',
      argumentHint: '[refresh | start <#n|KEY> | finish | pr | stop | github | jira | linear]',
    })
    await update($, filtersAtom, () => ({ ...rt.settings.filters }))
    await hubHello(
      $,
      { version: VERSION, publishes: ['task.started', 'task.finished', 'test.result', 'git.commit', 'git.push', 'pr.opened'], consumes: ['task.finished', 'ci.result'] },
      { id: TAB, title: PANE_TITLE, order: TAB_ORDER, command: 'issues' },
    )
    return next(e)
  })

  on('command.run', { command: 'issues' }, async ($, e) => ({ text: await issuesCommand($, rt, e.args) }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) $.clock.after(0, () => void checkSignals($, rt))
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawBody($, rt, e))

  on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawBody($, rt, e)}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
