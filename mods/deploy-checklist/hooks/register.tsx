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

function testsItem(command: string, settings: Settings, memory: Memory, now: number): Item {
  if (testsRunFirst(command, settings.extra)) return { id: 'tests', label: 'Tests', status: 'pass', detail: 'this command runs them before deploying' }
  const last = memory.lastTest
  if (last === null) return { id: 'tests', label: 'Tests', status: 'warn', detail: 'no test run seen in this session' }
  const when = ago(now - last.at)
  return last.passed
    ? { id: 'tests', label: 'Tests', status: 'pass', detail: `${last.command} passed ${when}` }
    : { id: 'tests', label: 'Tests', status: 'fail', detail: `${last.command} failed ${when}` }
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
  if (!top.ok) {
    return [
      { id: 'branch', label: 'Branch', status: 'skip', detail: 'not a git repository' },
      { id: 'tree', label: 'Working tree', status: 'skip', detail: 'not a git repository' },
      testsItem(command, settings, memory, now),
      { id: 'changelog', label: 'Changelog', status: 'skip', detail: 'not a git repository' },
    ]
  }
  const [branch, status, sync] = await Promise.all([
    git($, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, ['status', '--porcelain']),
    git($, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
  ])
  const paths = changedPaths(status.out)
  return [
    branchItem(settings, branch, sync),
    treeItem(paths),
    testsItem(command, settings, memory, now),
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

  // Beneath the gate: remembers the last test run and changelog edits for the checklist.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const isDone = ran.deny === undefined
    const tool = String(e.tool)
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
