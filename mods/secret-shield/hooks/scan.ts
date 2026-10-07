import { findSecrets } from './shared/secrets'

export type Finding = {
  /** The shared rule's kind (`aws-key`, `github-token`, `secret`, ...), for mods-hub's events. */
  kind: string
  /** What it is, for people: `AWS access key`. */
  pattern: string
  line: number
  preview: string
}

/** The shared rules (shared/secrets) by kind, named for the refusal. */
const NAMES: Readonly<Record<string, string>> = {
  'aws-key': 'AWS access key',
  'github-token': 'GitHub token',
  'anthropic-key': 'Anthropic API key',
  'openai-key': 'OpenAI API key',
  'stripe-key': 'Stripe live key',
  'slack-token': 'Slack token',
  'google-api-key': 'Google API key',
  'private-key': 'private key (PEM)',
  jwt: 'JSON web token',
  secret: 'high-entropy secret assignment',
}
/** The generic `NAME_SECRET = value` rule: made-up values in a template are expected, so only key formats count there. */
const ASSIGNMENT_KIND = 'secret'
const SECRETS_ONLY = new Set(['secrets'] as const)
const MAX_PREVIEW = 120

/** Shows enough of a secret to recognise it, never all of it. */
export function mask(text: string): string {
  const masked = text.trim().replace(/[A-Za-z0-9+/=_.-]{12,}/g, token => `${token.slice(0, 4)}…[${token.length}]`)
  return masked.length > MAX_PREVIEW ? `${masked.slice(0, MAX_PREVIEW)}…` : masked
}

/** Files meant to be committed with made-up values: `.env.example`, `config.sample.yml`, `settings.dist`, `app.template.json`. */
const TEMPLATE_FILE = /\.(?:example|sample|template|dist|tmpl)(?:\.[^./\\]+)?$/i

export const isTemplatePath = (path: string): boolean => TEMPLATE_FILE.test(path)

/**
 * One finding per offending line, from the shared secret rules (placeholders such as `changeme`, `AKIA…EXAMPLE`
 * and `process.env.X` are not secrets). `allowlist` exempts a matching value or line.
 */
export function findLeaks(text: string, allowlist: RegExp | undefined, isTemplate = false): Finding[] {
  const lines = text.split('\n')
  const findings: Finding[] = []
  const seen = new Set<number>()
  for (const found of findSecrets(text, { enabled: SECRETS_ONLY, ...(allowlist === undefined ? {} : { allowlist }) })) {
    if (seen.has(found.line) || (isTemplate && found.kind === ASSIGNMENT_KIND)) continue
    const line = (lines[found.line - 1] ?? '').replace(/\r$/, '')
    if (allowlist?.test(line) === true) continue
    seen.add(found.line)
    findings.push({ kind: found.kind, pattern: NAMES[found.kind] ?? found.kind, line: found.line, preview: mask(line) })
  }
  return findings
}
