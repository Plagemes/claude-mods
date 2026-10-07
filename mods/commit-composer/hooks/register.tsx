import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CommitComposerDraft as Draft } from '../types'
import { COMMITLINT_FILES, cleanMessage, problemsOf, rulesFrom, systemPrompt, userPrompt, withSubject } from './message'
import type { DiffContext, Rules } from './message'

type Git = { ok: boolean; out: string; err: string }
type Settings = { model: string; root: string }

const PLUGIN = 'commit-composer'
const PANE = 'commit'
const COMMAND_NAMES = ['commit', 'compose-commit']
const GIT_TIMEOUT_MS = 60_000
const MODEL_TIMEOUT_MS = 90_000
const MAX_TOKENS = 800
const FILES_SHOWN = 12
const IDLE: Draft = {
  phase: 'idle',
  repo: null,
  summary: '',
  files: [],
  message: '',
  problems: [],
  error: null,
  committed: null,
  rulesSource: null,
}

const draft = atom({ plugin: 'commit-composer', key: 'draft' } as const, IDLE)

const git = async ($: EngineInterface, cwd: string | undefined, args: readonly string[]): Promise<Git> => {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout, err: run.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

const setDraft = ($: EngineInterface, change: Partial<Draft>): Promise<Draft> =>
  update($, draft, (current: Draft) => ({ ...current, ...change }))

/** The commitlint rules of the repository: the first config file found, else `package.json`'s `commitlint` key. */
const loadRules = async ($: EngineInterface, root: string): Promise<Rules> => {
  for (const name of COMMITLINT_FILES) {
    const text = await $.fs.read(`${root}/${name}`).catch(() => undefined)
    if (typeof text === 'string') return rulesFrom(name, text)
  }
  const manifest = await $.fs.read(`${root}/package.json`).catch(() => undefined)
  if (typeof manifest === 'string') {
    try {
      const config = (JSON.parse(manifest) as { commitlint?: unknown }).commitlint
      if (config !== undefined) return rulesFrom('package.json', JSON.stringify(config, null, 1))
    } catch {
      // Not JSON: no rules from it.
    }
  }
  return rulesFrom(undefined, undefined)
}

const readStaged = async ($: EngineInterface, root: string): Promise<DiffContext> => {
  const [nameStatus, stat, diff, log] = await Promise.all([
    git($, root, ['diff', '--cached', '--name-status']),
    git($, root, ['diff', '--cached', '--stat']),
    git($, root, ['diff', '--cached', '--no-color', '--no-ext-diff']),
    git($, root, ['log', '-n', '12', '--format=%s']),
  ])
  return { nameStatus: nameStatus.out, stat: stat.out, diff: diff.out, recentSubjects: log.ok ? log.out : '' }
}

/** "4 files · +120 −14", from `--stat`'s last line. */
const summaryOf = (stat: string): string => {
  const last = stat.trim().split('\n').at(-1) ?? ''
  const files = /(\d+) files? changed/.exec(last)?.[1] ?? '0'
  const added = /(\d+) insertions?/.exec(last)?.[1] ?? '0'
  const removed = /(\d+) deletions?/.exec(last)?.[1] ?? '0'
  return `${files} file${files === '1' ? '' : 's'} · +${added} −${removed}`
}

/** Asks the model for a message over what is staged now, and puts the draft in the pane. */
const compose = async ($: EngineInterface, settings: Settings, instruction?: string): Promise<void> => {
  await setDraft($, { phase: 'generating', error: null, committed: null })
  const [context, rules] = await Promise.all([readStaged($, settings.root), loadRules($, settings.root)])
  if (context.nameStatus.trim() === '') {
    await setDraft($, { phase: 'error', error: 'Nothing is staged any more.' })
    return
  }
  const files = context.nameStatus.trim().split('\n')
  const shown = files.slice(0, FILES_SHOWN).map(line => line.replace(/\t/g, '  '))
  if (files.length > FILES_SHOWN) shown.push(`… and ${files.length - FILES_SHOWN} more`)
  await setDraft($, { summary: summaryOf(context.stat), files: shown, rulesSource: rules.configName ?? null })

  const previous = (await read($, draft)).message
  const prompt = userPrompt(context, instruction === undefined ? undefined : `${instruction}\nThe current message is:\n${previous}`)
  const reply = await $.model.complete({
    model: settings.model,
    system: systemPrompt(rules),
    prompt,
    maxTokens: MAX_TOKENS,
    effort: 'low',
    timeoutMs: MODEL_TIMEOUT_MS,
  })
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `the API answered ${reply.status ?? 'nothing'} (${reply.error})` : reply.reason
    await setDraft($, { phase: 'error', error: `No message: ${why}.` })
    return
  }
  const message = cleanMessage(reply.text)
  await setDraft($, { phase: 'ready', message, problems: problemsOf(message, rules) })
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
  await hubHello($, { version: await ownVersion($), publishes: ['git.commit'], consumes: [] })
}

/**
 * The commit just made, on the hub's bus as `git.commit` (pr-describer, changelog-keeper, session-journal,
 * standup, achievements... react to it). The extra git reads only run when the hub is installed.
 */
const publishCommit = async ($: EngineInterface, root: string, message: string): Promise<void> => {
  if ((await hubMode($)) === undefined) return
  const [sha, branch, files] = await Promise.all([
    git($, root, ['rev-parse', 'HEAD']),
    git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, root, ['show', '--name-only', '--format=', 'HEAD']),
  ])
  if (!sha.ok || sha.out.trim() === '') return
  await hubPublish($, {
    topic: 'git.commit',
    data: {
      sha: sha.out.trim(),
      message,
      branch: branch.ok ? branch.out.trim() : '',
      files: files.out.split('\n').filter(line => line.trim() !== '').length,
    },
    scope: 'global',
  })
}

const commitDraft = async ($: EngineInterface, settings: Settings): Promise<void> => {
  const { message } = await read($, draft)
  await setDraft($, { phase: 'committing', error: null })
  const committed = await git($, settings.root, ['commit', '-m', message])
  if (!committed.ok) {
    await setDraft($, { phase: 'error', error: `git commit failed: ${committed.err || committed.out.trim()}` })
    return
  }
  const head = await git($, settings.root, ['log', '-1', '--format=%h %s'])
  await setDraft($, { phase: 'done', committed: head.ok ? head.out.trim() : (message.split('\n')[0] ?? '') })
  await publishCommit($, settings.root, message)
}

const reviseSubject = async ($: EngineInterface, subject: string, root: string): Promise<void> => {
  const current = await read($, draft)
  const message = withSubject(current.message, subject)
  const rules = await loadRules($, root)
  await setDraft($, { phase: 'ready', message, problems: problemsOf(message, rules) })
}

/** `/commit [all]`: checks there is something staged, opens the pane and drafts the message. */
const runCommit = async ($: EngineInterface, args: string, model: string, commandName: string): Promise<{ text: string }> => {
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { text: `${PLUGIN}: not in a git repository.` }
  const root = top.out.trim()

  if (args.trim() === 'all') {
    const staged = await git($, root, ['add', '-A'])
    if (!staged.ok) return { text: `${PLUGIN}: git add -A failed: ${staged.err}` }
  }
  const cached = await git($, root, ['diff', '--cached', '--quiet'])
  if (cached.ok) {
    const changed = (await git($, root, ['status', '--porcelain'])).out.trim()
    const count = changed === '' ? 0 : changed.split('\n').length
    return {
      text:
        count === 0
          ? `${PLUGIN}: nothing to commit, the work tree is clean.`
          : `${PLUGIN}: nothing is staged. Stage files with git add, or run /${commandName} all to stage all ${count} changed file${count === 1 ? '' : 's'}.`,
    }
  }

  await update($, draft, () => ({ ...IDLE, repo: root }))
  await $.ui.open({ id: PANE, title: 'Commit', focus: true })
  await compose($, { model, root })
  const { phase, error } = await read($, draft)
  return { text: phase === 'ready' ? `${PLUGIN}: draft ready in the Commit pane.` : `${PLUGIN}: ${error ?? 'no draft.'}` }
}

export const register: Register = (on, options) => {
  const model = typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : 'haiku'
  let commandName = COMMAND_NAMES[0] as string

  on('session.start', async ($, e, next) => {
    // `/commit` may be taken by a built-in or bundled command; fall back to a name of our own.
    for (const name of COMMAND_NAMES) {
      try {
        await $.command.register({ name, description: 'Write a Conventional Commit message for the staged diff and commit it', argumentHint: '[all]' })
        commandName = name
        break
      } catch (error) {
        $.ui.log(`${PLUGIN}: /${name} is not available (${String(error)})`, { to: 'debug' })
      }
    }
    await greetHub($)
    return next(e)
  })

  on('command.run', { command: 'commit' }, ($, e) => runCommit($, e.args, model, commandName))
  on('command.run', { command: 'compose-commit' }, ($, e) => runCommit($, e.args, model, commandName))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const current = await read($, draft)
    const root = current.repo
    if (root === null) return <Text dimColor>Run /{commandName} to draft a commit message for the staged changes.</Text>
    const settings: Settings = { model, root }
    const close = () => $.ui.close({ id: PANE })

    const header = (
      <Box flexDirection="row" gap={1}>
        <Text bold>Commit</Text>
        <Text dimColor>
          {current.summary}
          {current.rulesSource === null ? '' : ` · rules from ${current.rulesSource}`}
        </Text>
      </Box>
    )
    const files = (
      <Box flexDirection="column">
        {current.files.map(line => (
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    )

    if (current.phase === 'done') {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box key="result">
            <Text color="success">✓ Committed {current.committed}</Text>
          </Box>
          <Button key="close" label="Close" role="dismiss" hotkey="q" autoFocus onPress={close} />
        </Box>
      )
    }

    const [subject = '', ...body] = current.message.split('\n')
    const isBusy = current.phase === 'generating' || current.phase === 'committing'
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {files}
        {current.phase === 'generating' && <Text color="suggestion">Writing a message with {model}…</Text>}
        {current.phase === 'committing' && <Text color="suggestion">Committing…</Text>}
        {current.message !== '' && (
          <Box key="message" flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
            <Text bold>{subject}</Text>
            {body.length > 0 && <Text>{body.join('\n')}</Text>}
          </Box>
        )}
        {current.problems.length > 0 && (
          <Box key="problems" flexDirection="column">
            {current.problems.map(problem => (
              <Text color="warning">! {problem}</Text>
            ))}
          </Box>
        )}
        {current.error !== null && (
          <Box key="error">
            <Text color="error">{current.error}</Text>
          </Box>
        )}
        {current.phase === 'editing' && Input !== undefined ? (
          <Box flexDirection="column">
            <Input
              key="subject"
              label="Subject "
              value={subject}
              submitLabel="save"
              autoFocus
              onSubmit={(value: string) => reviseSubject($, value, root)}
            />
            <Input
              key="instruction"
              label="Or ask for changes "
              placeholder="e.g. use the auth scope, mention the migration"
              submitLabel="regenerate"
              onSubmit={(value: string) => (value.trim() === '' ? setDraft($, { phase: 'ready' }) : compose($, settings, value))}
            />
            <Button key="back" label="Back" onPress={() => setDraft($, { phase: 'ready' })} />
          </Box>
        ) : (
          !isBusy && (
            <Box flexDirection="row" gap={1}>
              {current.message !== '' && current.phase === 'ready' && (
                <Button key="commit" label="Commit" hotkey="c" variant="primary" autoFocus onPress={() => commitDraft($, settings)} />
              )}
              <Button key="regenerate" label="Regenerate" hotkey="r" onPress={() => compose($, settings)} />
              {current.message !== '' && Input !== undefined && (
                <Button key="edit" label="Edit" hotkey="e" onPress={() => setDraft($, { phase: 'editing' })} />
              )}
              <Button key="cancel" label="Cancel" hotkey="q" role="dismiss" onPress={close} />
            </Box>
          )
        )}
      </Box>
    )
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, draft, () => IDLE)
    return next(e)
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
