import type { EngineInterface, Register } from 'claude-code'

import { COVERED_BY_HADOLINT, lintDockerfile } from './dockerfile'
import type { Rule } from './dockerfile'
import { parseHadolint } from './hadolint'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const DOCKERFILE = /(?:^|[\\/])(?:Dockerfile|Containerfile)(?:\.[\w.-]+)?$|\.dockerfile$/i
const HADOLINT_TIMEOUT_MS = 15000
const MAX_LISTED = 12

type Line = { line: number; text: string }

type Memory = { isHadolintMissing: boolean }

/** hadolint's findings for the file as lines, or undefined when it is not installed or gave no JSON. */
async function runHadolint($: EngineInterface, file: string, memory: Memory): Promise<Line[] | undefined> {
  if (memory.isHadolintMissing) return undefined
  try {
    const { stdout } = await $.process.run(['hadolint', '--no-color', '--format', 'json', file], { timeoutMs: HADOLINT_TIMEOUT_MS })
    return parseHadolint(stdout)?.map(({ code, line, message }) => ({ line, text: `${message} [${code}]` }))
  } catch (error) {
    if (String(error).includes('ENOENT')) memory.isHadolintMissing = true
    return undefined
  }
}

async function lint($: EngineInterface, file: string, ignored: ReadonlySet<string>, useHadolint: boolean, memory: Memory): Promise<Line[]> {
  const text = await $.fs.read(file)
  const builtIn = lintDockerfile(text).filter(finding => !ignored.has(finding.rule))
  const external = useHadolint ? await runHadolint($, file, memory) : undefined
  if (external === undefined) return builtIn.map(({ line, message }) => ({ line, text: message }))

  const covered: readonly Rule[] = COVERED_BY_HADOLINT
  const own = builtIn.filter(finding => !covered.includes(finding.rule)).map(({ line, message }) => ({ line, text: message }))
  const theirs = external.filter(({ text: message }) => ![...ignored].some(code => message.toUpperCase().includes(`[${code.toUpperCase()}]`)))
  return [...theirs, ...own].sort((a, b) => a.line - b.line)
}

export const register: Register = (on, options) => {
  const ignored = new Set(
    String(options.ignore ?? '')
      .split(',')
      .map(rule => rule.trim())
      .filter(rule => rule !== ''),
  )
  const useHadolint = options.useHadolint !== false
  const memory: Memory = { isHadolintMissing: false }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const file = 'file_path' in e ? e.file_path : undefined
    if (typeof file !== 'string' || !DOCKERFILE.test(file) || ran.deny !== undefined || ran.isError === true) return ran
    if ('_host' in e && e._host !== undefined) return ran

    const found = await lint($, file, ignored, useHadolint, memory).catch((): Line[] => [])
    if (found.length === 0) return ran

    const name = file.split(/[\\/]/).at(-1) ?? file
    const listed = found.slice(0, MAX_LISTED).map(({ line, text }) => `  line ${line}: ${text}`)
    const more = found.length > MAX_LISTED ? [`  (+${found.length - MAX_LISTED} more)`] : []
    $.ui.toast(`${found.length} Dockerfile ${found.length === 1 ? 'issue' : 'issues'} in ${name}`)
    return {
      ...ran,
      context: [...(ran.context ?? []), [`docker-lint: ${found.length} ${found.length === 1 ? 'issue' : 'issues'} in ${file}:`, ...listed, ...more].join('\n')],
    }
  })
}
