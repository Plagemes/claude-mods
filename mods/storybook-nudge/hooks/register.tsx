import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StorybookNudgeState } from '../types'
import { basename, dirname, hasStoryIn, isComponentPath, stemOf, storyExtension, storyFor } from './paths'

const DEFAULT_FOLDERS = 'components'
const STORY_FOLDERS = ['stories', '__stories__']
const MAX_LEVELS_UP = 12
const TOAST_MS = 8_000
const MAX_LISTED = 3

const EMPTY: StorybookNudgeState = { watching: [], missing: [] }
const state = atom({ plugin: 'storybook-nudge', key: 'state' } as const, EMPTY)

const addAll = (list: readonly string[], more: readonly string[]): string[] => [...new Set([...list, ...more])]

/** True when a `.storybook` folder sits in the file's folder or above it, up to the project root. */
async function hasStorybook($: EngineInterface, file: string, root: string): Promise<boolean> {
  if (!file.startsWith(`${root}/`)) return false
  let folder = dirname(file)
  for (let level = 0; level < MAX_LEVELS_UP && folder.length >= root.length; level += 1) {
    if (await $.fs.exists(`${folder}/.storybook`)) return true
    folder = dirname(folder)
  }
  return false
}

async function namesIn($: EngineInterface, folder: string): Promise<string[]> {
  try {
    return (await $.fs.list(folder)).map(entry => entry.name)
  } catch {
    return []
  }
}

/** A story next to the component, or in a stories/ or __stories__/ folder beside it. */
async function hasStory($: EngineInterface, file: string): Promise<boolean> {
  const folder = dirname(file)
  const stem = stemOf(file)
  for (const where of [folder, ...STORY_FOLDERS.map(name => `${folder}/${name}`)]) {
    if (hasStoryIn(await namesIn($, where), stem)) return true
  }
  return false
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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

/** The toast, with its own timeout, when there is no hub; an `info` notification through mods-hub when it is installed. */
async function notice($: EngineInterface, title: string, timeoutMs: number): Promise<void> {
  if ((await hubMode($)) === undefined) $.ui.toast(title, { timeoutMs })
  else await hubNotify($, { level: 'info', title })
}

/** At the end of a main turn: the components made in it are checked for stories, and the ones without are remembered. */
async function settleTurn($: EngineInterface): Promise<void> {
  const { watching } = await read($, state)
  if (watching.length === 0) return
  const missing: string[] = []
  for (const file of watching) if (!(await hasStory($, file))) missing.push(file)
  await update($, state, current => ({ watching: current.watching.filter(file => !watching.includes(file)), missing: addAll(current.missing, missing) }))
  if (missing.length > 0) {
    await notice($, missing.length === 1 ? `${basename(missing[0] ?? '')} has no story yet` : `${missing.length} new components have no story yet`, TOAST_MS)
  }
}

const requestFor = (files: readonly string[], root: string): string =>
  [
    'These new components have no Storybook story:',
    ...files.map(file => `- ${file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file} (story file: ${stemOf(file)}.stories.${storyExtension(file)})`),
    '',
    'Add a story next to each one, following the stories this project already has (format, title and args conventions). Cover the main variants and states. Do not change the components.',
  ].join('\n')

const summarize = (files: readonly string[]): string => {
  const names = files.slice(0, MAX_LISTED).map(basename).join(', ')
  return files.length === 1 ? `${names} has no story` : `${names}${files.length > MAX_LISTED ? ` and ${files.length - MAX_LISTED} more` : ''} have no story`
}

export const register: Register = (on, options) => {
  const folders = new Set(String(options.directories ?? DEFAULT_FOLDERS).split(',').map(name => name.trim()).filter(name => name !== ''))

  on('session.start', async ($, e, next) => {
    afterStart($, 'storybook-nudge', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const story = storyFor(e.file_path)
    const isCandidate = isComponentPath(e.file_path, folders)
    if (e._host !== undefined || (story === undefined && !isCandidate)) return next(e)

    const root = ((await $.session.repo())?.root ?? (await $.session.cwd())).replace(/\/+$/, '')
    const isNew = isCandidate && !(await $.fs.exists(e.file_path)) && (await hasStorybook($, e.file_path, root))
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    if (isNew) await update($, state, current => ({ ...current, watching: addAll(current.watching, [e.file_path]) }))
    // A story written for a component the band is waiting on settles it.
    if (story !== undefined) {
      const isOf = (file: string): boolean => stemOf(file) === story
      await update($, state, current => ({ watching: current.watching.filter(file => !isOf(file)), missing: current.missing.filter(file => !isOf(file)) }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted) await settleTurn($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const { missing } = await read($, state)
    if (missing.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const root = ((await $.session.repo())?.root ?? (await $.session.cwd())).replace(/\/+$/, '')
    // Other plugins' bands draw beneath this one rather than being replaced by it.
    const below = await next(e)
    const askClaude = async (): Promise<void> => {
      await update($, state, current => ({ ...current, missing: [] }))
      await $.prompt.submit({ text: requestFor(missing, root), asUser: true })
    }

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color="warning" bold>Storybook</Text>
          <Text wrap="truncate-end">{summarize(missing)}</Text>
        </Box>
        <Box gap={1}>
          <Button key="ask" label="Ask Claude to add stories" hotkey="s" variant="primary" onPress={() => void askClaude()} />
          <Button key="dismiss" label="Dismiss" hotkey="d" role="dismiss" onPress={() => void update($, state, current => ({ ...current, missing: [] }))} />
        </Box>
        {below}
      </Box>
    )
  })
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
