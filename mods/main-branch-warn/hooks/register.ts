import type { EngineInterface, Register } from 'claude-code'

const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const GIT_TIMEOUT_MS = 3000
const MAX_PARENT_STEPS = 12

function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return ''
  return cut === 0 ? '/' : path.slice(0, cut)
}

/** The nearest directory that exists at or above `dir`: a Write may create folders that are not there yet. */
async function existingDirectory($: EngineInterface, dir: string): Promise<string | undefined> {
  let current = dir
  for (let step = 0; step < MAX_PARENT_STEPS && current !== ''; step++) {
    try {
      if (await $.fs.exists(current)) return current
    } catch {
      return undefined
    }
    const parent = parentOf(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** The branch of the repository the file lives in; undefined outside a repository or on a detached HEAD. */
async function branchOfFile($: EngineInterface, file: string | undefined): Promise<string | undefined> {
  try {
    const cwd = file === undefined ? undefined : await existingDirectory($, parentOf(file))
    const { exitCode, stdout } = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : undefined
  } catch {
    return undefined
  }
}

function fileOf(input: Readonly<Record<string, unknown>>): string | undefined {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? path : undefined
}

export const register: Register = (on, options) => {
  const mainBranches = String(options.branches ?? 'main,master,trunk')
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
  const shouldBlock = options.block === true
  let hasWarned = false

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const branch = await branchOfFile($, fileOf(e))
    const isOnMain = branch !== undefined && mainBranches.includes(branch)

    $.ui.status(isOnMain ? `⚠ editing on ${branch}` : undefined)
    if (!isOnMain) return next(e)

    if (shouldBlock) {
      return {
        deny: `main-branch-warn: not editing directly on "${branch}". Create a branch first (git switch -c <type>/<name>, or /git-branch <task> with branch-namer), then retry.`,
      }
    }
    if (!hasWarned) {
      hasWarned = true
      $.ui.toast(`Claude is editing directly on "${branch}". Branch first: git switch -c <name> (or /git-branch).`, { timeoutMs: 8000 })
    }
    return next(e)
  }).catch(($, e, next) => (next.called || !shouldBlock ? next(e) : { deny: 'main-branch-warn: its check failed, so the edit was blocked.' }))
}
