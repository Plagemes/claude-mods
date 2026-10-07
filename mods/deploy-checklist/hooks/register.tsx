import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeployChecklistItem as Item, DeployChecklistPending as Pending } from '../types'
import {
  CHANGELOG_NAMES,
  GLYPH,
  ago,
  branchList,
  changedPaths,
  checklistText,
  compileExtra,
  deployKind,
  isAllClear,
  isTestCommand,
  listShort,
  testsRunFirst,
} from './checks'
import { deployTargetOf, failureOf, urlIn } from './events'
import type { DeployTarget } from './events'

const PANE = 'deploy-checklist'
const GIT_TIMEOUT_MS = 5000
const APPROVAL_TTL_MS = 15 * 60_000
const LABEL_WIDTH = 14
const EDIT_TOOLS = /^(?:Edit|MultiEdit|Write|NotebookEdit)$/
const STATUS_COLOR: Record<Item['status'], string> = { pass: 'success', fail: 'error', warn: 'warning', skip: 'inactive' }

const pending = atom({ plugin: 'deploy-checklist', key: 'pending' } as const, null)
const isChecking = atom({ plugin: 'deploy-checklist', key: 'isChecking' } as const, false)

type Settings = { branches: string[]; extra: RegExp | undefined; confirmWhenPassing: boolean }

/** What this load has seen in the session: the latest test run and whether Claude edited the changelog. */
type Memory = { lastTest: { command: string; passed: boolean; at: number } | null; changelogEdited: boolean }

/** A test run as the checklist reads it: from this mod's own watch, or another mod's `test.result` on mods-hub. */
type TestRun = { command: string; passed: boolean; at: number; source?: string }

type Git = { ok: boolean; out: string }

async function git($: EngineInterface, args: readonly string[]): Promise<Git> {
  try {
    const run = await $.process.run(['git', ...args], { timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout.replace(/\s+$/, '') }
  } catch {
    return { ok: false, out: '' }
  }
}

function branchItem(settings: Settings, branch: Git, sync: Git): Item {
  const name = branch.out
  if (!branch.ok || name === '') return { id: 'branch', label: 'Branch', status: 'warn', detail: 'could not read the current branch' }
  if (name === 'HEAD') return { id: 'branch', label: 'Branch', status: 'fail', detail: 'detached HEAD: check out a release branch first' }
  if (!settings.branches.includes(name)) {
    return { id: 'branch', label: 'Branch', status: 'fail', detail: `on ${name}; deploys go out from ${settings.branches.join(' or ')}` }
  }
  const [behind = 0, ahead = 0] = sync.ok ? sync.out.split(/\s+/).map(Number) : []
  if (behind > 0) return { id: 'branch', label: 'Branch', status: 'warn', detail: `${name}, ${behind} commit${behind === 1 ? '' : 's'} behind its upstream: pull first` }
  const pushed = !sync.ok ? 'no upstream' : ahead > 0 ? `${ahead} commit${ahead === 1 ? '' : 's'} not pushed` : 'in sync with its upstream'
  return { id: 'branch', label: 'Branch', status: 'pass', detail: `${name} (${pushed})` }
}

function treeItem(paths: readonly string[]): Item {
  if (paths.length === 0) return { id: 'tree', label: 'Working tree', status: 'pass', detail: 'clean: everything is committed' }
  const count = `${paths.length} uncommitted change${paths.length === 1 ? '' : 's'}`
  return { id: 'tree', label: 'Working tree', status: 'fail', detail: `${count}: ${listShort(paths)}` }
}

function testsItem(command: string, settings: Settings, memory: Memory, now: number, reported?: TestRun): Item {
  if (testsRunFirst(command, settings.extra)) return { id: 'tests', label: 'Tests', status: 'pass', detail: 'this command runs them before deploying' }
  // The newest run wins: mods-hub's `test.result` also covers runs this hook never sees (test-watch's own).
  const last = reported !== undefined && (memory.lastTest === null || reported.at >= memory.lastTest.at) ? reported : memory.lastTest
  if (last === null) return { id: 'tests', label: 'Tests', status: 'warn', detail: 'no test run seen in this session' }
  const when = ago(now - last.at)
  const by = 'source' in last && last.source !== undefined && last.source !== 'mods-hub' ? ` (${last.source})` : ''
  return last.passed
    ? { id: 'tests', label: 'Tests', status: 'pass', detail: `${last.command} passed ${when}${by}` }
    : { id: 'tests', label: 'Tests', status: 'fail', detail: `${last.command} failed ${when}${by}` }
}

// ── mods-hub: test and CI results instead of guessing, deploys on the bus ───────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['deploy.started', 'deploy.finished', 'deploy.failed'], consumes: ['test.result', 'ci.result'] })
}

/** The latest test run any mod reported on mods-hub (`test.result`); undefined without the hub or a run. */
async function reportedTest($: EngineInterface): Promise<TestRun | undefined> {
  try {
    const event = await $.mods.latest({ topic: 'test.result' })
    const data = event?.data as { outcome?: unknown; command?: unknown; runner?: unknown } | undefined
    if (event === null || data === undefined || (data.outcome !== 'passed' && data.outcome !== 'failed' && data.outcome !== 'error')) return undefined
    const command = typeof data.command === 'string' && data.command !== '' ? data.command : String(data.runner ?? 'tests')
    return { command: command.trim().slice(0, 80), passed: data.outcome === 'passed', at: event.at, source: event.source }
  } catch {
    return undefined
  }
}

/** The latest CI run of `branch` on mods-hub (`ci.result`, from ci-watch), as a checklist line; none without the hub or a run. */
async function ciItem($: EngineInterface, branch: string, now: number): Promise<Item | undefined> {
  try {
    const runs = await $.mods.recent({ topic: 'ci.result', limit: 20 })
    const run = runs.filter(event => {
      const ran = (event.data as { branch?: unknown }).branch
      return ran === undefined || ran === branch
    }).at(-1)
    if (run === undefined) return undefined
    const { workflow, outcome, url } = run.data as { workflow?: unknown; outcome?: unknown; url?: unknown }
    const what = `${String(workflow ?? 'CI')} ${String(outcome)} on ${branch} ${ago(now - run.at)}${typeof url === 'string' ? ` (${url})` : ''}`
    const status = outcome === 'passed' ? 'pass' : outcome === 'failed' ? 'fail' : 'warn'
    return { id: 'ci', label: 'CI', status, detail: what }
  } catch {
    return undefined
  }
}

/**
 * Runs a deploy the checklist let through, on the hub's bus for every session (team-hub, guardian): `deploy.started`,
 * then `deploy.finished` (with the link it printed) or `deploy.failed` (with why). Only with the hub.
 */
async function publishStart($: EngineInterface, target: DeployTarget): Promise<void> {
  await hubPublish($, { topic: 'deploy.started', data: { ...target }, scope: 'global' })
}

async function publishEnd($: EngineInterface, target: DeployTarget, output: string, hasFailed: boolean, durationMs: number): Promise<void> {
  const url = urlIn(output)
  if (hasFailed) {
    await hubPublish($, { topic: 'deploy.failed', data: { ...target, reason: failureOf(output), ...(url === undefined ? {} : { url }) }, scope: 'global' })
    await hubNotify($, { level: 'error', title: `Deploy failed: ${target.target} (${target.environment})`, body: failureOf(output), topic: 'deploy.failed', ...(url === undefined ? {} : { url }) })
  } else {
    await hubPublish($, { topic: 'deploy.finished', data: { ...target, durationMs, ...(url === undefined ? {} : { url }) }, scope: 'global' })
  }
}

/** What Bash printed, stdout and stderr. */
function outputOf(ran: { result?: unknown; text?: string }): string {
  const result = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
  if (result !== undefined && result !== null && typeof result === 'object' && typeof result.stdout === 'string') {
    return `${result.stdout}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
  }
  return typeof ran.text === 'string' ? ran.text : typeof ran.result === 'string' ? ran.result : ''
}

/** Whether the changelog changed since the last tag (or the upstream), in the working tree or in this session. */
async function changelogItem($: EngineInterface, root: string, paths: readonly string[], memory: Memory): Promise<Item> {
  let name: string | undefined
  for (const candidate of CHANGELOG_NAMES) {
    if (await $.fs.exists(`${root}/${candidate}`).catch(() => false)) {
      name = candidate
      break
    }
  }
  if (name === undefined) return { id: 'changelog', label: 'Changelog', status: 'skip', detail: 'no CHANGELOG in this repository' }
  if (memory.changelogEdited || paths.includes(name)) return { id: 'changelog', label: 'Changelog', status: 'pass', detail: `${name} has new, uncommitted entries` }

  const tag = await git($, ['describe', '--tags', '--abbrev=0'])
  const base = tag.ok && tag.out !== '' ? tag.out : (await git($, ['rev-parse', '--verify', '-q', '@{upstream}'])).ok ? '@{upstream}' : undefined
  if (base === undefined) return { id: 'changelog', label: 'Changelog', status: 'warn', detail: `${name}: no tag or upstream to compare with` }
  const changed = await git($, ['diff', '--name-only', base, 'HEAD', '--', `:/${name}`])
  const since = base === '@{upstream}' ? 'the upstream' : base
  return changed.ok && changed.out !== ''
    ? { id: 'changelog', label: 'Changelog', status: 'pass', detail: `${name} updated since ${since}` }
    : { id: 'changelog', label: 'Changelog', status: 'warn', detail: `${name} not updated since ${since}` }
}

async function gatherChecklist($: EngineInterface, command: string, settings: Settings, memory: Memory): Promise<Item[]> {
  const now = await $.clock.now()
  const top = await git($, ['rev-parse', '--show-toplevel'])
  const reported = await reportedTest($)
  if (!top.ok) {
    return [
      { id: 'branch', label: 'Branch', status: 'skip', detail: 'not a git repository' },
      { id: 'tree', label: 'Working tree', status: 'skip', detail: 'not a git repository' },
      testsItem(command, settings, memory, now, reported),
      { id: 'changelog', label: 'Changelog', status: 'skip', detail: 'not a git repository' },
    ]
  }
  const [branch, status, sync] = await Promise.all([
    git($, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, ['status', '--porcelain']),
    git($, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
  ])
  const paths = changedPaths(status.out)
  const ci = branch.ok && branch.out !== '' && branch.out !== 'HEAD' ? await ciItem($, branch.out, now) : undefined
  return [
    branchItem(settings, branch, sync),
    treeItem(paths),
    testsItem(command, settings, memory, now, reported),
    ...(ci === undefined ? [] : [ci]),
    await changelogItem($, top.out, paths, memory),
  ]
}

/** Uses up the person's approval when it is for exactly this command and still fresh. */
async function takeApproval($: EngineInterface, command: string): Promise<boolean> {
  const current = await read($, pending)
  if (current?.status !== 'approved' || current.command !== command || current.approvedAt === null) return false
  const now = await $.clock.now()
  await update($, pending, () => null)
  return now - current.approvedAt <= APPROVAL_TTL_MS
}

async function openPane($: EngineInterface): Promise<void> {
  try {
    await $.ui.open({ id: PANE, title: 'Deploy checklist', focus: true })
  } catch (error) {
    $.ui.log(`deploy-checklist: could not open the pane: ${String(error)}`, { to: 'debug' })
  }
}

async function note($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {
    // The note is a courtesy: the deny the model already has stands on its own.
  }
}

async function approve($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const approved = await update($, pending, (current: Pending | null) =>
    current === null ? null : { ...current, status: 'approved' as const, approvedAt: now },
  )
  await $.ui.close({ id: PANE }).catch(() => undefined)
  if (approved === null) return
  $.ui.toast('Deploy approved: Claude will run it once')
  await $.prompt.submit({
    text: `The user reviewed the deploy checklist and approved the deploy. Run it again, exactly as before:\n\n${approved.command}`,
  })
}

async function cancel($: EngineInterface): Promise<void> {
  const current = await read($, pending)
  await update($, pending, () => null)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  if (current === null) return
  $.ui.toast('Deploy cancelled')
  await note($, `deploy-checklist: the user cancelled the deploy (${current.command}). Do not run it again unless they ask for it.`)
}

async function recheck($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  const current = await read($, pending)
  if (current === null) return
  await update($, isChecking, () => true)
  try {
    const items = await gatherChecklist($, current.command, settings, memory)
    const checkedAt = await $.clock.now()
    await update($, pending, (latest: Pending | null) => (latest?.command === current.command ? { ...latest, items, checkedAt } : latest))
  } finally {
    await update($, isChecking, () => false)
  }
}

/** Checks a deploy command; answers whether it may run now, with the reason it may not. */
async function gate($: EngineInterface, command: string, settings: Settings, memory: Memory): Promise<string | undefined> {
  const kind = deployKind(command, settings.extra)
  if (kind === undefined || (await takeApproval($, command))) return undefined

  const items = await gatherChecklist($, command, settings, memory)
  if (!settings.confirmWhenPassing && isAllClear(items)) {
    $.ui.toast('✓ Deploy checklist passed')
    return undefined
  }
  const checkedAt = await $.clock.now()
  await update($, pending, () => ({ command, kind, items, checkedAt, status: 'waiting' as const, approvedAt: null }))
  $.clock.after(0, () => void openPane($))
  return (
    `deploy-checklist: this ${kind} waits for the user's confirmation.\n${checklistText(items)}\n` +
    'The user reviews the checklist in the Deploy checklist pane (/deploy-checklist). Do not run the command again ' +
    'until they approve it: you will be told. Meanwhile you may fix what the checklist flags if they ask you to.'
  )
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    branches: branchList(options.branches),
    extra: compileExtra(options.extraPattern),
    confirmWhenPassing: options.confirmWhenPassing !== false,
  }
  const memory: Memory = { lastTest: null, changelogEdited: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'deploy-checklist', description: 'Review the deploy waiting for your approval, or check readiness now' })
    await greetHub($)
    return next(e)
  })

  on('command.run', { command: 'deploy-checklist' }, async $ => {
    const current = await read($, pending)
    if (current !== null) {
      await openPane($)
      return { text: `Deploy checklist opened for: ${current.command}` }
    }
    const items = await gatherChecklist($, '', settings, memory)
    const verdict = isAllClear(items) ? 'Ready to deploy.' : 'Not ready yet:'
    return { text: `No deploy is waiting. ${verdict}\n${checklistText(items)}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const reason = await gate($, e.command.trim(), settings, memory)
    return reason === undefined ? next(e) : { deny: reason }
  }).catch(($, e, next) => {
    if (next.called || deployKind(e.command, settings.extra) === undefined) return next(e)
    return { deny: 'deploy-checklist: the checklist could not be run, so the deploy was blocked. Ask the user to deploy it themselves.' }
  })

  // Beneath the gate: remembers the last test run and changelog edits for the checklist, and reports the deploys it let through.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const deploying = tool === 'Bash' && 'command' in e && typeof e.command === 'string' ? deployTargetOf(e.command, settings.extra) : undefined
    const isReported = deploying !== undefined && (await hubMode($)) !== undefined
    const startedAt = isReported ? await $.clock.now() : 0
    if (isReported && deploying !== undefined) await publishStart($, deploying)
    const ran = await next(e)
    const isDone = ran.deny === undefined
    if (isReported && deploying !== undefined && isDone) {
      const output = outputOf(ran)
      const hasFailed = ran.isError === true
      const durationMs = (await $.clock.now()) - startedAt
      $.clock.after(0, () => void publishEnd($, deploying, output, hasFailed, durationMs))
    }
    if (isDone && tool === 'Bash' && 'command' in e && typeof e.command === 'string' && isTestCommand(e.command)) {
      memory.lastTest = { command: e.command.trim().slice(0, 80), passed: ran.isError !== true, at: await $.clock.now() }
    }
    if (isDone && ran.isError !== true && EDIT_TOOLS.test(tool) && 'file_path' in e && typeof e.file_path === 'string') {
      const base = e.file_path.split(/[\\/]/).pop() ?? ''
      if (CHANGELOG_NAMES.includes(base)) memory.changelogEdited = true
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const current = await read($, pending)
    const checking = await read($, isChecking)
    if (current === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No deploy is waiting for you.</Text>
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      )
    }
    const isClear = isAllClear(current.items)
    const hasFailure = current.items.some(item => item.status === 'fail')
    const isNarrow = e.props.bodyColumns < 48
    const headline = isClear ? '✓ Ready to deploy' : hasFailure ? '✗ Not ready to deploy' : '! Check before deploying'

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="head" flexDirection="column">
          <Text bold color={isClear ? 'success' : hasFailure ? 'error' : 'warning'}>
            {headline}
          </Text>
          <Text dimColor>Claude wants to run a {current.kind}. It runs only once you approve.</Text>
        </Box>
        <Code language="bash" source={current.command} />
        <Box flexDirection="column">
          {current.items.map(item => (
            <Box key={`item:${item.id}`} flexDirection={isNarrow ? 'column' : 'row'} columnGap={1}>
              <Box flexDirection="row" gap={1} flexShrink={0} width={isNarrow ? undefined : LABEL_WIDTH + 2}>
                <Text color={STATUS_COLOR[item.status]} bold>
                  {GLYPH[item.status]}
                </Text>
                <Text bold>{item.label}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} paddingLeft={isNarrow ? 2 : 0}>
                <Text dimColor={item.status === 'skip'}>{item.detail}</Text>
              </Box>
            </Box>
          ))}
        </Box>
        {current.status === 'approved' ? (
          <Box key="approved">
            <Text color="success">Approved: Claude runs it once.</Text>
          </Box>
        ) : (
          <Box key="actions" flexDirection="row" gap={2} flexWrap="wrap">
            <Button
              key="deploy"
              label={isClear ? 'Deploy' : 'Deploy anyway'}
              hotkey="d"
              variant="primary"
              autoFocus
              onPress={() => void approve($)}
            />
            <Button key="cancel" label="Cancel" hotkey="c" role="dismiss" onPress={() => void cancel($)} />
            <Button
              key="recheck"
              label={checking ? 'Checking…' : 'Re-check'}
              hotkey="r"
              plain
              dimColor
              onPress={() => void recheck($, settings, memory)}
            />
          </Box>
        )}
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
