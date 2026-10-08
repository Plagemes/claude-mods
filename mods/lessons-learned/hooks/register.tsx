import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Lesson } from '../types'

const SECTION = '## Lessons learned'
const DEFAULT_MODEL = 'haiku'
const DEFAULT_FILE = 'CLAUDE.md'
const OUTPUT_TAIL_CHARS = 1_500
const ANSWER_CHARS = 1_500
const LESSON_CHARS = 240
const MAX_QUEUED = 3
const MODEL_TIMEOUT_MS = 20_000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** The hub's own `test.result` comes from the Bash calls this mod already watches; other sources run tests themselves. */
const HUB = 'mods-hub'
/** How many edits are remembered to attach to a test run another mod reported. */
const MAX_EDITS = 200
const MAX_PULLED = 50

/** A shell segment's start, past env assignments and launchers (`npx`, `poetry run`, `bundle exec`...) and a path. */
const LAUNCHED =
  String.raw`^\s*(?:\w+=\S*\s+|(?:sudo|time|env|nice|command|npx|pnpx|bunx|yarn|pnpm|bun)\s+|timeout\s+\S+\s+|(?:poetry|uv|pipenv|pdm|hatch|rye)\s+run\s+|(?:bundle|pnpm|yarn|npm)\s+exec\s+(?:--\s+)?)*?` +
  String.raw`(?:[\w.~-]*\/)*`
/**
 * Commands that check the code: a failure then a pass of the same one, with edits between, is a fix.
 * Each must be the command a shell segment runs: `cat jest.config.js` or `npm i -D vitest` check nothing.
 */
const CHECKS: readonly RegExp[] = [
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check|tsc)`,
  String.raw`jest|vitest|mocha|playwright|cypress|tsc|eslint|biome|ruff|mypy|pyright|pytest|tox|nox|rspec|phpunit`,
  String.raw`cargo\s+(?:test|build|check|clippy|nextest)`,
  String.raw`go\s+(?:test|build|vet)`,
  String.raw`(?:make|gradlew?|mvn|dotnet|swift|deno|mix)\s+(?:test|build|check|verify|lint)`,
  String.raw`python\d?(?:\.\d+)?\s+-m\s+(?:pytest|unittest|mypy)`,
].map(check => new RegExp(`${LAUNCHED}(${check})(?![\\w./-])`))
const SEGMENTS = /&&|\|\||[;|&\n(){}]/

const SYSTEM =
  'You distill debugging episodes into one line for a project\'s CLAUDE.md, the instructions future AI coding sessions read. ' +
  'Write one imperative sentence of at most 25 words with a reusable, project-specific lesson that would have avoided the failure, ' +
  'for example: Run `npm run build` before `npm test`; the tests import from dist/. ' +
  'If the failure was a one-off typo or teaches nothing reusable, reply exactly NONE.'

const lessonsAtom = atom({ plugin: 'lessons-learned', key: 'lessons' } as const, [])

type Settings = { model: string; file: string }
/** A failing check; `at` is when it failed, so edits made before another mod reported it still count. */
type Failure = { command: string; output: string; files: Set<string>; at: number }
type Fix = { check: string; command: string; output: string; files: string[] }
/**
 * What this load has seen: failing checks awaiting a fix, fixes awaiting a lesson, lessons already decided,
 * recent edits (name, time), and how far the hub's `test.result` events were read.
 */
type Tracker = { failures: Map<string, Failure>; fixes: Fix[]; decided: Set<string>; edits: { name: string; at: number }[]; testsSeenAt: number }
/** One `test.result` as the hub stamped it (only what this mod reads). */
type TestEvent = { source: string; at: number; data: { runner?: unknown; outcome?: unknown; command?: unknown; failures?: unknown } }

function readSettings(options: PluginOptions): Settings {
  const model = typeof options.model === 'string' ? options.model.trim() : ''
  const file = typeof options.file === 'string' ? options.file.trim().replace(/^\.?\/+/, '') : ''

  return { model: model || DEFAULT_MODEL, file: file || DEFAULT_FILE }
}

/** The check a command runs, as one key for its variants (`npm run test` and `npm test` alike); undefined for others. */
function checkOf(command: string): string | undefined {
  const segments = command.split(SEGMENTS)
  for (const pattern of CHECKS) {
    for (const segment of segments) {
      const found = pattern.exec(segment)?.[1]
      if (found !== undefined) return found.toLowerCase().replace(/\s+/g, ' ').replace(/ run /, ' ')
    }
  }
  return undefined
}

const tail = (text: string, chars: number): string => (text.length > chars ? `…${text.slice(-chars)}` : text)
const normalize = (lesson: string): string => lesson.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** The model's line as a bullet's text, or undefined for NONE and empty replies. */
function cleanLesson(text: string): string | undefined {
  const line = (text.trim().split('\n').find(one => one.trim()) ?? '')
    .trim()
    .replace(/^[-*•]\s*/, '')
    .replace(/^lesson:\s*/i, '')
    .replace(/^["“]|["”]$/g, '')
    .trim()
  if (!line || /^none\b/i.test(line)) return undefined

  return line.length > LESSON_CHARS ? `${line.slice(0, LESSON_CHARS - 1)}…` : line
}

/** `text` with `- lesson` at the end of its Lessons learned section, the section added when missing. */
function withLesson(text: string, lesson: string): string {
  const lines = text.length > 0 ? text.replace(/\s+$/, '').split('\n') : []
  const start = lines.findIndex(line => /^##\s+lessons learned\s*$/i.test(line.trim()))
  if (start < 0) return `${lines.length > 0 ? `${lines.join('\n')}\n\n` : ''}${SECTION}\n\n- ${lesson}\n`

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  let insertAt = end
  while (insertAt > start + 1 && !(lines[insertAt - 1] ?? '').trim()) insertAt -= 1
  const isFirst = insertAt === start + 1
  const added = isFirst ? ['', `- ${lesson}`] : [`- ${lesson}`]
  const after = lines.slice(end)
  const rest = after.length > 0 ? ['', ...after] : []

  return `${[...lines.slice(0, insertAt), ...added, ...rest].join('\n')}\n`
}

async function draftLesson($: EngineInterface, fix: Fix, answer: string, settings: Settings): Promise<string | undefined> {
  const repeats = await repeatedFailures($, fix.command)
  const prompt = [
    `A check failed, files were edited, and the check then passed.`,
    `Failed command: ${fix.command}`,
    ...(repeats === undefined ? [] : [`It failed ${repeats} times in a row before the fix, so this was not a one-off.`]),
    `Failure output (tail):\n${fix.output}`,
    `Files edited before it passed: ${fix.files.join(', ') || 'unknown'}`,
    `The assistant's final message (excerpt):\n${answer.slice(0, ANSWER_CHARS)}`,
  ].join('\n\n')
  const reply = await $.model.complete({
    model: settings.model,
    system: SYSTEM,
    prompt,
    maxTokens: 120,
    effort: 'low',
    timeoutMs: MODEL_TIMEOUT_MS,
  })

  return reply.isAnswered ? cleanLesson(reply.text) : undefined
}

/** Turns the latest fix into a lesson for the band, unless it repeats one already decided. */
async function learn($: EngineInterface, fix: Fix, answer: string, tracker: Tracker, settings: Settings): Promise<void> {
  try {
    const lesson = await draftLesson($, fix, answer, settings)
    if (lesson === undefined || tracker.decided.has(normalize(lesson))) return
    tracker.decided.add(normalize(lesson))
    const queued: Lesson = { id: crypto.randomUUID(), text: lesson, check: fix.check }
    await update($, lessonsAtom, lessons => [...lessons, queued].slice(-MAX_QUEUED))
    await offerAway($, queued, settings)
  } catch {
    // No lesson this time; the fix still happened.
  }
}

// ── mods-hub: test runs other mods report, repeated errors, and lessons on the bus ─────────────────

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
  await hubHello($, { version: await ownVersion($), publishes: ['lesson.learned'], consumes: ['test.result', 'error.repeated'] })
}

/** How many times the hub saw this command fail in a row (its `error.repeated`); undefined without the hub or such an event. */
async function repeatedFailures($: EngineInterface, command: string): Promise<number | undefined> {
  try {
    const events = await $.mods.recent({ topic: 'error.repeated', limit: MAX_PULLED })
    const counts = events.flatMap(event => {
      const data = event.data as { command?: unknown; count?: unknown }
      // The hub keeps the first 200 characters of the command.
      return typeof data.command === 'string' && data.command !== '' && command.startsWith(data.command) && typeof data.count === 'number' ? [data.count] : []
    })
    return counts.length === 0 ? undefined : Math.max(...counts)
  } catch {
    return undefined
  }
}

/**
 * Folds in the test runs other mods reported on the hub since the last look (test-watch runs the tests of
 * what Claude edits on its own; quick-commands runs them from a slash command): a failed run, edits, then a
 * passing run of the same runner is a fix, exactly as for the checks Claude runs through Bash. Nothing
 * happens without the hub.
 */
async function foldHubTests($: EngineInterface, tracker: Tracker): Promise<void> {
  let events: TestEvent[]
  try {
    events = (await $.mods.recent({ topic: 'test.result', since: tracker.testsSeenAt, limit: MAX_PULLED })) as TestEvent[]
  } catch {
    return
  }
  for (const event of events) {
    tracker.testsSeenAt = Math.max(tracker.testsSeenAt, event.at)
    const { runner, outcome, command, failures } = event.data
    if (event.source === HUB || typeof runner !== 'string' || runner === '') continue
    const check = `${runner} (${event.source})`
    const ran = typeof command === 'string' && command !== '' ? command : runner
    if (outcome === 'failed' || outcome === 'error') {
      const earlier = tracker.failures.get(check)
      const output = Array.isArray(failures) && failures.length > 0 ? failures.map(String).join('\n') : `${runner} reported ${outcome}`
      tracker.failures.set(check, { command: ran, output: tail(output, OUTPUT_TAIL_CHARS), files: earlier?.files ?? new Set(), at: earlier?.at ?? event.at })
    } else if (outcome === 'passed') {
      const failure = tracker.failures.get(check)
      tracker.failures.delete(check)
      if (failure === undefined) continue
      const files = new Set([...failure.files, ...tracker.edits.filter(edit => edit.at > failure.at && edit.at <= event.at).map(edit => edit.name)])
      if (files.size > 0) tracker.fixes.push({ check: runner, command: failure.command, output: failure.output, files: [...files] })
    }
  }
}

/** A saved lesson on the hub's bus, for every session (project-brain and recall keep it). */
async function publishLesson($: EngineInterface, lesson: Lesson, settings: Settings): Promise<void> {
  await hubPublish($, { topic: 'lesson.learned', data: { lesson: lesson.text, context: `fixing ${lesson.check}`, path: settings.file }, scope: 'global' })
}

/** While the person is away from the keyboard, the waiting lesson also reaches them through the hub (it obeys Interaction). */
async function offerAway($: EngineInterface, lesson: Lesson, settings: Settings): Promise<void> {
  const mode = await hubMode($)
  if (mode === undefined || mode.presence === 'here') return
  await hubNotify($, { level: 'info', kind: 'question', title: `💡 Lesson learned from fixing ${lesson.check}`, body: `${lesson.text}\nSave it to ${settings.file} from the terminal.` })
}

async function saveLesson($: EngineInterface, id: string, settings: Settings): Promise<void> {
  const lesson = (await read($, lessonsAtom)).find(one => one.id === id)
  if (lesson === undefined) return
  const path = `${(await $.session.root()).replace(/[\\/]+$/, '')}/${settings.file}`
  try {
    const current = await $.fs.read(path).catch(() => '')
    const text = typeof current === 'string' ? current : ''
    const isPresent = text.split('\n').some(line => normalize(line.replace(/^\s*[-*]\s*/, '')) === normalize(lesson.text))
    if (!isPresent) await $.fs.write(path, withLesson(text, lesson.text))
    $.ui.toast(isPresent ? `📘 Already in ${settings.file}` : `📘 Saved to ${settings.file}`)
    if (!isPresent) await publishLesson($, lesson, settings)
  } catch (error) {
    $.ui.toast(`⚠️ Could not write ${settings.file}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  await update($, lessonsAtom, lessons => lessons.filter(one => one.id !== id))
}

async function dismissLesson($: EngineInterface, id: string): Promise<void> {
  await update($, lessonsAtom, lessons => lessons.filter(one => one.id !== id))
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const tracker: Tracker = { failures: new Map(), fixes: [], decided: new Set(), edits: [], testsSeenAt: 0 }

  on('session.start', async ($, e, next) => {
    afterStart($, 'lessons-learned', () => greetHub($))
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const check = checkOf(e.command)
    if (check === undefined || ran.deny !== undefined) return ran

    if (ran.isError === true) {
      const earlier = tracker.failures.get(check)
      tracker.failures.set(check, { command: e.command, output: tail(ran.text ?? '', OUTPUT_TAIL_CHARS), files: earlier?.files ?? new Set(), at: earlier?.at ?? (await $.clock.now()) })
    } else {
      const failure = tracker.failures.get(check)
      tracker.failures.delete(check)
      if (failure !== undefined && failure.files.size > 0 && ran.result.interrupted !== true) {
        tracker.fixes.push({ check, command: failure.command, output: failure.output, files: [...failure.files] })
      }
    }
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!EDIT_TOOLS.has(e.tool) || ran.deny !== undefined || ran.isError === true) return ran
    const input = e as { file_path?: unknown; notebook_path?: unknown }
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    const name = path.split(/[\\/]/).pop() ?? ''
    if (name) for (const failure of tracker.failures.values()) failure.files.add(name)
    if (name) tracker.edits = [...tracker.edits, { name, at: await $.clock.now() }].slice(-MAX_EDITS)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') await foldHubTests($, tracker)
    const fix = tracker.fixes.at(-1)
    if (e.agentId === undefined && e.reason === 'answer' && fix !== undefined) {
      tracker.fixes = []
      const answer = e.answer
      $.clock.after(0, () => void learn($, fix, answer, tracker, settings))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lessons = await read($, lessonsAtom)
    const lesson = lessons[0]
    if (e.props.hasSurvey || lesson === undefined) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const count = lessons.length > 1 ? ` · 1 of ${lessons.length}` : ''
    // Other plugins' bands stay below this one instead of being hidden while a lesson waits.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box key="lesson" flexDirection="column" width={e.props.bodyColumns}>
          <Text wrap="truncate-end">
            <Text bold color="claude">
              💡 Lesson learned
            </Text>
            <Text dimColor>
              {' '}
              from fixing {lesson.check}
              {count}
            </Text>
          </Text>
          <Text>{lesson.text}</Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="save"
              label={`Save to ${settings.file}`}
              hotkey="s"
              variant="primary"
              onPress={() => saveLesson($, lesson.id, settings)}
            />
            <Button key="dismiss" label="Dismiss" hotkey="x" role="dismiss" onPress={() => dismissLesson($, lesson.id)} />
          </Box>
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
