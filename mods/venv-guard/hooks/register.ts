import type { EngineInterface, Register } from 'claude-code'

import { findGlobalInstall } from './pip'

const ENVIRONMENT_FOLDERS = ['.venv', 'venv']
const MAX_SHOWN = 70
const PIP_WORDS = /\bpip\d*\b|-m\s+pip\b/

/** Whether the process the Bash tool inherits from already runs inside a virtualenv or a named conda env. */
async function isEnvironmentActive($: EngineInterface): Promise<boolean> {
  if (((await $.env.get('VIRTUAL_ENV')) ?? '') !== '') return true
  const prefix = (await $.env.get('CONDA_PREFIX')) ?? ''
  return prefix !== '' && (await $.env.get('CONDA_DEFAULT_ENV')) !== 'base'
}

/** The project's own environment folder (`.venv` or `venv`) in the working directory, if there is one. */
async function projectEnvironment($: EngineInterface): Promise<string | undefined> {
  try {
    const entries = await $.fs.list(await $.session.cwd())
    return ENVIRONMENT_FOLDERS.find(name => entries.some(entry => entry.name === name && entry.kind === 'dir'))
  } catch {
    return undefined
  }
}

function refusal(offender: string, folder: string | undefined): string {
  const shown = offender.length > MAX_SHOWN ? `${offender.slice(0, MAX_SHOWN)}...` : offender
  const how =
    folder === undefined
      ? 'Create one first: python3 -m venv .venv && source .venv/bin/activate && pip install ... (or: uv venv && uv pip install ...).'
      : `This project has ${folder}/: run source ${folder}/bin/activate && pip install ... (or ${folder}/bin/pip install ...), or use uv pip install.`
  return `venv-guard: no virtualenv is active, so "${shown}" would install into the system Python. ${how} If a global install is really wanted, the user can turn on allowGlobal in the mod's settings.`
}

export const register: Register = (on, options) => {
  const isAllowed = options.allowGlobal === true

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isAllowed) return next(e)
    const offender = findGlobalInstall(e.command)
    if (offender === undefined || (await isEnvironmentActive($))) return next(e)
    return { deny: refusal(offender, await projectEnvironment($)) }
  }).catch(($, e, next) =>
    next.called || isAllowed || !PIP_WORDS.test(e.command) ? next(e) : { deny: 'venv-guard: its check failed, so the pip command was blocked.' },
  )
}
