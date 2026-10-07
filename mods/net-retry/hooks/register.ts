import type { Register, ToolCallResult } from 'claude-code'

import { backoffMs, isRetryable, transientError } from './commands'

const DEFAULT_RETRIES = 2
const MAX_RETRIES = 5
const DEFAULT_BACKOFF_SECONDS = 2
/** What a hook keeps in hand when it waits: the time to put its note together and return before its budget is gone. */
const SAFETY_MARGIN_MS = 2000
const MAX_REASON_LENGTH = 50

const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/** What a failed command's output blames the failure on, when that is a temporary network error. */
const networkReason = (ran: ToolCallResult): string | undefined => {
  if (ran.deny !== undefined || ran.isError !== true) return undefined
  const reason = transientError(ran.text ?? '')
  return reason === undefined || reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`
}

const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(1))} s`

export const register: Register = (on, options) => {
  const maxRetries = Math.min(MAX_RETRIES, Math.max(0, Math.round(numberOr(options.retries, DEFAULT_RETRIES))))
  const firstWaitMs = Math.max(100, numberOr(options.backoffSeconds, DEFAULT_BACKOFF_SECONDS) * 1000)

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let ran = await next(e)
    if (maxRetries === 0 || e.run_in_background === true || !isRetryable(e.command)) return ran

    const retries: string[] = []
    while (retries.length < maxRetries) {
      const reason = networkReason(ran)
      const waitMs = backoffMs(retries.length + 1, firstWaitMs)
      // Waits count against the hook's budget: with less left than the wait and the margin, stop rather than be cut off.
      if (reason === undefined || next.signal.aborted || next.budget.remainingMs < waitMs + SAFETY_MARGIN_MS) break

      retries.push(`${reason}, waited ${seconds(waitMs)}`)
      $.ui.toast(`network error (${reason}); retrying in ${seconds(waitMs)} (${retries.length}/${maxRetries})`, { timeoutMs: waitMs })
      await $.clock.sleep(waitMs, { signal: next.signal })
      ran = await next(e)
    }

    if (retries.length === 0 || ran.deny !== undefined) return ran
    const outcome = ran.isError === true ? 'it still failed' : 'it worked'
    const note = `net-retry: this command hit a temporary network error and was run again ${retries.length} time${retries.length === 1 ? '' : 's'} (${retries.join('; ')}); ${outcome} on the last try.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}
