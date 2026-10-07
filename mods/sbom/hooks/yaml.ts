/**
 * A small YAML reader for pnpm-lock.yaml: block mappings and block
 * sequences by indentation, quoted or plain keys and scalars. A flow
 * collection (`{integrity: ...}`, `[x64]`) is kept as its text, `{}` and
 * `[]` as empty ones; anchors, tags and multi-line scalars are not read.
 */
export type YamlValue = string | YamlValue[] | YamlMap
export type YamlMap = { [key: string]: YamlValue }

type Line = { indent: number; text: string }
type Frame = { indent: number; node: YamlMap | YamlValue[] }

/** A scalar's text without its quotes (`''` inside single quotes is one quote). */
export const unquote = (raw: string): string => {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string
  return value
}

/** Where a mapping key ends: the first `:` followed by a space or the line's end, outside quotes. */
const keyEnd = (text: string): number => {
  const quote = text[0]
  let from = 0
  if (quote === "'" || quote === '"') {
    let close = 1
    for (;;) {
      close = text.indexOf(quote, close)
      if (close === -1) return -1
      if (quote === "'" && text[close + 1] === "'") {
        close += 2
        continue
      }
      break
    }
    from = close + 1
  }
  for (let at = text.indexOf(':', from); at !== -1; at = text.indexOf(':', at + 1)) {
    if (at + 1 === text.length || text[at + 1] === ' ') return at
  }
  return -1
}

const stripComment = (text: string): string => {
  if (text.startsWith('#')) return ''
  const hash = text.search(/\s#/)
  return hash === -1 ? text : text.slice(0, hash).trimEnd()
}

const scalar = (raw: string): YamlValue => {
  const value = raw.trim()
  if (value === '{}') return {}
  if (value === '[]') return []
  return unquote(value)
}

export function parseYaml(text: string): YamlMap {
  const lines: Line[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#') || raw === '---') continue
    const indent = raw.length - raw.trimStart().length
    lines.push({ indent, text: stripComment(raw.trimStart()) })
  }

  const root: YamlMap = {}
  const stack: Frame[] = [{ indent: -1, node: root }]
  /** A key whose value is the block on the following, deeper lines. */
  let open: { owner: YamlMap; key: string; indent: number } | undefined

  for (const line of lines) {
    if (open !== undefined) {
      if (line.indent > open.indent) {
        const node: YamlMap | YamlValue[] = line.text.startsWith('- ') || line.text === '-' ? [] : {}
        open.owner[open.key] = node
        stack.push({ indent: line.indent, node })
      } else {
        open.owner[open.key] = ''
      }
      open = undefined
    }
    while (stack.length > 1 && line.indent < (stack.at(-1) as Frame).indent) stack.pop()
    const frame = stack.at(-1) as Frame

    if (Array.isArray(frame.node)) {
      if (!line.text.startsWith('-')) throw new SyntaxError(`YAML: expected a list item, found "${line.text}"`)
      frame.node.push(scalar(line.text.slice(1)))
      continue
    }
    const end = keyEnd(line.text)
    if (end === -1) throw new SyntaxError(`YAML: expected "key: value", found "${line.text}"`)
    const key = unquote(line.text.slice(0, end))
    const rest = line.text.slice(end + 1).trim()
    if (rest === '') open = { owner: frame.node, key, indent: line.indent }
    else frame.node[key] = scalar(rest)
  }
  if (open !== undefined) open.owner[open.key] = ''
  return root
}
