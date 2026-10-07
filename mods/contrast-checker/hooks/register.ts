import type { Register, ToolCallInput } from 'claude-code'

import { analyze, isChecked, report } from './analyze'
import type { Level, Range } from './analyze'
import { ratioText } from './color'

const MAX_FILE_CHARS = 400_000
const MAX_RANGES = 20
const EDIT_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const SKIPPED_PATH = /(?:^|[\\/])(?:node_modules|dist|build|\.next|vendor|coverage)[\\/]/

/** Where `needle` stands in `text`, every time (an edit's new text may land anywhere it occurs). */
const occurrences = (text: string, needle: string): Range[] => {
  const ranges: Range[] = []
  for (let at = text.indexOf(needle); at !== -1 && ranges.length < MAX_RANGES; at = text.indexOf(needle, at + Math.max(1, needle.length))) {
    ranges.push({ start: at, end: at + needle.length })
  }
  return ranges
}

/** The stretches an edit wrote: everything for Write, each new string for Edit and MultiEdit. */
const writtenRanges = (e: ToolCallInput, text: string): Range[] | 'all' => {
  if (String(e.tool) === 'Write') return 'all'
  const strings: unknown[] = 'new_string' in e ? [e.new_string] : 'edits' in e && Array.isArray(e.edits) ? e.edits.map((edit: { new_string?: unknown }) => edit.new_string) : []
  return strings.flatMap(value => (typeof value === 'string' && value.trim() !== '' ? occurrences(text, value) : []))
}

export const register: Register = (on, options) => {
  const level: Level = options.level === 'AAA' ? 'AAA' : 'AA'

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (ran.deny !== undefined || ran.isError === true || !isChecked(path) || SKIPPED_PATH.test(path)) return ran
    try {
      const text = await $.fs.read(path)
      if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) return ran
      const ranges = writtenRanges(e, text)
      if (ranges !== 'all' && ranges.length === 0) return ran
      const issues = analyze(path, text, ranges, level)
      if (issues.length === 0) return ran
      const file = path.split(/[\\/]/).pop() ?? path
      const lowest = Math.min(...issues.map(issue => issue.ratio))
      $.ui.toast(`⚠ ${issues.length} contrast issue${issues.length === 1 ? '' : 's'} in ${file} (lowest ${ratioText(lowest)}, WCAG ${level})`)
      return { ...ran, context: [...(ran.context ?? []), report(path, issues, level)] }
    } catch (error) {
      $.ui.log(`contrast-checker: could not check ${path}: ${String(error)}`, { to: 'debug' })
      return ran
    }
  })
}
