import { simpleCommands as readCommands } from './shared/shell'

/** One simple command of a shell line: its words, and how data reaches it. */
export type Simple = {
  /** The command and its arguments, wrappers (`sudo`, `env X=1`, `timeout 5`, `xargs`) peeled. */
  words: string[]
  /** Targets of its redirections (`> /dev/tcp/host/port`, `< file`). */
  redirects: string[]
  /** It follows a `|`: another command's output is its input. */
  isPiped: boolean
  /** It reads a file or here-document: `< file`, `<<EOF`, `<<<`. */
  hasInput: boolean
}

/**
 * The simple commands of a shell line, from the shared claude-mods shell reader: quotes, comments and
 * here-document bodies are honoured, wrappers peeled, and the scripts of `bash -c '...'`, `eval`, `$(...)` and
 * heredocs fed to a shell read as commands of their own. A script handed to a shell takes on how data reached
 * that shell (a pipe, a file); a substitution's commands do not, and a heredoc fed to a shell is its script, not
 * its data.
 */
export const simpleCommands = (line: string): Simple[] => {
  /** The latest command at each depth: a script nested at depth d is run by the one at d - 1. */
  const latest: Simple[] = []
  const commands: Simple[] = []
  for (const command of readCommands(line)) {
    const parent = command.depth > 0 && command.via !== '$()' ? latest[command.depth - 1] : undefined
    const simple: Simple = {
      words: command.argv,
      redirects: command.redirects.map(({ target }) => target).filter(target => target !== ''),
      isPiped: command.stage > 0 || parent?.isPiped === true,
      hasInput: command.redirects.some(({ op }) => op.startsWith('<')) || (command.via !== 'heredoc' && parent?.hasInput === true),
    }
    latest[command.depth] = simple
    if (simple.words.length > 0 || simple.redirects.length > 0) commands.push(simple)
  }
  return commands
}
