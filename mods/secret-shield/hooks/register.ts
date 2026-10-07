import type { Register } from 'claude-code'

import { findSecrets, isTemplatePath } from './scan'

const WRITE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const MAX_REPORTED = 3

function compile(source: string): RegExp | undefined {
  try {
    return source === '' ? undefined : new RegExp(source)
  } catch {
    return undefined
  }
}

/** Every piece of new text a write-type tool call would put on disk. */
function addedTexts(input: Readonly<Record<string, unknown>>): string[] {
  const texts = [input.new_string, input.content, input.new_source]
  const edits = Array.isArray(input.edits) ? input.edits : []
  for (const edit of edits) {
    if (typeof edit === 'object' && edit !== null) texts.push((edit as Record<string, unknown>).new_string)
  }
  return texts.filter((text): text is string => typeof text === 'string')
}

function targetPath(input: Readonly<Record<string, unknown>>): string {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? path : 'file'
}

export const register: Register = (on, options) => {
  const allowlist = compile(String(options.allowlist ?? ''))

  on('tool.call', { tool: WRITE_TOOLS }, ($, e, next) => {
    const path = targetPath(e)
    const isAllowed = (secret: string, line: string) =>
      allowlist !== undefined && [secret, line, path].some(text => allowlist.test(text))
    const findings = addedTexts(e).flatMap(text => findSecrets(text, isAllowed, isTemplatePath(path)))

    if (findings.length === 0) return next(e)

    const lines = findings
      .slice(0, MAX_REPORTED)
      .map(f => `  line ${f.line}: ${f.pattern} -> ${f.preview}`)
      .join('\n')
    const more = findings.length > MAX_REPORTED ? `\n  (+${findings.length - MAX_REPORTED} more)` : ''
    return {
      deny: `secret-shield: refusing to write ${path}; it looks like it contains a secret.\n${lines}${more}\nUse an environment variable or a secret manager and reference it by name.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'secret-shield: its scan failed, so the write was blocked.' }))
}
