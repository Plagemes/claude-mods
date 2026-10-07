import type { EngineInterface, Register } from 'claude-code'

import { applyEdits, findPushes, parseBranchList, type Edit, type Push } from './push'
import { redactSummary } from './shared/secrets'

const GIT_TIMEOUT_MS = 5000
const MOD = 'force-push-guard'
/** The remote a push that names none goes to, as published in `git.push`. */
const DEFAULT_REMOTE = 'origin'

/** Why a force push is refused; `rule` is for mods-hub's risk.blocked. */
type Refusal = { rule: string; deny: string }

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

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked', 'git.push'], consumes: [] })
}

/** Tells mods-hub (when installed) what was blocked, the command masked and cut short. The deny never waits on it. */
async function reportBlock($: EngineInterface, refusal: Refusal, command: string): Promise<void> {
  await hubPublish($, {
    topic: 'risk.blocked',
    data: { guard: MOD, tool: 'Bash', reason: `${refusal.rule}: ${refusal.deny.slice(MOD.length + 2)}`, severity: 'high', command: redactSummary(command) },
  })
}

/** After a push went through: one `git.push` per branch on mods-hub (for ci-watch, git-status-line), when it is installed. */
async function announcePushes($: EngineInterface, pushes: readonly Push[]): Promise<void> {
  if ((await hubMode($)) === undefined) return
  for (const push of pushes) {
    for (const branch of (await targetsOf($, push)) ?? []) {
      await hubPublish($, { topic: 'git.push', data: { remote: push.remote ?? DEFAULT_REMOTE, branch, isForce: push.isForced }, scope: 'global' })
    }
  }
}

export const register: Register = (on, options) => {
  const protectedBranches = parseBranchList(String(options.protectedBranches ?? ''))
  const isProtected = (branch: string) => protectedBranches.some(rule => rule.matches.test(branch))
  const protectedLabels = protectedBranches.map(rule => rule.label).join(', ')

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  /** Why a forced push may not run, or undefined when it may (after the lease rewrite). */
  const refusalOf = (push: Push, targets: readonly string[] | undefined): Refusal | undefined => {
    if (push.isBroad) {
      return { rule: 'force-all', deny: `${MOD}: --force with --all/--mirror would rewrite every branch, protected ones included. Push the branch you mean, by name.` }
    }
    if (targets === undefined) {
      return { rule: 'unknown-target', deny: `${MOD}: cannot tell which branch this force-push updates. Name it: git push --force-with-lease <remote> <branch>.` }
    }
    const hit = targets.find(isProtected)
    if (hit === undefined) return undefined
    return {
      rule: 'protected-branch',
      deny: `${MOD}: force-pushing to "${hit}" is blocked (protected: ${protectedLabels}), even with --force-with-lease. Use a normal push or a pull request; if history really must change, ask the user to run it.`,
    }
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const pushes = findPushes(e.command)
    if (pushes.length === 0) return next(e)
    const edits: Edit[] = []

    for (const push of pushes.filter(candidate => candidate.isForced)) {
      const refusal = refusalOf(push, await targetsOf($, push))
      if (refusal !== undefined) {
        await reportBlock($, refusal, e.command)
        return { deny: refusal.deny }
      }
      edits.push(...push.leaseEdits)
    }

    if (edits.length > 0) await hubNotify($, { level: 'info', title: 'Rewrote --force to --force-with-lease', topic: 'risk.blocked' })
    const ran = await next(edits.length === 0 ? e : { ...e, command: applyEdits(e.command, edits) })
    if (ran.deny === undefined && ran.isError !== true) await announcePushes($, pushes)
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${MOD}: its check failed, so the command was blocked.` }))
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts
