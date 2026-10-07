# workflow-studio
> Build, save and share reusable workflows — release, dependency update, security audit — and run them with one command.

**Category:** Agents & Orchestration · **Version:** 1.0.0

## What it does
Keeps a library of **recipes**: multi-step jobs with params, prompt templates per step (with a tier hint and parallel groups), success checks and a run mode (inline, parallel subagents, or a workflow). Recipes are YAML or JSON files in `.claude/recipes/` (the project's, shared through git) and `~/.claude/claude-mods/recipes/` (yours); six ship built in. `/recipe` lists, searches, edits and runs them; a run sends Claude one precise prompt, then runs the recipe's checks itself and files the outcome in the history.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install workflow-studio@claude-mods
```

## Usage
- **`/recipe`** opens the **Workflows** tab of the Claude Mods panel (its own pane without mods-hub):
  - **List** with a search field; ⚠ marks a file that does not load. **New recipe** (`n`), **History** (`h`).
  - **Detail:** steps (parallel groups shown together), checks, a field per param, **Run** (`r`; **Run as workflow** for a workflow recipe), **Edit** (`e`), **Copy to project** (`c`) / **Copy to personal**, **Back** (`b`).
  - **Editor** (a simple field editor): name, title, description, params (`version, channel=stable`), mode, each step's title, group, prompt and tier, the checks; **Save** (`s`) validates and writes YAML, showing every schema error instead of writing a bad file.
  - **History:** each run with its outcome (`✓ passed`, `✗ failed`, `✓ done`, `■ cancelled`), params, duration, checks and (with the hub) how many subagents finished; **re-check** and **again**.
- **`/recipe run <name> [param=value …]`**, or just **`/recipe <name> param=value`**. Quotes work: `notes="first stable"`.
- `/recipe list` · `show <name>` · `new <name> [--personal]` · `edit <name>` · `copy <name> [--personal]` · `validate [name]` · `history`.
- **`/recipe save [name] [--from autopilot|route] [--personal]`** turns the last successful **autopilot** run (its goal, steps and checks) or the last **`/route`** plan of smart-router (subtasks, tiers, stages as parallel groups, its mode) into a recipe; without `--from`, the newer of the two.
- Built in: **release** (inline: version bump, changelog, verify, tag), **dependency-update** (parallel), **security-audit** (workflow: four reviewers in parallel, then a ranked report), **flaky-test-hunt** (parallel), **onboarding-docs** (parallel), **perf-pass** (parallel). `/recipe copy <name>` makes one yours.

A recipe:
```yaml
name: release
description: Ship {{version}} with a changelog and a tag.
mode: parallel            # inline | parallel | workflow
params:
  - name: version
    required: true
steps:
  - title: Changelog
    tier: standard        # light | standard | deep
    group: prep           # neighbours with the same group run in parallel
    prompt: |
      Write the {{version}} changelog from the commits since the last tag.
  - title: Bump
    tier: light
    group: prep
    prompt: Set the version to {{version}} everywhere it is declared.
  - Tag v{{version}} and tell me the push command.
checks:
  - name: Tests
    command: npm test
```
`{{project}}`, `{{date}}` and `{{branch}}` are always there. Errors read like `steps[2].prompt: {{versoin}} is not a param (params: version)` or `stpes: unknown field — did you mean "steps"?`.

## Configuration
No configuration needed.

## How it works
- **Running:** the prompt goes out with `$.prompt.submit({ asUser: true })` once the command has answered, or, when a turn is running, right after it ends (published as `task.queued`). It says exactly how to work for the mode: inline steps in order; parallel stages with each agent's model by tier (all Agent calls of a stage in ONE message, a shared opening for the prompt cache); for a **workflow** recipe it states your explicit opt-in to the Workflow tool, because you pressed Run on a workflow recipe. The prompt ends with a tag (`[workflow-studio run <id>]`) so `turn.start`/`turn.complete` find its turn.
- **Outcome:** when that turn ends, each check runs as `sh -c "<command>"` in the project root (5 min timeout); all exit 0 → passed. A run without checks is done when Claude answers, cancelled when you interrupt it. The history (last 30) is kept per project in the plugin's store.
- **With mods-hub:** the **Workflows** tab (order 50); `task.queued`/`task.started`/`task.finished` and `x.workflow-studio.finished`; `notify` success or error at the end; tier models from smart-router's `smart-router.policy` fact when it shares one (haiku / sonnet / opus otherwise); finished subagents counted from `agent.finished`. Without the hub: toasts, its own pane, default models.
- **Files:** YAML is read by a small built-in reader (block style: mappings, lists, quoted and `|`/`>` text, `[a, b]` lists, comments); anchors, tags and multi-line plain text are refused with their line. The editor writes YAML back in a fixed field order (comments in a file you edit are not kept). Files are never deleted by the studio: remove one by hand.
- **Limits:** a workflow that keeps running in the background after Claude's turn ends is judged at that turn's end (use **re-check** later); `/recipe save --from route` needs the `/route` plan of this session (smart-router keeps it per session); the checks need a POSIX `sh`.
