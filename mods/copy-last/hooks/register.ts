import type { EngineInterface, Register, UiCopyResult } from 'claude-code'

type CodeBlock = { language: string; code: string }

const OPENING_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/
const NOTHING_YET = "Claude hasn't answered yet in this session, so there is nothing to copy."

const countLines = (text: string): number => text.split('\n').length

/** Fenced code blocks of a Markdown text in order, as CommonMark reads them (an unclosed fence runs to the end). */
const codeBlocksOf = (markdown: string): CodeBlock[] => {
  const blocks: CodeBlock[] = []
  let open: { indent: number; fence: string; language: string; lines: string[] } | undefined

  for (const line of markdown.split('\n')) {
    if (open === undefined) {
      const opening = OPENING_FENCE.exec(line)

      if (opening !== null) {
        open = {
          indent: (opening[1] ?? '').length,
          fence: opening[2] ?? '```',
          language: opening[3] ?? '',
          lines: [],
        }
      }
      continue
    }

    const trimmed = line.trim()
    const isClosing = trimmed.length >= open.fence.length && trimmed === (open.fence[0] ?? '`').repeat(trimmed.length)

    if (isClosing) {
      blocks.push({ language: open.language, code: open.lines.join('\n') })
      open = undefined
    } else {
      const strip = Math.min(open.indent, line.length - line.trimStart().length)
      open.lines.push(line.slice(strip))
    }
  }

  if (open !== undefined) {
    blocks.push({ language: open.language, code: open.lines.join('\n') })
  }

  return blocks
}

/** The assistant's answers that have text, newest first. */
const answersNewestFirst = async ($: EngineInterface): Promise<string[]> =>
  (await $.session.messages())
    .filter(message => message.role === 'assistant' && message.text.trim() !== '')
    .map(message => message.text)
    .reverse()

const describeFailure = (result: Extract<UiCopyResult, { isCopied: false }>): string =>
  result.reason === 'no-surface'
    ? 'Nothing to copy to: this session draws no screen (a headless run).'
    : result.reason === 'no-clipboard'
      ? 'The clipboard did not take it: no clipboard tool was found and the terminal ignored the OSC 52 request.'
      : 'Another plugin refused the copy.'

const copy = async ($: EngineInterface, text: string, what: string): Promise<{ text: string }> => {
  const result = await $.ui.copy({ text })

  return {
    text: result.isCopied
      ? `Copied ${what} (${text.length} characters, ${countLines(text)} lines).`
      : describeFailure(result),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'copy-last',
      description: "Copy Claude's last answer to the clipboard",
    })
    await registerCommand($, {
      name: 'copy-code',
      description: "Copy the last fenced code block of Claude's answers to the clipboard",
      argumentHint: '[n]',
    })

    return next(e)
  })

  on('command.run', { command: 'copy-last' }, async $ => {
    const [latest] = await answersNewestFirst($)

    return latest === undefined ? { text: NOTHING_YET } : copy($, latest, "Claude's last answer")
  })

  on('command.run', { command: 'copy-code' }, async ($, e) => {
    const asked = Number.parseInt(e.args, 10)
    const nth = Number.isFinite(asked) && asked > 0 ? asked : 1
    const answers = await answersNewestFirst($)

    if (answers.length === 0) {
      return { text: NOTHING_YET }
    }

    // Newest block first, across answers: the last block of the last answer is number 1.
    const blocks = answers.flatMap(answer => codeBlocksOf(answer).reverse())
    const block = blocks[nth - 1]

    if (block === undefined) {
      return {
        text:
          blocks.length === 0
            ? "No fenced code block in Claude's answers yet."
            : `Only ${blocks.length} code block${blocks.length === 1 ? '' : 's'} so far.`,
      }
    }

    return copy($, block.code, block.language === '' ? 'the code block' : `the ${block.language} code block`)
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
