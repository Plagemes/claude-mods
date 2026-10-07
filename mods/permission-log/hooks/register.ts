import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PermissionLogEntry } from '../types'

const KEPT = 200
const SHOWN = 50
const MAX_SUMMARY_LENGTH = 100
const MAX_REASON_LENGTH = 200
/** Claude Code's wording when the person answers "no" at a permission prompt. */
const PROMPT_REJECTION = /^The user doesn't want to proceed/
const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path', 'prompt', 'description']

const denied = atom({ plugin: 'permission-log', key: 'denied' } as const, [])

const clockTime = (ms: number): string => {
  const date = new Date(ms)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const cut = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/** What a call was about: its command, path, URL or query, else its arguments as JSON. */
const summarize = (args: unknown): string => {
  if (typeof args !== 'object' || args === null) return ''
  const fields = args as Record<string, unknown>
  const field = SUMMARY_FIELDS.find(name => typeof fields[name] === 'string')
  return cut(field === undefined ? JSON.stringify(args) : String(fields[field]), MAX_SUMMARY_LENGTH)
}

const statusLine = (count: number): string | undefined => (count > 0 ? `⛔ ${count} denied` : undefined)

const record = async ($: EngineInterface, call: { id?: string; tool: string; args: unknown; reason: string }) => {
  const at = await $.clock.now()
  const entry: PermissionLogEntry = {
    id: call.id ?? String(at),
    at,
    tool: call.tool,
    summary: summarize(call.args),
    reason: cut(call.reason, MAX_REASON_LENGTH),
  }
  const kept = await update($, denied, list =>
    list.some(known => known.id === entry.id) ? list : [...list, entry].slice(-KEPT),
  )
  $.ui.status(statusLine(kept.length))
}

const rows = (entry: PermissionLogEntry): string[] => [
  `${clockTime(entry.at)}  ${entry.tool}  ${entry.summary}`,
  `          why: ${entry.reason}`,
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'denied',
      description: 'Lists the tool calls that were denied this session, and why.',
      argumentHint: '[clear]',
    })
    $.ui.status(statusLine((await read($, denied)).length))
    return next(e)
  })

  // A refusal from a plugin's guard, or the person's "no" at the permission prompt.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const reason =
      ran.deny ?? (ran.isError && PROMPT_REJECTION.test(ran.text ?? '') ? 'Rejected by you at the permission prompt.' : undefined)
    if (reason !== undefined) await record($, { id: e.tool_use_id, tool: e.tool, args: e, reason })
    return ran
  })

  // The engine's own verdict: a deny rule, the permission mode, or a settings hook.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id !== undefined && verdict.decision === 'deny') {
      const rule = verdict.rule === undefined ? '' : ` (rule ${verdict.rule})`
      await record($, { id: e.tool_use_id, tool: e.tool, args: e.input, reason: `${verdict.reason ?? 'Denied by permissions.'}${rule}` })
    }
    return verdict
  })

  on('command.run', { command: 'denied' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, denied, () => [])
      $.ui.status(undefined)
      return { text: 'Cleared the denied-call log.' }
    }

    const all = await read($, denied)
    if (all.length === 0) return { text: 'No tool call has been denied this session.' }

    const heading = `${all.length} denied tool call${all.length === 1 ? '' : 's'} (newest last)`
    return { text: [heading, '', ...all.slice(-SHOWN).flatMap(rows)].join('\n') }
  })
}
