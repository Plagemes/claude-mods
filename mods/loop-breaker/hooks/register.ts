import type { PromptOrigin, Register } from 'claude-code'

const DEFAULT_LIMIT = 3
const MAX_SHOWN = 80
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
/** Input fields that identify a call but say nothing about what it does. */
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', '_host'])

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** Consecutive failures per call, per loop; a person's next prompt and anything that changes the project clear them. */
const failures = new Map<string, number>()

const squash = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** What makes two calls "the same": the agent, the tool and its input (a shell command with its spacing normalized). */
const keyOf = (e: Readonly<Record<string, unknown>>): string => {
  const input = Object.entries(e).filter(([name]) => !ENVELOPE.has(name))
  const body = e.tool === 'Bash' ? squash(String(e.command)) : JSON.stringify(input)
  return `${String(e.agentId ?? 'main')}\u0000${String(e.tool)}\u0000${body}`
}

const summary = (e: Readonly<Record<string, unknown>>): string => {
  const text = e.tool === 'Bash' ? squash(String(e.command)) : `${String(e.tool)} ${String(e.file_path ?? e.notebook_path ?? '')}`.trim()
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text
}

const advice = (what: string, limit: number): string =>
  `This exact call (${what}) has now failed ${limit} times in a row. Stop repeating it. Step back, read the error it printed, ` +
  'work out why it fails, and try a different approach: another command, another way to the same result, or ask the user.'

export const register: Register = (on, options) => {
  const asked = Math.floor(Number(options.limit))
  const limit = Number.isFinite(asked) && asked >= 2 ? asked : DEFAULT_LIMIT

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) failures.clear()
    return next(e)
  })

  on('tool.call', { tool: /^(?:Bash|Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const key = keyOf(e)
    if ((failures.get(key) ?? 0) >= limit) {
      return { deny: `loop-breaker: refused. ${advice(summary(e), limit)}` }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) {
      const count = (failures.get(key) ?? 0) + 1
      failures.set(key, count)
      if (count < limit) return ran
      $.ui.toast(`stopped a loop: "${summary(e)}" failed ${limit} times in a row`, { timeoutMs: 8000 })
      return { ...ran, context: [...(ran.context ?? []), `loop-breaker: ${advice(summary(e), limit)}`] }
    }

    // A successful edit, or a command that is not read-only, may have changed what the failing call depends on.
    if (e.tool !== 'Bash' || ran.isReadOnly !== true) failures.clear()
    return ran
  })
}
