/** Which userConfig toggle a rule belongs to. */
export type Category = 'secrets' | 'emails' | 'phones' | 'ibans' | 'cards' | 'privateIps'

/** One detector: the label it masks with, its pattern and an optional check on the match. */
type Rule = {
  kind: string
  category: Category
  pattern: RegExp
  /** Capture group holding the value to mask; the rest of the match is kept (default: whole match). */
  group?: number
  isValid?: (value: string) => boolean
}

export type RedactOptions = {
  enabled: ReadonlySet<Category>
  allowlist: RegExp | undefined
}

export type Redaction = { text: string; counts: Record<string, number> }

const MIN_SECRET_LENGTH = 12
const MIN_SECRET_ENTROPY = 3.3
const PLACEHOLDER_VALUE = /^(?:x+|\*+|\.+|<[^>]*>|\$\{?.*|%[^%]*%|changeme|redacted|your[-_].*|example.*|null|none|true|false|undefined)$/i
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/

const shannonEntropy = (value: string): number => {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/** A token-like value: long, letters and digits mixed, random-looking, not a placeholder or a code reference. */
const looksLikeSecretValue = (value: string): boolean =>
  value.length >= MIN_SECRET_LENGTH &&
  /\d/.test(value) &&
  /[A-Za-z]/.test(value) &&
  !PLACEHOLDER_VALUE.test(value) &&
  !DOTTED_IDENTIFIER.test(value) &&
  shannonEntropy(value) >= MIN_SECRET_ENTROPY

const digitsOf = (value: string): string => value.replace(/\D/g, '')

/** Luhn checksum over the digits of `value`. */
export const passesLuhn = (value: string): boolean => {
  const digits = digitsOf(value)
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return digits.length > 0 && sum % 10 === 0
}

/** Issuer prefixes and lengths of the major card networks, so long numbers (timestamps, ids) are not mistaken. */
const CARD_SHAPES: readonly { prefix: RegExp; lengths: readonly number[] }[] = [
  { prefix: /^4/, lengths: [13, 16, 19] },
  { prefix: /^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/, lengths: [16] },
  { prefix: /^3[47]/, lengths: [15] },
  { prefix: /^(?:6011|65|64[4-9])/, lengths: [16, 19] },
  { prefix: /^3(?:0[0-5]|[68])/, lengths: [14] },
  { prefix: /^35(?:2[89]|[3-8]\d)/, lengths: [16] },
]

const isCardNumber = (value: string): boolean => {
  const digits = digitsOf(value)
  const hasShape = CARD_SHAPES.some(
    shape => shape.prefix.test(digits) && shape.lengths.includes(digits.length),
  )
  return hasShape && passesLuhn(digits)
}

/** IBAN mod-97 check (ISO 13616), computed piecewise to stay inside safe integers. */
export const isIban = (value: string): boolean => {
  const compact = value.replace(/\s/g, '').toUpperCase()
  if (compact.length < 15 || compact.length > 34) return false
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const char of rearranged) {
    const code = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

const hasPhoneDigitCount = (value: string): boolean => {
  const count = digitsOf(value).length
  return count >= 10 && count <= 15
}

/**
 * Order matters: multi-line and specific shapes first, so generic rules never see a half-masked token.
 * Repetitions are bounded so a pathological line (a long dotted or dashed run) stays linear to scan.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'private-key',
    category: 'secrets',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: 'aws-key', category: 'secrets', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', category: 'secrets', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: 'anthropic-key', category: 'secrets', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', category: 'secrets', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'stripe-key', category: 'secrets', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { kind: 'slack-token', category: 'secrets', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-api-key', category: 'secrets', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', category: 'secrets', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: 'secret',
    category: 'secrets',
    pattern: /\b[A-Za-z0-9_-]{0,40}(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Za-z0-9_-]{0,40}["']?[ \t]{0,4}[:=][ \t]{0,4}["']?([A-Za-z0-9_\-+/=.~]{1,512})/gi,
    group: 1,
    isValid: looksLikeSecretValue,
  },
  {
    kind: 'card',
    category: 'cards',
    pattern: /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g,
    isValid: isCardNumber,
  },
  {
    kind: 'iban',
    category: 'ibans',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    isValid: isIban,
  },
  {
    kind: 'email',
    category: 'emails',
    pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g,
  },
  {
    kind: 'phone',
    category: 'phones',
    pattern: /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?)(?:[ .-]?\d{2,5}){1,4}(?![\w])|(?<![\w.-])(?:\(\d{3}\) ?|\d{3}[.-])\d{3}[.-]\d{4}(?![\w.-])/g,
    isValid: hasPhoneDigitCount,
  },
  {
    kind: 'private-ip',
    category: 'privateIps',
    pattern: /(?<![\d.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?![\d.])/g,
    isValid: value => value.split('.').every(part => Number(part) <= 255),
  },
]

export const ALL_CATEGORIES: readonly Category[] = ['secrets', 'emails', 'phones', 'ibans', 'cards', 'privateIps']

export const mask = (kind: string): string => `[REDACTED:${kind}]`

/** Masks every enabled kind in `text`; `counts` says how many of each were masked. */
export const redactText = (text: string, options: RedactOptions): Redaction => {
  const counts: Record<string, number> = {}
  let result = text
  for (const rule of RULES) {
    if (!options.enabled.has(rule.category)) continue
    result = result.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      const value = rule.group === undefined ? match : groups[rule.group - 1]
      if (typeof value !== 'string' || value === '') return match
      if (rule.isValid !== undefined && !rule.isValid(value)) return match
      if (options.allowlist?.test(value) === true) return match
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1
      return rule.group === undefined ? mask(rule.kind) : match.slice(0, match.length - value.length) + mask(rule.kind)
    })
  }
  return { text: result, counts }
}
