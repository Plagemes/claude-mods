const STRICT_TYPES = /declare\s*\(\s*strict_types\s*=/i
const FUTURE_ANNOTATIONS = /^[ \t]*from\s+__future__\s+import\b[^\n]*\bannotations\b/m
const FUTURE_IMPORT = /^[ \t]*from\s+__future__\s+import\b/
const ENCODING_COMMENT = /^[ \t]*#.*coding[:=][ \t]*[-\w.]+/
const COMMENT_OR_BLANK = /^\s*(?:#.*)?$/
const TRIPLE_DOCSTRING = /^[ \t]*[rRuU]?("""|''')/
const SINGLE_DOCSTRING = /^[ \t]*[rRuU]?(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')[ \t]*(?:#.*)?$/

const eolOf = (content: string): string => (content.includes('\r\n') ? '\r\n' : '\n')

/**
 * Adds `declare(strict_types=1);` right after the opening `<?php` line of a PHP file.
 * Undefined when there is nothing to do: it has the declaration already, or does not open
 * with `<?php` alone on its line (a template, `<?=`, code on the tag's line).
 */
export function addStrictTypes(content: string): string | undefined {
  if (STRICT_TYPES.test(content)) return undefined
  const eol = eolOf(content)
  const lines = content.split(eol)
  const open = lines[0]?.startsWith('#!') ? 1 : 0
  if ((lines[open] ?? '').trimEnd() !== '<?php') return undefined

  const rest = lines.slice(open + 1)
  while (rest.length > 0 && (rest[0] ?? '').trim() === '' && rest.length > 1) rest.shift()
  const isEmpty = rest.length === 0 || (rest.length === 1 && rest[0] === '')
  return [...lines.slice(0, open + 1), '', 'declare(strict_types=1);', ...(isEmpty ? [''] : ['', ...rest])].join(eol)
}

/** Index of the line a statement that starts at `start` ends on (parentheses and backslash continuations). */
function statementEnd(lines: readonly string[], start: number): number {
  let end = start
  let depth = 0
  for (; end < lines.length; end += 1) {
    const line = lines[end] ?? ''
    depth += (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0)
    if (depth <= 0 && !line.trimEnd().endsWith('\\')) break
  }
  return Math.min(end, lines.length - 1)
}

/** Index after a module docstring that starts at `start`, or `start` when the line is not one. */
function afterDocstring(lines: readonly string[], start: number): number {
  const line = lines[start] ?? ''
  const triple = TRIPLE_DOCSTRING.exec(line)
  if (triple === null) return SINGLE_DOCSTRING.test(line) ? start + 1 : start
  const delimiter = triple[1] as string
  if (line.indexOf(delimiter, line.indexOf(delimiter) + 3) >= 0) return start + 1
  for (let end = start + 1; end < lines.length; end += 1) if ((lines[end] ?? '').includes(delimiter)) return end + 1
  return lines.length
}

/**
 * Adds `from __future__ import annotations` to a Python module: after the shebang, the encoding
 * line, leading comments, the docstring and any other `__future__` imports. Undefined when the file
 * is empty (an empty `__init__.py` stays empty) or already has it.
 */
export function addFutureAnnotations(content: string): string | undefined {
  if (content.trim() === '' || FUTURE_ANNOTATIONS.test(content)) return undefined
  const eol = eolOf(content)
  const lines = content.split(eol)

  let index = lines[0]?.startsWith('#!') ? 1 : 0
  if (ENCODING_COMMENT.test(lines[index] ?? '') && index < 2) index += 1
  while (index < lines.length && COMMENT_OR_BLANK.test(lines[index] ?? '')) index += 1
  let at = afterDocstring(lines, index)

  let isAfterFuture = false
  for (let scan = at; scan < lines.length; scan += 1) {
    const line = lines[scan] ?? ''
    if (FUTURE_IMPORT.test(line)) {
      scan = statementEnd(lines, scan)
      at = scan + 1
      isAfterFuture = true
    } else if (!COMMENT_OR_BLANK.test(line)) {
      break
    }
  }

  const before = lines.slice(0, at)
  const after = lines.slice(at)
  const needsBlankBefore = before.length > 0 && (before.at(-1) ?? '').trim() !== '' && !isAfterFuture
  const needsBlankAfter = after.length > 0 && (after[0] ?? '').trim() !== ''
  const isLastLine = after.length === 0
  return [
    ...before,
    ...(needsBlankBefore ? [''] : []),
    'from __future__ import annotations',
    ...(needsBlankAfter ? [''] : []),
    ...after,
    ...(isLastLine ? [''] : []),
  ].join(eol)
}
