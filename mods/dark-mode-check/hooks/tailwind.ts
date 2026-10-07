export type Finding = {
  line: number
  /** What is wrong, as shown to Claude. */
  text: string
  advice: string
  /** How many colors the finding is about. */
  count: number
  /** The same for an unchanged element wherever it moves: used to tell new findings from old ones. */
  key: string
}

const CLASS_CONTEXT =
  /(?:\b(?:className|class|:class|v-bind:class|\[class\]|\[ngClass\])\s*=\s*|\b(?:cn|clsx|classNames|classnames|twMerge|twJoin|cva|tw)\s*\()/g
const UTILITY = /^(bg|text|border(?:-[trblxyse])?|divide(?:-[xy])?|ring|placeholder)-(white|black|(?:slate|gray|zinc|neutral|stone)-(?:50|100|200|300|400|500|600|700|800|900|950))(?:\/\d+)?$/
const TOKEN = /[A-Za-z0-9_!:/[\]#.%@-]+/g
const MAX_SCAN = 6000
const STRING_LITERAL = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g
const NEUTRAL_DARK: Record<string, string> = { '50': '900', '100': '800', '200': '700', '300': '600' }
const NEUTRAL_LIGHT: Record<string, string> = { '600': '400', '700': '300', '800': '200', '900': '100', '950': '50' }

/** Index just after the bracket that closes the one at `start`, strings and templates respected; -1 when it never does. */
const endOfBrackets = (text: string, start: number): number => {
  const open = text[start]
  const close = open === '(' ? ')' : '}'
  let depth = 0
  for (let index = start; index < Math.min(text.length, start + MAX_SCAN); index += 1) {
    const char = text[index]
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return index + 1
    } else if (char === '"' || char === "'" || char === '`') {
      let end = index + 1
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1
      index = end
    }
  }
  return -1
}

type Group = { start: number; text: string }

/** The class lists in a source: attribute values and class-helper calls (all their strings together), then any other string. */
const classGroups = (text: string): Group[] => {
  const groups: Group[] = []
  let covered = 0
  for (const match of text.matchAll(CLASS_CONTEXT)) {
    const start = (match.index ?? 0) + match[0].length
    if (start < covered) continue
    const first = text[start]
    const isCall = match[0].endsWith('(')
    const end =
      isCall ? endOfBrackets(text, start - 1) :
      first === '{' ? endOfBrackets(text, start) :
      first === '"' || first === "'" ? text.indexOf(first, start + 1) + 1 :
      -1
    if (end <= 0) continue
    groups.push({ start, text: text.slice(isCall ? start - 1 : start, end) })
    covered = end
  }
  for (const match of text.matchAll(STRING_LITERAL)) {
    const index = match.index ?? 0
    if (index >= covered && !groups.some(group => index >= group.start && index < group.start + group.text.length)) groups.push({ start: index, text: match[0].slice(1, -1) })
  }
  return groups
}

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length

/** A Tailwind utility with the parts that matter: its variants (hover, dark, ...), property family and color. */
type Utility = { variants: string[]; family: string; prefix: string; color: string; shade: string }

const familyOf = (token: string): string | undefined => /^(bg|text|border|divide|ring|placeholder)(?:-|$)/.exec(token)?.[1]

const parseUtility = (token: string): Utility | undefined => {
  const parts = token.replace(/^!/, '').split(':')
  const match = UTILITY.exec(parts.at(-1) ?? '')
  if (match === null) return undefined
  const [, prefix = '', name = ''] = match
  const [color = '', shade = ''] = name.split('-')
  return { variants: parts.slice(0, -1), family: familyOf(prefix) ?? prefix, prefix, color, shade }
}

/** Light-theme colors: pale surfaces and borders, dark text. */
const isLightAssuming = ({ family, color, shade }: Utility): boolean => {
  const level = shade === '' ? Number.NaN : Number(shade)
  return family === 'text' || family === 'placeholder' ? color === 'black' || level >= 600 : color === 'white' || level <= 300
}

const darkShade = ({ family, color, shade }: Utility): string => {
  if (family === 'text' || family === 'placeholder') return color === 'black' ? 'white' : `${color}-${NEUTRAL_LIGHT[shade] ?? '300'}`
  if (color === 'white') return family === 'bg' ? 'gray-900' : 'gray-800'
  return `${color}-${NEUTRAL_DARK[shade] ?? '700'}`
}

/** `bg-white` needs `dark:bg-gray-900`; `hover:bg-gray-100` needs `dark:hover:bg-gray-800`. */
const darkCounterpart = (item: Utility): string => `${['dark', ...item.variants].join(':')}:${item.prefix}-${darkShade(item)}`

/** The same property in a dark variant and the same state (hover, focus, ...): the counterpart a light color needs. */
const hasDarkCounterpart = (tokens: readonly string[], item: Utility): boolean => {
  const state = item.variants.join(':')
  return tokens.some(token => {
    const parts = token.replace(/^!/, '').split(':')
    const variants = parts.slice(0, -1)
    return variants.includes('dark') && familyOf(parts.at(-1) ?? '') === item.family && variants.filter(variant => variant !== 'dark').join(':') === state
  })
}

/** Light-assuming Tailwind colors in class lists that have no `dark:` counterpart in the same list. */
export const findClassFindings = (text: string): Finding[] => {
  const findings: Finding[] = []
  for (const group of classGroups(text)) {
    const tokens = [...group.text.matchAll(TOKEN)].map(match => match[0])
    const flagged = new Map<string, Utility>()
    for (const token of tokens) {
      const utility = parseUtility(token)
      if (utility !== undefined && !utility.variants.includes('dark') && isLightAssuming(utility) && !hasDarkCounterpart(tokens, utility)) flagged.set(token, utility)
    }
    const names = [...flagged.keys()]
    if (names.length === 0) continue
    findings.push({
      line: lineAt(text, group.start + Math.max(0, group.text.indexOf(names[0] ?? ''))),
      text: names.join(', '),
      advice: [...flagged.values()].map(darkCounterpart).join(' '),
      count: names.length,
      key: `${names.join(' ')}|${[...tokens].sort().join(' ')}`,
    })
  }
  return findings
}
