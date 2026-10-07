# mod-doctor
> /mod-doctor checks your installed mods for outdated versions, conflicts and load errors.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
`/mod-doctor` checks every installed plugin and lists what needs attention, with a fix button where one exists. It finds:
- mods whose hooks module fails to load
- versions behind the claude-mods catalog on GitHub
- two plugins registering the same slash command, or a built-in command name
- mods known to pull against each other
- disabled mods
- a crowded status line, prompt band or system prompt

When the session runs with `--debug`, it also finds hooks this session skipped.

## Install
```
/plugin install mod-doctor --marketplace plagemes/claude-mods
```

## Usage
- `/mod-doctor` opens the **Mod Doctor** pane and runs the check in the background.
  - **Header:** the plugin count, plus errors, warnings and notes.
  - **Catalog line:** where the latest versions came from: GitHub, the cached copy, or your local marketplace copy when offline.
  - **Findings:** one per problem, worst first (`✗` error, `▲` warning, `•` note, `✓` fine), each with its details and fix buttons:
    - **Update to x.y.z** refreshes the marketplace, then runs `claude plugin update`
    - **Disable**, **Enable**
    - **Disable &lt;mod&gt;** for each side of a clash
  - **Toolbar:** **Re-check** (`r`), **Update all** (`u`) and **Close** (`q`).
  - **After a fix:** a notice with **Reload plugins** (`l`), and the check runs again.
- `/mod-doctor report` prints the same findings into the transcript, each fix as the CLI command it would run. Claude can read it too. It is also what you get where no pane can be shown.

Known pairs it reports when both are enabled, among others:
- `concise-mode` + `explain-level`: contradicting answer styles
- `soundpack` + `done-chime`: two sounds for one event
- `test-watch` + `regression-guard`: regression-guard does not see test-watch's own runs
- `output-trimmer` + `redactor`: both rewrite results, which is fine

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `repository` | string | `plagemes/claude-mods` | GitHub owner/repo whose `.claude-plugin/marketplace.json` holds the latest versions. |
| `branch` | string | `main` | Branch the catalog is read from. |
| `readDebugLog` | boolean | `true` | Under `--debug`, report hooks this session skipped and trees it refused, per mod. |
| `checkAtStart` | boolean | `false` | Run a quiet check when a session starts and toast new load errors or command clashes. |

## How it works
- Runs `claude plugin list --json`, then `claude plugin validate --json` on each plugin's folder, four at a time. The validator's report gives the load errors, the commands each mod answers, and whether it writes the status line, draws above the prompt or adds to the system prompt.
- Latest versions:
  - for claude-mods: `marketplace.json` from GitHub through `$.http.fetch`, cached in `$.store` for ten minutes and kept for offline use
  - for every other marketplace: its local copy
- Hints come from `~/.claude/debug/<session>.txt`, which exists only when the session runs with `--debug`. Built-in command names come from `$.command.list()`.
- Fixes run `claude plugin update|enable|disable <id> --scope <scope> --json` through `$.process.run`, one at a time.
- Limits:
  - A load error is what the validator finds. A hook that throws only at run time shows up only through the debug log.
  - Mods installed by your organization (managed scope) get no fix buttons.
  - The pair table covers claude-mods only.
