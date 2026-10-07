import type { EngineInterface, Register } from 'claude-code'

import { newIssues } from './markup'
import type { Issue } from './markup'

const UI_FILE = /\.(?:jsx|tsx|vue|svelte|html?|astro)$/i
const MAX_FILE_BYTES = 400_000
const MAX_LISTED = 8

const basename = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** The file as it is on disk now; empty when it is missing, too big or unreadable. */
async function readCurrent($: EngineInterface, path: string): Promise<string> {
  try {
    const stat = await $.fs.stat(path)
    return stat.kind === 'file' && stat.size <= MAX_FILE_BYTES ? await $.fs.read(path) : ''
  } catch {
    return ''
  }
}

type Change = { before: string; after: string }

/** The file before and after the edit, applied the way the tool would; the bare snippets when the edit cannot be replayed. */
async function changeOf($: EngineInterface, e: { tool: string; file_path: string; content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown }): Promise<Change> {
  const current = await readCurrent($, e.file_path)
  if (e.tool === 'Write') return { before: current, after: String(e.content ?? '') }

  const oldText = String(e.old_string ?? '')
  const newText = String(e.new_string ?? '')
  if (oldText === '' || !current.includes(oldText)) return { before: oldText, after: newText }
  return { before: current, after: e.replace_all === true ? current.split(oldText).join(newText) : current.replace(oldText, () => newText) }
}

const listOf = (issues: readonly Issue[]): string =>
  [...issues.slice(0, MAX_LISTED).map(issue => `- line ${issue.line}: ${issue.message}`), ...(issues.length > MAX_LISTED ? [`- and ${issues.length - MAX_LISTED} more`] : [])].join('\n')

const countOf = (issues: readonly Issue[]): string => `${issues.length} accessibility issue${issues.length === 1 ? '' : 's'}`

export const register: Register = (on, options) => {
  const isBlocking = options.mode === 'block'

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (!UI_FILE.test(e.file_path) || e._host !== undefined) return next(e)
    const { before, after } = await changeOf($, e)
    // A file this big is generated or vendored: scanning it would stall the edit for no useful answer.
    if (after.length > MAX_FILE_BYTES) return next(e)
    const issues = newIssues(before, after)
    if (issues.length === 0) return next(e)

    const file = basename(e.file_path)
    if (isBlocking) {
      return {
        deny:
          `a11y-guard: blocked, this edit to ${file} adds ${countOf(issues)}:\n${listOf(issues)}\n` +
          'Fix the markup and make the edit again. (The user can set a11y-guard to warn mode to allow such edits.)',
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    $.ui.toast(`${countOf(issues)} in ${file}`)
    return { ...ran, context: [...(ran.context ?? []), `a11y-guard: this edit to ${e.file_path} adds ${countOf(issues)}:\n${listOf(issues)}\nFix them in a follow-up edit.`] }
  }).catch(($, e, next) => next(e))
}
