import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { nameBranch } from './slug'

const GIT_TIMEOUT_MS = 10000
const MAX_SOURCE_CHARS = 200
const USAGE = 'branch-namer: /git-branch <what you are about to do>, e.g. /git-branch fix login redirect loop. With no description it uses your last prompt.'

function isFromPerson(origin: PromptOrigin): boolean {
  return ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
}

/** After a hot reload the remembered prompt is gone, so fall back to the transcript. */
async function lastUserPrompt($: EngineInterface): Promise<string | undefined> {
  try {
    const messages = await $.session.messages()
    if (!Array.isArray(messages)) return undefined
    const typed = messages.filter(m => m.role === 'user' && m.text.trim() !== '' && !m.text.startsWith('/') && !m.toolResults?.length)
    return typed.at(-1)?.text
  } catch {
    return undefined
  }
}

async function switchToNewBranch($: EngineInterface, name: string): Promise<string> {
  try {
    const { exitCode, stderr } = await $.process.run(['git', 'switch', '-c', name], { timeoutMs: GIT_TIMEOUT_MS })
    if (exitCode === 0) return `branch-namer: created and switched to ${name}`
    if (/already exists/.test(stderr)) return `branch-namer: ${name} already exists. Make the description more specific, or git switch ${name}.`
    if (/not a git repository/i.test(stderr)) return 'branch-namer: not inside a git repository.'
    return `branch-namer: git could not create ${name}: ${stderr.trim().split('\n')[0] ?? 'unknown error'}`
  } catch {
    return 'branch-namer: could not run git.'
  }
}

export const register: Register = (on, options) => {
  const prefix = String(options.prefix ?? '')
  const maxSlugLength = Math.max(8, Number(options.maxSlugLength ?? 40))
  let lastPrompt: string | undefined

  on('session.start', async ($, e, next) => {
    // The name is spelled out here and in the command.run matcher: validate reads both as literals.
    await $.command.register({
      name: 'git-branch',
      description: 'Create and switch to a well-named git branch from a short description',
      argumentHint: '[what you are about to do]',
    })
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (isFromPerson(e.origin) && !e.text.startsWith('/')) lastPrompt = e.text
    return next(e)
  })

  on('command.run', { command: 'git-branch' }, async ($, e) => {
    const description = e.args.trim() !== '' ? e.args : (lastPrompt ?? (await lastUserPrompt($)))
    const branch = nameBranch((description ?? '').slice(0, MAX_SOURCE_CHARS), prefix, maxSlugLength)
    if (branch === undefined) return { text: USAGE }

    const text = await switchToNewBranch($, branch.name)
    return text.includes('created and switched') ? { text, context: [`The user ran /git-branch: the git branch is now ${branch.name}.`] } : { text }
  })
}
