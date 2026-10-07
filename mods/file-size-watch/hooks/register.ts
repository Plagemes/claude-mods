import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_MAX_LINES = 500
const NOT_CODE =
  /\.(json|lock|lockb|map|svg|csv|tsv|snap|log|txt|md|mdx)$|\.min\.(js|css)$|\.generated\./

/** Lines in `text`, a final newline not starting a new one. */
const lineCount = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

/** Lines of the file on disk; 0 when it is missing or cannot be read. */
const linesOf = async ($: EngineInterface, path: string): Promise<number> => {
  try {
    return lineCount(await $.fs.read(path))
  } catch {
    return 0
  }
}

export const register: Register = (on, options) => {
  const limit = typeof options.maxLines === 'number' ? options.maxLines : DEFAULT_MAX_LINES
  const toasted = new Set<string>()

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (e._host !== undefined || NOT_CODE.test(e.file_path)) return next(e)

    // An Edit says by itself whether it adds lines; only a Write needs the old file read.
    const isGrowing =
      e.tool === 'Edit'
        ? lineCount(e.new_string) > lineCount(e.old_string)
        : lineCount(e.content) > (await linesOf($, e.file_path))
    if (!isGrowing) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const lines = e.tool === 'Write' ? lineCount(e.content) : await linesOf($, e.file_path)
    if (lines <= limit) return ran

    if (!toasted.has(e.file_path)) {
      toasted.add(e.file_path)
      $.ui.toast(`file-size-watch: ${e.file_path.split('/').pop()} is ${lines} lines. Consider splitting it.`)
    }
    const note =
      `file-size-watch: ${e.file_path} is now ${lines} lines (limit ${limit}) and this edit made it longer. ` +
      `Before adding more to it, consider splitting it into smaller modules by responsibility.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}
