import { redactText } from './shared/secrets'

const REDACTED = '[redacted]'
/** The shared rule set's keys and tokens only: e-mails and IPs in a command are not credentials. */
const SHARED_SECRETS = { enabled: new Set(['secrets'] as const) }
const SECRET_WORD = String.raw`(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)`
/** The most characters of one text that are looked at: a pasted megabyte costs no more than a long command. */
const SCAN_LIMIT_FACTOR = 8

/** Credential shapes that are secret wherever they appear. Each match is replaced whole. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b[sr]k_live_[0-9A-Za-z]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]
/** The user:password part of `scheme://user:password@host`. */
const URL_CREDENTIALS = /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g
/** `Authorization: Bearer abc`, `Authorization: Basic abc`, `Authorization: abc`. */
const AUTH_HEADER = /(\bAuthorization\s*[:=]\s*["']?(?:(?:Basic|Bearer|Token)\s+)?)[A-Za-z0-9._~+/=-]{8,}/gi
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g
/** `PASSWORD=hunter2`, `"api_key": "abc"`, `token: abc`; the name stays, the value goes. */
const ASSIGNMENT = new RegExp(String.raw`(${SECRET_WORD}[\w.-]*["']?\s*[=:]\s*)(["']?)[^\s"'&;,]+\2`, 'gi')
/** `--password hunter2`, `--api-key abc`. */
const SECRET_FLAG = /(--[\w-]*(?:password|passwd|secret|token|api-?key)[\w-]*\s+)(?!-)\S+/gi
/** curl's `-u user:password` and `--user user:password`: the user stays, the password goes. */
const USER_PASSWORD = /((?:^|\s)(?:-u|--user)[\s=]+["']?[^\s:"']+:)[^\s"']+/g
/** `mysql -phunter2`: the password glued to `-p`. */
const MYSQL_PASSWORD = /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?\s-p)[^\s-]\S*/g

/**
 * Masks the credentials in `text`, so a log can hold what Claude ran without holding what it was trusted with:
 * this mod's shapes and assignments first, then the key and token rules every Claude Mod shares (`shared/secrets.ts`).
 */
export const redact = (text: string): string => {
  const masked = SECRET_SHAPES.reduce((current, shape) => current.replace(shape, REDACTED), text)
  const assigned = masked
    .replace(URL_CREDENTIALS, REDACTED)
    .replace(AUTH_HEADER, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(ASSIGNMENT, `$1$2${REDACTED}$2`)
    .replace(SECRET_FLAG, `$1${REDACTED}`)
    .replace(USER_PASSWORD, `$1${REDACTED}`)
    .replace(MYSQL_PASSWORD, `$1${REDACTED}`)
  return redactText(assigned, SHARED_SECRETS).text
}

/** One line of at most `max` characters: whitespace collapsed, the end replaced by an ellipsis when cut. */
export const clip = (text: string, max: number): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

type Input = Readonly<Record<string, unknown>>

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** What a call was about, in the words its tool uses: the command, the file, the pattern, the URL. */
const subject = (tool: string, input: Input): string | undefined => {
  switch (tool) {
    case 'Bash':
      return text(input.command)
    case 'Grep': {
      const pattern = text(input.pattern)
      const path = text(input.path)
      return pattern === undefined ? path : path === undefined ? pattern : `${pattern} in ${path}`
    }
    case 'Glob':
      return [text(input.pattern), text(input.path)].filter(Boolean).join(' in ') || undefined
    case 'WebFetch':
      return text(input.url)
    case 'WebSearch':
      return text(input.query)
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : undefined
    case 'Agent':
    case 'Task':
      return text(input.description) ?? text(input.subagent_type)
    default:
      return (
        text(input.file_path) ??
        text(input.notebook_path) ??
        text(input.path) ??
        text(input.command) ??
        text(input.url) ??
        text(input.query) ??
        text(input.pattern) ??
        text(input.description)
      )
  }
}

/**
 * A short, redacted description of a tool call's input. A tool with no obvious subject (an MCP tool, say)
 * is described by the names of its arguments only, never their values.
 */
export const summarize = (tool: string, input: Input, max: number): string => {
  const found = subject(tool, input)
  if (found !== undefined) return clip(redact(found.slice(0, max * SCAN_LIMIT_FACTOR)), max)
  const names = Object.keys(input).filter(name => name !== 'tool' && name !== 'tool_use_id' && name !== 'agentId')
  return names.length === 0 ? '' : clip(`(${names.join(', ')})`, max)
}
