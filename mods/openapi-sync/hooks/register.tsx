import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register } from 'claude-code'

import { describeIssue, diffRoutes, findIssues, isRouteFile, isSpecFile, mergeChanges, routesOf, specRoutesOf, updatePrompt } from './routes'
import type { Issue, Route, RouteChange } from './routes'

const SPEC_DIRS = ['', 'api', 'docs', 'doc', 'spec', 'specs', 'openapi', 'swagger', 'public', 'static', 'src', 'resources', 'config']
const SPEC_NAME = /^(?:openapi|swagger)(?:[.-][\w-]+)?\.(?:ya?ml|json)$/i
const MAX_FILE_BYTES = 512 * 1024
const LINES_SHOWN = 4

const issuesAtom = atom({ plugin: 'openapi-sync', key: 'issues' } as const, [])
const specAtom = atom({ plugin: 'openapi-sync', key: 'spec' } as const, null)

/** What the running turn changed: route changes and whether the spec itself was written. */
type Tracker = { changes: RouteChange[]; specEdited: boolean }

const relativeTo = (root: string, path: string): string | undefined => {
  const base = root.replace(/[\\/]+$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined
}

/** Ranks spec candidates: openapi before swagger, YAML before JSON, shallower first. */
const rank = (path: string): number =>
  (/swagger/i.test(path) ? 10 : 0) + (/\.json$/i.test(path) ? 5 : 0) + path.split('/').length

/** The spec file, relative to the root: the configured one, else the best openapi/swagger file in the usual folders. */
async function findSpec($: EngineInterface, root: string, configured: string): Promise<string | null> {
  if (configured !== '') return (await $.fs.exists(`${root}/${configured}`).catch(() => false)) ? configured : null
  const found: string[] = []
  await Promise.all(
    SPEC_DIRS.map(async dir => {
      let entries: FsEntry[]
      try {
        entries = await $.fs.list(dir === '' ? root : `${root}/${dir}`)
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.kind === 'file' && SPEC_NAME.test(entry.name)) found.push(dir === '' ? entry.name : `${dir}/${entry.name}`)
      }
    }),
  )
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? null
}

async function routesOnDisk($: EngineInterface, absolute: string, file: string): Promise<Route[]> {
  try {
    const stat = await $.fs.stat(absolute)
    if (stat.kind !== 'file' || stat.size > MAX_FILE_BYTES) return []
    return routesOf(file, await $.fs.read(absolute))
  } catch {
    return []
  }
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
  await hubHello($, { version: await ownVersion($), publishes: ['lint.result'], consumes: [] })
}

/** The routes out of sync with the spec, as a `lint.result` on the hub's bus (nothing happens without the hub). */
async function publishIssues($: EngineInterface, issues: readonly Issue[], spec: string): Promise<void> {
  if (issues.length === 0) return
  const files = [...new Set([spec, ...issues.map(issue => issue.file)])]
  await hubPublish($, { topic: 'lint.result', data: { tool: 'openapi-sync', errors: 0, warnings: issues.length, files } })
}

/** At the end of a main turn: checks this turn's route changes and the open issues against the spec as it is now. */
async function settleTurn($: EngineInterface, tracker: Tracker, configured: string): Promise<void> {
  const { changes, specEdited } = tracker
  tracker.changes = []
  tracker.specEdited = false
  const pending = await read($, issuesAtom)
  if (changes.length === 0 && pending.length === 0) return
  try {
    const root = await $.session.root()
    const spec = await findSpec($, root, configured)
    if (spec === null) {
      if (pending.length > 0) await update($, issuesAtom, () => [])
      return
    }
    if (changes.length === 0 && !specEdited && spec === (await read($, specAtom))) return
    const issues = findIssues(pending, changes, specRoutesOf(await $.fs.read(`${root}/${spec}`)))
    await update($, specAtom, () => spec)
    await update($, issuesAtom, () => issues)
    await publishIssues($, issues, spec)
  } catch (error) {
    $.ui.log(`openapi-sync: could not check the spec: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

async function askClaude($: EngineInterface, issues: readonly Issue[], spec: string): Promise<void> {
  await update($, issuesAtom, () => [])
  await $.prompt.submit({ text: updatePrompt(issues, spec), asUser: true })
}

export const register: Register = (on, options) => {
  const configured = String(options.specPath ?? '').trim().replace(/^\.\//, '')
  const tracker: Tracker = { changes: [], specEdited: false }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    tracker.changes = []
    tracker.specEdited = false
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const file = relativeTo(await $.session.root(), e.file_path)
    if (file === undefined || (!isSpecFile(file) && file !== configured && !isRouteFile(file))) return next(e)
    if (isSpecFile(file) || file === configured) {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) tracker.specEdited = true
      return ran
    }
    const before = await routesOnDisk($, e.file_path, file)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const changes = diffRoutes(file, before, await routesOnDisk($, e.file_path, file))
    if (changes.length > 0) tracker.changes = mergeChanges(tracker.changes, changes)
    return ran
  }).catch(($, e, next) => next(e)) // after `next`, this replays its answer: the edit never runs twice

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await settleTurn($, tracker, configured)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) return next(e)
    const issues = await read($, issuesAtom)
    if (issues.length === 0) return next(e)
    const spec = (await read($, specAtom)) ?? 'the spec'
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = [...issues].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'undocumented' ? -1 : 1)).slice(0, LINES_SHOWN)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="warning" bold>⚠ openapi-sync</Text>
            <Text wrap="truncate-end">{`${issues.length} route${issues.length === 1 ? '' : 's'} out of sync with ${spec}`}</Text>
          </Box>
          {shown.map(issue => (
            <Text dimColor wrap="truncate-end">{`  ${describeIssue(issue)}`}</Text>
          ))}
          {issues.length > shown.length && <Text dimColor>{`  … ${issues.length - shown.length} more`}</Text>}
          <Box gap={1}>
            <Button key="update" label="Ask Claude to update the spec" hotkey="u" variant="primary" onPress={() => void askClaude($, issues, spec)} />
            <Button key="dismiss" label="Dismiss" hotkey="d" role="dismiss" onPress={() => void update($, issuesAtom, () => [])} />
          </Box>
        </Box>
        {await next(e)}
      </Box>
    )
  })
}

// #region @vendored shared/hub-client.ts sha256:d76b7319c8a3: edit the source, then run `node scripts/sync-shared.mjs`.
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

/** Routes a notification through the hub (channels, silent, night, presence), or shows a toast when there is no hub. */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    $.ui.toast(input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`)
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

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
