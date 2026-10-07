import type { DevServerLine } from '../types'

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const ERROR = /\b\w*(?:error|exception)s?\b|\b(?:traceback|fatal|panic|uncaught|unhandled|failed to compile|failed to start|cannot find module|module not found|segmentation fault|EADDRINUSE|ECONNREFUSED)\b|\bERR!|[✘✖⨯]/i
const NOT_AN_ERROR = /\b(?:0|no|zero|without)\s+(?:errors?|problems?)\b|\berrors?:\s*0\b|\berror[-_ ]?(?:boundary|handler|page|overlay)\b/i
const WARNING = /\bwarn(?:ing)?s?\b|⚠/i
const URL_IN_TEXT = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]+\.(?:local|localhost|test)|\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})(?:\/[^\s'"`)\]>]*)?/i
const PORT_IN_TEXT = /\b(?:listening|running|started|serving|server|available|ready)\b[^\n]*?\bport\b\s*[:=]?\s*(\d{2,5})\b/i
/** Stack frames, traceback lines and code frames: the lines that explain an error. */
const STACK = /^\s*(?:at\s|File\s"|Traceback|During handling|The above exception|Caused by|\^+\s*$|~+\s*$|>?\s*\d+\s*\||\|)/
const FRAME = /^\s+(?:at\s|File\s")/
const TRACEBACK = /^\s*Traceback \(most recent call last\)/

export const MAX_BLOCK_LINES = 60
const MAX_REACH = 30

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** How a line of server output reads: an error, a warning, or plain output. */
export const kindOf = (line: string): DevServerLine['kind'] => {
  if (FRAME.test(line)) return 'info'
  if (ERROR.test(line) && !NOT_AN_ERROR.test(line)) return 'error'
  return WARNING.test(line) ? 'warning' : 'info'
}

/**
 * Splits a piece of output into whole lines, keeping the unfinished tail for
 * the next piece. Colors are stripped and a carriage return keeps what was
 * written after it, as a terminal shows a redrawn progress line.
 */
export const splitLines = (partial: string, text: string): { lines: string[]; partial: string } => {
  const parts = (partial + text).split('\n')
  const rest = parts.pop() ?? ''
  const lines = parts.map(part => {
    const clean = stripAnsi(part)
    const redrawn = clean.replace(/\r+$/, '')
    return redrawn.slice(redrawn.lastIndexOf('\r') + 1).replace(CONTROL, '')
  })
  return { lines, partial: rest }
}

/** The address a line says the server listens on (`http://localhost:5173/`), 0.0.0.0 read as localhost. */
export const findUrl = (line: string): string | undefined => {
  const url = URL_IN_TEXT.exec(line)
  if (url !== null) return url[0].replace(/:\/\/(?:0\.0\.0\.0|\[::\])(?=:)/, '://localhost').replace(/[.,;]+$/, '')
  const port = PORT_IN_TEXT.exec(line)
  return port === null ? undefined : `http://localhost:${port[1]}`
}

/**
 * The last error the server printed with the lines that explain it: the
 * stack or traceback around the last error line, at most MAX_BLOCK_LINES.
 */
export const lastErrorBlock = (lines: readonly DevServerLine[]): string | undefined => {
  let index = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.kind === 'error') {
      index = i
      break
    }
  }
  if (index < 0) return undefined

  const isBlank = (line: DevServerLine | undefined): boolean => line === undefined || line.text.trim() === ''
  const isAbove = (line: DevServerLine | undefined): boolean => !isBlank(line) && (line?.kind === 'error' || STACK.test(line?.text ?? ''))
  const isBelow = (line: DevServerLine | undefined): boolean => isAbove(line) || /^\s+\S/.test(line?.text ?? '')

  let start = index
  // A Python traceback leads up to its error line.
  for (let i = index - 1; i >= Math.max(0, index - MAX_REACH) && !isBlank(lines[i]); i -= 1) {
    if (TRACEBACK.test(lines[i]?.text ?? '')) {
      start = i
      break
    }
  }
  while (start > 0 && index - start < MAX_REACH && isAbove(lines[start - 1])) start -= 1
  let end = index
  while (end < lines.length - 1 && end - index < MAX_REACH && isBelow(lines[end + 1])) end += 1
  // A lone line reads better with the output just before it.
  if (start === index && end === index) {
    while (start > 0 && index - start < 3 && !isBlank(lines[start - 1])) start -= 1
  }

  return lines
    .slice(start, end + 1)
    .slice(0, MAX_BLOCK_LINES)
    .map(line => line.text)
    .join('\n')
    .trim()
}
