import type { EngineInterface, Register } from 'claude-code'

import { checkWorkflow, parseActionlint } from './workflow'
import type { Finding } from './workflow'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const WORKFLOW = /(?:^|[\\/])\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/
const ACTIONLINT_TIMEOUT_MS = 15000
const MAX_LISTED = 12

type Memory = { isActionlintMissing: boolean }

/** actionlint's problems for the file, or none when it is not installed (it is then not asked again). */
async function runActionlint($: EngineInterface, file: string, memory: Memory): Promise<Finding[]> {
  if (memory.isActionlintMissing) return []
  try {
    const { stdout } = await $.process.run(['actionlint', '-oneline', '-no-color', file], { timeoutMs: ACTIONLINT_TIMEOUT_MS })
    return parseActionlint(stdout).map(({ line, message }) => ({ line, severity: 'error', message: `actionlint: ${message}` }))
  } catch (error) {
    if (String(error).includes('ENOENT')) memory.isActionlintMissing = true
    return []
  }
}

async function check($: EngineInterface, file: string, requireSha: boolean, useActionlint: boolean, memory: Memory): Promise<Finding[]> {
  const text = await $.fs.read(file)
  const external = useActionlint ? await runActionlint($, file, memory) : []
  return [...checkWorkflow(text, { requireSha }), ...external].sort((a, b) => a.line - b.line)
}

const describe = ({ line, severity, message }: Finding): string => `  ${line === 0 ? 'file' : `line ${line}`} [${severity}]: ${message}`

export const register: Register = (on, options) => {
  const requireSha = options.requireSha === true
  const useActionlint = options.useActionlint !== false
  const memory: Memory = { isActionlintMissing: false }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const file = 'file_path' in e ? e.file_path : undefined
    if (typeof file !== 'string' || !WORKFLOW.test(file) || ran.deny !== undefined || ran.isError === true) return ran
    if ('_host' in e && e._host !== undefined) return ran

    const found = await check($, file, requireSha, useActionlint, memory).catch((): Finding[] => [])
    if (found.length === 0) return ran

    const name = file.split(/[\\/]/).at(-1) ?? file
    const noun = found.length === 1 ? 'issue' : 'issues'
    const more = found.length > MAX_LISTED ? [`  (+${found.length - MAX_LISTED} more)`] : []
    $.ui.toast(`${found.length} workflow ${noun} in ${name}`)
    return {
      ...ran,
      context: [...(ran.context ?? []), [`ci-yaml-check: ${found.length} ${noun} in ${file}:`, ...found.slice(0, MAX_LISTED).map(describe), ...more].join('\n')],
    }
  })
}
