# context-optimizer
> Keeps the context lean automatically: trims noise, picks the right moment to compact and shows the tokens it saved.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
Cuts noisy tool results (a 3,000-line grep, a huge MCP reply, a build log) to their head, tail and error lines before Claude reads them, and replaces an unchanged file Claude re-reads with a one-line note pointing at the earlier read. It watches the context fill and spots good moments to compact (a commit, green tests, a finished todo list, a new topic) and suggests `/compact` with a focus, or runs it for you when you opt in. Before any compaction it saves a short carry-over (decisions, open todos, files in play, the last test run), asks the summary to keep it, and hands it back to Claude with your next prompt.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install context-optimizer@claude-mods
```

## Usage
- `/ctx` opens the **Context** tab (in the Claude Mods panel with mods-hub, its own pane without) and prints a summary: the fill gauge, the biggest contributors since the last compaction (by tool, and by file read, plus the window's categories as `/context` counts them), the tokens saved by trimming and by dedupe, the compaction history, and switches for this session (trim, dedupe, carry-over, compact by itself).
- At a good moment a band appears above the prompt, `◆ Good moment to /compact: after a commit · 72% full [Compact] [Later]`, and a notice carries the ready-made `/compact <focus>`. `/ctx compact` compacts now with that focus.
- With `autoCompact` on, it runs `/compact <focus>` itself once the session has been idle for `idleSeconds` after such a moment; typing anything cancels it.
- Claude sees `[context-optimizer: lines 61-2,940 (2,880 lines) of this Grep result cut to save context …]` in a trimmed result, and `[context-optimizer: already read src/big.ts at turn 3; unchanged since …]` for a repeated read (reading it once more brings it back whole).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `trimAboveChars` | number | `10000` | Tool results longer than this are trimmed; `0` turns trimming off. |
| `trimTools` | string | `Bash,Grep,Glob,WebFetch,WebSearch,mcp__*` | Tools whose results are trimmed (`*` wildcard). Read, Edit, Write, todo and Agent results never are. |
| `suggestAt` | number | `55` | Context fill (%) from which task boundaries are suggested as compaction moments. |
| `autoCompact` | boolean | `false` | Run `/compact` by itself at a good moment once idle. |
| `idleSeconds` | number | `45` | Idle time before an automatic compaction. |
| `carryOver` | boolean | `true` | Keep decisions, todos and files in play across a compaction. |
| `dedupeReads` | boolean | `true` | Replace unchanged repeated reads with a note. |

## How it works
- **Trim and dedupe** in `session.append` on tool-result rows of the main conversation (subagents are left alone): Claude reads the trimmed text while the transcript still draws the full output. When **output-trimmer** is installed (from mods-hub's plugin list, else your `enabledPlugins`) Bash results are left to it and only the other tools are trimmed here. A read counts as repeated when the same path and range is read again with the same size and modification time, within 12 turns and with no compaction since. Token figures are estimates (4 characters per token).
- **Moments** come from `session.measure` (the live fill), `tool.call` (git commit/push, `gh pr create`, a passing test run via the shared test-runner detector, TodoWrite) and `prompt.submit` (a prompt sharing almost no words with the recent ones is a new topic); a commit with todos still open is not a boundary, and there is at most one suggestion per 6 turns. The suggestion goes through `notify` (info, terminal only).
- **Carry-over:** `session.compact` adds it to the compaction's instructions (yours are kept first) and, once the compaction stands, gives it back as `prompt.submit` context with the next prompt. Decisions are sentences of your prompts such as "let's…", "never…", "use X instead", plus `decision.recorded` events from the hub.
- **Bus:** publishes `context.pressure` when the fill crosses 70/85/95 % (unless mods-hub just published the same step) and `x.context-optimizer.saved` after each turn that saved tokens; registers the Context tab. Without mods-hub everything works the same, with its own pane and toasts.
