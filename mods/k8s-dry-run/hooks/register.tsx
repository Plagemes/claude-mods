import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, ToolCallResult } from 'claude-code'

import type { K8sDryRunApproval as Approval, K8sDryRunObject as K8sObject, K8sDryRunPreview as Preview } from '../types'
import { approvalKey, findKubectls, parseDeleted, parseDiff, previewArgv } from './kubectl'
import type { KubectlCall } from './kubectl'

const PANE = 'k8s-diff'
const DEFAULT_PROD = /(^|[-_./:=\s])(prod|production|prd|live)([-_./:=\s]|$)/i
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 300
const CONTEXT_TIMEOUT_MS = 5_000
const APPROVAL_TTL_MS = 30 * 60_000
const BAND_OBJECTS = 4
const SUMMARY_OBJECTS = 12
/** A short reply that approves a held change (outside production contexts). */
const APPROVAL_REPLY = /^\s*(?:y|yes|yep|yeah|ok|okay|sure|approved?|go(?: ahead)?|do it|apply(?: it)?|run it|proceed|confirm(?:ed)?|lgtm|ship it)\s*[.!]*\s*$/i
const DIFF_ENV = { KUBECTL_EXTERNAL_DIFF: 'diff -u -N' }
const CHANGE_LOOK: Record<K8sObject['change'], { glyph: string; color: string }> = {
  create: { glyph: '+', color: 'success' },
  update: { glyph: '~', color: 'warning' },
  delete: { glyph: '-', color: 'error' },
}

const pendingAtom = atom({ plugin: 'k8s-dry-run', key: 'pending' } as const, null)
const approvalsAtom = atom({ plugin: 'k8s-dry-run', key: 'approvals' } as const, [])

type Settings = { isProd: (text: string) => boolean; timeoutMs: number }

/** What this load of the mod remembers: whether the last cluster it judged was production. */
type Host = { wasProd: boolean }

type Outcome = { kind: 'preview'; preview: Preview } | { kind: 'error'; reason: string }

const compile = (source: string): RegExp => {
  try {
    return source.trim() === '' ? DEFAULT_PROD : new RegExp(source, 'i')
  } catch {
    return DEFAULT_PROD
  }
}

/** Words the person typed (or sent from a phone or the SDK); never a notification, a peer or a tool. */
const isFromPerson = (origin: PromptOrigin): boolean =>
  ['composer', 'bridge', 'sdk', 'slack-ping'].includes(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

const joinPath = (base: string, next: string | undefined): string =>
  next === undefined ? base : next.startsWith('/') ? next : `${base.replace(/\/$/, '')}/${next}`

const counts = (object: K8sObject): string => (object.change === 'delete' && object.diff === '' ? 'deleted' : `+${object.adds} −${object.dels}`)

const where = (preview: Pick<Preview, 'context' | 'namespace'>): string =>
  [preview.context === null ? 'the current context' : `context "${preview.context}"`, preview.namespace === null ? null : `namespace "${preview.namespace}"`]
    .filter(part => part !== null)
    .join(', ')

/** The deny text: what the dry run found, and how the change gets approved. */
const holdMessage = (preview: Preview): string => {
  const listed = preview.objects.slice(0, SUMMARY_OBJECTS).map(object => `  ${CHANGE_LOOK[object.change].glyph} ${object.name} (${counts(object)})`)
  const more = preview.objects.length > SUMMARY_OBJECTS ? [`  … and ${preview.objects.length - SUMMARY_OBJECTS} more`] : []
  const how = preview.isProd
    ? 'They approve with the Approve button above the prompt or /k8s-approve (a typed "yes" is not enough on production).'
    : 'They approve with the Approve button above the prompt, /k8s-approve, or a short "yes".'
  return [
    `k8s-dry-run: held for approval. The server-side dry run of \`${preview.command}\` on ${where(preview)}${preview.isProd ? ' (PRODUCTION)' : ''} would change ${preview.objects.length} object${preview.objects.length === 1 ? '' : 's'}:`,
    ...listed,
    ...more,
    `Show this to the user and ask them to approve it. ${how} Once approved, run exactly the same command again; do not change it or add --dry-run.`,
  ].join('\n')
}

const withNote = (ran: ToolCallResult, note: string): ToolCallResult => (ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] })

/** The context the command targets: its --context, else kubectl's current one. */
async function contextOf($: EngineInterface, call: KubectlCall, cwd: string): Promise<string | null> {
  if (call.context !== undefined) return call.context
  try {
    const argv = ['kubectl', ...(call.kubeconfig === undefined ? [] : ['--kubeconfig', call.kubeconfig]), 'config', 'current-context']
    const ran = await $.process.run(argv, { cwd, timeoutMs: CONTEXT_TIMEOUT_MS })
    return ran.exitCode === 0 && ran.stdout.trim() !== '' ? ran.stdout.trim() : null
  } catch {
    return null
  }
}

/** Runs the dry run that stands for the call and reads what it would change. */
async function dryRun($: EngineInterface, settings: Settings, call: KubectlCall, command: string, cwd: string, context: string | null, isProd: boolean): Promise<Outcome> {
  if (call.unpreviewable !== undefined) return { kind: 'error', reason: call.unpreviewable }
  const argv = previewArgv(call)
  if (argv === undefined) return { kind: 'error', reason: 'it names no -f or -k source to diff' }
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs: settings.timeoutMs, env: DIFF_ENV, ...(call.stdin === undefined ? {} : { stdin: call.stdin }) })
    const isDiff = call.verb !== 'delete'
    // kubectl diff exits 1 when it found differences, above 1 on an error.
    if (ran.exitCode > (isDiff ? 1 : 0)) {
      const reason = (ran.stderr.trim() || ran.stdout.trim()).split('\n').slice(0, 3).join(' ').slice(0, 400)
      return { kind: 'error', reason: reason === '' ? `the dry run exited with ${ran.exitCode}` : reason }
    }
    const objects = isDiff ? parseDiff(ran.stdout) : parseDeleted(ran.stdout)
    return {
      kind: 'preview',
      preview: { command, verb: call.verb, context, namespace: call.namespace ?? null, isProd, objects, isCut: ran.isStdoutTruncated },
    }
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error)
    return { kind: 'error', reason: /ENOENT|failed to start/i.test(text) ? 'kubectl is not installed' : /still running|timed? ?out/i.test(text) ? `the dry run took over ${settings.timeoutMs / 1000}s` : text }
  }
}

/** Uses up a live approval of this exact command; false when there is none. */
async function consumeApproval($: EngineInterface, key: string): Promise<boolean> {
  const now = await $.clock.now()
  let isFound = false
  await update($, approvalsAtom, (approvals: Approval[]) => {
    isFound = approvals.some(approval => approval.key === key && approval.until > now)
    return approvals.filter(approval => approval.until > now && approval.key !== key)
  })
  return isFound
}

/** Tells Claude the held command is approved, so it runs it again. */
async function announce($: EngineInterface, preview: Preview): Promise<void> {
  await $.prompt.submit({ text: `I approve \`${preview.command}\` on ${where(preview)}. Run exactly that command again now.`, asUser: true })
}

/** Approves the held command once; `isAnnounced` tells Claude to run it again. */
async function approve($: EngineInterface, isAnnounced: boolean): Promise<Preview | null> {
  const preview = await read($, pendingAtom)
  if (preview === null) return null
  const until = (await $.clock.now()) + APPROVAL_TTL_MS
  const key = approvalKey(preview.command, preview.context)
  await update($, approvalsAtom, (approvals: Approval[]) => [...approvals.filter(approval => approval.key !== key), { key, until }])
  await update($, pendingAtom, () => null)
  $.ui.status(undefined)
  if (isAnnounced) await announce($, preview)
  return preview
}

async function reject($: EngineInterface): Promise<void> {
  const preview = await read($, pendingAtom)
  if (preview === null) return
  await update($, pendingAtom, () => null)
  $.ui.status(undefined)
  await $.prompt.submit({ text: `I rejected \`${preview.command}\`: do not run it. Tell me what you would change instead.`, asUser: true })
}

async function hold($: EngineInterface, preview: Preview): Promise<void> {
  await update($, pendingAtom, () => preview)
  $.ui.status(`⎈ kubectl ${preview.verb} awaiting approval${preview.isProd ? ' · PRODUCTION' : ''}`)
  $.ui.toast(`kubectl ${preview.verb} held: ${preview.objects.length} object${preview.objects.length === 1 ? '' : 's'} would change on ${preview.context ?? 'the current context'}. Approve above the prompt.`)
}

export const register: Register = (on, options) => {
  const prod = compile(String(options.prodPattern ?? ''))
  const seconds = Number(options.timeoutSeconds)
  const settings: Settings = {
    isProd: text => prod.test(text),
    timeoutMs: Math.min(seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000,
  }
  const host: Host = { wasProd: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'k8s-approve', description: 'Approve the kubectl change k8s-dry-run is holding (once)' })
    await $.command.register({ name: 'k8s-diff', description: 'Show the server-side diff of the kubectl change awaiting approval' })
    return next(e)
  })

  on('command.run', { command: 'k8s-approve' }, async $ => {
    const preview = await approve($, false)
    if (preview === null) return { text: 'No kubectl change is waiting for approval.' }
    // A command's own turn is still held here: the prompt goes once it is over.
    $.clock.after(0, () => void announce($, preview))
    return { text: `Approved once: ${preview.command}` }
  })

  on('command.run', { command: 'k8s-diff' }, async $ => {
    if ((await read($, pendingAtom)) === null) return { text: 'No kubectl change is waiting for approval.' }
    await $.ui.open({ id: PANE, title: 'kubectl diff' })
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    if (isFromPerson(e.origin) && APPROVAL_REPLY.test(e.text)) {
      const preview = await read($, pendingAtom)
      if (preview !== null && !preview.isProd) await approve($, false)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const [call, ...others] = findKubectls(e.command)
    if (call === undefined) return next(e)
    // One approval stands for one previewed change: a second change in the same command would run unreviewed.
    if (others.length > 0) {
      return {
        deny: `k8s-dry-run: this command makes ${others.length + 1} kubectl changes. Run each kubectl apply, replace or delete as its own command (or pass several -f to one apply), so each change gets its own dry run and approval.`,
      }
    }

    const cwd = joinPath(await $.session.cwd(), call.cd)
    const context = await contextOf($, call, cwd)
    const isProd = settings.isProd(context ?? '') || settings.isProd(call.namespace ?? '')
    host.wasProd = isProd
    if (await consumeApproval($, approvalKey(e.command, context))) return next(e)

    const outcome = await dryRun($, settings, call, e.command, cwd, context, isProd)
    if (outcome.kind === 'error') {
      if (isProd) {
        return {
          deny: `k8s-dry-run: blocked. No server-side dry run of this change on production ${where({ context, namespace: call.namespace ?? null })} was possible (${outcome.reason}), and production changes are only run after a reviewed diff. Fix what stops the dry run, or ask the user to run the command themselves.`,
        }
      }
      return withNote(await next(e), `k8s-dry-run: no dry run was possible (${outcome.reason}), so the command ran without a reviewed diff.`)
    }
    if (outcome.preview.objects.length === 0) {
      return withNote(await next(e), 'k8s-dry-run: the server-side dry run showed no changes, so the command ran without asking.')
    }
    await hold($, outcome.preview)
    return { deny: holdMessage(outcome.preview) }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The check itself failed: production stays closed, the rest stays open.
    return host.wasProd || settings.isProd(e.command) ? { deny: 'k8s-dry-run: its check failed, so this production change was blocked.' } : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const preview = await read($, pendingAtom)
    if (preview === null || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const shown = preview.objects.slice(0, BAND_OBJECTS)

    return (
      <Box flexDirection="column">
        <Box key="k8s-hold" flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold color={preview.isProd ? 'error' : 'warning'}>
            ⎈ {preview.isProd ? 'PRODUCTION change held' : 'kubectl change held'}
          </Text>
          <Text wrap="truncate-end">{preview.command}</Text>
          <Text dimColor>· {preview.context ?? 'current context'}</Text>
        </Box>
        {shown.map(object => (
          <Box key={`k8s-object:${object.name}`} flexDirection="row" columnGap={1}>
            <Text color={CHANGE_LOOK[object.change].color}>{`  ${CHANGE_LOOK[object.change].glyph}`}</Text>
            <Text wrap="truncate-end">{object.name}</Text>
            <Text dimColor>{counts(object)}</Text>
          </Box>
        ))}
        {preview.objects.length > shown.length && <Text dimColor>{`  … and ${preview.objects.length - shown.length} more`}</Text>}
        <Box key="k8s-actions" flexDirection="row" gap={1}>
          <Button key="k8s-approve" label="Approve" hotkey="a" variant="primary" onPress={() => void approve($, true)} />
          {preview.verb !== 'delete' && <Button key="k8s-show" label="Show diff" hotkey="d" onPress={() => void $.ui.open({ id: PANE, title: 'kubectl diff' })} />}
          <Button key="k8s-reject" label="Reject" hotkey="x" onPress={() => void reject($)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const preview = await read($, pendingAtom)
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
    if (preview === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Nothing is waiting for approval.</Text>
          {close}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box key="header" flexDirection="column">
          <Text bold color={preview.isProd ? 'error' : undefined}>
            {preview.isProd ? '⎈ PRODUCTION · ' : '⎈ '}
            {where(preview)}
          </Text>
          <Text dimColor wrap="truncate-end">{`$ ${preview.command}`}</Text>
          {preview.isCut && <Text color="warning">The dry run's output was cut: more may change than shown.</Text>}
        </Box>
        {preview.objects.map(object => (
          <Box key={`object:${object.name}`} flexDirection="column" marginTop={1}>
            <Box flexDirection="row" columnGap={1}>
              <Text bold color={CHANGE_LOOK[object.change].color}>
                {CHANGE_LOOK[object.change].glyph} {object.name}
              </Text>
              <Text dimColor>{counts(object)}</Text>
            </Box>
            {object.diff !== '' && <Code format="diff" source={object.diff} language="yaml" />}
          </Box>
        ))}
        <Box key="actions" flexDirection="row" gap={1} marginTop={1}>
          <Button
            key="approve"
            label="Approve"
            hotkey="a"
            variant="primary"
            onPress={() => {
              void approve($, true)
              void $.ui.close({ id: PANE })
            }}
          />
          <Button
            key="reject"
            label="Reject"
            hotkey="x"
            onPress={() => {
              void reject($)
              void $.ui.close({ id: PANE })
            }}
          />
          {close}
        </Box>
      </Box>
    )
  })
}
