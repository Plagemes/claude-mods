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
  draftedAt: 0,
}
/** `gh pr create` / `glab mr create`, and the pull request link they print. */
const OPENS_PR = /\b(?:gh\s+pr|glab\s+mr)\s+create\b/
const PR_URL = /https?:\/\/\S+?\/(?:pull|merge_requests)\/\d+/
const TITLE_FLAG = /(?:--title|-t)[=\s]+(?:"([^"]*)"|'([^']*)'|(\S+))/

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
  let reply: Awaited<ReturnType<EngineInterface['model']['complete']>>
  try {
    reply = await $.model.complete({
      model: settings.model,
      system: systemPrompt(context.template),
      prompt: userPrompt(context),
      maxTokens: MAX_TOKENS,
      timeoutMs: MODEL_TIMEOUT_MS,
    })
  } catch (error) {
    // A refused call (an unknown model, no account) must not leave the pane stuck "writing" with no buttons.
    await setDraft($, { phase: 'error', error: `no description: ${error instanceof Error ? error.message : String(error)}.` })
    return
  }
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `the API answered ${reply.status ?? 'nothing'} (${reply.error})` : reply.reason
    await setDraft($, { phase: 'error', error: `no description: ${why}.` })
    return
  }
  const { title, body } = parseDescription(reply.text)
  // Only mods-hub's `git.commit` is compared with it; without the hub the time is never read.
  const draftedAt = (await hubMode($)) === undefined ? 0 : await $.clock.now()
  await setDraft($, { phase: 'ready', title, body, draftedAt })
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

// ── mods-hub: commits that make a draft stale, and the pull request once it is open ─────────────────

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
  await hubHello($, { version: await ownVersion($), publishes: ['pr.opened'], consumes: ['git.commit'] })
}

/** The latest `git.commit` on the hub's bus made on `branch` after `since`, as `abc1234 subject`; read while drawing, it redraws the pane. */
const newerCommit = async ($: EngineInterface, branch: string, since: number): Promise<string | undefined> => {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'latest', id: 'git.commit' })
  if (value === undefined || value === null || value.at <= since) return undefined
  const data = value.data as { sha?: unknown; message?: unknown; branch?: unknown }
  if (data.branch !== branch || typeof data.sha !== 'string') return undefined
  return `${data.sha.slice(0, 7)} ${typeof data.message === 'string' ? (data.message.split('\n')[0] ?? '') : ''}`.trim()
}

/**
 * A pull request Claude opened (`gh pr create`, `glab mr create`, typically after "Insert into prompt"), on the
 * hub's bus as `pr.opened`: the link from the command's output, the drafted title when there is one. Only with the hub.
 */
const publishOpened = async ($: EngineInterface, command: string, output: string): Promise<void> => {
  const url = PR_URL.exec(output)?.[0]
  if (url === undefined || (await hubMode($)) === undefined) return
  const current = await read($, draft)
  const flag = TITLE_FLAG.exec(command)
  const title = current.phase === 'ready' && current.title !== '' ? current.title : (flag?.[1] ?? flag?.[2] ?? flag?.[3] ?? 'Pull request')
  const branch = current.branch !== '' ? current.branch : (await git($, undefined, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  await hubPublish($, { topic: 'pr.opened', data: { url, title, branch }, scope: 'global' })
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
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && OPENS_PR.test(e.command)) {
      const output = `${typeof ran.text === 'string' ? ran.text : ''}\n${JSON.stringify(ran.result ?? '')}`
      const command = e.command
      $.clock.after(0, () => void publishOpened($, command, output))
    }
    return ran
  })

  on('command.run', { command: 'pr-desc' }, ($, e) => runDescribe($, e.args, model))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const current = await read($, draft)
    if (current.repo === null) return <Text dimColor>Run /pr-desc [base] to draft a pull request description.</Text>
    const settings: Settings = { model, root: current.repo, base: current.base }
    const shortBase = current.base.replace(/^origin\//, '')
    const newer = current.phase === 'ready' ? await newerCommit($, current.branch, current.draftedAt) : undefined
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
        {newer !== undefined && (
          <Box key="stale">
            <Text color="warning">New commit since this draft ({newer}): Regenerate to include it.</Text>
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

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
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
// #endregion @vendored shared/hub-client.ts
