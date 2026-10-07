# mod-advisor
> Recommends the right mods for your project and for what you're asking, with the commands to type, and installs them in one click.

**Category:** Core · **Version:** 1.0.0

## What it does
An **Advisor** side pane that keeps up with you. At session start it reads the catalog and your project (files and dependencies from `package.json`, `pyproject.toml`, `requirements*.txt`, `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`) and lists the mods that fit: "Next.js · uses next", "Docker · Dockerfile". As the session goes on it watches what changes (a Dockerfile written, `npm install prisma`, a `git checkout`) and what you ask about, and puts the mods that start to fit under **New for you** with the reason ("you added Dockerfile", "prisma was installed", "you're asking about "deploy""). For mods you already have it tells you what to type, and Install puts any mod in place in one click. Nothing is hard-coded: a mod added to the catalog tomorrow is recommended the same way.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install mod-advisor@claude-mods
```

## Usage
The pane opens by itself at session start where the screen docks panes beside the conversation (a wide fullscreen terminal, the desktop app). Elsewhere a one-line band above the prompt says what fits, with **Show**, **Install all recommended** and **Not now** (quiet for 7 days in this project).

With [mods-hub](../mods-hub) installed, the Advisor is the first tab (**Advisor**, hotkey `1`) of the shared Claude Mods panel instead of a pane of its own: it opens there at session start and on `/mods-advisor`, with the same sections and buttons.

| Command | What it does |
| --- | --- |
| `/mods-advisor` | Open the Advisor pane (`/advisor` is a built-in Claude Code command, hence the name). |
| `/mods-advisor <words>` | Open it with a search: "deploy checks", "quanto sto spendendo". |
| `/mods-advisor why <mod>` | Explain a mod's score: the files, dependencies and prompt words that matched. |
| `/mods-advisor refresh` | Read the catalog, the installed mods and the project again now. |
| `/mods-advisor quiet [on\|off]` | Mute (or unmute) tips, toasts and the band. |
| `/mods-advisor reset` | Bring back the mods you dismissed in this project and lift the snooze. |

The pane's sections:

- **New for you**: what started to fit during this session, marked `●` for 15 minutes, with **Install all**.
- **For this project**: the best fits for the stack found, then **Show N more** and **Install all**.
- **For what you're doing now**: the mods that fit your last few prompts (older prompts count less).
- **Installed — how to use**: each installed mod of the collection with its commands, or "works on its own".

Every mod has **Install**, **How to use** (its commands, the README's Usage section and a link) and **Dismiss** (never offered again in this project); installed ones have **Uninstall**. After a change, **Reload plugins** (`l`) activates it. Notifications stay gentle: at most one toast per 15 minutes for new recommendations, one tip per 10 minutes for a mod you have ("Tip: /commit writes a Conventional Commit message…"), never the same tip twice in a session.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `repository` | `plagemes/claude-mods` | GitHub `owner/repo` whose `catalog.json` lists the mods. |
| `branch` | `main` | Branch the catalog and READMEs are read from. |
| `autoOpen` | `true` | Open the Advisor pane at session start. |
| `tellClaude` | `true` | Add a short note to a prompt naming the installed mods that fit it and their commands, so Claude can suggest them (once per mod per conversation). |
| `useModel` | `false` | Re-rank each prompt's best matches with a haiku-class model, in the background (a few tokens per prompt). |

## How it works
- **Catalog:** `catalog.json` fetched raw from GitHub with `$.http.fetch` (10 s timeout), cached in `$.store` and refreshed at most every 12 hours; offline it uses the cache, then the marketplace copy already on disk (`claude plugin marketplace list --json`), and otherwise stays silent. Installed mods come from `claude plugin list --json`, their live commands from `$.command.list()`; installs and uninstalls run `claude plugin install|uninstall <mod>@claude-mods`, adding the marketplace first when it is missing. Changes need `/reload-plugins`.
- **Scoring** (`hooks/score.ts`, pure and unit-tested): a mod's catalog `signals` (`files` globs, `deps`, `intents`, `always`) decide when present. Without them it reads the mod's name and description against the technologies found in the project (Next.js, Prisma, Django, Go, Terraform, Docker and some 30 more), and prompts against every mod's words, weighted by how rare they are, with Italian and common shorthand understood. Hooks: `session.start` (scan, pane), `tool.call` (Write/Edit/NotebookEdit and Bash installs, file creation, checkouts and scaffolders, rescanned 5 s after the last change; a full rescan at most every 10 minutes), `prompt.submit` (your own prompts only, never slash commands; the scoring runs after the prompt is sent, so it never waits), `turn.complete`, `ui.render` (pane and band).
- **With mods-hub:** the Advisor registers its tab and draws it by hooking the hub's `claude-mods` pane; every new recommendation is published as `mod.recommended`, and the stack found as the fact `mod-advisor.stack`; after each turn it reads the bus (`$.mods.recent`) for `mod.installed` (refresh what is installed), failing `test.result` (suggests test-watch, flaky-detector, regression-guard) and failing `ci.result` (issue-drafter, ci-watch), with the event as the reason ("2 tests failed", "CI failed on main"); its toasts go through the hub's notifications, terminal only, so Silent holds them. Without the hub it keeps its own pane and toasts.
- **Limits:** recommendations from words alone are a heuristic, so a request can surface a mod that only shares its words; Dismiss, `quiet` and `useModel` are there for that, and catalog `signals` make it precise. The scan looks four folders deep and skips `node_modules`, build output and the like; changes made outside Claude show up within about 10 minutes.
