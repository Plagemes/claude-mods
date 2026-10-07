import type { EngineInterface, Register } from 'claude-code'

import { languageOf, toolsOf } from './languages'
import { WEEKS_SHOWN, asWeek, emptyWeek, isoWeekKey, mergeWeeks, recentWeeks, report } from './weeks'
import type { Week } from './weeks'

const DEFAULT_TOP = 6
const KEY_PREFIX = 'week:'
/** Older weeks are dropped from the store. */
const KEEP_WEEKS = 60

/** Counts not yet written to the store, by week: they are flushed at the end of a turn, not on every tool call. */
const pending = new Map<string, Week>()

const record = (now: number, language: string | undefined, tools: readonly string[]): void => {
  const key = isoWeekKey(now)
  const week = pending.get(key) ?? emptyWeek()
  if (language !== undefined) week.lang[language] = (week.lang[language] ?? 0) + 1
  for (const tool of tools) week.tool[tool] = (week.tool[tool] ?? 0) + 1
  pending.set(key, week)
}

/** Adds the pending counts to the stored weeks and drops the oldest ones; on any trouble the counts wait for the next flush. */
async function flush($: EngineInterface): Promise<void> {
  if (pending.size === 0) return
  const batch = [...pending]
  pending.clear()
  try {
    for (const [key, week] of batch) {
      const stored = asWeek(await $.store.get(KEY_PREFIX + key))
      await $.store.set(KEY_PREFIX + key, mergeWeeks([stored, week]))
    }
    const keys = (await $.store.keys()).filter(name => name.startsWith(KEY_PREFIX)).sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_WEEKS))) await $.store.delete(old)
  } catch {
    for (const [key, week] of batch) pending.set(key, mergeWeeks([pending.get(key) ?? emptyWeek(), week]))
  }
}

async function summary($: EngineInterface, top: number): Promise<string> {
  await flush($)
  const keys = recentWeeks(await $.clock.now(), WEEKS_SHOWN)
  const weeks = new Map<string, Week>()
  for (const key of keys) weeks.set(key, asWeek(await $.store.get(KEY_PREFIX + key)))
  return report(keys, weeks, top)
}

export const register: Register = (on, options) => {
  const asked = Math.floor(Number(options.topCount))
  const top = Number.isFinite(asked) && asked >= 1 ? asked : DEFAULT_TOP

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'my-skills',
      description: 'Languages and tools you worked with this week and the last 8 weeks',
    })
    return next(e)
  })

  on('command.run', { command: 'my-skills' }, async $ => ({ text: await summary($, top) }))

  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write|NotebookEdit|Bash)$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
    const language = typeof path === 'string' ? languageOf(path) : undefined
    const tools = e.tool === 'Bash' ? toolsOf(e.command) : []
    if (language !== undefined || tools.length > 0) record(await $.clock.now(), language, tools)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await flush($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($)
    return next(e)
  })
}
