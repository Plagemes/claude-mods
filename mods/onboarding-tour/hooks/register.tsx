import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Tour, TourStep } from '../types'
import { IGNORED, PROJECT_FILES, SOURCE_DIRS, SYSTEM, excerptOf, parseSteps, tourPrompt, treeOf } from './tour'
import type { Entry } from './tour'

const PANE = 'tour'
const PANE_TITLE = 'Tour'
const PANE_ROWS = 26
const STORE_PREFIX = 'tour:'
const MATERIAL_CHARS = 40_000
const MAX_TOKENS = 6_000
const MODEL_TIMEOUT_MS = 180_000
const MIN_USABLE_STEPS = 2
const KEPT_DOTFILES = new Set(['.github', '.env.example'])

const tourAtom = atom({ plugin: 'onboarding-tour', key: 'tour' } as const, null)

type Settings = { model: string }
type Session = { root: string | undefined }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function rootOf($: EngineInterface, session: Session): Promise<string> {
  if (session.root === undefined) session.root = (await $.session.root().catch(() => '')).replace(/[\\/]+$/, '')
  return session.root
}

async function listed($: EngineInterface, folder: string): Promise<Entry[]> {
  const entries = await $.fs.list(folder).catch(() => [])
  return entries
    .filter(entry => !IGNORED.has(entry.name) && (!entry.name.startsWith('.') || KEPT_DOTFILES.has(entry.name)))
    .map(entry => ({ name: entry.name, isDir: entry.kind === 'dir' }))
}

/** A sketch of the project: its tree, and the start of its README, manifests and notes. */
async function scan($: EngineInterface, root: string): Promise<{ name: string; tree: string; files: { name: string; text: string }[] } | undefined> {
  const top = await listed($, root)
  if (top.length === 0) return undefined
  const nested = new Map<string, Entry[]>()
  for (const entry of top) if (entry.isDir && SOURCE_DIRS.includes(entry.name)) nested.set(entry.name, await listed($, `${root}/${entry.name}`))

  const present = new Set(top.filter(entry => !entry.isDir).map(entry => entry.name))
  const files: { name: string; text: string }[] = []
  let budget = MATERIAL_CHARS
  let hasReadme = false
  for (const name of PROJECT_FILES) {
    if (!present.has(name) || (hasReadme && /^readme/i.test(name))) continue
    const text = await $.fs.read(`${root}/${name}`).catch(() => undefined)
    if (typeof text !== 'string' || text.trim() === '') continue
    const excerpt = excerptOf(name, text)
    if (excerpt.length > budget) continue
    budget -= excerpt.length
    hasReadme ||= /^readme/i.test(name)
    files.push({ name, text: excerpt })
  }
  const packageName = files.find(file => file.name === 'package.json')?.text.match(/"name":\s*"([^"]+)"/)?.[1]
  return { name: packageName ?? root.split('/').pop() ?? 'this project', tree: treeOf(top, nested), files }
}

/** Applies `change` to the tour and keeps a finished build in the store for the project. */
async function commit($: EngineInterface, session: Session, change: (tour: Tour | null) => Tour | null): Promise<Tour | null> {
  const tour = await update($, tourAtom, change)
  if (tour?.status === 'ready') {
    await $.store.set(`${STORE_PREFIX}${await rootOf($, session)}`, tour).catch(error => $.ui.log(`onboarding-tour: could not save: ${messageOf(error)}`, { to: 'debug' }))
  }
  return tour
}

async function build($: EngineInterface, session: Session, settings: Settings): Promise<void> {
  const builtAt = await $.clock.now()
  await update($, tourAtom, (): Tour => ({ status: 'building', steps: [], index: 0, isFinished: false, builtAt, error: '' }))
  const fail = (error: string) => commit($, session, (tour): Tour | null => (tour?.builtAt === builtAt ? { ...tour, status: 'failed', error } : tour))
  try {
    const root = await rootOf($, session)
    const project = await scan($, root)
    if (project === undefined) {
      await fail('This folder looks empty: there is nothing to tour yet.')
      return
    }
    const reply = await $.model.complete({
      model: settings.model,
      system: SYSTEM,
      prompt: tourPrompt(project.name, project.tree, project.files),
      maxTokens: MAX_TOKENS,
      timeoutMs: MODEL_TIMEOUT_MS,
    })
    if (!reply.isAnswered) {
      await fail(reply.reason === 'api-error' ? `The model request failed (${reply.status ?? 'no response'}).` : reply.reason === 'aborted' ? 'Planning the tour took too long.' : 'The model gave no answer.')
      return
    }
    const steps: TourStep[] = []
    for (const step of parseSteps(reply.text)) {
      const files: string[] = []
      for (const file of step.files) if (await $.fs.exists(`${root}/${file}`).catch(() => false)) files.push(file)
      steps.push({ ...step, files })
    }
    if (steps.length < MIN_USABLE_STEPS) {
      await fail('The model did not return a usable tour.')
      return
    }
    await commit($, session, (tour): Tour | null => (tour?.builtAt === builtAt ? { ...tour, status: 'ready', steps } : tour))
  } catch (error) {
    await fail(`Could not build the tour: ${messageOf(error)}`)
  }
}

async function go($: EngineInterface, session: Session, by: number): Promise<void> {
  await commit($, session, (tour): Tour | null => {
    if (tour?.status !== 'ready') return tour
    const last = tour.steps.length - 1
    if (by > 0 && tour.index >= last) return { ...tour, isFinished: true }
    return { ...tour, index: Math.max(0, Math.min(last, tour.index + by)) }
  })
}

async function restart($: EngineInterface, session: Session): Promise<void> {
  await commit($, session, (tour): Tour | null => (tour?.status === 'ready' ? { ...tour, index: 0, isFinished: false } : tour))
}

/** Puts text in the prompt box: in place of an empty draft, after one you had typed. */
async function fillPrompt($: EngineInterface, text: string): Promise<void> {
  const draft = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
  const filled = await $.prompt.fill({ text: draft.text.trim() === '' ? text : ` ${text}`, mode: draft.text.trim() === '' ? 'replace' : 'append' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(`Type it yourself: ${text.trim()}`)
}

async function startBuild($: EngineInterface, session: Session, settings: Settings): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE, rows: PANE_ROWS })
  $.clock.after(0, () => void build($, session, settings))
}

async function runCommand($: EngineInterface, session: Session, settings: Settings, args: string): Promise<string> {
  const word = args.trim().toLowerCase()
  if (word !== '' && word !== 'restart' && word !== 'new') return 'Usage: /tour to start or resume, /tour restart to plan a fresh tour.'
  if (word === '') {
    let tour = await read($, tourAtom)
    if (tour === null) {
      const stored = (await $.store.get(`${STORE_PREFIX}${await rootOf($, session)}`).catch(() => undefined)) as Tour | undefined
      if (stored !== undefined && stored !== null && stored.status === 'ready' && Array.isArray(stored.steps)) tour = await update($, tourAtom, () => stored)
    }
    if (tour?.status === 'building') {
      await $.ui.open({ id: PANE, title: PANE_TITLE, rows: PANE_ROWS })
      return 'The tour is still being planned.'
    }
    if (tour?.status === 'ready') {
      await $.ui.open({ id: PANE, title: PANE_TITLE, rows: PANE_ROWS })
      const step = tour.steps[tour.index]
      return `Resuming the tour at step ${tour.index + 1} of ${tour.steps.length}: ${step?.title ?? ''}. (/tour restart plans a fresh one.)`
    }
  }
  await startBuild($, session, settings)
  return 'Reading the repository and planning a tour…'
}

export const register: Register = (on, options: PluginOptions) => {
  const settings: Settings = { model: (typeof options.model === 'string' ? options.model.trim() : '') || 'sonnet' }
  const session: Session = { root: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tour', description: 'A guided, step-by-step tour of this repository', argumentHint: '[restart]' })
    return next(e)
  })

  on('command.run', { command: 'tour' }, async ($, e) => {
    try {
      return { text: await runCommand($, session, settings, e.args) }
    } catch (error) {
      return { text: `onboarding-tour failed: ${messageOf(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const tour = await read($, tourAtom)
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
    if (tour === null) return <Text dimColor>Run /tour to start a guided tour of this repository.</Text>
    if (tour.status === 'building') {
      return (
        <Box key="building" flexDirection="column" gap={1}>
          <Text color="suggestion">🧭 Reading the repository and planning the tour…</Text>
          <Box>{close}</Box>
        </Box>
      )
    }
    if (tour.status === 'failed') {
      return (
        <Box key="failed" flexDirection="column" gap={1}>
          <Text color="error">{tour.error}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="retry" label="Retry" hotkey="r" variant="primary" onPress={() => void build($, session, settings)} />
            {close}
          </Box>
        </Box>
      )
    }

    const step = tour.steps[tour.index]
    if (step === undefined) return <Text dimColor>This tour has no steps. Run /tour restart.</Text>
    const isFirst = tour.index === 0
    const isLast = tour.index === tour.steps.length - 1
    const dots = tour.steps.map((_, index) => (index < tour.index ? '●' : index === tour.index ? '◉' : '○')).join(' ')

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="progress" flexDirection="row" gap={1}>
          <Text dimColor>
            Step {tour.index + 1} of {tour.steps.length}
          </Text>
          <Text dimColor>{dots}</Text>
        </Box>
        <Box key="title">
          <Text bold color="claude">
            {step.title}
          </Text>
        </Box>
        <Markdown key="body" text={step.body} />
        {step.files.length > 0 && (
          <Box key="files" flexDirection="column">
            <Text dimColor>Files (press to add to your prompt):</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {step.files.map(path => (
                <Button key={`file:${path}`} label={`@${path}`} onPress={() => void fillPrompt($, `@${path} `)} />
              ))}
            </Box>
          </Box>
        )}
        {isLast && tour.isFinished && (
          <Box key="finished">
            <Text color="success">🎉 That is the whole tour. Ask Claude about anything it touched, or /tour restart after big changes.</Text>
          </Box>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {!isFirst && <Button key="back" label="◀ Back" hotkey="b" onPress={() => void go($, session, -1)} />}
          {!(isLast && tour.isFinished) && (
            <Button key="next" label={isLast ? 'Finish' : 'Next ▶'} hotkey="n" variant="primary" onPress={() => void go($, session, 1)} />
          )}
          {isLast && tour.isFinished && <Button key="again" label="Start over" hotkey="s" onPress={() => void restart($, session)} />}
          <Button key="ask" label="Ask about this" hotkey="a" onPress={() => void fillPrompt($, `In this repository, regarding "${step.title}": `)} />
          {close}
        </Box>
      </Box>
    )
  })
}
