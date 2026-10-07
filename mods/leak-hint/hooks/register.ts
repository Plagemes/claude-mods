import type { EngineInterface, Register } from 'claude-code'

import { findLeaks, introducedLeaks } from './scan'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i
/** Code nobody edits for its leaks: dependencies, build output, tests and mocks. */
const NOT_CHECKED = /(?:^|[\\/])(?:node_modules|dist|build|coverage|\.next|\.nuxt|__tests__|__mocks__|vendor)[\\/]|\.(?:test|spec|stories|d|min)\.[cm]?[jt]sx?$/i
const MAX_FILE_CHARS = 400_000
const MAX_REPORTED = 3
const MAX_TOAST_MESSAGE = 90

const compile = (source: string): RegExp | undefined => {
  try {
    return source === '' ? undefined : new RegExp(source)
  } catch {
    return undefined
  }
}

const readCode = ($: EngineInterface, path: string): Promise<string | undefined> =>
  $.fs.read(path).then(
    text => (text.length > MAX_FILE_CHARS ? undefined : text),
    () => undefined,
  )

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export const register: Register = (on, options) => {
  const ignore = compile(String(options.ignore ?? ''))

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Readonly<Record<string, unknown>> = e
    const path = typeof input.file_path === 'string' ? input.file_path : ''
    if (!CODE_FILE.test(path) || NOT_CHECKED.test(path) || ignore?.test(path) === true) return next(e)

    // What the file said before the edit tells what the edit brought in, and what was already there.
    const before = (await readCode($, path)) ?? ''
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const after = await readCode($, path)
    if (after === undefined) return ran
    const found = introducedLeaks(findLeaks(before), findLeaks(after))
    const [first] = found
    if (first === undefined) return ran

    const name = path.split(/[\\/]/).at(-1) ?? path
    const more = found.length > 1 ? ` (+${found.length - 1} more)` : ''
    $.ui.toast(`possible leak in ${name}:${first.line}${more}: ${clip(first.message, MAX_TOAST_MESSAGE)}`)

    const lines = found.slice(0, MAX_REPORTED).map(leak => `- line ${leak.line}: ${leak.message}`)
    const note = [
      `leak-hint: this edit to ${path} may have introduced a leak (found by pattern, so check it):`,
      ...lines,
      ...(found.length > MAX_REPORTED ? [`- (+${found.length - MAX_REPORTED} more)`] : []),
      'If it is real, add the cleanup now; if the listener has to live as long as the page, say so in a comment.',
    ].join('\n')
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}
