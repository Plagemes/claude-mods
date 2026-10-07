import type { Register } from 'claude-code'

import { addFutureAnnotations, addStrictTypes } from './transform'

type Kind = 'php' | 'python'

const PHP_FILE = /\.php$/i
const PHP_TEMPLATE = /\.(?:blade|phtml)\.php$/i
const PYTHON_FILE = /\.py$/i

const kindOf = (path: string): Kind | undefined => {
  if (PHP_FILE.test(path) && !PHP_TEMPLATE.test(path)) return 'php'
  return PYTHON_FILE.test(path) ? 'python' : undefined
}

const LINES: Readonly<Record<Kind, string>> = { php: 'declare(strict_types=1);', python: 'from __future__ import annotations' }

export const register: Register = (on, options) => {
  const isEnabled: Record<Kind, boolean> = { php: options.php !== false, python: options.python !== false }

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const kind = kindOf(e.file_path)
    if (kind === undefined || !isEnabled[kind] || e._host !== undefined) return next(e)

    // Only files that do not exist yet; when that cannot be told, leave the write alone.
    const isNew = await $.fs.exists(e.file_path).then(
      exists => !exists,
      () => false,
    )
    if (!isNew) return next(e)

    const content = kind === 'php' ? addStrictTypes(e.content) : addFutureAnnotations(e.content)
    if (content === undefined) return next(e)

    const ran = await next({ ...e, content })
    if (ran.deny !== undefined || ran.isError === true) return ran

    $.ui.toast(`added ${LINES[kind]} to ${e.file_path.split(/[\\/]/).at(-1)}`)
    return { ...ran, context: [...(ran.context ?? []), `strict-types: ${LINES[kind]} was added to the new file ${e.file_path}.`] }
  })
}
