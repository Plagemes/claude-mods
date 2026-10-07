import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ToolError } from '../types'

const PANE = 'error-feed'
const COMMAND = 'errors'
const ERROR_CHARS = 300
const SUMMARY_CHARS = 160
const SHOWN_ERROR_LINES = 4
const DEFAULT_MAX_ERRORS = 50
/** The shell's own first line of a failed Bash call; the header already says `exit N`. */
const EXIT_LINE = /^exit code:? \d+$/i

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
    const opened = await $.ui.open({ id: PANE, title: 'Errors' })
    const summary = count === 0 ? 'No errors so far' : `${count} error${count === 1 ? '' : 's'} collected`
    return {
      text: opened.isPlaced ? `${summary}.` : `${summary}; the pane waits for room (${opened.reason}).`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, errors)
    const width = Math.max(24, e.props.bodyColumns)
    const sent = list.filter(one => one.isSent === true).length

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
          <Button key="close" role="dismiss" hotkey="x" onPress={() => void $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
      </Box>
    )
  })
}
