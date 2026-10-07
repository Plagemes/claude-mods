import type { EngineInterface, Register } from 'claude-code'

import { checkComponent, nextProjectDir } from './component'
import type { Finding } from './component'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const APP_FILE = /\.(?:[jt]sx?|mjs)$/
const MAX_LISTED = 8

/** Whether each folder checked so far has a package.json that lists `next`. */
type Known = Map<string, boolean>

async function isNextProject($: EngineInterface, dir: string, known: Known): Promise<boolean> {
  const cached = known.get(dir)
  if (cached !== undefined) return cached
  let isNext = false
  try {
    const pkg: unknown = JSON.parse(await $.fs.read(`${dir}/package.json`))
    const deps = typeof pkg === 'object' && pkg !== null ? pkg : {}
    isNext = ['dependencies', 'devDependencies', 'peerDependencies'].some(field => {
      const group = (deps as Record<string, unknown>)[field]
      return typeof group === 'object' && group !== null && 'next' in group
    })
  } catch {
    isNext = false
  }
  known.set(dir, isNext)
  return isNext
}

async function check($: EngineInterface, file: string, hintUnneeded: boolean, known: Known): Promise<Finding[]> {
  const dir = nextProjectDir(file)
  if (dir === undefined || !APP_FILE.test(file) || !(await isNextProject($, dir === '' ? '/' : dir, known))) return []
  return checkComponent(await $.fs.read(file), file, { hintUnneeded })
}

const describe = ({ kind, line, message }: Finding): string =>
  `  ${kind === 'needless-client' ? 'hint' : 'warn'}${line > 0 ? ` (line ${line})` : ''}: ${message}`

export const register: Register = (on, options) => {
  const hintUnneeded = options.hintUnneeded !== false
  const known: Known = new Map()

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const file = 'file_path' in e ? e.file_path : undefined
    if (typeof file !== 'string' || ran.deny !== undefined || ran.isError === true) return ran
    if ('_host' in e && e._host !== undefined) return ran

    const found = await check($, file, hintUnneeded, known).catch((): Finding[] => [])
    if (found.length === 0) return ran

    const name = file.split(/[\\/]/).at(-1) ?? file
    const noun = found.length === 1 ? 'note' : 'notes'
    const more = found.length > MAX_LISTED ? [`  (+${found.length - MAX_LISTED} more)`] : []
    $.ui.toast(`${found.length} 'use client' ${noun} for ${name}`)
    return {
      ...ran,
      context: [...(ran.context ?? []), [`next-guard: ${found.length} ${noun} on ${file}:`, ...found.slice(0, MAX_LISTED).map(describe), ...more].join('\n')],
    }
  })
}
