# auto-checkpoint
> Snapshots your work tree before every editing turn and lets you /rollback to any checkpoint.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
Before the first edit of each turn (an `Edit`, `Write`, `NotebookEdit` or a Bash command that is not obviously read-only), the whole work tree is saved as a git commit under `refs/claude-checkpoints/<n>`, labelled with your prompt. Untracked files are included, ignored files are not, and your index, branch and stash are never touched. `/checkpoints` lists them; rolling back first saves the current state as a new checkpoint, so a rollback can itself be undone.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install auto-checkpoint@claude-mods
```

## Usage
- `/checkpoints` opens a pane listing the checkpoints of this repository, newest first, each with its prompt and age and a **Roll back** button that asks for confirmation.
- `/rollback <n>` opens the same pane with checkpoint `n` waiting for your confirmation. (Claude Code's built-in `/rewind` owns that name, so this mod uses `/rollback`.)
- After a checkpoint is taken, the status line reads `checkpoint #12 saved · /checkpoints`.

The refs are plain git: `git diff refs/claude-checkpoints/12` or `git checkout refs/claude-checkpoints/12 -- path/to/file` work too.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `keep` | number | `20` | How many checkpoints to keep per repository (1–200); older refs are deleted. |

## How it works
- `turn.start` remembers the prompt; a `tool.call` hook on editing tools snapshots once per turn through a private index (`GIT_INDEX_FILE=.git/claude-checkpoint.index`: `read-tree --reset HEAD`, `add -A`, `write-tree`, `commit-tree`, `update-ref`). A tree identical to the newest checkpoint is not saved again.
- A rollback runs `read-tree -m -u <current> <checkpoint>` on that private index: changed files are restored and files created since are removed, while the real index and HEAD stay as they were. The list lives in the plugin store per repository; the pane draws from session state.
- Silent outside git repositories, and a failed snapshot never blocks the tool call (it is written to the debug log). Ignored files (`node_modules`, build output) are not part of a checkpoint and are left alone by a rollback.
- Limits: the edit waits for its snapshot. The first one in a large repository hashes every file and can take a few seconds; later ones only hash what changed. Large untracked files that are not ignored are stored in `.git` too, so keep `.gitignore` current.
- With [mods-hub](../mods-hub) installed every saved checkpoint is published as `x.auto-checkpoint.saved` (number, commit, repository name and the first 80 characters of the prompt), and a paused mod (a snapshot outran its timeout) is also sent as a warning through the hub's notifications, so you hear about it away from the terminal; without the hub only the status line says so. `turn.finished` is not read: the checkpoint is taken before the turn's first edit, so there is nothing to do when the turn ends. The pane stays this mod's own.
