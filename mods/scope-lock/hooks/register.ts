import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { writeTargets } from './bash'
import type { WriteTarget } from './bash'
import { isInScope, normalizeGlob, resolvePath } from './glob'

const SECTION_ID = 'scope-lock:scope'
const GUARDED_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|Bash)$/
const TEMP_GLOBS = ['/tmp/**', '/private/tmp/**', '/var/folders/**']
const OFF_WORDS = /^(?:off|clear|none|unlock|reset)$/i
/** Who may change the scope: the person, at the prompt, in an SDK host or over Remote Control. */
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
const USAGE = 'Usage: /scope <glob…> (lock writes to them) · /scope add <glob…> · /scope remove <glob…> · /scope show · /scope off'

const globsAtom = atom({ plugin: 'scope-lock', key: 'globs' } as const, [])

type Settings = { allowTemp: boolean; blockUncheckable: boolean }
type Checked = { target: WriteTarget; resolved?: string; problem?: string }

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && (origin as { asUser?: boolean }).asUser === true)

const splitGlobs = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map(glob => normalizeGlob(glob.replace(/^['"]|['"]$/g, '')))
    .filter(Boolean)

const statusText = (globs: readonly string[]): string | undefined =>
  globs.length === 0 ? undefined : `🔒 scope: ${globs[0]}${globs.length > 1 ? ` +${globs.length - 1}` : ''}`

const describe = (globs: readonly string[]): string => (globs.length === 0 ? 'off (Claude may write anywhere)' : `writes allowed only under ${globs.join(', ')}`)

const sectionText = (globs: readonly string[]): string =>
  [
    '# Scope lock',
    `The user has locked this session's writes to these paths (globs relative to the project root): ${globs.join(', ')}.`,
    'Create, edit, move or delete files only inside them. Reading anything is fine. Edits and shell writes (redirections, rm, mv, cp, sed -i, …) outside the scope are refused before they run.',
    'If the task needs a change outside the scope, do not work around the lock: say which files and why, and ask the user to widen it with /scope add <glob>.',
  ].join('\n')

async function setGlobs($: EngineInterface, globs: readonly string[]): Promise<void> {
  const unique = [...new Set(globs)]
  await update($, globsAtom, () => unique)
  $.ui.status(statusText(unique))
}

/** Expands what a shell would before writing (`~`, `$HOME`, `$PWD`); undefined when it cannot tell. */
const expandShellPath = (path: string, home: string | undefined, cwd: string): string | undefined => {
  let result = path
  if (result === '~' || result.startsWith('~/')) {
    if (home === undefined) return undefined
    result = home + result.slice(1)
  }
  result = result.replace(/\$\{?HOME\}?(?!\w)/g, () => home ?? '$HOME').replace(/\$\{?PWD\}?(?!\w)/g, cwd)
  if (/[$`]|^~/.test(result)) return undefined
  // A glob writes where it expands: check the folder it sits in, with a stand-in name.
  return result.replace(/[*?]|\[[^\]]*\]/g, 'x')
}

/** Where each Bash write target lands, following the `cd`s before it on the line. */
async function checkBash($: EngineInterface, command: string): Promise<Checked[]> {
  const targets = writeTargets(command)
  if (targets.length === 0) return []
  const [cwd, home] = await Promise.all([$.session.cwd(), $.env.get('HOME')])
  return targets.map(target => {
    let folder = cwd
    for (const step of target.cdChain) {
      const expanded = step === '-' ? undefined : expandShellPath(step, home, folder)
      if (expanded === undefined) return { target, problem: `it follows a \`cd ${step}\` that cannot be checked` }
      folder = resolvePath(expanded, folder)
    }
    const expanded = expandShellPath(target.path, home, folder)
    return expanded === undefined ? { target, problem: 'it uses a shell variable or substitution that cannot be checked' } : { target, resolved: resolvePath(expanded, folder) }
  })
}

export const register: Register = (on, options) => {
  const settings: Settings = { allowTemp: options.allowTemp !== false, blockUncheckable: options.blockUncheckable !== false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'scope',
      description: 'Lock Claude’s writes to the files you name (globs); /scope off to unlock',
      argumentHint: '<glob…> | add <glob…> | remove <glob…> | show | off',
    })
    return next(e)
  })

  on('command.run', { command: 'scope' }, async ($, e) => {
    const args = e.args.trim()
    const current = await read($, globsAtom)
    if (args === '' || /^(?:show|status)$/i.test(args)) return { text: `Scope: ${describe(current)}.${current.length === 0 ? `\n${USAGE}` : ''}` }
    if (!isPerson(e.origin)) return { text: `Only the user can change the scope (now: ${describe(current)}).` }
    const [verb = '', ...rest] = args.split(/\s+/)
    let next: string[]
    if (OFF_WORDS.test(args)) next = []
    else if (/^add$/i.test(verb)) next = [...current, ...splitGlobs(rest.join(' '))]
    else if (/^(?:remove|rm|del)$/i.test(verb)) {
      const removed = new Set(splitGlobs(rest.join(' ')))
      next = current.filter(glob => !removed.has(glob))
    } else next = splitGlobs(args)
    if (next.length === 0 && !OFF_WORDS.test(args) && !/^(?:remove|rm|del)$/i.test(verb)) return { text: USAGE }
    await setGlobs($, next)
    return { text: next.length === 0 ? 'Scope off: Claude may write anywhere again.' : `🔒 Scope locked: ${describe(next)}.` }
  })

  // The status line belongs to the plugin, not the state: put it back after a reload.
  on('turn.start', async ($, e, next) => {
    $.ui.status(statusText(await read($, globsAtom)))
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const globs = await read($, globsAtom)
    if (globs.length === 0) return composed
    return { sections: [...composed.sections.filter(section => section.id !== SECTION_ID), { id: SECTION_ID, text: sectionText(globs), scope: 'session' }] }
  })

  on('tool.call', { tool: GUARDED_TOOLS }, async ($, e, next) => {
    const globs = await read($, globsAtom)
    if (globs.length === 0) return next(e)
    const allowed = settings.allowTemp ? [...globs, ...TEMP_GLOBS] : globs
    const root = await $.session.root()
    const tool = String(e.tool)
    const checks: Checked[] =
      tool === 'Bash'
        ? 'command' in e && typeof e.command === 'string'
          ? await checkBash($, e.command)
          : []
        : (() => {
            const path = 'notebook_path' in e ? e.notebook_path : 'file_path' in e ? e.file_path : undefined
            return typeof path === 'string' ? [{ target: { path, via: tool, cdChain: [] }, resolved: resolvePath(path, root) }] : []
          })()
    for (const check of checks) {
      if (check.resolved === undefined) {
        if (!settings.blockUncheckable) continue
        return { deny: `🔒 scope-lock: blocked ${check.target.via} on "${check.target.path}": ${check.problem}. The scope is ${globs.join(', ')}; use a literal path inside it.` }
      }
      if (!isInScope(check.resolved, root, allowed)) {
        return {
          deny:
            `🔒 scope-lock: blocked ${check.target.via} on "${check.target.path}": it is outside the scope (${globs.join(', ')}). ` +
            'Keep to those files, or ask the user to widen the scope with /scope add <glob>.',
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: '🔒 scope-lock: could not check this write against the scope, so it was blocked.' }))
}
