import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { isTestFile as isSharedTestFile } from './shared/test-runners'

type Rule = { label: string; marker: RegExp; files: RegExp }

/** What silences or narrows a test run, per language. Counted, so markers already in the file are not new. */
const RULES: readonly Rule[] = [
  {
    label: '.skip / .only',
    marker: /\b(?:it|test|describe|context|suite|bench)(?:\.[A-Za-z]+)*\.(?:skip|only)\b/g,
    files: /\.[cm]?[jt]sx?$/,
  },
  {
    label: 'fit / xit / xdescribe',
    marker: /(?:^|[^\w.$])(?:fit|fdescribe|xit|xdescribe|xtest|xcontext|xspecify)\s*\(/gm,
    files: /\.(?:[cm]?[jt]sx?|rb)$/,
  },
  {
    label: '@pytest.mark.skip / @unittest.skip',
    marker: /\b(?:pytest\.mark\.skip|unittest\.skip)\b/g,
    files: /\.py$/,
  },
  { label: 't.Skip', marker: /\b[tb]\.Skip(?:f|Now)?\(/g, files: /_test\.go$/ },
  { label: '#[ignore]', marker: /#\[\s*ignore\b/g, files: /\.rs$/ },
  { label: '@Disabled / @Ignore', marker: /@(?:Disabled|Ignore)\b/g, files: /\.(?:java|kt)$/ },
]

const TEST_FILE_NAMES: readonly RegExp[] = [
  /\.(?:test|spec)\.[A-Za-z]+$/,
  /_(?:test|spec)\.[A-Za-z]+$/,
  /(?:^|\/)test_[^/]*\.py$/,
  /(?:Test|Tests|IT)\.(?:java|kt)$/,
  /(?:^|\/)(?:__tests__|tests?|specs?|e2e)\//,
]
/** Rust keeps its tests inside the source files, so every .rs file is checked. */
const ALWAYS_CHECKED = /\.rs$/

const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])
/** Words the person typed (or sent from a phone or the SDK, or a plugin sent as theirs); never a notification or a peer. */
const isPerson = (origin: PromptOrigin): boolean => PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)
const DEFAULT_ALLOW_WORD = 'SKIP-OK'

/**
 * Windows paths are matched with forward slashes, so `tests\\` folders count too. The shapes every Claude Mod
 * shares (`shared/test-runners.ts`: `ATest.php`, `a_spec.rb`...) count as well as this guard's own (folders, Java).
 */
const isTestFile = (path: string): boolean => {
  const slashed = path.replace(/\\/g, '/')
  return ALWAYS_CHECKED.test(slashed) || isSharedTestFile(slashed) || TEST_FILE_NAMES.some(pattern => pattern.test(slashed))
}

const countMarkers = (marker: RegExp, text: string): number => (text.match(marker) ?? []).length

/** Labels of the markers that `after` has more of than `before`, for a file of this name. */
const addedMarkers = (path: string, before: string, after: string): string[] =>
  RULES.filter(
    ({ files, marker }) => files.test(path) && countMarkers(marker, after) > countMarkers(marker, before),
  ).map(({ label }) => label)

/** The file's current text: '' when there is no file yet, null when it exists but cannot be read. */
const currentText = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    if (!(await $.fs.exists(path))) {
      return ''
    }
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

const editPairs = (edits: unknown): { before: string; after: string } => {
  const list = Array.isArray(edits) ? edits : []
  const field = (name: string): string =>
    list.map(edit => (typeof edit?.[name] === 'string' ? edit[name] : '')).join('\n')

  return { before: field('old_string'), after: field('new_string') }
}

/** The text a file-changing tool call replaces and the text it puts there; null when it cannot be judged. */
const changeOf = async (
  $: EngineInterface,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Promise<{ path: string; before: string; after: string } | null> => {
  const path = input.file_path

  if (typeof path !== 'string') {
    return null
  }

  if (tool === 'Edit') {
    return { path, before: String(input.old_string ?? ''), after: String(input.new_string ?? '') }
  }

  if (tool === 'MultiEdit') {
    return { path, ...editPairs(input.edits) }
  }

  const before = await currentText($, path)

  return before === null ? null : { path, before, after: String(input.content ?? '') }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
const ownVersion = async ($: EngineInterface): Promise<string> => {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
const greetHub = async ($: EngineInterface): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['risk.blocked'], consumes: [] })
}

/** A refused edit on the hub's bus (guardian, audit-trail, permission-log); published after the refusal, never before it. */
const publishBlocked = async ($: EngineInterface, tool: string, path: string, added: readonly string[]): Promise<void> => {
  await hubPublish($, { topic: 'risk.blocked', data: { guard: 'no-skip-tests', tool, reason: `adds ${added.join(', ')} to a test file`, severity: 'low', path } })
}

export const register: Register = (on, options) => {
  const allowWord = typeof options.allowWord === 'string' ? options.allowWord.trim() : DEFAULT_ALLOW_WORD
  let isAllowed = false

  on('session.start', async ($, e, next) => {
    afterStart($, 'no-skip-tests', () => greetHub($))
    return next(e)
  })

  on('prompt.submit', (_$, e, next) => {
    if (isPerson(e.origin)) {
      isAllowed = allowWord !== '' && e.text.includes(allowWord)
    } else if (e.turnId === undefined) {
      // A turn nobody typed (a notification, a schedule, a peer) starts without the approval of an earlier prompt.
      isAllowed = false
    }

    return next(e)
  })

  on('tool.call', { tool: /^(?:Edit|Write|MultiEdit)$/ }, async ($, e, next) => {
    if (isAllowed) {
      return next(e)
    }

    const change = await changeOf($, String(e.tool), e)

    if (change === null || !isTestFile(change.path)) {
      return next(e)
    }

    const added = addedMarkers(change.path, change.before, change.after)

    if (added.length === 0) {
      return next(e)
    }

    // Decided already: the hub only hears about it (hubPublish never throws).
    await publishBlocked($, String(e.tool), change.path, added)
    const escape =
      allowWord === '' ? '' : ` If the user really wants it, ask them to put ${allowWord} in their next message.`

    return {
      deny: `no-skip-tests: this change adds ${added.join(', ')} to ${change.path}. Fix the test or the code instead of silencing the test.${escape}`,
    }
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
