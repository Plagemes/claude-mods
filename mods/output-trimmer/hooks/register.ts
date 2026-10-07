import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { OutputTrimmerSaved } from '../types'
import { trimOutput } from './trim'
import type { TrimShape } from './trim'

const NO_TRIM = /#\s*no-trim\b/i
const DEFAULT_MAX_CHARS = 12_000
const DEFAULT_HEAD_LINES = 60
const DEFAULT_TAIL_LINES = 80
/** The usual rule of thumb for English text and code. */
const CHARS_PER_TOKEN = 4

const saved = atom({ plugin: 'output-trimmer', key: 'saved' } as const, { chars: 0, outputs: 0 })

type Settings = TrimShape & { maxChars: number }

const wholeNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.round(value) : fallback

const compact = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${+(n / 1_000).toFixed(1)}k` : `${Math.round(n)}`

const statusText = ({ chars, outputs }: OutputTrimmerSaved): string =>
  `✂ ${compact(chars / CHARS_PER_TOKEN)} tokens trimmed from ${outputs} output${outputs === 1 ? '' : 's'}`

/** The text of a tool_result's content: a string, or its text blocks joined. */
const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined

  const texts = content.map(block =>
    typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string' ? block.text : undefined,
  )

  return texts.every(text => text !== undefined) ? texts.join('\n') : undefined
}

async function recordSaving($: EngineInterface, chars: number): Promise<void> {
  const total = await update($, saved, before => ({ chars: before.chars + chars, outputs: before.outputs + 1 }))
  $.ui.status(statusText(total))
}

export const register: Register = (on, options: PluginOptions) => {
  const settings: Settings = {
    maxChars: wholeNumber(options.maxChars, DEFAULT_MAX_CHARS),
    headLines: wholeNumber(options.headLines, DEFAULT_HEAD_LINES),
    tailLines: wholeNumber(options.tailLines, DEFAULT_TAIL_LINES),
  }
  /** Calls whose command asked for the whole output, by tool_use_id. */
  const keptWhole = new Set<string>()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (NO_TRIM.test(e.command)) {
      keptWhole.add(e.tool_use_id)
      return next(e)
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    // A trimmed output fits inline, so it drops the engine's saved-to-file preview;
    // the note names the saved file instead.
    const { persistedOutputPath, persistedOutputSize, ...record } = ran.result
    const before = record.stdout.length + record.stderr.length
    if (record.isImage === true || record.backgroundTaskId !== undefined || before <= settings.maxChars) return ran

    const stdout = trimOutput(record.stdout, settings, persistedOutputPath)
    const stderr = trimOutput(record.stderr, settings, persistedOutputPath)
    const after = stdout.length + stderr.length
    if (after >= before) return ran

    await recordSaving($, before - after)

    const result = { ...record, stdout, stderr }

    return ran.context === undefined ? { result } : { result, context: ran.context }
  })

  // An errored call (a non-zero exit) carries no record to rewrite at tool.call, so its
  // text is trimmed where the result row is kept: the model reads the trimmed text,
  // the transcript still draws the whole output.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (e.origin.kind !== 'tool' || e.origin.tool !== 'Bash') return next(e)

    let savedChars = 0
    const content = e.message.content.map(block => {
      const isKeptWhole = typeof block.tool_use_id === 'string' && keptWhole.delete(block.tool_use_id)
      const text = block.type === 'tool_result' && block.is_error === true ? textOf(block.content) : undefined
      if (isKeptWhole || text === undefined || text.length <= settings.maxChars) return block

      const trimmed = trimOutput(text, settings)
      if (trimmed.length >= text.length) return block

      savedChars += text.length - trimmed.length
      return { ...block, content: trimmed }
    })

    if (savedChars === 0) return next(e)

    await recordSaving($, savedChars)

    return next({ ...e, message: { ...e.message, content } })
  })
}
