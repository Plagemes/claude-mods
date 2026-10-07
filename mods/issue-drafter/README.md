# issue-drafter
> /issue turns the current conversation into a well-structured GitHub issue.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
`/issue` asks a fork of the current conversation (same model, served from the prompt cache, no tools) to write a self-contained GitHub issue: a title and a body with **Summary**, **Steps to reproduce** (or **Proposal** for a feature), **Expected**, **Actual** and **Context**, using the real paths, commands and errors from the session and `TODO` where something is unknown. You review it in a pane, rename it if you like, then create it with the GitHub CLI or copy it.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install issue-drafter@claude-mods
```

## Usage
- `/issue` — let the draft pick bug or feature.
- `/issue bug` / `/issue feature` — force the type; add words to focus it: `/issue bug the checkout rounding`.
- The **Issue draft** pane shows the type, title and body, a **Title** field (Enter renames), and **Create with gh** (`g`), **Copy** (`c`), **Redraft** (`r`), **Close**. After creating, it shows the issue link with **Copy link**.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `labels` | string | `""` | Labels for every created issue, comma-separated (they must exist in the repo). |
| `typeLabels` | boolean | `false` | Also add `bug` or `enhancement` after the draft's type. |

## How it works
- `command.run` (`/issue`) calls `$.model.fork`, so the draft sees the whole conversation without adding to it; the pane draws from `$.state`.
- **Create with gh** writes the body to `$TMPDIR/claude-issue-<time>.md` (default `/tmp`) with `$.fs`, then runs `gh issue create --title … --body-file …` in the project root. Errors from gh (not installed, not logged in, unknown label) are shown in the pane and the draft is kept.
- Needs `gh` installed and authenticated for the current repository; Copy works anywhere. The temporary body file is left in the temp folder.
