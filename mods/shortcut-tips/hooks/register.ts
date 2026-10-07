import type { EngineInterface, Register } from 'claude-code'

import { TIPS, dayKey, positionOf, tipAt } from './tips'

const SHOWN_ON = 'shownOn'
const NEXT = 'next'
const TOAST_MS = 12_000

const line = (position: number): string => `Tip ${position + 1} of ${TIPS.length}: ${tipAt(position).text}`

/** Takes the next tip off the rotation: its position, with the store already moved on. */
async function takeTip($: EngineInterface): Promise<number> {
  const position = positionOf(await $.store.get(NEXT))
  await $.store.set(NEXT, (position + 1) % TIPS.length)
  return position
}

/** Shows today's tip once; any trouble with the store means no tip, never a failed start. */
async function announce($: EngineInterface): Promise<void> {
  try {
    const today = dayKey(await $.clock.now())
    if ((await $.store.get(SHOWN_ON)) === today) return
    await $.store.set(SHOWN_ON, today)
    $.ui.toast(`💡 ${tipAt(await takeTip($)).text}  ·  /tip for another`, { timeoutMs: TOAST_MS })
  } catch {
    // A tip is a nicety: stay silent when the store or clock cannot be used.
  }
}

export const register: Register = (on, options) => {
  const showAtStart = options.showAtStart !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tip', description: 'Show the next Claude Code shortcut or feature tip' })
    if (showAtStart && e.isInteractive) await announce($)
    return next(e)
  })

  on('command.run', { command: 'tip' }, async $ => {
    try {
      return { text: line(await takeTip($)) }
    } catch {
      return { text: line(0) }
    }
  })
}
