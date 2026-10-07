# explain-diff
> /explain-diff explains in plain words what changed in the last turn and why.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
While Claude works, explain-diff keeps each file as it was before the turn first touched it, and when the turn ends it computes exactly what that turn changed. `/explain-diff` then asks a model to explain the change file by file: what changed, why it was needed, what to watch out for, and how to check it works, at a beginner or an expert level. The explanation sits in a pane next to the real diff of each file.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install explain-diff@claude-mods
```

## Usage
- `/explain-diff` explains the last turn that changed files at your default level; `/explain-diff expert` or `/explain-diff beginner` picks one for this time.
- The **Explain diff** pane shows `Last change · 2 files +14 -3`, what you asked, a short summary, then each file with its `+/-` counts, **What changed / Why / Watch out / How to check**, and a **Show diff** / **Hide diff** toggle for its unified diff.
- Buttons: **Beginner** (`b`), **Expert** (`e`), **Regenerate** (`r`), **Close**. An explanation already written for the same change and level is shown again without a new request.
- A turn that only answers a question keeps the last change; the last change is remembered per project across sessions.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `level` | `beginner` \| `expert` | `beginner` | Default explanation level. |
| `model` | string | `sonnet` | Model that writes explanations (`haiku` is cheaper, `opus` deeper). |

## How it works
- `turn.start` begins a record; `tool.call` on Edit, Write and NotebookEdit (subagents' too, during the turn) reads each file before its first edit; `turn.complete` reads them again and diffs them (a built-in line diff, so new and untracked files work and git is not needed).
- `/explain-diff` sends the request, Claude's final message and the diffs (up to about 60,000 characters) to `$.model.complete` and asks for JSON per file; a reply that is not JSON is shown as is.
- Changes made through the shell (`sed`, generators, `git checkout`) are not seen, and files over 512 KB are listed without a diff.
