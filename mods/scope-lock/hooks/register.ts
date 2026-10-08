import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { writeTargets } from './bash'
import type { WriteTarget } from './bash'
import { isInScope, normalizeGlob, resolvePath } from './glob'
import { redactSummary } from './shared/secrets'

const MOD = 'scope-lock'
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
  // On mods-hub's blackboard as `scope-lock.scope` (an empty list when off).
  await hubShareFact($, { name: 'scope', value: unique })
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed, and shares the scope a reload kept. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
  await hubShareFact($, { name: 'scope', value: await read($, globsAtom) })
}

/** Tells mods-hub (when installed) what was blocked, path and command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, rule: string, reason: string, tool: string, path: string, command: string | undefined): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: {
      guard: MOD,
      tool,
      reason: `${rule}: ${reason}`,
      severity: 'medium',
      path: redactSummary(path),
      ...(command === undefined ? {} : { command: redactSummary(command) }),
    },
  })
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
    await registerCommand($, {
      name: 'scope',
      description: 'Lock Claude’s writes to the files you name (globs); /scope off to unlock',
      argumentHint: '<glob…> | add <glob…> | remove <glob…> | show | off',
    })
    afterStart($, 'scope-lock', () => greetHub($))
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
    const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
    for (const check of checks) {
      if (check.resolved === undefined) {
        if (!settings.blockUncheckable) continue
        await reportBlock($, 'unverifiable-write', `${check.target.via}: ${check.problem ?? 'cannot be checked'}`, tool, check.target.path, command)
        return { deny: `🔒 scope-lock: blocked ${check.target.via} on "${check.target.path}": ${check.problem}. The scope is ${globs.join(', ')}; use a literal path inside it.` }
      }
      if (!isInScope(check.resolved, root, allowed)) {
        await reportBlock($, 'outside-scope', `${check.target.via} outside ${globs.join(', ')}`, tool, check.target.path, command)
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

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
