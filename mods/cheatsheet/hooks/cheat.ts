import type { Sheet } from './sheet'
import { SHEETS, findSheet } from './sheets'

const MAX_LINES = 50
const CODE_INDENT = '    '

type Section = { title: string; lines: string[] }

/** The sections of a sheet and the code lines in each; prose between them is not searched. */
export const sectionsOf = (sheet: Sheet): Section[] => {
  const sections: Section[] = []
  for (const line of sheet.markdown.split('\n')) {
    if (line.startsWith('## ')) sections.push({ title: line.slice(3), lines: [] })
    else if (line.startsWith(CODE_INDENT)) sections.at(-1)?.lines.push(line)
  }
  return sections
}

/** Words to filter by: lower case, quotes dropped. */
const tokensOf = (words: readonly string[]): string[] => words.map(word => word.replace(/["']/g, '').toLowerCase()).filter(word => word !== '')

/** Sections reduced to the lines that contain every word; a word may also match the sheet's or the section's title. */
const filtered = (sheet: Sheet, tokens: readonly string[]): Section[] =>
  sectionsOf(sheet)
    .map(section => ({
      title: section.title,
      lines: section.lines.filter(line => {
        const text = `${sheet.title} ${section.title} ${line}`.toLowerCase()
        return tokens.every(token => text.includes(token))
      }),
    }))
    .filter(section => section.lines.length > 0)

const block = (section: Section, level: string): string => `${level} ${section.title}\n${section.lines.join('\n')}`

const topicList = (): string =>
  [
    '# Cheat sheets',
    '',
    ...SHEETS.map(sheet => `${CODE_INDENT}${sheet.topic.padEnd(10)}${sheet.summary}`),
    '',
    'Use /cheat <topic> for a whole sheet, /cheat <topic> <words> to filter its lines (/cheat git stash),',
    'or /cheat <words> to search every sheet (/cheat prune).',
  ].join('\n')

const searchAll = (tokens: readonly string[]): string => {
  const hits = SHEETS.map(sheet => ({ sheet, sections: filtered(sheet, tokens) })).filter(hit => hit.sections.length > 0)
  if (hits.length === 0) {
    return `Nothing matches "${tokens.join(' ')}" in any cheat sheet. Topics: ${SHEETS.map(sheet => sheet.topic).join(', ')}.`
  }
  const out: string[] = [`# Cheat sheets: "${tokens.join(' ')}"`]
  let shown = 0
  let total = 0
  for (const { sheet, sections } of hits) {
    const kept: Section[] = []
    for (const section of sections) {
      total += section.lines.length
      const room = Math.max(0, MAX_LINES - shown)
      if (room === 0) continue
      const lines = section.lines.slice(0, room)
      shown += lines.length
      kept.push({ title: section.title, lines })
    }
    if (kept.length > 0) out.push('', `## ${sheet.title}`, ...kept.map(section => block(section, '###')))
  }
  if (total > shown) out.push('', `…and ${total - shown} more lines. Add a topic or another word to narrow it down.`)
  return out.join('\n')
}

const oneSheet = (sheet: Sheet, tokens: readonly string[]): string => {
  if (tokens.length === 0) return `# ${sheet.title} cheat sheet\n\n${sheet.markdown.trimEnd()}`
  const sections = filtered(sheet, tokens)
  if (sections.length === 0) {
    return `No line in the ${sheet.title} sheet matches "${tokens.join(' ')}". /cheat ${sheet.topic} shows the whole sheet.`
  }
  return [`# ${sheet.title}: "${tokens.join(' ')}"`, '', ...sections.map(section => block(section, '##'))].join('\n')
}

/** The answer to `/cheat <args>`: the topic list, a whole sheet, a filtered one, or a search of every sheet. */
export const answer = (args: string): string => {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const [first, ...rest] = words
  if (first === undefined) return topicList()
  const sheet = findSheet(first)
  return sheet === undefined ? searchAll(tokensOf(words)) : oneSheet(sheet, tokensOf(rest))
}
