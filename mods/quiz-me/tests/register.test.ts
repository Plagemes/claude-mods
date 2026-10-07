import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { parseQuestions, parseQuizArgs, statsText } from '../hooks/quiz'

const ROOT = '/work/shop'
const USAGE = { input_tokens: 700, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const QUESTIONS = {
  questions: [
    { q: 'What does `total([])` return?', options: ['0', 'undefined', 'NaN', 'It throws'], answer: 0, why: 'The reduce starts from `0`.' },
    { q: 'Why skip items priced 0?', options: ['Speed', 'Free items must not count', 'A typo', 'Rounding'], answer: 1, why: 'The request asked for it.' },
  ],
}
const PANE: RenderPropsOf['Pane'] = {
  title: 'Quiz',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type World = { clock: MockClock; asked: string[]; store: Map<string, unknown>; reply: { text: string }; files: Map<string, string> }

function world(on: On): World {
  const seen: World = { clock: mock.clock(on, { now: Date.UTC(2026, 9, 7, 12) }), asked: [], store: new Map(), reply: { text: JSON.stringify(QUESTIONS) }, files: new Map() }
  on('store.get', ($, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($, e) => {
    seen.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.read', ($, e) => {
    const text = seen.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', ($, e) => {
    seen.asked.push(e.prompt)
    return { value: { isAnswered: true, text: seen.reply.text, usage: USAGE } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return seen
}

const quiz = async ($: Engine, args = ''): Promise<string> =>
  (await $.command.run({ command: 'quiz', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text ?? ''

async function editingTurn($: Engine, seen: World): Promise<void> {
  await $.turn.start({ text: 'Skip free items in the cart total', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/cart.ts`, old_string: 'sum += item.price', new_string: 'if (item.price > 0) sum += item.price' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await seen.clock.advance(0)
}

/** Presses the option whose label is `text`, wherever the shuffle put it. */
async function choose(ui: Mounted<'terminal' | 'desktop', 'Pane'>, text: string): Promise<void> {
  const option = (await ui.findAll({ type: 'Button' })).find(button => button.props.label === text)
  expect(option?.key).toMatch(/^option:/)
  await ui.press({ key: String(option?.key) })
}

test('reads arguments, keeps only well-formed questions and shuffles their options', async () => {
  expect(parseQuizArgs('')).toEqual({ kind: 'quiz', count: undefined, file: undefined })
  expect(parseQuizArgs('3 src/cart.ts')).toEqual({ kind: 'quiz', count: 3, file: 'src/cart.ts' })
  expect(parseQuizArgs('99')).toEqual({ kind: 'quiz', count: 10, file: undefined })
  expect(parseQuizArgs('stats')).toEqual({ kind: 'stats' })

  const reply = JSON.stringify({
    questions: [
      ...QUESTIONS.questions,
      { q: 'Too few options?', options: ['a', 'b'], answer: 0, why: '' },
      { q: 'Bad answer index?', options: ['a', 'b', 'c', 'd'], answer: 7, why: '' },
    ],
  })
  const reversed = parseQuestions(`Sure:\n${reply}`, 5, () => 0)
  expect(reversed).toHaveLength(2)
  for (const [index, question] of reversed.entries()) {
    const original = QUESTIONS.questions[index]
    expect(question.options[question.answer]).toBe(original?.options[original.answer])
    expect([...question.options].sort()).toEqual([...(original?.options ?? [])].sort())
  }
  expect(reversed[0]?.options[0]).not.toBe('0')
  expect(parseQuestions('no json here', 3, Math.random)).toEqual([])
  expect(statsText([{ at: Date.UTC(2026, 9, 7, 12), source: 'src/cart.ts', correct: 4, total: 5 }])).toContain('1 quiz · 4/5 right (80%)')
})

test("quizzes you on the last turn's edits, one question at a time, and keeps the score", async ($, on) => {
  const seen = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await editingTurn($, seen)
  expect(await quiz($, '2')).toBe('Writing 2 questions about the last turn (1 file)…')
  await seen.clock.advance(0)
  expect(seen.asked[0]).toContain('Write 2 multiple-choice questions')
  expect(seen.asked[0]).toContain('Skip free items in the cart total')
  expect(seen.asked[0]).toContain('=== src/cart.ts (edited)\n--- before\nsum += item.price\n+++ after\nif (item.price > 0) sum += item.price')

  for (const surface of ['terminal', 'desktop'] as const) {
    if (surface === 'desktop') {
      await quiz($, '2')
      await seen.clock.advance(0)
    }
    const ui = await $.ui.mount({ plugin: 'quiz-me', surface, component: 'Pane', requestId: 'quiz', props: PANE })
    expect((await ui.find({ key: 'progress' }))?.text).toContain('Question 1 of 2')
    expect((await ui.find({ key: 'question' }))?.text).toContain('total([])')
    await choose(ui, '0')
    expect((await ui.find({ key: 'feedback' }))?.text).toContain('✓ Right.')
    expect((await ui.find({ key: 'why' }))?.text).toContain('starts from `0`')
    await ui.press({ key: 'next' })
    await choose(ui, 'Speed')
    expect((await ui.find({ key: 'feedback' }))?.text).toContain('✗ Not quite')
    await ui.press({ key: 'next' })
    expect((await ui.find({ key: 'done' }))?.text).toContain('Score: 1/2 (50%)')
    expect((await ui.find({ key: 'missed' }))?.text).toContain('Answer: Free items must not count')
    await ui.unmount()
  }

  expect(seen.store.get('history')).toEqual([
    { at: Date.UTC(2026, 9, 7, 12), source: 'the last turn (1 file)', correct: 1, total: 2 },
    { at: Date.UTC(2026, 9, 7, 12), source: 'the last turn (1 file)', correct: 1, total: 2 },
  ])
  expect(await quiz($, 'stats')).toContain('2 quizzes · 2/4 right (50%) · 0 perfect')
})

test('quizzes on a file you name, says when there is nothing, and retries a bad reply', async ($, on) => {
  const seen = world(on)
  expect(await quiz($)).toContain('Nothing to quiz on yet')
  expect(await quiz($, 'src/missing.ts')).toBe('Cannot read src/missing.ts.')

  seen.files.set(`${ROOT}/src/money.ts`, 'export const round = (n: number) => Math.round(n * 100) / 100\n')
  seen.reply.text = 'I would rather not.'
  expect(await quiz($, '3 src/money.ts')).toBe('Writing 3 questions about src/money.ts…')
  await seen.clock.advance(0)
  expect(seen.asked[0]).toContain('=== src/money.ts\nexport const round')

  const ui = await $.ui.mount({ plugin: 'quiz-me', surface: 'desktop', component: 'Pane', requestId: 'quiz', props: PANE })
  expect((await ui.find({ key: 'failed' }))?.text).toContain('did not return usable questions')
  seen.reply.text = JSON.stringify(QUESTIONS)
  await ui.press({ key: 'retry' })
  const progress = (await ui.find({ key: 'progress' }))?.text
  expect(progress).toContain('Question 1 of 2')
  expect(progress).toContain('src/money.ts')
  await ui.unmount()
})
