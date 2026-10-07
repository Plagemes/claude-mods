import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

const DEFAULT_MAX = 3
const POLL_MS = 3000
/** Statuses that occupy a slot; an `idle` teammate is only waiting for a message. */
const BUSY: ReadonlySet<AgentInfo['status']> = new Set(['pending', 'running', 'waiting'])

type Cap = {
  max: number
  /** Agent calls that passed the cap and have not shown up in `$.agent.list()` yet. */
  reserved: Set<string>
  poll?: Timer
}

const cap: Cap = { max: DEFAULT_MAX, reserved: new Set() }

/** Agents the engine lists as busy, leaving out `finished` (an agent whose last turn just ended). */
async function listedBusy($: EngineInterface, finished?: string): Promise<number> {
  try {
    return (await $.agent.list()).filter(agent => BUSY.has(agent.status) && agent.id !== finished).length
  } catch {
    return 0
  }
}

/** Keeps `agents n/max` in the status line while any agent runs, and polls to notice the ones that end quietly. */
async function showStatus($: EngineInterface, finished?: string): Promise<void> {
  const busy = (await listedBusy($, finished)) + cap.reserved.size
  $.ui.status(busy > 0 ? `agents ${busy}/${cap.max}` : undefined)
  if (busy === 0) {
    cap.poll?.cancel()
    cap.poll = undefined
  } else if (cap.poll === undefined) {
    cap.poll = $.clock.every(POLL_MS, () => void showStatus($))
  }
}

const refusal = (max: number): string =>
  `subagent-cap: ${max} of ${max} subagents are already running. Wait for one to finish before starting another, ` +
  'or do the work yourself. The user can raise the limit in the mod settings.'

export const register: Register = (on, options) => {
  const max = Math.floor(Number(options.max))
  cap.max = Number.isFinite(max) && max >= 1 ? max : DEFAULT_MAX

  on('tool.call', { tool: /^(?:Agent|Task)$/ }, async ($, e, next) => {
    // Read the list first, then compare and reserve with no await between: parallel calls cannot share a slot.
    const busy = await listedBusy($)
    if (busy + cap.reserved.size >= cap.max) {
      $.ui.toast(`held back a subagent: ${cap.max}/${cap.max} already running`)
      return { deny: refusal(cap.max) }
    }
    cap.reserved.add(e.tool_use_id)
    try {
      return await next(e)
    } finally {
      cap.reserved.delete(e.tool_use_id)
      await showStatus($)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    cap.reserved.delete(e.tool_use_id)
    await showStatus($)
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await showStatus($, e.agentId)
    return next(e)
  })
}
