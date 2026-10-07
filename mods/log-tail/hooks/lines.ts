import type { LogTailLine, LogTailSource } from '../types'

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
/** Log levels in capitals (`ERROR`, `[FATAL]`), `level=error` and JSON `"level":"error"`, `error:` prefixes, exceptions and crashes. */
const ERROR =
  /\b(?:ERROR|ERR|FATAL|CRIT(?:ICAL)?|EMERG(?:ENCY)?|ALERT|SEVERE|PANIC)\b|\blevel\W{0,3}(?:error|fatal|crit\w*|panic)\b|\b(?:[Ee]rror|[Ff]atal|[Pp]anic)(?::|\])|\[(?:error|crit|alert|emerg)\]|\b\w*(?:Error|Exception)\b|\b(?:[Ee]xception|Traceback|[Uu]ncaught|[Uu]nhandled|[Ss]egmentation fault|[Oo]ut of memory|OOMKilled)\b|^\s*E\d{4}\b/
const NOT_AN_ERROR = /\b(?:0|no|zero|without)\s+errors?\b|\berrors?[=:]\s*0\b/i
const WARNING = /\b(?:WARN(?:ING)?|DEPRECAT\w*)\b|\blevel\W{0,3}warn\w*\b|\bwarn(?:ing)?:|^\s*W\d{4}\b/i
const FRAME = /^\s+(?:at\s|File\s")/
const ID_CHARS = /[^A-Za-z0-9_-]+/g
const MAX_ID = 40

/** The process that follows a target, and how the tail is named. */
export type Target = { source: LogTailSource; target: string; argv: string[]; id: string }

/** The lines a filter keeps, or why it could not be read. */
export type Filter = { keeps: (text: string) => boolean; error: string | null }

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** How a log line reads: an error, a warning, or plain output (a stack frame is plain: its error is above it). */
export const kindOf = (text: string): LogTailLine['kind'] => {
  if (FRAME.test(text)) return 'info'
  if (ERROR.test(text) && !NOT_AN_ERROR.test(text)) return 'error'
  return WARNING.test(text) ? 'warning' : 'info'
}

/** Splits a piece of output into whole lines, keeping the unfinished tail for the next piece. */
export const splitLines = (partial: string, text: string): { lines: string[]; partial: string } => {
  const parts = (partial + text).split('\n')
  const rest = parts.pop() ?? ''
  const lines = parts.map(part => {
    const clean = stripAnsi(part).replace(/\r+$/, '')
    return clean.slice(clean.lastIndexOf('\r') + 1).replace(CONTROL, '')
  })
  return { lines, partial: rest }
}

/** `app.log` → `app-log`: the id a tail and its pane go by. */
export const idOf = (name: string): string => {
  const id = name.replace(ID_CHARS, '-').replace(/^-+|-+$/g, '').slice(0, MAX_ID)
  return id === '' ? 'log' : id
}

/**
 * What `/tail <arg>` follows: `docker:<container>`, `compose:<service>`, or a
 * file path (absolute, `~/`, or relative to `cwd`). Each starts with its last
 * `lines` lines and then follows.
 */
export const targetOf = (arg: string, cwd: string, home: string | undefined, lines: number): Target => {
  const docker = /^docker:(.+)$/.exec(arg)
  if (docker !== null) {
    const name = docker[1]?.trim() ?? ''
    return { source: 'docker', target: name, argv: ['docker', 'logs', '-f', '--tail', String(lines), name], id: idOf(name) }
  }
  const compose = /^compose:(.+)$/.exec(arg)
  if (compose !== null) {
    const service = compose[1]?.trim() ?? ''
    return {
      source: 'compose',
      target: service,
      argv: ['docker', 'compose', 'logs', '-f', '--tail', String(lines), '--no-color', '--no-log-prefix', service],
      id: idOf(service),
    }
  }
  const path =
    arg.startsWith('~/') && home !== undefined ? `${home.replace(/\/$/, '')}/${arg.slice(2)}` : arg.startsWith('/') ? arg : `${cwd.replace(/\/$/, '')}/${arg.replace(/^\.\//, '')}`
  return { source: 'file', target: path, argv: ['tail', '-n', String(lines), '-F', path], id: idOf(path.slice(path.lastIndexOf('/') + 1)) }
}

/** `id`, or `id-2`, `id-3`… when it is taken. */
export const uniqueId = (id: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(id)) return id
  let n = 2
  while (taken.has(`${id}-${n}`)) n += 1
  return `${id}-${n}`
}

/** A filter from what the person typed: `/regex/flags`, or a case-insensitive substring. */
export const compileFilter = (text: string): Filter => {
  const trimmed = text.trim()
  if (trimmed === '') return { keeps: () => true, error: null }
  const regex = /^\/(.+)\/([a-z]*)$/.exec(trimmed)
  if (regex === null) {
    const needle = trimmed.toLowerCase()
    return { keeps: line => line.toLowerCase().includes(needle), error: null }
  }
  try {
    const pattern = new RegExp(regex[1] ?? '', (regex[2] ?? '').replace(/[gy]/g, ''))
    return { keeps: line => pattern.test(line), error: null }
  } catch (error) {
    return { keeps: () => true, error: `Not a regex: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The lines to show: those the filter keeps, errors alone when asked. */
export const visible = (lines: readonly LogTailLine[], filter: Filter, isErrorsOnly: boolean): LogTailLine[] =>
  lines.filter(line => (!isErrorsOnly || line.kind === 'error') && filter.keeps(line.text))
