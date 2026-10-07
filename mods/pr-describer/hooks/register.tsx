import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { PrDescriberDraft as Draft } from '../types'
import { FALLBACK_BASES, TEMPLATE_PATHS, parseDescription, promptText, systemPrompt, userPrompt } from './describe'
import type { BranchContext } from './describe'

type Git = { ok: boolean; out: string; err: string }
type Settings = { model: string; root: string; base: string }

const PLUGIN = 'pr-describer'
const PANE = 'pr-desc'
const GIT_TIMEOUT_MS = 30_000
const MODEL_TIMEOUT_MS = 120_000
const MAX_TOKENS = 2_000
const MAX_COMMITS = 60
const IDLE: Draft = {
  phase: 'idle',
  repo: null,
  base: '',
  branch: '',
  commitCount: 0,
  summary: '',
  title: '',
  body: '',
  error: null,
  templateSource: null,
  hasUncommitted: false,
}

const draft = atom({ plugin: 'pr-describer', key: 'draft' } as const, IDLE)

const git = async ($: EngineInterface, cwd: string | undefined, args: readonly string[]): Promise<Git> => {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout.trim(), err: run.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

const setDraft = ($: EngineInterface, change: Partial<Draft>): Promise<Draft> =>
  update($, draft, (current: Draft) => ({ ...current, ...change }))

/** The base asked for (as a local or `origin/` branch), else origin's default branch, else main/master/develop. */
const resolveBase = async ($: EngineInterface, root: string, requested: string): Promise<string | undefined> => {
  const originHead = await git($, root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
  const candidates =
    requested === '' ? [...(originHead.ok ? [originHead.out] : []), ...FALLBACK_BASES] : [requested, `origin/${requested}`]
  for (const candidate of candidates) {
    if ((await git($, root, ['rev-parse', '--verify', '-q', `${candidate}^{commit}`])).ok) return candidate
  }
  return undefined
}

const readTemplate = async ($: EngineInterface, root: string): Promise<BranchContext['template']> => {
  for (const name of TEMPLATE_PATHS) {
    const text = await $.fs.read(`${root}/${name}`).catch(() => undefined)
    if (typeof text === 'string' && text.trim() !== '') return { name, text }
  }
  return undefined
}

/** Everything the description is written from: commits, stat and diff since the merge base, and the template. */
const gather = async ($: EngineInterface, settings: Settings): Promise<BranchContext | string> => {
  const { root, base } = settings
  const mergeBase = await git($, root, ['merge-base', base, 'HEAD'])
  if (!mergeBase.ok) return `no common history between HEAD and ${base}.`
  const range = `${mergeBase.out}..HEAD`
  const [branch, count, commits, stat, diff, dirty, template] = await Promise.all([
    git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, root, ['rev-list', '--count', '--no-merges', range]),
    git($, root, ['log', '--reverse', '--no-merges', `--max-count=${MAX_COMMITS}`, '--format=- %h %s%n%w(0,2,2)%b', range]),
    git($, root, ['diff', '--stat=100', range]),
    git($, root, ['diff', '--no-color', '--no-ext-diff', range]),
    git($, root, ['status', '--porcelain', '--untracked-files=no']),
    readTemplate($, root),
  ])
  const commitCount = Number(count.out)
  if (!Number.isFinite(commitCount) || commitCount === 0) return `HEAD has no commits ahead of ${base}.`
  const summaryLine = stat.out.split('\n').at(-1)?.trim() ?? ''
  await setDraft($, {
    branch: branch.out,
    commitCount,
    summary: summaryLine,
    hasUncommitted: dirty.out !== '',
    templateSource: template?.name ?? null,
  })
  return { branch: branch.out, base, commits: commits.out, stat: stat.out, diff: diff.out, template }
}

const compose = async ($: EngineInterface, settings: Settings): Promise<void> => {
  await setDraft($, { phase: 'generating', error: null })
  const context = await gather($, settings)
  if (typeof context === 'string') {
    await setDraft($, { phase: 'error', error: context })
    return
  }
  const reply = await $.model.complete({
    model: settings.model,
    system: systemPrompt(context.template),
    prompt: userPrompt(context),
    maxTokens: MAX_TOKENS,
    timeoutMs: MODEL_TIMEOUT_MS,
  })
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `the API answered ${reply.status ?? 'nothing'} (${reply.error})` : reply.reason
    await setDraft($, { phase: 'error', error: `no description: ${why}.` })
    return
  }
  const { title, body } = parseDescription(reply.text)
  await setDraft($, { phase: 'ready', title, body })
}

const copy = async ($: EngineInterface, what: string, text: string, surface: RenderSurface): Promise<void> => {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `Copied the ${what}` : `${PLUGIN}: could not copy (${copied.reason})`)
}

const insertIntoPrompt = async ($: EngineInterface): Promise<void> => {
  const { title, body, branch, base } = await read($, draft)
  const filled = await $.prompt.fill({ text: promptText(title, body, branch, base), mode: 'append' })
  $.ui.toast(filled.isFilled ? 'Inserted into the prompt: edit it and press Enter' : `${PLUGIN}: the prompt box is not available right now`)
}

/** `/pr-desc [base]`: finds the base, opens the pane and writes the description. */
const runDescribe = async ($: EngineInterface, args: string, model: string): Promise<{ text: string }> => {
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { text: `${PLUGIN}: not in a git repository.` }
  const root = top.out
  const requested = args.trim()
  const base = await resolveBase($, root, requested)
  if (base === undefined) {
    return {
      text: requested === '' ? `${PLUGIN}: no base branch found; name one: /pr-desc <base>.` : `${PLUGIN}: no branch named ${requested} or origin/${requested}.`,
    }
  }
  await update($, draft, () => ({ ...IDLE, repo: root, base }))
  await $.ui.open({ id: PANE, title: 'Pull request', focus: true })
  await compose($, { model, root, base })
  const { phase, error } = await read($, draft)
  return { text: phase === 'ready' ? `${PLUGIN}: description ready in the Pull request pane.` : `${PLUGIN}: ${error ?? 'no description.'}` }
}

export const register: Register = (on, options) => {
  const model = typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : 'sonnet'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-desc',
      description: 'Draft a pull request title and description from this branch',
      argumentHint: '[base]',
    })
    return next(e)
  })

  on('command.run', { command: 'pr-desc' }, ($, e) => runDescribe($, e.args, model))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const current = await read($, draft)
    if (current.repo === null) return <Text dimColor>Run /pr-desc [base] to draft a pull request description.</Text>
    const settings: Settings = { model, root: current.repo, base: current.base }
    const shortBase = current.base.replace(/^origin\//, '')
    const details = [
      `${current.commitCount} commit${current.commitCount === 1 ? '' : 's'}`,
      current.summary,
      current.templateSource === null ? '' : `template: ${current.templateSource}`,
    ].filter(part => part !== '')

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            {current.branch === '' ? 'HEAD' : current.branch} → {shortBase}
          </Text>
          {current.commitCount > 0 && <Text dimColor>{details.join(' · ')}</Text>}
          {current.hasUncommitted && <Text color="warning">Uncommitted changes are not part of the description.</Text>}
        </Box>
        {current.phase === 'generating' && <Text color="suggestion">Writing the description with {model}…</Text>}
        {current.error !== null && (
          <Box key="error">
            <Text color="error">{current.error}</Text>
          </Box>
        )}
        {current.phase === 'ready' && (
          <Box key="title" flexDirection="row" gap={1} borderStyle="round" borderColor="promptBorder" paddingX={1}>
            <Box flexGrow={1}>
              <Text bold>{current.title}</Text>
            </Box>
            <Button key="copy-title" label="Copy title" plain dimColor onPress={press => copy($, 'title', current.title, press.surface)} />
          </Box>
        )}
        {current.phase === 'ready' && <Markdown key="body" text={current.body} />}
        {current.phase !== 'generating' && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {current.phase === 'ready' && (
              <Button key="insert" label="Insert into prompt" hotkey="i" variant="primary" autoFocus onPress={() => insertIntoPrompt($)} />
            )}
            {current.phase === 'ready' && (
              <Button key="copy-body" label="Copy description" hotkey="d" onPress={press => copy($, 'description', current.body, press.surface)} />
            )}
            {current.phase === 'ready' && (
              <Button
                key="copy-all"
                label="Copy all"
                hotkey="a"
                onPress={press => copy($, 'title and description', `${current.title}\n\n${current.body}`, press.surface)}
              />
            )}
            <Button key="regenerate" label="Regenerate" hotkey="r" onPress={() => compose($, settings)} />
            <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        )}
      </Box>
    )
  })
}
