import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BashHistoryEntry, BashHistoryOutcome } from '../types'

const KEPT = 200
const DEFAULT_SHOWN = 30
const MAX_COMMAND_LENGTH = 110

const entries = atom({ plugin: 'bash-history', key: 'entries' } as const, [])

const clockTime = (ms: number): string => {
  const date = new Date(ms)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const duration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

const oneLine = (command: string): string => {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_COMMAND_LENGTH ? `${flat.slice(0, MAX_COMMAND_LENGTH)}...` : flat
}

const OUTCOME_LABEL: Record<BashHistoryOutcome, string> = { ok: 'ok', failed: 'FAILED', denied: 'denied' }

const row = (entry: BashHistoryEntry): string =>
  `${clockTime(entry.at)}  ${OUTCOME_LABEL[entry.outcome].padEnd(6)}  ${duration(entry.ms).padStart(6)}  ${oneLine(entry.command)}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bash-history',
      description: 'Lists the shell commands Claude ran recently, with exit status and duration.',
      argumentHint: '[count]',
    })
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    const ms = (await $.clock.now()) - startedAt
    const outcome: BashHistoryOutcome = ran.deny !== undefined ? 'denied' : ran.isError ? 'failed' : 'ok'

    await update($, entries, kept => [...kept, { at: startedAt, command: e.command, outcome, ms }].slice(-KEPT))
    return ran
  })

  on('command.run', { command: 'bash-history' }, async ($, e) => {
    const asked = Number.parseInt(e.args, 10)
    const count = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), KEPT) : DEFAULT_SHOWN
    const all = await read($, entries)
    if (all.length === 0) return { text: 'bash-history: Claude has not run any shell commands yet.' }

    const shown = all.slice(-count)
    const heading = `bash-history: last ${shown.length} of ${all.length} shell commands (newest last)`
    return { text: [heading, '', ...shown.map(row)].join('\n') }
  })
}
