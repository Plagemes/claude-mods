import type { EngineInterface, Register } from 'claude-code'

type Rule = { label: string; pattern: RegExp; isDirective?: true }

// Global, so each occurrence counts: two `as any` on one line are two.
const RULES: Rule[] = [
  { label: ': any', pattern: /:\s*any\b/g },
  { label: 'as any', pattern: /\bas\s+any\b/g },
  { label: '<any>', pattern: /(?<=[<,]\s*)any(?=\s*[>,])/g },
  { label: '@ts-ignore', pattern: /@ts-ignore\b/g, isDirective: true },
  { label: '@ts-nocheck', pattern: /@ts-nocheck\b/g, isDirective: true },
  { label: 'eslint-disable', pattern: /\beslint-disable/g, isDirective: true },
]

const TYPESCRIPT_FILE = /\.(ts|tsx|mts|cts)$/
// A backslash is read only as an escape (`\\.`), never as a plain character too: no exponential backtracking.
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g
const TRAILING_COMMENT = /(^|\s)\/\/.*$/
const BLOCK_COMMENT_LINE = /^\s*(\/\*|\*)/
const ALLOW_MARKER = 'no-any: allow'
const BLOCK = 'block'

/** What the `any` rules should read: the line without string contents or comments. */
const codeOf = (line: string): string =>
  BLOCK_COMMENT_LINE.test(line) ? '' : line.replace(STRING_LITERAL, '""').replace(TRAILING_COMMENT, '')

/** One label per escape hatch in the text, so two `as any` on a line count twice. */
const escapeHatches = (text: string): string[] =>
  text
    .split('\n')
    .filter(line => !line.includes(ALLOW_MARKER))
    .flatMap(line => {
      const code = codeOf(line)
      return RULES.flatMap(rule => [...(rule.isDirective ? line : code).matchAll(rule.pattern)].map(() => rule.label))
    })

/** The escape hatches `after` has beyond those `before` already had, kind by kind: one left in place is not added. */
const addedHatches = (before: string, after: string): string[] => {
  const had = new Map<string, number>()
  for (const label of escapeHatches(before)) had.set(label, (had.get(label) ?? 0) + 1)
  return escapeHatches(after).filter(label => {
    const left = had.get(label) ?? 0
    had.set(label, left - 1)
    return left <= 0
  })
}

const summarize = (labels: string[]): string => {
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  return [...counts].map(([label, n]) => (n === 1 ? label : `${label} x${n}`)).join(', ')
}

const readLocal = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
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

/** The finding as a `lint.result` on the hub's bus (nothing happens without the hub): `errors` when the edit was refused. */
async function publishFound($: EngineInterface, file: string, count: number, isBlocked: boolean): Promise<void> {
  await hubPublish($, {
    topic: 'lint.result',
    data: { tool: 'no-any', errors: isBlocked ? count : 0, warnings: isBlocked ? 0 : count, files: [file] },
  })
}

export const register: Register = (on, options) => {
  const isBlocking = options.mode === BLOCK

  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (!TYPESCRIPT_FILE.test(e.file_path)) return next(e)

    const before =
      e.tool === 'Edit' ? e.old_string : e._host === undefined ? await readLocal($, e.file_path) : ''
    const after = e.tool === 'Edit' ? e.new_string : e.content

    const found = addedHatches(before, after)
    if (found.length === 0) return next(e)

    const summary = summarize(found)
    if (isBlocking) {
      await publishFound($, e.file_path, found.length, true)
      return {
        deny:
          `no-any: blocked, this change adds ${summary} to ${e.file_path}. ` +
          `Use a precise type or unknown and fix the underlying error instead. ` +
          `If it is truly unavoidable, put "${ALLOW_MARKER}" and the reason on that line.`,
      }
    }

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    await hubNotify($, { level: 'warning', title: `Added ${summary} to ${e.file_path.split('/').pop()}`, topic: 'lint.result' })
    await publishFound($, e.file_path, found.length, false)
    const note =
      `no-any: this edit added ${summary} to ${e.file_path}. Replace it with a precise type, ` +
      `unknown plus a narrowing check, or fix the underlying type error. ` +
      `If it is truly unavoidable, put "${ALLOW_MARKER}" and the reason on that line.`
    return { ...ran, context: [...(ran.context ?? []), note] }
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
