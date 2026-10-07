import type { EngineInterface, Register } from 'claude-code'

import { applyEdits, findPushes, parseBranchList, type Edit, type Push } from './push'

const GIT_TIMEOUT_MS = 5000

async function currentBranch($: EngineInterface, directory: string | undefined): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: directory,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** The branches a push updates, or undefined when they cannot be told. */
async function targetsOf($: EngineInterface, push: Push): Promise<string[] | undefined> {
  const needsCurrent = push.usesCurrentBranch || push.refs.includes('HEAD')
  const current = needsCurrent ? await currentBranch($, push.directory) : undefined
  if (needsCurrent && current === undefined) return undefined
  const named = push.refs.filter(ref => ref !== 'HEAD')
  return current === undefined ? named : [...named, current]
}

export const register: Register = (on, options) => {
  const protectedBranches = parseBranchList(String(options.protectedBranches ?? ''))
  const isProtected = (branch: string) => protectedBranches.some(rule => rule.matches.test(branch))
  const protectedLabels = protectedBranches.map(rule => rule.label).join(', ')

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const edits: Edit[] = []

    for (const push of findPushes(e.command).filter(candidate => candidate.isForced)) {
      const targets = await targetsOf($, push)
      if (push.isBroad) {
        return { deny: 'force-push-guard: --force with --all/--mirror would rewrite every branch, protected ones included. Push the branch you mean, by name.' }
      }
      if (targets === undefined) {
        return { deny: 'force-push-guard: cannot tell which branch this force-push updates. Name it: git push --force-with-lease <remote> <branch>.' }
      }
      const hit = targets.find(isProtected)
      if (hit !== undefined) {
        return {
          deny: `force-push-guard: force-pushing to "${hit}" is blocked (protected: ${protectedLabels}), even with --force-with-lease. Use a normal push or a pull request; if history really must change, ask the user to run it.`,
        }
      }
      edits.push(...push.leaseEdits)
    }

    if (edits.length === 0) return next(e)
    $.ui.toast('Rewrote --force to --force-with-lease')
    return next({ ...e, command: applyEdits(e.command, edits) })
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'force-push-guard: its check failed, so the command was blocked.' }))
}
