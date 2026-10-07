import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { MARKER, addedMarkers, instructions, isSecurityCritical, summary } from './todos'

const STATUS = '🎓 learning'
const DEFAULT_MAX_TODOS = 2

/** TODO(you) markers added this turn, by file. */
const left = new Map<string, number>()

/** The file's current text for a Write: '' when it is new, remote or unreadable. */
async function currentText($: EngineInterface, path: string, isRemote: boolean): Promise<string> {
  if (isRemote) return ''
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

export const register: Register = (on, options) => {
  const asked = Math.floor(Number(options.maxTodos))
  const maxTodos = Number.isFinite(asked) && asked >= 1 ? asked : DEFAULT_MAX_TODOS
  const isOn = atom({ plugin: 'learning-mode', key: 'isOn' } as const, options.startOn === true)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'learning',
      description: 'Turn learning mode on or off: Claude explains why and leaves small TODO(you) pieces for you',
      argumentHint: '[on|off]',
    })
    $.ui.status((await read($, isOn)) ? STATUS : undefined)
    return next(e)
  })

  on('command.run', { command: 'learning' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    const now = await update($, isOn, was => (asked === 'on' ? true : asked === 'off' ? false : !was))
    $.ui.status(now ? STATUS : undefined)
    return {
      text: now
        ? `Learning mode on. Claude will explain why it changes things and leave up to ${maxTodos} ${MARKER} pieces per task for you to write. /learning off turns it off.`
        : 'Learning mode off. Claude is back to writing everything itself.',
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare') || !(await read($, isOn))) return composed
    return { sections: [...composed.sections, { id: 'learning-mode:instructions', text: instructions(maxTodos), scope: 'session' }] }
  })

  on('turn.start', ($, e, next) => {
    left.clear()
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)

    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const before = e.tool === 'Edit' ? e.old_string : e.tool === 'Write' ? await currentText($, path, e._host !== undefined) : ''
    const after = e.tool === 'Edit' ? e.new_string : e.tool === 'Write' ? e.content : e.new_source
    const added = addedMarkers(before, after)
    if (added === 0) return next(e)

    if (isSecurityCritical(path)) {
      return {
        deny:
          `learning-mode: ${path} looks security-critical, so ${MARKER} is not left there. Write that code completely, ` +
          `and keep ${MARKER} for small, non-security pieces.`,
      }
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) left.set(path, (left.get(path) ?? 0) + added)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && left.size > 0 && (await read($, isOn))) {
      $.ui.toast(summary(left, maxTodos), { timeoutMs: 8000 })
      left.clear()
    }
    return next(e)
  })
}
