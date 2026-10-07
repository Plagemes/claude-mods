import { atom, read, update } from 'claude-code'
import type { PromptOrigin, Register } from 'claude-code'

const DEFAULT_MAX = 15
const DEFAULT_ALLOW_WORD = 'EDITS-OK'
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

/** What this turn has modified so far, and whether the person has already said yes. */
const turn = { files: new Set<string>(), isApproved: false }

/** The file a write-type tool call changes, qualified by the machine it runs on. */
const targetOf = (input: Readonly<Record<string, unknown>>): string | undefined => {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? `${String(input._host ?? '')}:${path}` : undefined
}

const positiveInteger = (text: string): number | undefined => (/^\d+$/.test(text) && Number(text) >= 1 ? Number(text) : undefined)

export const register: Register = (on, options) => {
  const asked = Math.floor(Number(options.max))
  const configured = Number.isFinite(asked) && asked >= 1 ? asked : DEFAULT_MAX
  const allowWord = typeof options.allowWord === 'string' ? options.allowWord.trim() : DEFAULT_ALLOW_WORD
  const override = atom({ plugin: 'edit-limit', key: 'override' } as const, null)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'edit-limit',
      description: 'Show or change how many files one turn may modify before Claude asks you',
      argumentHint: '[<n>|reset]',
    })
    return next(e)
  })

  on('command.run', { command: 'edit-limit' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const was = (await read($, override)) ?? configured
    if (arg === '') {
      const approval = allowWord === '' ? '' : ` Say ${allowWord} in a prompt to lift it for one turn.`
      return { text: `This turn: ${turn.files.size} of ${was} files modified.${approval} /edit-limit <n> changes the limit for this session.` }
    }
    if (arg === 'reset') {
      await update($, override, () => null)
      return { text: `The limit is back to ${configured} files per turn.` }
    }
    const raised = positiveInteger(arg)
    if (raised === undefined) return { text: 'Give a whole number of files, 1 or more: /edit-limit 30 (or /edit-limit reset).' }
    await update($, override, () => raised)
    return { text: `Claude may now modify ${raised} files per turn (was ${was}), until the session ends.` }
  })

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) turn.isApproved = allowWord !== '' && e.text.includes(allowWord)
    // A turn nobody typed (a notification, a schedule, a peer) starts without the approval of an earlier prompt.
    else if (e.turnId === undefined) turn.isApproved = false
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    turn.files.clear()
    return next(e)
  })

  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const target = targetOf(e)
    if (target === undefined) return next(e)

    const limit = (await read($, override)) ?? configured
    const isNew = !turn.files.has(target)
    if (isNew && !turn.isApproved && turn.files.size >= limit) {
      $.ui.toast(`stopped at ${limit} files this turn; Claude was told to check with you`, { timeoutMs: 8000 })
      const ways = [allowWord === '' ? undefined : `writing ${allowWord} in their next message`, 'raising the limit with /edit-limit <n>']
      return {
        deny:
          `edit-limit: this turn has already modified ${turn.files.size} files and the limit is ${limit}, so ${String(e.tool)} was not run. ` +
          'Do not modify more files yet. Summarise your plan (which files, and why) and ask the user whether to continue. ' +
          `They can approve by ${ways.filter(way => way !== undefined).join(' or by ')}.`,
      }
    }

    if (isNew) turn.files.add(target)
    const ran = await next(e)
    if (isNew && (ran.deny !== undefined || ran.isError === true)) turn.files.delete(target)
    return ran
  })
}
