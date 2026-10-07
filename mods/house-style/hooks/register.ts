import type { EngineInterface, Register } from 'claude-code'

const COMMAND = 'style'
const SECTION_ID = 'house-style:style'
const DEFAULT_FILES = ['STYLE.md', '.claude/style.md', 'docs/STYLE.md', 'CONTRIBUTING.md']
/** Files read for their style sections alone, not whole. */
const SECTIONED_FILE = /(^|\/)CONTRIBUTING\.md$/i
/** Headings whose sections count as style guidance in a sectioned file. */
const STYLE_HEADING = /\b(style|conventions?|coding standards?|code standards?|formatting|guidelines?)\b/i
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const DEFAULT_MAX_CHARS = 8000
const MIN_MAX_CHARS = 500
const PREVIEW_LINES = 30
const CHARS_PER_TOKEN = 4

type Guide = {
  /** The file as configured, relative to the project root. */
  file: string
  mtimeMs: number
  size: number
  /** The guidance taken from it: the whole file, or a sectioned file's style sections. */
  text: string
  isSection: boolean
}

type Cache = {
  root: string
  guide: Guide | null
  /** Files read and found to hold no guidance, by the mtime they had then. */
  empty: Record<string, number>
}

const settings = { files: DEFAULT_FILES, maxChars: DEFAULT_MAX_CHARS }
let cache: Cache | undefined

const joinPath = (root: string, file: string): string => `${root.replace(/[\\/]+$/, '')}/${file}`

/** The style sections of a Markdown file: each matching heading down to the next heading of its level or above. */
const styleSections = (markdown: string): string => {
  const lines = markdown.split(/\r?\n/)
  const taken: string[][] = []
  let current: string[] | undefined
  let level = 0
  let isFenced = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) isFenced = !isFenced
    const heading = isFenced ? null : HEADING.exec(line)
    if (heading !== null) {
      const depth = heading[1]?.length ?? 1
      if (current !== undefined && depth <= level) current = undefined
      if (current === undefined && STYLE_HEADING.test(heading[2] ?? '')) {
        current = []
        level = depth
        taken.push(current)
      }
    }
    current?.push(line)
  }
  return taken
    .map(section => section.join('\n').trim())
    .join('\n\n')
    .trim()
}

/** Cuts `text` to `max` characters, at a line break when one is near. */
const cut = (text: string, max: number): { text: string; leftOut: number } => {
  if (text.length <= max) return { text, leftOut: 0 }
  const lineBreak = text.lastIndexOf('\n', max)
  const end = lineBreak > max * 0.8 ? lineBreak : max
  return { text: text.slice(0, end).trimEnd(), leftOut: text.length - end }
}

const sectionText = (guide: Guide): string => {
  const { text, leftOut } = cut(guide.text, settings.maxChars)
  const source = guide.isSection ? `the style sections of ${guide.file}` : guide.file
  return [
    '# Project house style',
    `This project keeps a style guide (${source}). Follow it in the code, comments, tests, commit messages and docs you write in this repository; where it differs from your own defaults, the guide wins. Apply it quietly rather than restating it to the user.`,
    '',
    `<house-style source="${guide.file}">`,
    text,
    leftOut > 0 ? `\n[… ${leftOut} more characters of ${guide.file} were left out; read the file for the rest.]` : undefined,
    '</house-style>',
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

/** Finds the guide under the project root, re-reading a file only when its mtime or size changed. */
async function refresh($: EngineInterface): Promise<Guide | null> {
  const root = await $.session.root()
  const previous = cache?.root === root ? cache : undefined
  const empty: Record<string, number> = {}
  for (const file of settings.files) {
    const path = joinPath(root, file)
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat === undefined || stat.kind !== 'file') continue
    const known = previous?.guide
    if (known?.file === file && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
      cache = { root, guide: known, empty: { ...previous?.empty, ...empty } }
      return known
    }
    if (previous?.empty[file] === stat.mtimeMs) {
      empty[file] = stat.mtimeMs
      continue
    }
    const raw = await $.fs.read(path).catch(() => undefined)
    if (raw === undefined) continue
    const isSection = SECTIONED_FILE.test(file)
    const text = (isSection ? styleSections(raw) : raw).trim()
    if (text === '') {
      empty[file] = stat.mtimeMs
      continue
    }
    const guide: Guide = { file, mtimeMs: stat.mtimeMs, size: stat.size, text, isSection }
    cache = { root, guide, empty }
    return guide
  }
  cache = { root, guide: null, empty }
  return null
}

async function refreshQuietly($: EngineInterface): Promise<Guide | null> {
  try {
    return await refresh($)
  } catch (error) {
    $.ui.log(`house-style: could not read the style guide: ${String(error)}`, { to: 'debug' })
    return cache?.guide ?? null
  }
}

export const register: Register = (on, options) => {
  const configured = typeof options.files === 'string' ? options.files.split(',').map(file => file.trim()) : []
  settings.files = [...new Set([...configured.filter(file => file !== ''), ...DEFAULT_FILES])]
  settings.maxChars =
    typeof options.maxChars === 'number' && options.maxChars >= MIN_MAX_CHARS
      ? Math.floor(options.maxChars)
      : DEFAULT_MAX_CHARS

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Show the project's house style that goes into the system prompt",
      argumentHint: '[reload]',
    })
    const started = await next(e)
    await refreshQuietly($)
    return started
  })

  on('turn.start', async ($, e, next) => {
    await refreshQuietly($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare')) return composed
    const guide = cache === undefined ? await refreshQuietly($) : cache.guide
    if (guide === null) return composed
    return {
      sections: [
        ...composed.sections.filter(section => section.id !== SECTION_ID),
        { id: SECTION_ID, text: sectionText(guide), scope: 'session' },
      ],
    }
  })

  on('command.run', { command: COMMAND }, async $ => {
    const guide = await refresh($)
    if (guide === null) {
      const looked = settings.files.map(file => (SECTIONED_FILE.test(file) ? `a style section in ${file}` : file))
      return {
        text: `No style guide found under ${cache?.root ?? 'the project root'}; looked for ${looked.join(', ')}. Nothing is injected.`,
      }
    }
    const injected = sectionText(guide)
    const { leftOut } = cut(guide.text, settings.maxChars)
    const lines = guide.text.split('\n')
    const preview = lines.slice(0, PREVIEW_LINES)
    return {
      text: [
        `Injecting ${guide.isSection ? `the style sections of ${guide.file}` : guide.file} into the system prompt` +
          ` (${injected.length.toLocaleString('en-US')} characters, about ${Math.ceil(injected.length / CHARS_PER_TOKEN).toLocaleString('en-US')} tokens` +
          `${leftOut > 0 ? `; ${leftOut.toLocaleString('en-US')} characters over the limit left out` : ''}).`,
        '',
        ...preview.map(line => `  ${line}`),
        lines.length > preview.length ? `  … ${lines.length - preview.length} more lines` : undefined,
      ]
        .filter(line => line !== undefined)
        .join('\n'),
    }
  })
}
