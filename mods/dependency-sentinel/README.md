# dependency-sentinel
> Flags typosquatted or brand-new packages before npm, pip or cargo installs them.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Before a Bash install runs, every package it names is checked twice: offline against ~340 popular packages for one- or two-letter typos (`lodahs`, `expresss`, `reqeusts`), and online against its registry for names that do not exist (a hallucinated dependency is an open invitation to squatters), were first published under 30 days ago, or have a single release. A name close to a popular one is not held back when the registry shows it is established in its own right (a year old with five or more releases, like `ms` or `vuex`). A suspicious install is held back with the reasons, and goes through once you reply with **DEPS-OK**.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install dependency-sentinel@claude-mods
```

## Usage
Nothing to run. A held-back install shows as the tool's error and a toast:

```
dependency-sentinel: held back `npm install lodahs`:
  - lodahs looks like a typo of "lodash" (1 edit away)
  - lodahs does not exist on npm: a mistyped or hallucinated name, or a squat waiting to happen
Check the names. If they are intended, ask the user to reply with DEPS-OK, then run the install again.
```

Put `DEPS-OK` anywhere in your next prompt to allow the installs of that turn; packages installed that way are remembered and not flagged again.

Covered (leading options like `pnpm --filter web add` and `yarn workspace web add` included): `npm install|i|add`, `npm exec`, `npx`, `pnpm add|install|dlx`, `yarn add|global add|dlx`, `bun add|install`, `bunx`, `pip install`, `python -m pip install`, `pipx install`, `uv add`, `uv pip install`, `poetry add`, `cargo add|install`, `go get|install`. Paths, URLs, git sources, `-r requirements.txt` and tarballs are skipped.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `minAgeDays` | number | `30` | Hold back packages first published fewer than this many days ago. |
| `minVersions` | number | `2` | Hold back packages with fewer releases than this. |
| `timeoutMs` | number | `4000` | How long to wait for a registry before letting the install through with a notice. |
| `checkRegistry` | boolean | `true` | Ask npm, PyPI, crates.io and the Go proxy. Off: only the offline typosquat check runs. |

## How it works
- A `tool.call` hook on Bash parses the command line with the shared claude-mods shell reader (wrappers such as `sudo`, `env` and `timeout` peeled; `bash -c`, `eval`, `$(…)` and heredocs fed to a shell read; comments and heredoc notes ignored); `prompt.submit` watches your prompts for `DEPS-OK`.
- With [mods-hub](../mods-hub) installed, every hold is also published as `risk.blocked` (rule `suspicious-package`, the reasons, severity `medium`, the command with secrets masked), the "Held back … Reply DEPS-OK" note goes through the hub as a `warning` question (it reaches your phone when the hub's Interaction mode allows), and the "could not check" note as `info`. Without the hub they are toasts as before.
- Registry answers are fetched with `$.http.fetch` (popular packages are never looked up) and cached in the plugin store for a day; approved packages are kept there too.
- Fails open by design: a registry timeout, a network error or a failed check lets the install through and says so in a toast. Packages pulled in by a lockfile, `requirements.txt` or a transitive dependency are not checked.
