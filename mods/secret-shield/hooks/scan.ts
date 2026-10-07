export type Finding = {
  pattern: string
  line: number
  preview: string
}

type Rule = { name: string; regex: RegExp }

// Order matters: the first rule that matches a line wins (sk-ant- before sk-).
const RULES: readonly Rule[] = [
  { name: 'AWS access key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'Stripe live key', regex: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
  { name: 'Slack token', regex: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'private key (PEM)',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
]

// NAME_KEY = "value", SECRET: 'value', apiToken=value ...
const GENERIC_ASSIGNMENT =
  /\b[A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?([A-Za-z0-9+/=_.-]{20,})["']?/i

// Documentation keys (AKIA...EXAMPLE) and references to a variable are not secrets.
const PLACEHOLDER = /example|sample|placeholder|changeme|your[_-]|xxxx|\*{4}|<[^>]*>|process\.env|import\.meta|\$\{|os\.environ|getenv/i
const MAX_PREVIEW = 120
const MIN_ENTROPY_BITS = 3.5

function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length)
  return bits
}

function looksRandom(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value) && entropy(value) >= MIN_ENTROPY_BITS
}

/** Shows enough of a secret to recognise it, never all of it. */
export function mask(text: string): string {
  const masked = text.trim().replace(/[A-Za-z0-9+/=_.-]{12,}/g, token => `${token.slice(0, 4)}…[${token.length}]`)
  return masked.length > MAX_PREVIEW ? `${masked.slice(0, MAX_PREVIEW)}…` : masked
}

function matchLine(line: string): { name: string; secret: string } | undefined {
  for (const { name, regex } of RULES) {
    const hit = regex.exec(line)
    if (hit && !PLACEHOLDER.test(hit[0])) return { name, secret: hit[0] }
  }
  const assigned = GENERIC_ASSIGNMENT.exec(line)
  const value = assigned?.[1]
  if (value && !PLACEHOLDER.test(line) && looksRandom(value)) {
    return { name: 'high-entropy secret assignment', secret: value }
  }
  return undefined
}

/** One finding per offending line; `isAllowed` filters by matched secret, line or path. */
export function findSecrets(text: string, isAllowed: (secret: string, line: string) => boolean): Finding[] {
  const findings: Finding[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const hit = matchLine(line)
    if (hit && !isAllowed(hit.secret, line)) {
      findings.push({ pattern: hit.name, line: index + 1, preview: mask(line) })
    }
  })
  return findings
}
