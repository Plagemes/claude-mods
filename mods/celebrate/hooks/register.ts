import type { EngineInterface, Register } from 'claude-code'

import { isTestCommand, runnerOfCommand, summarizeRun } from './shared/test-runners'
import type { TestRunner } from './shared/test-runners'

const FANFARE = { asset: 'assets/celebrate.wav' } as const
/** mods-hub publishes `test.result` from a timer just after the tool returns; wait for it. */
const HUB_SETTLE_MS = 250

const SEGMENTS = /&&|\|\||[;|&\n(){}]/
/** A package script or make target named test: `npm run test` and `npm test` are the same runner. */
const TEST_SCRIPT = /\b(npm|pnpm|yarn|bun|make|just|task)\s+(?:run\s+)?test\b/
// A runner that printed failures but still exited 0 (e.g. `npm test | tail`).
const FAILURE_REPORT = /\b[1-9]\d* (?:failed|failing|failures?)\b|^FAIL\b|\bFAILED\b/m
/** How a runner is named in the toast: the command people type. */
const NAMES: Partial<Record<TestRunner, string>> = { go: 'go test', cargo: 'cargo test', bun: 'bun test', deno: 'deno test' }

/** What this load remembers: which runners went red and have not been green since, and whether to play the fanfare. */
type Celebrator = { isSoundOn: boolean; failing: Set<string> }
/** What the hook saw of one test run. */
type Run = { command: string; since: number; runner: string; hasFailed: boolean }

/** The runner a command runs, as the person would name it; undefined when it runs no tests (`cat jest.config.js`, `grep -r pytest`). */
function runnerOf(command: string): string | undefined {
  const runner = runnerOfCommand(command)
  if (runner !== undefined) return NAMES[runner] ?? runner
  if (!isTestCommand(command)) return undefined
  const segment = command.split(SEGMENTS).find(part => TEST_SCRIPT.test(part))
  const script = segment === undefined ? undefined : TEST_SCRIPT.exec(segment)
  return script === null || script === undefined ? 'tests' : `${script[1]} test`
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
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: ['test.result'] })
}

/** The hub's `test.result` for the run that started at `since` (not another run's), when mods-hub saw it. */
async function hubVerdict($: EngineInterface, run: Run): Promise<'passed' | 'failed' | 'error' | undefined> {
  try {
    const event = await $.mods.latest({ topic: 'test.result' })
    const data: unknown = event?.data
    if (event === null || event.at < run.since || typeof data !== 'object' || data === null) return undefined
    const { command, outcome } = data as { command?: unknown; outcome?: unknown }
    // The hub keeps the first 200 characters of the command; a run it did not see (test-watch's own) names another one.
    const isThisRun = typeof command === 'string' && run.command.startsWith(command)
    return isThisRun && (outcome === 'passed' || outcome === 'failed' || outcome === 'error') ? outcome : undefined
  } catch {
    return undefined
  }
}

/** The toast and the fanfare (which the hub holds at night and while Silent). */
async function cheer($: EngineInterface, celebrator: Celebrator, runner: string): Promise<void> {
  await hubNotify($, { level: 'success', title: `🎉 All green: ${runner} passes again`, topic: 'test.result' })
  const mode = await hubMode($)
  if (!celebrator.isSoundOn || mode?.isSilent === true || mode?.isNight === true) return
  // Not awaited (the call resolves when the clip ends), and started outside this dispatch so it is not cut off with it.
  $.clock.after(0, () => void $.audio.play(FANFARE).catch(() => undefined))
}

/**
 * Folds one finished test run in. With mods-hub the verdict is its `test.result`; without it (or when it did not
 * see this run) the output was read by the hook already.
 */
async function judge($: EngineInterface, celebrator: Celebrator, run: Run, isHubbed: boolean): Promise<void> {
  const verdict = isHubbed ? await hubVerdict($, run) : undefined
  const hasFailed = verdict === undefined ? run.hasFailed : verdict !== 'passed'
  if (hasFailed) {
    celebrator.failing.add(run.runner)
  } else if (celebrator.failing.delete(run.runner)) {
    await cheer($, celebrator, run.runner)
  }
}

export const register: Register = (on, options) => {
  const celebrator: Celebrator = { isSoundOn: options.sound !== false, failing: new Set() }

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const since = await $.clock.now()
    const ran = await next(e)
    const runner = runnerOf(e.command)
    if (runner === undefined || ran.deny !== undefined) return ran

    const text = ran.text ?? ''
    const hasFailed = ran.isError === true || FAILURE_REPORT.test(text) || summarizeRun(e.command, text, false).outcome !== 'passed'
    const run: Run = { command: e.command, since, runner, hasFailed }

    if ((await hubMode($)) === undefined) {
      await judge($, celebrator, run, false)
    } else {
      $.clock.after(HUB_SETTLE_MS, () => void judge($, celebrator, run, true))
    }
    return ran
  })
}

// #region @vendored shared/hub-client.ts sha256:3ade61508f36: edit the source, then run `node scripts/sync-shared.mjs`.
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

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
