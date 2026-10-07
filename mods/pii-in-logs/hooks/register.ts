import type { EngineInterface, Register } from 'claude-code'

import { ALLOW_MARKER, findPii, isScannedFile } from './scan'
import type { Finding } from './scan'

const MAX_LISTED = 5

type Change = { path: string; before: string; after: string; isWholeFile: boolean }

/** The file's current text for a Write: '' when it is new, remote or unreadable. */
async function currentText($: EngineInterface, path: string, isRemote: boolean): Promise<string> {
  if (isRemote) return ''
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

const editsOf = (edits: unknown, field: 'old_string' | 'new_string'): string =>
  (Array.isArray(edits) ? edits : []).map(edit => (typeof edit?.[field] === 'string' ? edit[field] : '')).join('\n')

/** The text a file-changing tool call replaces and the text it puts there; undefined for other tools. */
async function changeOf($: EngineInterface, input: Readonly<Record<string, unknown>>): Promise<Change | undefined> {
  const tool = String(input.tool)
  const path = input.file_path ?? input.notebook_path
  if (typeof path !== 'string') return undefined
  if (tool === 'Edit') return { path, before: String(input.old_string ?? ''), after: String(input.new_string ?? ''), isWholeFile: false }
  if (tool === 'MultiEdit') return { path, before: editsOf(input.edits, 'old_string'), after: editsOf(input.edits, 'new_string'), isWholeFile: false }
  if (tool === 'NotebookEdit') return { path, before: '', after: String(input.new_source ?? ''), isWholeFile: false }
  if (tool === 'Write') {
    return { path, before: await currentText($, path, input._host !== undefined), after: String(input.content ?? ''), isWholeFile: true }
  }
  return undefined
}

const listing = (findings: readonly Finding[], isWholeFile: boolean): string => {
  const rows = findings.slice(0, MAX_LISTED).map(finding => {
    const where = isWholeFile ? `line ${finding.line}: ` : ''
    return `- ${where}${finding.call}  (prints ${finding.reasons.join(', ')})`
  })
  const more = findings.length > MAX_LISTED ? [`- ...and ${findings.length - MAX_LISTED} more`] : []
  return [...rows, ...more].join('\n')
}

const ADVICE =
  'Log an id or a masked value instead (for example the last 4 characters, or a hash), or leave the value out. ' +
  `If this is intended, put "${ALLOW_MARKER}" in a comment on that line.`

export const register: Register = (on, options) => {
  const isBlocking = options.mode === 'block'

  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const change = await changeOf($, e)
    if (change === undefined || !isScannedFile(change.path)) return next(e)

    const findings = findPii(change.before, change.after)
    if (findings.length === 0) return next(e)

    const shown = listing(findings, change.isWholeFile)
    if (isBlocking) {
      return { deny: `pii-in-logs: blocked, ${change.path} would log personal data or secrets:\n${shown}\n${ADVICE}` }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const name = change.path.split(/[\\/]/).pop() ?? change.path
    $.ui.toast(`${findings.length} log statement${findings.length === 1 ? '' : 's'} in ${name} may print personal data or secrets`)
    return { ...ran, context: [...(ran.context ?? []), `pii-in-logs: this edit added ${findings.length === 1 ? 'a log statement' : 'log statements'} to ${change.path} that may print personal data or secrets:\n${shown}\n${ADVICE}`] }
  })
}
