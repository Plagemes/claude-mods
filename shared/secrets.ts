/**
 * shared/secrets.ts — one set of secret and personal-data patterns (redactor, secret-shield, pii-in-logs,
 * whatsapp-bridge, mods-hub before anything leaves for a channel).
 *
 * Extracted from mods/redactor/hooks/patterns.ts (the rule table: bounded repetitions so a pathological line
 * stays linear, Luhn/IBAN/entropy checks) and mods/secret-shield/hooks/scan.ts (the richer placeholder list:
 * `AKIA…EXAMPLE`, `changeme`, `process.env.X` are not secrets).
 * Pure: no `$`, no I/O. Vendored into mods by scripts/sync-shared.mjs.
 */

/** Which kind of data a rule finds; mods let people switch categories on and off. */
export type SecretCategory = 'secrets' | 'emails' | 'phones' | 'ibans' | 'cards' | 'privateIps'

export type SecretFinding = {
  kind: string
  category: SecretCategory
  /** Offset of the value in the text, and its 1-based line. */
  index: number
  line: number
  /** The value with all but its first 4 characters masked: `ghp_…[40]`. */
  preview: string
}

export type RedactOptions = {
  /** The categories to act on; all of them when absent. */
  enabled?: ReadonlySet<SecretCategory>
  /** Values matching this are left alone. */
  allowlist?: RegExp
}

export type Redaction = { text: string; counts: Record<string, number> }

type Rule = {
  kind: string
  category: SecretCategory
  pattern: RegExp
  /** Capture group holding the value; the rest of the match is kept (default: the whole match). */
  group?: number
  isValid?: (value: string) => boolean
}

export const ALL_CATEGORIES: readonly SecretCategory[] = ['secrets', 'emails', 'phones', 'ibans', 'cards', 'privateIps']

const MIN_SECRET_LENGTH = 12
const MIN_SECRET_ENTROPY = 3.3
/** Fill-me-in values and references to a variable are not secrets. */
const PLACEHOLDER =
  /example|sample|placeholder|changeme|change[_-]?this|replace[_-]?(?:me|this|with)|generate[_-]?(?:with|one|me)|goes[_-]?here|dummy|fake|insecure|your[_-]|xxxx|\*{4}|<[^>]*>|process\.env|import\.meta|\$\{|os\.environ|getenv|^(?:x+|\.+|redacted|null|none|true|false|undefined)$/i
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/

export function shannonEntropy(value: string): number {
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
export const looksLikeSecretValue = (value: string): boolean =>
  value.length >= MIN_SECRET_LENGTH &&
  /\d/.test(value) &&
  /[A-Za-z]/.test(value) &&
  !PLACEHOLDER.test(value) &&
  !DOTTED_IDENTIFIER.test(value) &&
  shannonEntropy(value) >= MIN_SECRET_ENTROPY

const digitsOf = (value: string): string => value.replace(/\D/g, '')

/** Luhn checksum over the digits of `value`. */
export function passesLuhn(value: string): boolean {
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

export function isCardNumber(value: string): boolean {
  const digits = digitsOf(value)
  return CARD_SHAPES.some(shape => shape.prefix.test(digits) && shape.lengths.includes(digits.length)) && passesLuhn(digits)
}

/** IBAN mod-97 check (ISO 13616), computed piecewise to stay inside safe integers. */
export function isIban(value: string): boolean {
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

/** `+2024-01-15 10:30` (a date on an added diff line) is not a phone number. */
const DATE_LIKE = /^\+?\d{4}-\d{2}-\d{2}/

const isPhoneNumber = (value: string): boolean => {
  const count = digitsOf(value).length
  return count >= 10 && count <= 15 && !DATE_LIKE.test(value)
}

/** A documented example key (`AKIAIOSFODNN7EXAMPLE`) is not a leak. */
const notExample = (value: string): boolean => !/EXAMPLE|example/.test(value)

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
  { kind: 'aws-key', category: 'secrets', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, isValid: notExample },
  { kind: 'github-token', category: 'secrets', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: 'anthropic-key', category: 'secrets', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // Real keys always mix in digits; `sk-button-hover-variant-large` is a class name.
  { kind: 'openai-key', category: 'secrets', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, isValid: value => /\d/.test(value) },
  { kind: 'stripe-key', category: 'secrets', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { kind: 'slack-token', category: 'secrets', pattern: /\bxox[abeposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'google-api-key', category: 'secrets', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', category: 'secrets', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: 'secret',
    category: 'secrets',
    pattern: /\b[A-Za-z0-9_-]{0,40}(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Za-z0-9_-]{0,40}["']?[ \t]{0,4}[:=][ \t]{0,4}["']?([A-Za-z0-9_\-+/=.~]{1,512})/gi,
    group: 1,
    isValid: looksLikeSecretValue,
  },
  { kind: 'card', category: 'cards', pattern: /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g, isValid: isCardNumber },
  { kind: 'iban', category: 'ibans', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, isValid: isIban },
  { kind: 'email', category: 'emails', pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g },
  {
    kind: 'phone',
    category: 'phones',
    pattern: /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?)(?:[ .-]?\d{2,5}){1,4}(?![\w])|(?<![\w.-])(?:\(\d{3}\) ?|\d{3}[.-])\d{3}[.-]\d{4}(?![\w.-])/g,
    isValid: isPhoneNumber,
  },
  {
    kind: 'private-ip',
    category: 'privateIps',
    pattern: /(?<![\d.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?![\d.])/g,
    isValid: value => value.split('.').every(part => Number(part) <= 255),
  },
]

export const mask = (kind: string): string => `[REDACTED:${kind}]`

/** Shows enough of a value to recognise it, never all of it: `ghp_…[40]`. */
export const preview = (value: string): string => (value.length <= 4 ? '…' : `${value.slice(0, 4)}…[${value.length}]`)

const isOn = (rule: Rule, options: RedactOptions): boolean => options.enabled === undefined || options.enabled.has(rule.category)

/** Masks every enabled kind in `text`; `counts` says how many of each were masked. */
export function redactText(text: string, options: RedactOptions = {}): Redaction {
  const counts: Record<string, number> = {}
  let result = text
  for (const rule of RULES) {
    if (!isOn(rule, options)) continue
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

/** Every enabled finding in `text`, in order of position (a value found by two rules is reported once). */
export function findSecrets(text: string, options: RedactOptions = {}): SecretFinding[] {
  const newlines: number[] = []
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) newlines.push(at)
  const lineOf = (offset: number): number => {
    let low = 0
    let high = newlines.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((newlines[middle] ?? Infinity) < offset) low = middle + 1
      else high = middle
    }
    return low + 1
  }
  const findings: SecretFinding[] = []
  const taken: [number, number][] = []
  for (const rule of RULES) {
    if (!isOn(rule, options)) continue
    for (const match of text.matchAll(rule.pattern)) {
      const value = rule.group === undefined ? match[0] : match[rule.group]
      if (value === undefined || value === '') continue
      if (rule.isValid !== undefined && !rule.isValid(value)) continue
      if (options.allowlist?.test(value) === true) continue
      const index = (match.index ?? 0) + (rule.group === undefined ? 0 : match[0].length - value.length)
      if (taken.some(([start, end]) => index < end && index + value.length > start)) continue
      taken.push([index, index + value.length])
      findings.push({ kind: rule.kind, category: rule.category, index, line: lineOf(index), preview: preview(value) })
    }
  }
  return findings.sort((a, b) => a.index - b.index)
}

/** Whether `text` holds anything of the `secrets` category (keys, tokens, private keys). */
export const hasSecret = (text: string): boolean => findSecrets(text, { enabled: new Set(['secrets']) }).length > 0
