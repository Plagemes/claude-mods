import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import { ALL_CATEGORIES, redactText } from './patterns'
import type { Category, RedactOptions } from './patterns'

type Block = { type: string; [field: string]: unknown }
type Tally = Record<string, number>

const PLACEHOLDER = '[redactor: this tool result was withheld because it could not be scanned for secrets]'
const counts = atom({ plugin: 'redactor', key: 'counts' } as const, {})

const optionsFrom = (options: Readonly<Record<string, unknown>>): RedactOptions & { allowlistError?: string } => {
  const enabled = new Set<Category>(ALL_CATEGORIES.filter(category => options[category] !== false))
  if (options.privateIps !== true) enabled.delete('privateIps')
  const source = typeof options.allowlist === 'string' ? options.allowlist.trim() : ''
  if (source === '') return { enabled, allowlist: undefined }
  try {
    return { enabled, allowlist: new RegExp(source) }
  } catch (error) {
    return { enabled, allowlist: undefined, allowlistError: String(error) }
  }
}

const addInto = (total: Tally, more: Tally): void => {
  for (const [kind, n] of Object.entries(more)) total[kind] = (total[kind] ?? 0) + n
}

/** Rewrites the text a block carries: a text block's `text`, a tool_result's string or text-block `content`. */
const redactBlock = (block: Block, redact: (text: string) => string): Block => {
  if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: redact(block.text) }
  if (block.type !== 'tool_result') return block
  if (typeof block.content === 'string') return { ...block, content: redact(block.content) }
  if (!Array.isArray(block.content)) return block
  return { ...block, content: block.content.map(inner => redactBlock(inner as Block, redact)) }
}

const placeholderBlock = (block: Block): Block => {
  if (block.type === 'text') return { ...block, text: PLACEHOLDER }
  if (block.type === 'tool_result') return { ...block, content: PLACEHOLDER }
  return block
}

const statusLine = (tally: Tally): string | undefined => {
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  if (total === 0) return undefined
  const detail = entries.map(([kind, n]) => (n === 1 ? kind : `${kind} ×${n}`)).join(', ')
  return `redactor: ${total} masked (${detail})`
}

export const register: Register = (on, options) => {
  const config = optionsFrom(options)

  on('session.start', async ($, e, next) => {
    if (config.allowlistError !== undefined) {
      $.ui.toast(`redactor: allowlist ignored, not a valid regex (${config.allowlistError})`)
    }
    return next(e)
  })

  /** The row with every enabled kind masked, and what was masked. */
  const scrub = <E extends { message: { content: readonly Block[] } }>(e: E) => {
    const found: Tally = {}
    const redact = (text: string): string => {
      const result = redactText(text, config)
      addInto(found, result.counts)
      return result.text
    }
    const content = e.message.content.map(block => redactBlock(block, redact))
    return { event: { ...e, message: { ...e.message, content } }, found }
  }

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const { event, found } = scrub(e)
    if (Object.keys(found).length === 0) return next(e)

    try {
      const tally = await update($, counts, (previous: Tally) => {
        const total = { ...previous }
        addInto(total, found)
        return total
      })
      $.ui.status(statusLine(tally))
    } catch (error) {
      // Bookkeeping only: the masked row is stored either way.
      $.ui.log(`redactor: could not update the tally (${String(error)})`, { to: 'debug' })
    }
    return next(event)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // Re-entry: the hook was not run, but scanning is pure, so mask here without `$`.
    if (next.error.kind === 're-entry') return next(scrub(e).event)
    // The scan itself failed: never let an unscanned result through.
    return next({ ...e, message: { ...e.message, content: e.message.content.map(placeholderBlock) } })
  })
}
