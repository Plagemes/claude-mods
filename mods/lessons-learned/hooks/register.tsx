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
type Failure = { command: string; output: string; files: Set<string> }
type Fix = { check: string; command: string; output: string; files: string[] }
/** What this load has seen: failing checks awaiting a fix, fixes awaiting a lesson, lessons already decided. */
type Tracker = { failures: Map<string, Failure>; fixes: Fix[]; decided: Set<string> }

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
  const prompt = [
    `A check failed, files were edited, and the check then passed.`,
    `Failed command: ${fix.command}`,
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
  } catch {
    // No lesson this time; the fix still happened.
  }
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
  const tracker: Tracker = { failures: new Map(), fixes: [], decided: new Set() }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const check = checkOf(e.command)
    if (check === undefined || ran.deny !== undefined) return ran

    if (ran.isError === true) {
      const earlier = tracker.failures.get(check)
      tracker.failures.set(check, { command: e.command, output: tail(ran.text ?? '', OUTPUT_TAIL_CHARS), files: earlier?.files ?? new Set() })
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

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
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
