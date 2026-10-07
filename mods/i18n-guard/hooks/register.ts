import type { EngineInterface, Register } from 'claude-code'

import { addedFindings, describeFinding, fileKindOf, findHardCoded } from './scan'
import type { Finding } from './scan'

const DEFAULT_ATTRIBUTES = 'title,placeholder,aria-label,alt'
const MAX_LISTED = 6

const parseAttributes = (value: unknown): Set<string> =>
  new Set(
    (typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_ATTRIBUTES)
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(name => name !== ''),
  )

const listFindings = (found: readonly Finding[]): string => {
  const listed = found.slice(0, MAX_LISTED).map(describeFinding).join(', ')
  return found.length > MAX_LISTED ? `${listed}, +${found.length - MAX_LISTED} more` : listed
}

const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

// What a Write replaces: the file's current text, or nothing for a new file.
const currentText = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

export const register: Register = (on, options) => {
  const attributes = parseAttributes(options.attributes)
  const isBlocking = options.mode === 'block'

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const kind = fileKindOf(e.file_path)
    if (kind === undefined) return next(e)

    // Only strings the change adds count: those already in the file are not this edit's to fix.
    const found =
      e.tool === 'Write'
        ? addedFindings(findHardCoded(await currentText($, e.file_path), kind, attributes, true), findHardCoded(e.content, kind, attributes, true))
        : addedFindings(findHardCoded(e.old_string, kind, attributes, false), findHardCoded(e.new_string, kind, attributes, false))
    if (found.length === 0) return next(e)

    const file = baseName(e.file_path)
    if (isBlocking) {
      return {
        deny: `i18n-guard: hard-coded user-facing strings in ${file}: ${listFindings(found)}. Render them with the project's i18n function (for example t('key')), add the keys to the translation files, then retry.`,
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    $.ui.toast(`i18n-guard: ${found.length} hard-coded string${found.length === 1 ? '' : 's'} in ${file}`)
    const note = `i18n-guard: ${file} now has hard-coded user-facing strings: ${listFindings(found)}. Move them into the translation files and render them with the project's i18n function (for example t('key')).`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}
