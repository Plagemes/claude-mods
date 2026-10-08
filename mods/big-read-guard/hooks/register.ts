import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_MAX_KB = 256
const BYTES_PER_KB = 1024
/** Generated files below this size are harmless to read whole. */
const SMALL_FILE_BYTES = 16 * BYTES_PER_KB

const LOCK_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Podfile.lock',
  'go.sum',
])
const GENERATED_NAME = /(\.min\.(js|mjs|cjs|css)|\.(bundle|chunk)\.(js|mjs|cjs|css)|\.(js|css)\.map|\.lock)$/i
/** Files the Read tool opens in a way of their own (pages, image blocks). */
const NOT_LINE_BASED = /\.(pdf|png|jpe?g|gif|webp)$/i

const basename = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

const isGenerated = (path: string): boolean => {
  const name = basename(path)

  return LOCK_FILES.has(name) || GENERATED_NAME.test(name)
}

const formatSize = (bytes: number): string =>
  bytes >= BYTES_PER_KB * BYTES_PER_KB
    ? `${(bytes / (BYTES_PER_KB * BYTES_PER_KB)).toFixed(1)} MB`
    : `${Math.round(bytes / BYTES_PER_KB)} KB`

const HOW_TO_READ =
  'Use Read with offset and limit for the part you need, or find it with Grep first.'

const MOD = 'big-read-guard'

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

/** Tells mods-hub (when installed) what was refused. A wasted read is a cost, not a danger: severity low. The deny never waits on it. */
async function reportBlock($: EngineInterface, path: string, reason: string): Promise<void> {
  await hubPublish($, { topic: 'risk.blocked', data: { guard: MOD, tool: 'Read', reason, severity: 'low', path } })
}

export const register: Register = (on, options) => {
  const maxBytes =
    (typeof options.maxKb === 'number' && options.maxKb > 0 ? options.maxKb : DEFAULT_MAX_KB) *
    BYTES_PER_KB

  on('session.start', async ($, e, next) => {
    afterStart($, 'big-read-guard', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    // An offset alone reads one window of lines (the tool's default count), not the whole file.
    const isBounded = e.limit !== undefined || e.offset !== undefined || e.pages !== undefined
    const isElsewhere = e._host !== undefined

    if (isBounded || isElsewhere || NOT_LINE_BASED.test(e.file_path)) {
      return next(e)
    }

    let size: number
    try {
      const stat = await $.fs.stat(e.file_path)
      if (stat.kind !== 'file') {
        return next(e)
      }
      size = stat.size
    } catch {
      // Missing or unreadable: let the Read tool report it.
      return next(e)
    }

    if (size > maxBytes) {
      await reportBlock($, e.file_path, `over the ${formatSize(maxBytes)} limit for a full read (${formatSize(size)})`)
      return {
        deny: `big-read-guard: ${e.file_path} is ${formatSize(size)}, over the ${formatSize(maxBytes)} limit for a full read. ${HOW_TO_READ}`,
      }
    }

    if (size > SMALL_FILE_BYTES && isGenerated(e.file_path)) {
      await reportBlock($, e.file_path, `a minified, bundled or lock file (${formatSize(size)})`)
      return {
        deny: `big-read-guard: ${e.file_path} is a minified, bundled or lock file (${formatSize(size)}); reading it whole wastes context. ${HOW_TO_READ}`,
      }
    }

    return next(e)
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
