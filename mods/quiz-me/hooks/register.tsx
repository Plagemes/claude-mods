import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Quiz, QuizScore } from '../types'
import { MAX_QUESTIONS, MIN_QUESTIONS, SYSTEM, keptChange, materialOf, parseQuestions, parseQuizArgs, percent, quizPrompt, statsText } from './quiz'
import type { Change } from './quiz'

const PANE = 'quiz'
const PANE_TITLE = 'Quiz'
const PANE_ROWS = 24
const HISTORY_KEY = 'history'
const WORK_PREFIX = 'work:'
const MAX_HISTORY = 200
const MAX_CHANGES = 40
const FILE_CHARS = 40_000
const DIFF_CHARS = 40_000
const MAX_TOKENS = 4_096
const MODEL_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 15_000
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

const quizAtom = atom({ plugin: 'quiz-me', key: 'quiz' } as const, null)

type Settings = { count: number; model: string }

/** The edits of the last main-loop turn that made any, and what it was asked. */
type Work = { request: string; changes: Change[] }

/** What a quiz is written from, kept so New quiz and Retry can ask again. */
type Material = { text: string; request: string; source: string; count: number }

type Session = { root: string | undefined; turn: Work | undefined; last: Work | undefined; material: Material | undefined }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

function readSettings(options: PluginOptions): Settings {
  const count = Math.round(Number(options.questions))
  return {
    count: Number.isFinite(count) && count >= MIN_QUESTIONS ? Math.min(MAX_QUESTIONS, count) : 5,
    model: (typeof options.model === 'string' ? options.model.trim() : '') || 'sonnet',
  }
}

async function rootOf($: EngineInterface, session: Session): Promise<string> {
  if (session.root === undefined) session.root = (await $.session.root().catch(() => '')).replace(/[\\/]+$/, '')
  return session.root
}

const relativeTo = (root: string, path: string): string => (root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

async function lastWork($: EngineInterface, session: Session): Promise<Work | undefined> {
  if (session.last !== undefined) return session.last
  const stored = (await $.store.get(`${WORK_PREFIX}${await rootOf($, session)}`).catch(() => undefined)) as Work | undefined
  return stored !== undefined && stored !== null && Array.isArray(stored.changes) && stored.changes.length > 0 ? stored : undefined
}

async function rememberWork($: EngineInterface, session: Session, work: Work): Promise<void> {
  session.last = work
  try {
    await $.store.set(`${WORK_PREFIX}${await rootOf($, session)}`, work)
  } catch (error) {
    $.ui.log(`quiz-me: could not save the last turn's edits: ${messageOf(error)}`, { to: 'debug' })
  }
}

/** What to quiz on: the file named, else the last turn's edits, else the uncommitted changes. */
async function materialFor($: EngineInterface, session: Session, file: string | undefined, count: number): Promise<Material | string> {
  const root = await rootOf($, session)
  if (file !== undefined) {
    const path = file.startsWith('/') ? file : `${root}/${file.replace(/^\.\//, '')}`
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') return `Cannot read ${file}.`
    if (text.trim() === '') return `${file} is empty.`
    const body = text.length > FILE_CHARS ? `${text.slice(0, FILE_CHARS)}\n[…cut]` : text
    return { text: `=== ${relativeTo(root, path)}\n${body}`, request: '', source: relativeTo(root, path), count }
  }
  const work = await lastWork($, session)
  if (work !== undefined) {
    const files = new Set(work.changes.map(change => change.path)).size
    return { text: materialOf(work.changes), request: work.request, source: `the last turn (${plural(files, 'file')})`, count }
  }
  try {
    const run = await $.process.run(['git', 'diff', 'HEAD', '--no-color', '--no-ext-diff'], { timeoutMs: GIT_TIMEOUT_MS })
    if (run.exitCode === 0 && run.stdout.trim() !== '') {
      const diff = run.stdout.length > DIFF_CHARS ? `${run.stdout.slice(0, DIFF_CHARS)}\n[…cut]` : run.stdout
      return { text: diff, request: '', source: 'uncommitted changes', count }
    }
  } catch {
    // Not a git repository, or git is missing: nothing more to quiz on.
  }
  return 'Nothing to quiz on yet: run /quiz after Claude edits some code, or name a file (/quiz src/cart.ts).'
}

/** Asks the model for the questions of a new quiz, unless another quiz replaced it meanwhile. */
async function writeQuiz($: EngineInterface, session: Session, settings: Settings, material: Material): Promise<void> {
  const id = crypto.randomUUID()
  session.material = material
  await update($, quizAtom, (): Quiz => ({ id, source: material.source, status: 'writing', questions: [], index: 0, picked: [], error: '' }))
  let failed = ''
  let questions: Quiz['questions'] = []
  try {
    const reply = await $.model.complete({
      model: settings.model,
      system: SYSTEM,
      prompt: quizPrompt(material.count, material.text, material.request),
      maxTokens: MAX_TOKENS,
      timeoutMs: MODEL_TIMEOUT_MS,
    })
    if (reply.isAnswered) questions = parseQuestions(reply.text, material.count, Math.random)
    else failed = reply.reason === 'api-error' ? `The model request failed (${reply.status ?? 'no response'}).` : reply.reason === 'aborted' ? 'Writing the questions took too long.' : 'The model gave no answer.'
  } catch (error) {
    failed = `Could not write the questions: ${messageOf(error)}`
  }
  if (failed === '' && questions.length === 0) failed = 'The model did not return usable questions.'
  await update($, quizAtom, (quiz): Quiz | null =>
    quiz?.id !== id
      ? quiz
      : failed !== ''
        ? { ...quiz, status: 'failed', error: failed }
        : { ...quiz, status: 'asking', questions, picked: questions.map(() => null) },
  )
}

async function pick($: EngineInterface, option: number): Promise<void> {
  await update($, quizAtom, (quiz): Quiz | null => {
    if (quiz?.status !== 'asking' || quiz.picked[quiz.index] !== null) return quiz
    return { ...quiz, picked: quiz.picked.map((one, index) => (index === quiz.index ? option : one)) }
  })
}

const correctOf = (quiz: Quiz): number => quiz.questions.filter((question, index) => quiz.picked[index] === question.answer).length

/** The next question, or the score once the last is answered (and the score is kept). */
async function advance($: EngineInterface): Promise<void> {
  const quiz = await update($, quizAtom, (current): Quiz | null => {
    if (current?.status !== 'asking' || current.picked[current.index] === null) return current
    const isLast = current.index + 1 >= current.questions.length
    return isLast ? { ...current, status: 'done' } : { ...current, index: current.index + 1 }
  })
  if (quiz?.status !== 'done') return
  const score: QuizScore = { at: await $.clock.now(), source: quiz.source, correct: correctOf(quiz), total: quiz.questions.length }
  try {
    const history = await $.store.get(HISTORY_KEY).catch(() => [])
    await $.store.set(HISTORY_KEY, [...(Array.isArray(history) ? history : []), score].slice(-MAX_HISTORY))
  } catch (error) {
    $.ui.log(`quiz-me: could not save the score: ${messageOf(error)}`, { to: 'debug' })
  }
}

async function again($: EngineInterface, session: Session, settings: Settings): Promise<void> {
  if (session.material !== undefined) await writeQuiz($, session, settings, session.material)
}

async function runCommand($: EngineInterface, session: Session, settings: Settings, args: string): Promise<string> {
  const parsed = parseQuizArgs(args)
  if (parsed.kind === 'stats') {
    const history = await $.store.get(HISTORY_KEY).catch(() => [])
    return statsText(Array.isArray(history) ? (history as QuizScore[]) : [])
  }
  const material = await materialFor($, session, parsed.file, parsed.count ?? settings.count)
  if (typeof material === 'string') return material
  await $.ui.open({ id: PANE, title: PANE_TITLE, rows: PANE_ROWS })
  $.clock.after(0, () => void writeQuiz($, session, settings, material).catch(error => $.ui.log(`quiz-me: ${messageOf(error)}`, { to: 'debug' })))
  return `Writing ${plural(material.count, 'question')} about ${material.source}…`
}

const LETTERS = ['1', '2', '3', '4']

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const session: Session = { root: undefined, turn: undefined, last: undefined, material: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quiz', description: 'Quiz yourself on the code Claude just wrote', argumentHint: '[n] [file] | stats' })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    session.turn = { request: e.text, changes: [] }
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const { turn } = session
    if (turn === undefined || ran.deny !== undefined || ran.isError === true || turn.changes.length >= MAX_CHANGES) return ran
    const root = await rootOf($, session)
    if (e.tool === 'Edit') turn.changes.push(keptChange({ path: relativeTo(root, e.file_path), kind: 'edit', before: e.old_string, after: e.new_string }))
    else if (e.tool === 'Write') turn.changes.push(keptChange({ path: relativeTo(root, e.file_path), kind: 'write', before: '', after: e.content }))
    else if (e.tool === 'NotebookEdit') turn.changes.push(keptChange({ path: relativeTo(root, e.notebook_path), kind: 'edit', before: '', after: e.new_source }))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const { turn } = session
    if (e.agentId !== undefined || turn === undefined) return result
    session.turn = undefined
    if (turn.changes.length > 0) $.clock.after(0, () => void rememberWork($, session, turn))
    return result
  })

  on('command.run', { command: 'quiz' }, async ($, e) => {
    try {
      return { text: await runCommand($, session, settings, e.args) }
    } catch (error) {
      return { text: `Failed: ${messageOf(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const quiz = await read($, quizAtom)
    if (quiz === null) return <Text dimColor>Run /quiz after Claude writes some code.</Text>
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />

    if (quiz.status === 'writing') {
      return (
        <Box key="writing" flexDirection="column" gap={1}>
          <Text color="suggestion">⏳ Writing questions about {quiz.source}…</Text>
          <Box>{close}</Box>
        </Box>
      )
    }
    if (quiz.status === 'failed') {
      return (
        <Box key="failed" flexDirection="column" gap={1}>
          <Text color="error">{quiz.error}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="retry" label="Retry" hotkey="r" variant="primary" onPress={() => void again($, session, settings)} />
            {close}
          </Box>
        </Box>
      )
    }

    const total = quiz.questions.length
    if (quiz.status === 'done') {
      const correct = correctOf(quiz)
      const score = percent(correct, total)
      const missed = quiz.questions
        .map((question, index) => ({ question, index }))
        .filter(({ question, index }) => quiz.picked[index] !== question.answer)
        .map(({ question, index }) => `**${index + 1}. ${question.q}**\n\nAnswer: ${question.options[question.answer] ?? ''}${question.why ? ` (${question.why})` : ''}`)
      return (
        <Box key="done" flexDirection="column" gap={1}>
          <Text bold color={score >= 80 ? 'success' : score >= 50 ? 'warning' : 'error'}>
            🎓 Score: {correct}/{total} ({score}%)
          </Text>
          <Text dimColor>{score === 100 ? 'Perfect: you know this code.' : score >= 80 ? 'Solid understanding.' : 'Worth another look at the parts you missed.'}</Text>
          {missed.length > 0 && <Markdown key="missed" text={missed.join('\n\n')} />}
          <Box flexDirection="row" gap={1}>
            <Button key="again" label="New quiz" hotkey="r" variant="primary" onPress={() => void again($, session, settings)} />
            {close}
          </Box>
        </Box>
      )
    }

    const question = quiz.questions[quiz.index]
    if (question === undefined) return <Text dimColor>No question to show.</Text>
    const picked = quiz.picked[quiz.index] ?? null
    const isRight = picked === question.answer
    const progress = quiz.questions.map((one, index) => {
      const answer = quiz.picked[index]
      return answer === null || answer === undefined ? (index === quiz.index ? '◉' : '○') : answer === one.answer ? '●' : '✗'
    })

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="progress" flexDirection="row" gap={1}>
          <Text bold>
            Question {quiz.index + 1} of {total}
          </Text>
          <Text dimColor>{progress.join(' ')}</Text>
          <Text dimColor wrap="truncate-end">
            · {quiz.source}
          </Text>
        </Box>
        <Markdown key="question" text={question.q} />
        <Box flexDirection="column">
          {question.options.map((option, index) =>
            picked === null ? (
              <Button key={`option:${index}`} label={option} hotkey={LETTERS[index]} plain onPress={() => void pick($, index)} />
            ) : (
              <Box key={`option:${index}`} flexDirection="row" gap={1}>
                <Text color={index === question.answer ? 'success' : index === picked ? 'error' : undefined} dimColor={index !== question.answer && index !== picked}>
                  {index === question.answer ? '✓' : index === picked ? '✗' : ' '} {LETTERS[index]}: {option}
                </Text>
              </Box>
            ),
          )}
        </Box>
        {picked !== null && (
          <Box key="feedback" flexDirection="column">
            <Text bold color={isRight ? 'success' : 'error'}>
              {isRight ? '✓ Right.' : `✗ Not quite: the answer is ${LETTERS[question.answer]}.`}
            </Text>
            {question.why !== '' && <Markdown key="why" text={question.why} />}
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          {picked !== null && (
            <Button key="next" label={quiz.index + 1 >= total ? 'See score' : 'Next'} hotkey="n" variant="primary" onPress={() => void advance($)} />
          )}
          {close}
        </Box>
      </Box>
    )
  })
}
