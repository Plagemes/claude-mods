/** Pure helpers: reading conflict blocks out of a file and writing the instruction for Claude. */

export type Hunk = {
  /** 1-based line of the `<<<<<<<` marker. */
  line: number
  oursLabel: string
  theirsLabel: string
  ours: string
  theirs: string
}

export type ConflictFile = { path: string; hunks: Hunk[] }

const START = /^<{7}(?: (.*))?$/
const BASE = /^\|{7}(?: .*)?$/
const MIDDLE = /^={7}$/
const END = /^>{7}(?: (.*))?$/
/** Marker lines a written file should never contain (the `=======` divider alone is a valid underline). */
export const MARKER_LINE = /^(?:<{7}|>{7}|\|{7})(?: |$)/gm

const PROMPT_SIDE_LIMIT = 1_500
const PROMPT_TOTAL_LIMIT = 12_000

/** The conflict blocks of a file's text, with both sides; a diff3 base section is skipped. */
export const parseConflicts = (text: string): Hunk[] => {
  const hunks: Hunk[] = []
  let current: { line: number; oursLabel: string; ours: string[]; theirs: string[]; section: 'ours' | 'base' | 'theirs' } | undefined
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '')
    const start = START.exec(line)
    if (start !== null && current === undefined) {
      current = { line: index + 1, oursLabel: start[1] ?? '', ours: [], theirs: [], section: 'ours' }
      return
    }
    if (current === undefined) return
    const end = END.exec(line)
    if (end !== null && current.section === 'theirs') {
      hunks.push({
        line: current.line,
        oursLabel: current.oursLabel,
        theirsLabel: end[1] ?? '',
        ours: current.ours.join('\n'),
        theirs: current.theirs.join('\n'),
      })
      current = undefined
    } else if (BASE.test(line) && current.section === 'ours') {
      current.section = 'base'
    } else if (MIDDLE.test(line) && current.section !== 'theirs') {
      current.section = 'theirs'
    } else if (current.section === 'ours') {
      current.ours.push(line)
    } else if (current.section === 'theirs') {
      current.theirs.push(line)
    }
  })
  return hunks
}

export const markerCount = (text: string): number => text.match(MARKER_LINE)?.length ?? 0

const clip = (text: string): string =>
  text.length > PROMPT_SIDE_LIMIT ? `${text.slice(0, PROMPT_SIDE_LIMIT)}\n… (cut; read the file for the rest)` : text

/** A precise instruction for one or more files: every block with both sides, then the rules. */
export const resolveInstruction = (files: readonly ConflictFile[], operation: string | null): string => {
  const what = operation === null ? 'merge conflicts' : `${operation} conflicts`
  const parts: string[] = [
    files.length === 1
      ? `Resolve the ${what} in \`${files[0]?.path}\` (${files[0]?.hunks.length} block${files[0]?.hunks.length === 1 ? '' : 's'}).`
      : `Resolve the ${what} in these ${files.length} files: ${files.map(file => `\`${file.path}\``).join(', ')}.`,
  ]
  let budget = PROMPT_TOTAL_LIMIT
  for (const file of files) {
    for (const [index, hunk] of file.hunks.entries()) {
      const block = [
        `\n${file.path}, block ${index + 1} at line ${hunk.line}:`,
        `ours (${hunk.oursLabel || 'HEAD'}):`,
        '```',
        clip(hunk.ours),
        '```',
        `theirs (${hunk.theirsLabel || 'incoming'}):`,
        '```',
        clip(hunk.theirs),
        '```',
      ].join('\n')
      if (block.length > budget) {
        parts.push('\n(More blocks follow: read the files for them.)')
        budget = 0
        break
      }
      budget -= block.length
      parts.push(block)
    }
    if (budget === 0) break
  }
  parts.push(
    '',
    'For each block, keep the intent of both sides: combine them when they touch different things, and when they truly contradict, choose one and tell me which and why.',
    'Edit only the conflicted regions, leave no `<<<<<<<`, `=======` or `>>>>>>>` lines behind, and keep the code compiling.',
    `When a file is clean, stage it with \`git add <file>\`. Do not commit${operation === 'rebase' ? ' or continue the rebase' : ''}: I will review first.`,
  )
  return parts.join('\n')
}
