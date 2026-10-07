import { redactText } from './patterns'
import type { Category } from './patterns'

/** What leaves the machine for the owner: secrets, card numbers, IBANs and private keys are always masked. */
const OWNER_KINDS: ReadonlySet<Category> = new Set(['secrets', 'cards', 'ibans'])
/** Group members get everything masked: personal data and private addresses too. */
const MEMBER_KINDS: ReadonlySet<Category> = new Set(['secrets', 'cards', 'ibans', 'emails', 'phones', 'privateIps'])

const COST_FIGURE = /(?:US)?\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|€|dollars?|euros?)\b|€\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,.]*\s?[kKmM]?\s?tokens?\b/g
const CODE_FENCE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE_LONG = /`[^`\n]{60,}`/g
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*\S.*$/gm
const ABSOLUTE_PATH = /(?<![\w.~-])(?:\/(?:Users|home|root|etc|var|opt|private|tmp|usr|mnt|Volumes)\/[^\s'"`)\]]+|[A-Za-z]:\\[^\s'"`)\]]+|~\/[^\s'"`)\]]+)/g

export type Audience = 'owner' | 'member'

export type CleanOptions = {
  audience: Audience
  maxChars: number
  /** The project root: paths under it are shown relative to it, every other absolute path is hidden. */
  root?: string
  /** Members only: keep code blocks (the `shareCodeWithMembers` option). */
  shareCode?: boolean
}

export type Cleaned = { text: string; masked: number }

/** Shortens `text` to `max` characters on a word boundary, saying it was cut. */
export const cap = (text: string, max: number): string => {
  if (text.length <= max) return text
  const cut = text.slice(0, Math.max(0, max - 14))
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()} …(truncated)`
}

const relativize = (text: string, root: string | undefined): string => {
  if (root === undefined || root === '' || root === '/') return text
  const prefix = root.endsWith('/') ? root : `${root}/`
  return text.split(prefix).join('./')
}

/**
 * Makes a text safe to send: masks secrets (always), and for members also personal data, cost and token
 * figures, absolute paths outside the project, env-style assignments and code blocks. Then caps its length.
 */
export const clean = (input: string, options: CleanOptions): Cleaned => {
  const isMember = options.audience === 'member'
  let text = relativize(input, options.root)
  const redacted = redactText(text, { enabled: isMember ? MEMBER_KINDS : OWNER_KINDS, allowlist: undefined })
  text = redacted.text
  let masked = Object.values(redacted.counts).reduce((sum, n) => sum + n, 0)
  const count = (pattern: RegExp, replacement: string): void => {
    text = text.replace(pattern, () => {
      masked += 1
      return replacement
    })
  }
  if (isMember) {
    if (options.shareCode !== true) {
      count(CODE_FENCE, '[code omitted]')
      count(INLINE_CODE_LONG, '[code omitted]')
    }
    count(ENV_ASSIGNMENT, '[config value omitted]')
    count(COST_FIGURE, '[figure omitted]')
    count(ABSOLUTE_PATH, '[path omitted]')
  }
  return { text: cap(text.trim(), options.maxChars), masked }
}

/** One line, at most `max` characters: for logs, status lines and previews. */
export const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}
