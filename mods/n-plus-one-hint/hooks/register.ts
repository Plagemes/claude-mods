import type { EngineInterface, Register } from 'claude-code'

import { ADVICE, findLoopQueries, introduced, isScanned } from './loops'
import type { Hit } from './loops'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
/** Tests, migrations, seeds and vendored code run queries in loops on purpose, or are not ours. */
const SKIPPED_PATH =
  /(^|[\\/])(node_modules|vendor|dist|build|\.git|tests?|__tests__|specs?|migrations?|db[\\/]migrate|seeds?|fixtures)[\\/]|\.(?:test|spec)\.|_test\.go$|(^|[\\/])test_[^\\/]*\.py$|_spec\.rb$|Tests?\.(?:java|cs|kt)$/
const MAX_LISTED = 4

type Input = Readonly<Record<string, unknown>>

const extensionOf = (path: string): string => {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  return name.includes('.') ? (name.split('.').at(-1) ?? '').toLowerCase() : ''
}

/** The file as it will be once the tool has run. */
function resultingText(before: string, input: Input): string {
  if (typeof input.content === 'string') return input.content
  const edits: readonly unknown[] = Array.isArray(input.edits) ? input.edits : [input]
  let text = before
  for (const edit of edits) {
    const { old_string, new_string, replace_all } = edit as Record<string, unknown>
    if (typeof old_string !== 'string' || typeof new_string !== 'string' || old_string === '') continue
    text = replace_all === true ? text.replaceAll(old_string, () => new_string) : text.replace(old_string, () => new_string)
  }
  return text
}

/** Queries in loops that this change introduces: in the file after it, and not already in a loop before it. */
async function addedLoopQueries($: EngineInterface, path: string, input: Input): Promise<Hit[]> {
  const extension = extensionOf(path)
  if (!isScanned(extension) || SKIPPED_PATH.test(path)) return []
  const before = await $.fs.read(path).catch(() => '')
  return introduced(findLoopQueries(before, extension), findLoopQueries(resultingText(before, input), extension))
}

function describe(path: string, hits: readonly Hit[]): string {
  const lines = hits.slice(0, MAX_LISTED).map(({ line, call }) => `  ${path}:${line}  ${call}(...) runs once per iteration`)
  const more = hits.length > MAX_LISTED ? [`  (+${hits.length - MAX_LISTED} more)`] : []
  const advice = [...new Set(hits.map(hit => ADVICE[hit.kind]))].slice(0, 2).map(text => `  Instead: ${text}.`)
  return [`n-plus-one-hint: this edit puts a database query inside a loop, the N+1 pattern (one query per item):`, ...lines, ...more, ...advice].join('\n')
}

export const register: Register = on => {
  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Input = e
    const path = input.file_path
    if (typeof path !== 'string' || input._host !== undefined) return next(e)

    const hits = await addedLoopQueries($, path, input)
    if (hits.length === 0) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const first = hits[0] as Hit
    $.ui.toast(`possible N+1 query in ${path.split(/[\\/]/).at(-1)}:${first.line}${hits.length > 1 ? ` (+${hits.length - 1})` : ''}`)
    return { ...ran, context: [...(ran.context ?? []), describe(path, hits)] }
  })
}
