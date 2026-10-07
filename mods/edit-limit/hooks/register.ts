import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

const MOD = 'edit-limit'
const TOAST_MS = 8000
const DEFAULT_MAX = 15
const DEFAULT_ALLOW_WORD = 'EDITS-OK'
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** What this turn has modified so far, and whether the person has already said yes. */
const turn = { files: new Set<string>(), isApproved: false }

/** The file a write-type tool call changes, qualified by the machine it runs on. */
const pathOf = (input: Readonly<Record<string, unknown>>): string | undefined => {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? path : undefined
}

const targetOf = (input: Readonly<Record<string, unknown>>): string | undefined => {
  const path = pathOf(input)
  return path === undefined ? undefined : `${String(input._host ?? '')}:${path}`
}

const positiveInteger = (text: string): number | undefined => (/^\d+$/.test(text) && Number(text) >= 1 ? Number(text) : undefined)

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
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
}

/** Tells mods-hub (when installed) that a write was refused, and tells you through its notifications (a toast without it). The deny never waits on the hub. */
async function reportBlock($: EngineInterface, tool: string, path: string, limit: number): Promise<void> {
  await hubPublish($, { topic: 'risk.blocked', data: { guard: MOD, tool, reason: `more than ${limit} files in one turn`, severity: 'low', path } })
  await hubNotify($, { level: 'warning', title: `stopped at ${limit} files this turn; Claude was told to check with you` }, { timeoutMs: TOAST_MS })
}

export const register: Register = (on, options) => {
  const asked = Math.floor(Number(options.max))
  const configured = Number.isFinite(asked) && asked >= 1 ? asked : DEFAULT_MAX
  const allowWord = typeof options.allowWord === 'string' ? options.allowWord.trim() : DEFAULT_ALLOW_WORD
  const override = atom({ plugin: 'edit-limit', key: 'override' } as const, null)

  on('session.start', async ($, e, next) => {
    await greetHub($)
    await $.command.register({
      name: 'edit-limit',
      description: 'Show or change how many files one turn may modify before Claude asks you',
      argumentHint: '[<n>|reset]',
    })
    return next(e)
  })

  on('command.run', { command: 'edit-limit' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const was = (await read($, override)) ?? configured
    if (arg === '') {
      const approval = allowWord === '' ? '' : ` Say ${allowWord} in a prompt to lift it for one turn.`
      return { text: `This turn: ${turn.files.size} of ${was} files modified.${approval} /edit-limit <n> changes the limit for this session.` }
    }
    if (arg === 'reset') {
      await update($, override, () => null)
      return { text: `The limit is back to ${configured} files per turn.` }
    }
    const raised = positiveInteger(arg)
    if (raised === undefined) return { text: 'Give a whole number of files, 1 or more: /edit-limit 30 (or /edit-limit reset).' }
    await update($, override, () => raised)
    return { text: `Claude may now modify ${raised} files per turn (was ${was}), until the session ends.` }
  })

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) turn.isApproved = allowWord !== '' && e.text.includes(allowWord)
    // A turn nobody typed (a notification, a schedule, a peer) starts without the approval of an earlier prompt.
    else if (e.turnId === undefined) turn.isApproved = false
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    turn.files.clear()
    return next(e)
  })

  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const target = targetOf(e)
    if (target === undefined) return next(e)

    const limit = (await read($, override)) ?? configured
    const isNew = !turn.files.has(target)
    if (isNew && !turn.isApproved && turn.files.size >= limit) {
      await reportBlock($, String(e.tool), pathOf(e) ?? '', limit)
      const ways = [allowWord === '' ? undefined : `writing ${allowWord} in their next message`, 'raising the limit with /edit-limit <n>']
      return {
        deny:
          `edit-limit: this turn has already modified ${turn.files.size} files and the limit is ${limit}, so ${String(e.tool)} was not run. ` +
          'Do not modify more files yet. Summarise your plan (which files, and why) and ask the user whether to continue. ' +
          `They can approve by ${ways.filter(way => way !== undefined).join(' or by ')}.`,
      }
    }

    if (isNew) turn.files.add(target)
    const ran = await next(e)
    if (isNew && (ran.deny !== undefined || ran.isError === true)) turn.files.delete(target)
    return ran
  })
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
