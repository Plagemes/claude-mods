import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { PLUGIN, PRESETS, askFor, listText, presetNamed, presetOfType } from './presets'
import type { Preset } from './presets'
import { SCRATCH_DIRS, applyEdit, codeOnly, isDocPath, isTestPath, knowsComments, shellRefusal } from './scope'

const GUARDED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'] as const
const MAX_KNOWN_AGENTS = 500
const MAX_PATH_DEPTH = 64

/** The fields of a guarded call the guard reads (Edit, Write, NotebookEdit, Bash). */
type GuardedCall = {
  tool: string
  agentId?: string
  command?: unknown
  file_path?: unknown
  notebook_path?: unknown
  old_string?: unknown
  new_string?: unknown
  replace_all?: unknown
  content?: unknown
  cell_id?: unknown
  cell_type?: unknown
}

/** What this load knows: which agents run a preset (null: known not to), and the project root as resolved. */
type Context = { known: Map<string, Preset | null>; root: string | undefined }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The agent type a spawn names: `subagentType`, or the Agent tool's own `subagent_type` spelling. */
const spawnedType = (e: { subagentType?: string }): string | undefined => {
  const spelled = (e as Record<string, unknown>).subagent_type
  return e.subagentType ?? (typeof spelled === 'string' ? spelled : undefined)
}

function remember(context: Context, agentId: string, preset: Preset | null): void {
  if (context.known.size >= MAX_KNOWN_AGENTS) {
    const oldest = context.known.keys().next().value
    if (oldest !== undefined) context.known.delete(oldest)
  }
  context.known.set(agentId, preset)
}

async function registerPresets($: EngineInterface, model: string): Promise<void> {
  const available = new Set((await $.tool.list().catch(() => [])).map(tool => tool.name))
  for (const preset of PRESETS) {
    const tools = preset.tools.filter(tool => available.size === 0 || available.has(tool))
    try {
      await $.agent.register({ name: preset.name, description: preset.description, prompt: preset.prompt, tools, model })
    } catch (error) {
      $.ui.log(`${PLUGIN}: could not register ${preset.name}: ${messageOf(error)}`)
    }
  }
}

/** The preset an agent runs: from its spawn, else from the session's list of agents. */
async function presetOf($: EngineInterface, context: Context, agentId: string): Promise<Preset | undefined> {
  const known = context.known.get(agentId)
  if (known !== undefined) return known ?? undefined
  const listed = (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
  if (listed === undefined) return undefined
  const preset = presetOfType(listed.type) ?? null
  remember(context, agentId, preset)
  return preset ?? undefined
}

async function rootOf($: EngineInterface, context: Context): Promise<string> {
  if (context.root === undefined) {
    const root = (await $.session.root()).replace(/\/+$/, '')
    const stat = await $.fs.stat(root, { resolve: true }).catch(() => undefined)
    context.root = (stat?.realPath ?? root).replace(/\/+$/, '')
  }
  return context.root
}

/** Where a path lands, symbolic links resolved through its deepest existing folder; undefined when it cannot be placed. */
async function placed($: EngineInterface, path: string): Promise<string | undefined> {
  const absolute = path.startsWith('/') ? path : `${(await $.session.cwd()).replace(/\/+$/, '')}/${path}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  if (parts.length === 0 || parts.length > MAX_PATH_DEPTH) return undefined
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const head = `/${parts.slice(0, depth).join('/')}`
    const stat = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
    if (stat?.realPath !== undefined) return [stat.realPath.replace(/\/+$/, ''), ...parts.slice(depth)].join('/')
  }
  return undefined
}

/** For the doc writer in a notebook: only markdown cells. */
async function notebookRefusal($: EngineInterface, call: GuardedCall, real: string, relative: string): Promise<string | undefined> {
  if (call.cell_type === 'markdown') return undefined
  if (call.cell_type !== undefined) return `may edit only markdown cells of ${relative}`
  try {
    const raw = await $.fs.read(real)
    const cells = (JSON.parse(typeof raw === 'string' ? raw : '{}') as { cells?: { id?: unknown; cell_type?: unknown }[] }).cells ?? []
    const cell = cells.find(one => one.id === call.cell_id)
    return cell?.cell_type === 'markdown' ? undefined : `may edit only markdown cells of ${relative}`
  } catch {
    return `could not read ${relative} to check the cell`
  }
}

/** For the doc writer in a source file: the code outside comments and docstrings must stay as it is. */
async function codeChangeRefusal($: EngineInterface, call: GuardedCall, real: string, relative: string): Promise<string | undefined> {
  if (call.tool === 'NotebookEdit') return notebookRefusal($, call, real, relative)
  if (!knowsComments(relative)) return `may only edit documentation, not ${relative}`
  const current = await $.fs.read(real).catch(() => undefined)
  if (typeof current !== 'string') return call.tool === 'Write' ? `may not create code files (${relative})` : `could not read ${relative} to check the edit`
  const after =
    call.tool === 'Write'
      ? call.content
      : typeof call.old_string === 'string' && typeof call.new_string === 'string'
        ? applyEdit(current, call.old_string, call.new_string, call.replace_all === true)
        : undefined
  // An Edit whose old_string is not in the file fails on its own.
  if (typeof after !== 'string') return undefined
  return codeOnly(current, relative) === codeOnly(after, relative) ? undefined : `may change only comments and docstrings in ${relative}; this edit changes code`
}

/** Why `preset` may not make this call, or undefined when it may. */
async function refusal($: EngineInterface, context: Context, preset: Preset, call: GuardedCall): Promise<string | undefined> {
  const root = await rootOf($, context)
  if (call.tool === 'Bash') return typeof call.command === 'string' ? shellRefusal(preset.scope, call.command, root) : undefined

  const path = typeof call.file_path === 'string' ? call.file_path : typeof call.notebook_path === 'string' ? call.notebook_path : undefined
  if (path === undefined) return 'needs a file path it can check'
  const real = await placed($, path)
  if (real === undefined) return `cannot tell where ${path} is, so it may not write there`
  if (!real.startsWith(`${root}/`)) {
    const isScratch = SCRATCH_DIRS.some(dir => real.startsWith(dir))
    return isScratch && preset.scope === 'project' ? undefined : `writes only inside the project, not ${path}`
  }
  const relative = real.slice(root.length + 1)
  if (preset.scope === 'project') return undefined
  if (preset.scope === 'tests') {
    return isTestPath(relative) ? undefined : `may only write test files and fixtures, not ${relative}; report bugs in the code instead of fixing them`
  }
  return isDocPath(relative) ? undefined : codeChangeRefusal($, call, real, relative)
}

/** `/presets <name> <task>`: hands the task to the preset as your prompt, once the command has answered. */
async function delegate($: EngineInterface, args: string): Promise<string> {
  const [name = '', ...rest] = args.trim().split(/\s+/)
  const preset = presetNamed(name)
  if (preset === undefined) return `There is no preset "${name}". The presets are ${PRESETS.map(one => one.name).join(', ')}.`
  const task = rest.join(' ').trim()
  if (task === '') {
    $.clock.after(0, () => void fillPrompt($, preset))
    return `Describe the task for ${PLUGIN}:${preset.name} in the prompt box.`
  }
  $.clock.after(0, () => void $.prompt.submit({ text: askFor(preset, task), asUser: true }).catch(error => $.ui.log(`${PLUGIN}: ${messageOf(error)}`)))
  return `Handing it to ${PLUGIN}:${preset.name}.`
}

/** Starts your prompt with "Use the agent-presets:<name> agent to", keeping what you had typed. */
async function fillPrompt($: EngineInterface, preset: Preset): Promise<void> {
  const draft = (await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))).text.trim()
  const filled = await $.prompt.fill({ text: askFor(preset, draft), mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(`Type: ${askFor(preset, '<task>')}`)
}

export const register: Register = (on, options: PluginOptions) => {
  const model = (typeof options.model === 'string' ? options.model.trim() : '') || 'inherit'
  const context: Context = { known: new Map(), root: undefined }

  on('session.start', async ($, e, next) => {
    await registerPresets($, model)
    await registerCommand($, { name: 'presets', description: 'The ready-made subagents: debugger, test-writer, doc-writer, migrator', argumentHint: '[<name> <task>]' })
    return next(e)
  })

  // Learn which agents run a preset as they start, whoever starts them.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) remember(context, spawned.agentId, presetOfType(spawnedType(e)) ?? null)
    return spawned
  }).catch(($, e, next) => next(e)) // after `next`, this replays its answer: nothing is spawned twice

  // Each preset's write scope, for the calls its own agents make. Fails closed for a known preset.
  on('tool.call', { tool: GUARDED_TOOLS }, async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const preset = await presetOf($, context, e.agentId)
    if (preset === undefined) return next(e)
    const call: GuardedCall = e
    const why = await refusal($, context, preset, call)
    return why === undefined ? next(e) : { deny: `${PLUGIN}: the ${preset.name} preset ${why}.` }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const preset = e.agentId === undefined ? undefined : context.known.get(e.agentId)
    return preset === undefined || preset === null ? next(e) : { deny: `${PLUGIN}: could not check this ${preset.name} call against its scope, so it is refused.` }
  })

  on('command.run', { command: 'presets' }, async ($, e) => {
    try {
      return { text: e.args.trim() === '' ? listText() : await delegate($, e.args) }
    } catch (error) {
      return { text: `${PLUGIN}: ${messageOf(error)}` }
    }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'presets' } }, async ($, e, next) => {
    if (e.props.args.trim() !== '' || e.props.isErrored) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Subagents Claude can delegate to. Each runs with its own brief and tools, and is held to its write scope.</Text>
        {PRESETS.map(preset => (
          <Box key={`preset:${preset.name}`} flexDirection="column">
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text bold color="claude">
                {preset.title}
              </Text>
              <Text dimColor>
                {PLUGIN}:{preset.name}
              </Text>
            </Box>
            <Text>{preset.description}</Text>
            <Text dimColor>
              Writes {preset.scopeLabel} · {preset.tools.includes('Bash') ? 'can run commands' : 'runs no commands'}
            </Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key={`use:${preset.name}`} label={`Use ${preset.title}`} onPress={() => void fillPrompt($, preset)} />
              <Text dimColor wrap="truncate-end">
                or /presets {preset.name} {preset.example}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}
