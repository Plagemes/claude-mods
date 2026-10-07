import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { ToolError } from '../types'

const PANE = 'error-feed'
const COMMAND = 'errors'
const ERROR_CHARS = 300
const SUMMARY_CHARS = 160
const SHOWN_ERROR_LINES = 4
const DEFAULT_MAX_ERRORS = 50
/** The shell's own first line of a failed Bash call; the header already says `exit N`. */
const EXIT_LINE = /^exit code:? \d+$/i
/** The hub's shared panel, and this mod's Errors tab in it. */
const HUB_PANE = 'claude-mods'
const TAB = { id: 'errors', title: 'Errors', order: 210, command: COMMAND } as const

const errors = atom({ plugin: 'error-feed', key: 'errors' } as const, [])

/** Input fields that best describe a call, most telling first. */
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'path', 'description', 'skill']

/** Results flagged as errors that are not failures: the person said no, or stopped the call. */
const NOT_A_FAILURE = [
  /doesn't want to proceed/i,
  /interrupted by user/i,
  /user rejected/i,
  /user denied/i,
  /permission to use .* (has been|was) denied/i,
]

const settings = { maxErrors: DEFAULT_MAX_ERRORS, showStatus: true, includeSubagents: true }
/** The status line last set; null until the first set, so a reload always writes it once. */
let shownStatus: string | undefined | null = null

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const summarize = (input: Readonly<Record<string, unknown>>): string => {
  const known = SUMMARY_FIELDS.map(name => input[name]).find(value => typeof value === 'string' && value !== '')
  const any = Object.entries(input).find(
    ([name, value]) => name !== 'tool' && name !== 'tool_use_id' && typeof value === 'string' && value !== '',
  )?.[1]
  const picked = typeof known === 'string' ? known : typeof any === 'string' ? any : ''
  return oneLine(picked).slice(0, SUMMARY_CHARS)
}

const rawErrorText = (text: string | undefined, result: unknown): string => {
  if (text !== undefined && text !== '') return text
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result) ?? ''
  } catch {
    return String(result)
  }
}

const errorText = (text: string | undefined, result: unknown): string =>
  rawErrorText(text, result).replace(/<\/?tool_use_error>/g, '')

const exitCodeOf = (text: string): number | undefined => {
  const match = /exit code:? (\d+)/i.exec(text)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

const clockTime = (ms: number): string => {
  const date = new Date(ms)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

const fit = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

const fixPrompt = (failure: ToolError): string =>
  [
    'Please fix this failed tool call from earlier in the session.',
    '',
    `Tool: ${failure.tool}`,
    failure.summary === '' ? undefined : `Call: ${failure.summary}`,
    failure.exitCode === undefined ? undefined : `Exit code: ${failure.exitCode}`,
    `Error (first ${ERROR_CHARS} characters):`,
    '```',
    failure.error,
    '```',
    '',
    failure.tool === 'Bash'
      ? 'Find the root cause, fix it, then re-run the command to confirm it passes.'
      : 'Find the root cause, fix it, then retry the call to confirm it works.',
  ]
    .filter(line => line !== undefined)
    .join('\n')

function showCount($: EngineInterface, list: readonly ToolError[]): void {
  if (!settings.showStatus) return
  const text = list.length === 0 ? undefined : `⚠ ${list.length} error${list.length === 1 ? '' : 's'} · /${COMMAND}`
  if (text !== shownStatus) {
    shownStatus = text
    $.ui.status(text)
  }
}

async function change($: EngineInterface, fn: (list: ToolError[]) => ToolError[]): Promise<ToolError[]> {
  const list = await update($, errors, fn)
  showCount($, list)
  return list
}

async function askToFix($: EngineInterface, id: string): Promise<void> {
  const failure = (await read($, errors)).find(one => one.id === id)
  if (failure === undefined) return
  await change($, list => list.map(one => (one.id === id ? { ...one, isSent: true } : one)))
  $.ui.toast(`Asked Claude to fix the ${failure.tool} error`)
  try {
    // Resolves once the prompt's turn starts: after the running turn, if one runs.
    await $.prompt.submit({ text: fixPrompt(failure), asUser: true })
  } catch (error) {
    await change($, list => list.map(one => (one.id === id ? { ...one, isSent: false } : one)))
    $.ui.toast(`Could not send the prompt (${String(error)})`)
  }
}

// ── mods-hub: failures on the bus, repeated errors, the Errors tab ───────────────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** With mods-hub installed: hello and the Errors tab in its panel. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['tool.failed'], consumes: ['error.repeated'] }, TAB)
}

/** A recorded failure on the hub's bus as `tool.failed`: the call and the error's first line. */
async function publishFailure($: EngineInterface, failure: ToolError): Promise<void> {
  const firstLine = failure.error.split('\n').map(line => line.trim()).find(line => line !== '' && !EXIT_LINE.test(line)) ?? failure.tool
  await hubPublish($, {
    topic: 'tool.failed',
    data: { tool: failure.tool, summary: firstLine.slice(0, SUMMARY_CHARS), ...(failure.tool === 'Bash' && failure.summary !== '' ? { command: failure.summary } : {}) },
  })
}

/** The command the hub last saw fail again and again (`error.repeated`), and how often; read while drawing, it redraws. */
async function repeatedNow($: EngineInterface): Promise<{ command: string; count: number } | undefined> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'latest', id: 'error.repeated' })
  const data = value?.data as { command?: unknown; signature?: unknown; count?: unknown } | undefined
  const command = typeof data?.command === 'string' ? data.command : typeof data?.signature === 'string' ? data.signature : ''
  return command === '' || typeof data?.count !== 'number' ? undefined : { command, count: data.count }
}

/** The feed: this mod's own pane, or its tab in the hub's panel (`isTab`, no Close button). */
async function drawErrors($: EngineInterface, e: RenderInput<'Pane'>, isTab: boolean): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const list = await read($, errors)
  const repeated = await repeatedNow($)
  const width = Math.max(24, e.props.bodyColumns)
  const sent = list.filter(one => one.isSent === true).length
  const isRepeat = (failure: ToolError): boolean => repeated !== undefined && failure.tool === 'Bash' && failure.summary.startsWith(oneLine(repeated.command).slice(0, SUMMARY_CHARS))
  const close = isTab ? null : (
    <Button key="close" role="dismiss" hotkey="x" onPress={() => void $.ui.close({ id: PANE })}>
      Close
    </Button>
  )

  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold>Errors</Text>
      <Text dimColor>
        {list.length} collected{sent > 0 ? ` · ${sent} sent to Claude` : ''}
      </Text>
    </Box>
  )

  if (list.length === 0) {
    return (
      <Box flexDirection="column">
        {header}
        <Text color="success">✓ No failed commands or tool errors so far.</Text>
      </Box>
    )
  }

  const items = list.map(failure => {
    const right = [
      failure.exitCode === undefined ? undefined : `exit ${failure.exitCode}`,
      failure.agentId === undefined ? undefined : 'subagent',
      isRepeat(failure) && repeated !== undefined ? `↻ ${repeated.count}× in a row` : undefined,
      clockTime(failure.at),
    ]
      .filter(part => part !== undefined)
      .join(' · ')
    const title = fit(failure.summary, width - failure.tool.length - right.length - 4)
    const lines = failure.error
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.trim() !== '' && !EXIT_LINE.test(line))
    const shown = lines.slice(0, SHOWN_ERROR_LINES).map(line => fit(`  ${line}`, width))
    const hidden = lines.length - shown.length
    return (
      <Box key={`error:${failure.id}`} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color="error">✗ </Text>
            <Text bold>{failure.tool}</Text>
            <Text> {title}</Text>
          </Text>
          <Text dimColor>{right}</Text>
        </Box>
        {shown.map(line => (
          <Text dimColor={failure.isSent === true} color={failure.isSent === true ? undefined : 'error'} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {hidden > 0 && <Text dimColor>{`  … ${hidden} more line${hidden === 1 ? '' : 's'}`}</Text>}
        <Box flexDirection="row" gap={1} paddingLeft={2}>
          <Button
            key={`fix:${failure.id}`}
            variant={failure.isSent === true ? 'secondary' : 'primary'}
            onPress={() => void askToFix($, failure.id)}
          >
            {failure.isSent === true ? 'Ask again' : 'Ask Claude to fix'}
          </Button>
          <Button
            key={`dismiss:${failure.id}`}
            dimColor
            onPress={() => void change($, all => all.filter(one => one.id !== failure.id))}
          >
            Dismiss
          </Button>
        </Box>
      </Box>
    )
  })

  return (
    <Box flexDirection="column">
      {header}
      <Box flexDirection="column" marginTop={1} gap={1}>
        {items}
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="clear" hotkey="c" onPress={() => void change($, () => [])}>
          Clear all
        </Button>
        {close}
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  settings.maxErrors =
    typeof options.maxErrors === 'number' && options.maxErrors >= 1 ? Math.floor(options.maxErrors) : DEFAULT_MAX_ERRORS
  settings.showStatus = options.showStatus !== false
  settings.includeSubagents = options.includeSubagents !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show every failed command and tool error of this session in a pane',
      argumentHint: '[clear|close]',
    })
    await greetHub($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError !== true || (e.agentId !== undefined && !settings.includeSubagents)) return ran
    try {
      const full = errorText(ran.text, ran.result)
      if (NOT_A_FAILURE.some(pattern => pattern.test(full))) return ran
      const failure: ToolError = {
        id: e.tool_use_id,
        tool: e.tool,
        summary: summarize(e as unknown as Readonly<Record<string, unknown>>),
        error: full.trim().slice(0, ERROR_CHARS),
        exitCode: e.tool === 'Bash' ? exitCodeOf(full) : undefined,
        at: await $.clock.now(),
        agentId: e.agentId,
      }
      await change($, list => [failure, ...list.filter(one => one.id !== failure.id)].slice(0, settings.maxErrors))
      await publishFailure($, failure)
    } catch (error) {
      $.ui.log(`error-feed: could not record a failed ${e.tool} call: ${String(error)}`, { to: 'debug' })
    }
    return ran
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'clear') {
      await change($, () => [])
      return { text: 'Cleared.' }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Pane closed.' }
    }
    const count = (await read($, errors)).length
    const summary = count === 0 ? 'No errors so far' : `${count} error${count === 1 ? '' : 's'} collected`
    if (await hubShowTab($, TAB.id)) return { text: `${summary}: the Errors tab of the Claude Mods panel.` }
    const opened = await $.ui.open({ id: PANE, title: 'Errors' })
    return {
      text: opened.isPlaced ? `${summary}.` : `${summary}; the pane waits for room (${opened.reason}).`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawErrors($, e, false))

  // The Errors tab: drawn beneath the hub's tab strip when it is the tab shown; any other tab passes through.
  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e, next) => {
    if (!(await hubTabIs($, TAB.id))) return next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        {await drawErrors($, e, true)}
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
