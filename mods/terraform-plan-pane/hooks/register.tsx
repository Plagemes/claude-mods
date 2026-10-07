import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { TfPlan as Plan, TfPlanAction as Action, TfPlanResource as Resource } from '../types'
import { ACTION_ORDER, countsOf, parsePlanCommand, parsePlanJson, parsePlanText, shortCounts } from './plan'
import type { PlanCommand } from './plan'

const PANE = 'tfplan'
const SHOW_TIMEOUT_MS = 60_000
const LISTED_IN_NOTES = 10
const LISTED_IN_TOAST = 3
const ACTION_LOOK: Record<Action, { title: string; verb: string; glyph: string; color: string }> = {
  destroy: { title: 'Destroy', verb: 'destroy', glyph: '-', color: 'error' },
  replace: { title: 'Replace', verb: 'replace', glyph: '±', color: 'error' },
  update: { title: 'Update in place', verb: 'update', glyph: '~', color: 'warning' },
  create: { title: 'Create', verb: 'create', glyph: '+', color: 'success' },
  import: { title: 'Import', verb: 'import', glyph: '⇣', color: 'suggestion' },
  move: { title: 'Move', verb: 'move', glyph: '→', color: 'suggestion' },
  read: { title: 'Read during apply', verb: 'read', glyph: '≡', color: 'subtle' },
}

const planAtom = atom({ plugin: 'terraform-plan-pane', key: 'plan' } as const, null)

/** What this load of the mod holds: a count of plans seen, so a late JSON read never overwrites a newer plan. */
type Host = { seq: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const risky = (plan: Plan): Resource[] => plan.resources.filter(resource => resource.action === 'destroy' || resource.action === 'replace')

const joinPath = (base: string, next: string | undefined): string =>
  next === undefined ? base : next.startsWith('/') ? next : `${base.replace(/\/$/, '')}/${next.replace(/^\.\//, '')}`

/** `a, b and 3 more`. */
const listOf = (items: readonly string[], room: number): string => {
  const shown = items.slice(0, room)
  const rest = items.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : (shown[0] ?? '')
}

const describeRisk = (resources: readonly Resource[], room: number): string => {
  const named = (action: Action) =>
    resources.filter(resource => resource.action === action).map(resource => (resource.detail === null ? resource.address : `${resource.address} (${resource.detail})`))
  const destroyed = named('destroy')
  const replaced = named('replace')
  return [destroyed.length > 0 ? `destroys ${listOf(destroyed, room)}` : null, replaced.length > 0 ? `replaces ${listOf(replaced, room)}` : null]
    .filter(part => part !== null)
    .join(' and ')
}

/** The plan's output as the Bash tool returned it: its record's streams, the file a long output was saved to, or the text the model read. */
async function outputOf($: EngineInterface, ran: ToolCallResult): Promise<string> {
  const result: unknown = ran.result
  if (isRecord(result)) {
    if (typeof result.persistedOutputPath === 'string') {
      const saved = await $.fs.read(result.persistedOutputPath).catch(() => undefined)
      if (typeof saved === 'string') return saved
    }
    if (typeof result.stdout === 'string') return `${result.stdout}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
  }
  return ran.text ?? (typeof result === 'string' ? result : '')
}

/** Publishes a plan, shows it in the status line, and raises a toast when it destroys more than the plan it refines did. */
async function record($: EngineInterface, plan: Plan, previous: Plan | undefined): Promise<void> {
  await update($, planAtom, () => plan)
  const danger = risky(plan)
  if (plan.error !== null) $.ui.status('✗ tf plan failed · /tfplan')
  else if (plan.isNoChanges) $.ui.status('✓ tf plan: no changes')
  else $.ui.status(`${danger.length > 0 ? '⚠ ' : ''}tf plan: ${shortCounts(plan.resources)} · /tfplan`)
  if (danger.length > (previous === undefined ? 0 : risky(previous).length)) {
    $.ui.toast(`${plan.tool} plan ${describeRisk(danger.map(resource => ({ ...resource, detail: null })), LISTED_IN_TOAST)}. /tfplan`, { timeoutMs: 8_000 })
  }
}

/** Reads the saved plan file with `show -json` for exact addresses and reasons; keeps the text reading when that fails. */
async function refine($: EngineInterface, host: Host, seq: number, command: PlanCommand, base: string, plan: Plan): Promise<void> {
  if (command.out === undefined) return
  const argv = [command.tool, ...(command.chdir === undefined ? [] : [`-chdir=${command.chdir}`]), 'show', '-json', '-no-color', command.out]
  try {
    const shown = await $.process.run(argv, { cwd: base, timeoutMs: SHOW_TIMEOUT_MS })
    const parsed = shown.exitCode === 0 ? parsePlanJson(shown.stdout) : undefined
    if (parsed === undefined || host.seq !== seq) return
    await record($, { ...plan, source: 'json', resources: parsed.resources, isNoChanges: parsed.isNoChanges }, plan)
  } catch {
    // No terraform on PATH for us, or it took too long: the text reading stands.
  }
}

async function askReview($: EngineInterface, plan: Plan): Promise<void> {
  const text = [
    `Before anything is applied, review the last ${plan.tool} plan (\`${plan.command}\`): it ${describeRisk(risky(plan), LISTED_IN_NOTES)}.`,
    'For each of these, explain why the plan does it and whether it is safe. If it is not intended, say how to avoid it (moved blocks, lifecycle rules, ignore_changes, fixing the attribute that forces replacement).',
    'Do not apply anything.',
  ].join('\n\n')
  await $.prompt.submit({ text, asUser: true })
}

/** Lines that say the plan's summary counts more than the output listed (the output was cut). */
function cutNote(plan: Plan): string | null {
  if (plan.summary === null || plan.source === 'json') return null
  const counts = countsOf(plan.resources)
  const isCut =
    counts.create + counts.replace < plan.summary.add || counts.update < plan.summary.change || counts.destroy + counts.replace < plan.summary.destroy
  if (!isCut) return null
  const { add, change, destroy } = plan.summary
  return `The plan's summary says ${add} to add, ${change} to change, ${destroy} to destroy, but its output listed fewer (it was cut). Plan with -out=<file> so this pane reads the whole plan.`
}

export const register: Register = on => {
  const host: Host = { seq: 0 }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tfplan', description: 'Show the last terraform/tofu plan: resources to create, change and destroy' })
    return next(e)
  })

  on('command.run', { command: 'tfplan' }, async $ => {
    const plan = await read($, planAtom)
    if (plan === null) return { text: 'No terraform plan in this session yet: the pane fills in when Claude runs `terraform plan` (or `tofu plan`).' }
    await $.ui.open({ id: PANE, title: `${plan.tool} plan` })
    return { text: `${plan.tool} plan: ${plan.error !== null ? 'failed' : shortCounts(plan.resources)}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = parsePlanCommand(e.command)
    const ran = await next(e)
    if (command === undefined || ran.deny !== undefined) return ran
    try {
      const parsed = parsePlanText(await outputOf($, ran))
      if (parsed.resources.length === 0 && parsed.summary === null && !parsed.isNoChanges && parsed.error === null) return ran

      host.seq += 1
      const seq = host.seq
      const base = joinPath(await $.session.cwd(), command.cd)
      const plan: Plan = { tool: command.tool, command: e.command, dir: joinPath(base, command.chdir), source: 'text', at: await $.clock.now(), ...parsed }
      await record($, plan, undefined)
      if (command.out !== undefined && parsed.error === null) $.clock.after(0, () => void refine($, host, seq, command, base, plan))

      const danger = risky(plan)
      if (danger.length === 0) return ran
      const note = `terraform-plan-pane: this plan ${describeRisk(danger, LISTED_IN_NOTES)}. Make sure the user knows this before anything is applied.`
      return { ...ran, context: [...(ran.context ?? []), note] }
    } catch {
      return ran
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const plan = await read($, planAtom)
    const close = <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
    if (plan === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>No plan yet</Text>
          <Text dimColor>The pane fills in when Claude runs `terraform plan` or `tofu plan`.</Text>
          {close}
        </Box>
      )
    }

    const counts = countsOf(plan.resources)
    const danger = risky(plan)
    const cut = cutNote(plan)
    const source = plan.source === 'json' ? 'read from the saved plan file' : 'read from its output'

    return (
      <Box flexDirection="column">
        <Box key="counts" flexDirection="row" flexWrap="wrap" columnGap={2}>
          {plan.error !== null ? (
            <Text bold color="error">
              ✗ Plan failed
            </Text>
          ) : plan.isNoChanges ? (
            <Text bold color="success">
              ✓ No changes
            </Text>
          ) : (
            ACTION_ORDER.filter(action => counts[action] > 0).map(action => (
              <Text bold color={ACTION_LOOK[action].color}>
                {ACTION_LOOK[action].glyph}
                {counts[action]} to {ACTION_LOOK[action].verb}
              </Text>
            ))
          )}
        </Box>
        <Box key="meta">
          <Text dimColor wrap="truncate-end">
            {`$ ${plan.command} · ${plan.dir} · ${source}`}
          </Text>
        </Box>
        {plan.error !== null && (
          <Box key="error" marginTop={1}>
            <Text color="error">Error: {plan.error}</Text>
          </Box>
        )}
        {plan.isNoChanges && (
          <Box key="clean" marginTop={1}>
            <Text dimColor>Your infrastructure matches the configuration.</Text>
          </Box>
        )}
        {cut !== null && (
          <Box key="cut" marginTop={1}>
            <Text color="warning">{cut}</Text>
          </Box>
        )}
        {ACTION_ORDER.filter(action => counts[action] > 0).map(action => (
          <Box key={`group:${action}`} flexDirection="column" marginTop={1}>
            <Text bold color={ACTION_LOOK[action].color}>
              {ACTION_LOOK[action].title} ({counts[action]})
            </Text>
            {plan.resources
              .filter(resource => resource.action === action)
              .map(resource => (
                <Box key={`${action}:${resource.address}:${resource.detail ?? ''}`} flexDirection="row" columnGap={1}>
                  <Text color={ACTION_LOOK[action].color}>{` ${ACTION_LOOK[action].glyph}`}</Text>
                  <Text bold={action === 'destroy' || action === 'replace'} wrap="truncate-middle">
                    {resource.address}
                  </Text>
                  {resource.detail !== null && <Text dimColor wrap="truncate-end">({resource.detail})</Text>}
                </Box>
              ))}
          </Box>
        ))}
        <Box key="actions" flexDirection="row" gap={1} marginTop={1}>
          {danger.length > 0 && <Button key="review" label="Ask Claude to review" hotkey="a" variant="primary" onPress={() => void askReview($, plan)} />}
          {close}
        </Box>
      </Box>
    )
  })
}
