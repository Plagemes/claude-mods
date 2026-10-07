# onboarding-tour
> /tour walks a newcomer through the repository step by step.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
`/tour` reads the repository the way a new teammate would (the README, the manifests and their scripts, CLAUDE.md, the folder layout) and plans a guided tour of 4–8 steps: what the project is, how to run it, the entry points, the main modules, how data flows, how the tests work, and a good first place to make a change. You walk it in a pane, one step at a time, and can drop any file it points at into your prompt as an `@mention` to ask Claude about it. Your place is saved, so `/tour` picks up where you stopped.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install onboarding-tour@claude-mods
```

## Usage
- `/tour` starts a tour, or resumes the saved one: `Resuming the tour at step 3 of 7: Entry points.`
- `/tour restart` plans a fresh tour (after big changes to the repository).
- The **Tour** pane: `Step 3 of 7 ● ● ◉ ○ ○ ○ ○`, the step's title and explanation, its files as `@path` buttons (each adds `@path` to your prompt), and **◀ Back** (`b`), **Next ▶** / **Finish** (`n`), **Ask about this** (`a`, starts a question about the step in your prompt), **Close**. After the last step: **Start over** (`s`).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `sonnet` | Model that plans the tour. |

## How it works
- A codebase scan with `$.fs`: the top-level tree (ignoring `node_modules`, `dist`, `.git` and the like), the first level of the usual source folders, and the start of the README, `package.json` (name, scripts, dependencies), `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, CLAUDE.md and others, about 40,000 characters in all.
- One `$.model.complete` call plans the steps as JSON; file references that do not exist (or point outside the repository) are dropped, so every button leads somewhere real.
- The tour and your step are kept per project in `$.store`. It works in a fresh session, with no conversation needed; it only knows what that sketch shows, so ask Claude to dig deeper from any step.
