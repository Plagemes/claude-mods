import type { EngineInterface, Register } from 'claude-code'

import { RULES } from './rules'
import { ALLOW_MARKER, findWeakCrypto, isScannedFile } from './scan'
import type { Hit } from './scan'

const MAX_LISTED = 6

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
  if (typeof path !== 'string' || !isScannedFile(path)) return undefined
  if (tool === 'Edit') return { path, before: String(input.old_string ?? ''), after: String(input.new_string ?? ''), isWholeFile: false }
  if (tool === 'MultiEdit') return { path, before: editsOf(input.edits, 'old_string'), after: editsOf(input.edits, 'new_string'), isWholeFile: false }
  if (tool === 'NotebookEdit') return { path, before: '', after: String(input.new_source ?? ''), isWholeFile: false }
  if (tool === 'Write') return { path, before: await currentText($, path, input._host !== undefined), after: String(input.content ?? ''), isWholeFile: true }
  return undefined
}

const listing = (hits: readonly Hit[], isWholeFile: boolean): string => {
  const rows = hits.slice(0, MAX_LISTED).map(hit => {
    const where = isWholeFile ? `line ${hit.line}: ` : ''
    const rule = RULES[hit.rule]
    return `- ${where}${hit.code}\n  -> ${hit.detail ?? rule.title}. ${rule.advice}`
  })
  const more = hits.length > MAX_LISTED ? [`- ...and ${hits.length - MAX_LISTED} more`] : []
  return [...rows, ...more].join('\n')
}

const FOOTER = `If a line is intended (a checksum that is not a security control, a test vector), put "${ALLOW_MARKER}" in a comment on it.`

export const register: Register = (on, options) => {
  const isBlocking = options.mode === 'block'

  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const change = await changeOf($, e)
    if (change === undefined) return next(e)

    const hits = findWeakCrypto(change.before, change.after)
    if (hits.length === 0) return next(e)

    const shown = listing(hits, change.isWholeFile)
    if (isBlocking) {
      return { deny: `crypto-guard: blocked, ${change.path} would use weak cryptography:\n${shown}\n${FOOTER}` }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const name = change.path.split(/[\\/]/).pop() ?? change.path
    $.ui.toast(`weak cryptography in ${name}: ${[...new Set(hits.map(hit => RULES[hit.rule].title))].slice(0, 2).join(', ')}`)
    return { ...ran, context: [...(ran.context ?? []), `crypto-guard: this edit added weak cryptography to ${change.path}:\n${shown}\n${FOOTER}`] }
  })
}
