export type Tip = { id: string; text: string }

/**
 * Every tip is checked against Claude Code 2.1.292 itself: slash commands against the command definitions in the
 * binary, shortcuts against its default keybindings and the `?` shortcuts panel, flags against `claude --help`,
 * and several sentences come from its own tips and /powerup lessons. Commands that no longer exist (/agents is
 * removed, /vim and /todos are gone) are deliberately absent. Keep it that way: add a tip only after checking it.
 */
export const TIPS: readonly Tip[] = [
  { id: 'rewind', text: 'Went down the wrong path? Double-tap esc (or run /rewind) to roll the code and/or the conversation back to an earlier point. Claude checkpoints your files before every edit.' },
  { id: 'modes', text: 'shift+tab cycles the permission modes: default asks before every edit, accept edits edits freely, plan researches without touching files, auto lets Claude decide what is safe.' },
  { id: 'at-mention', text: 'Type @ anywhere in a prompt to fuzzy-find and attach a file. @folder/ attaches a whole directory tree.' },
  { id: 'btw', text: '/btw asks a quick side question without interrupting the main conversation.' },
  { id: 'transcript', text: 'ctrl+o shows verbose output: the full transcript with every tool call. In it, ctrl+e toggles showing everything and q or esc takes you back.' },
  { id: 'compact', text: '/compact summarizes the conversation to free up context. Add your own instructions after it to steer what the summary keeps.' },
  { id: 'queue', text: 'Keep typing while Claude works: Enter queues your message, so you can steer in real time.' },
  { id: 'resume', text: 'claude --continue picks up your latest conversation in this folder; /resume or claude --resume opens a picker, with an optional search term.' },
  { id: 'shell-mode', text: 'Start a prompt with ! to enter shell mode and run a command directly.' },
  { id: 'clear', text: '/clear starts a fresh session with empty context. The old one stays on disk and /resume brings it back.' },
  { id: 'history-search', text: 'ctrl+r searches your prompt history. Press it again for the next match; tab or esc keeps a match for editing, enter runs it.' },
  { id: 'context', text: '/context shows how full the context window is, as a colored grid.' },
  { id: 'clear-input', text: 'Changed your mind about a long prompt? Double-tap esc clears the input box.' },
  { id: 'rename', text: 'Name your conversations with /rename so you can find them in /resume later.' },
  { id: 'newline', text: 'Shift+Enter starts a new line (Option+Enter in Apple Terminal); run /terminal-setup if your terminal needs it. ctrl+j inserts a newline too.' },
  { id: 'init-memory', text: '/init writes a starter CLAUDE.md from your codebase and /memory edits it. Claude reads CLAUDE.md at the start of every session.' },
  { id: 'line-refs', text: 'Reference specific lines with src/app.ts:42 and Claude jumps straight there.' },
  { id: 'background', text: 'ctrl+b sends a running command to the background so you can keep chatting; /tasks shows everything in flight.' },
  { id: 'add-dir', text: '/add-dir <path> (or --add-dir at launch) lets Claude work in another directory.' },
  { id: 'model', text: '/model switches models, and alt+p opens the model picker without leaving the prompt.' },
  { id: 'external-editor', text: 'ctrl+g opens your prompt in $EDITOR, handy for long, careful prompts (ctrl+x ctrl+e does the same).' },
  { id: 'effort', text: '/effort sets how long Claude thinks before answering: high for tricky bugs, low when you just need a quick edit.' },
  { id: 'permissions', text: '/permissions pre-allows specific commands so Claude stops asking about them.' },
  { id: 'interrupt', text: 'Press esc to interrupt Claude while it works, then tell it what to do instead.' },
  { id: 'branch', text: '/branch forks the conversation at this point, so you can try two approaches side by side.' },
  { id: 'paste-image', text: 'ctrl+v pastes an image from the clipboard (control+v, not cmd+v, on a Mac). You can also drag image files into the terminal.' },
  { id: 'hooks', text: '/hooks shows the hooks configured for tool events.' },
  { id: 'todos', text: 'ctrl+t shows or hides Claude\'s task list.' },
  { id: 'skills', text: 'Save a prompt as .claude/skills/<name>/SKILL.md and it becomes /<name>. /skills lists what you have.' },
  { id: 'stash', text: 'Halfway through a prompt and need to send something else first? ctrl+s stashes the one you are typing.' },
  { id: 'plugins', text: '/plugin manages plugins, and claude plugin does the same from your shell.' },
  { id: 'mcp', text: '/mcp lists and connects MCP servers. From your shell, claude mcp add <name> -- <command> wires one up.' },
  { id: 'diff', text: '/diff shows your uncommitted changes.' },
  { id: 'worktree', text: 'Run several Claude sessions in parallel without collisions: claude --worktree <name> gives each its own git worktree.' },
  { id: 'copy', text: '/copy copies Claude\'s last response to the clipboard; /copy 2 copies the one before it.' },
  { id: 'color', text: 'Running several sessions? /color and /rename tell them apart at a glance.' },
  { id: 'statusline', text: '/statusline sets up a custom status line beneath the input box.' },
  { id: 'skill-doctor', text: '/skill-doctor shows which loaded skills are unused and costing you context.' },
  { id: 'default-mode', text: '/config sets your default permission mode, plan mode included.' },
  { id: 'agent-flag', text: 'claude --agent <name> starts a conversation directly with a subagent.' },
  { id: 'print', text: 'claude -p "your question" prints the answer and exits, which makes it handy in pipes and scripts.' },
  { id: 'usage', text: '/usage shows session cost, plan usage and activity stats.' },
  { id: 'shortcuts-panel', text: 'On an empty prompt, ? lists the keyboard shortcuts, / the commands and @ the files. /keybindings opens your shortcuts file to rebind keys.' },
  { id: 'export', text: '/export saves the current conversation to a file or the clipboard.' },
  { id: 'goal', text: '/goal <condition> sets a goal Claude checks before it stops, so it keeps working until the condition is met.' },
  { id: 'background-session', text: 'claude --bg starts a session in the background; claude agents lists them and claude attach <id> opens one again.' },
  { id: 'recap', text: '/recap writes a one-line recap of the session so far.' },
  { id: 'remote-control', text: '/remote-control lets you pick up this session from your phone or claude.ai/code.' },
  { id: 'focus', text: '/focus toggles a focus view: just your prompt, a summary and the response.' },
  { id: 'powerup', text: '/powerup teaches Claude Code features in short interactive lessons.' },
  { id: 'doctor', text: '/doctor checks your installation and setup and can fix what it finds.' },
  { id: 'truecolor', text: 'Colors look washed out? Try setting COLORTERM=truecolor in your environment.' },
  { id: 'release-notes', text: '/release-notes shows what changed in recent versions.' },
]

const pad = (n: number): string => String(n).padStart(2, '0')

/** The person's calendar day (local time), `2026-10-07`. */
export const dayKey = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The tip at `index`, wrapping around the list. */
export const tipAt = (index: number): Tip => TIPS[((index % TIPS.length) + TIPS.length) % TIPS.length] as Tip

/** `index` as a position in the list, from whatever the store holds. */
export const positionOf = (stored: unknown): number =>
  typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored % TIPS.length : 0
