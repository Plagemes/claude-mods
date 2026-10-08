import type { EngineInterface, Register } from 'claude-code'

const NO_SELECTION =
  'Nothing is selected. Select text in the transcript with the mouse first (fullscreen terminal or desktop app).'
const NO_PROMPT_BOX = 'The prompt box is not available right now (a dialog is open or this session has no prompt).'
const MIN_FENCE = 3

const trimTrailingNewlines = (text: string): string => text.replace(/\n+$/, '')

const quote = (text: string): string =>
  text
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n')

/** A fence longer than any run of backticks inside the text, so the block cannot close early. */
const fenced = (text: string, language: string): string => {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(MIN_FENCE, longestRun + 1))

  return `${fence}${language}\n${text}\n${fence}`
}

const insertSelection = async (
  $: EngineInterface,
  format: (selected: string) => string,
  done: string,
): Promise<{ text: string }> => {
  const selected = await $.ui.selection()
  const text = selected === undefined ? '' : trimTrailingNewlines(selected.text)

  if (text.trim() === '') {
    return { text: NO_SELECTION }
  }

  const { isFilled } = await $.prompt.fill({ text: `${format(text)}\n\n`, mode: 'insert' })

  return { text: isFilled ? done : NO_PROMPT_BOX }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'quote',
      description: 'Paste your mouse selection into the prompt as a Markdown quote',
    })
    await registerCommand($, {
      name: 'quote-code',
      description: 'Paste your mouse selection into the prompt as a fenced code block',
      argumentHint: '[language]',
    })

    return next(e)
  })

  on('command.run', { command: 'quote' }, $ => insertSelection($, quote, 'Quoted the selection.'))

  on('command.run', { command: 'quote-code' }, ($, e) =>
    insertSelection($, text => fenced(text, e.args.trim()), 'Put the selection in a code block.'),
  )
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
