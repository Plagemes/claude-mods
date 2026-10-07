# ci-watch
> /ci-watch follows your GitHub Actions run and tells you the moment it passes or fails.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
After a push, type `/ci-watch` and keep working. It follows every workflow run for the commit you pushed, keeps a live line under the prompt (`⏳ CI running on main @ abc1234 · 1/3 done · test`), and the moment the last one finishes it shows a toast, logs the result with a link to the run, and plays a chime (or a low tone on failure). Optionally it asks Claude to read the failed logs and fix the cause.

## Install
```
/plugin install ci-watch --marketplace plagemes/claude-mods
```
Needs the [GitHub CLI](https://cli.github.com) installed and logged in (`gh auth login`).

## Usage
- `/ci-watch` watches the current branch; `/ci-watch <branch>` another one.
- `/ci-watch stop` cancels the watch.
- What you see:
  - status line: `🕒 CI: waiting for a run on main @ abc1234`, then `⏳ CI running on ... · 1/3 done · build`
  - when done: toast `✅ CI passed on main · 3 workflows`, `❌ CI failed on main: test (failure)` or `⛔ CI cancelled on main: deploy`, plus a transcript line with the run's URL
- If the commit's runs already finished, `/ci-watch` simply reports the result.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `pollSec` | number | `30` | Seconds between polls (minimum 10). |
| `autoFix` | boolean | `false` | On failure, submit "CI failed: investigate ..." so Claude reads `gh run view <id> --log-failed` and fixes it. |
| `sound` | boolean | `true` | Play `assets/pass.wav` / `assets/fail.wav` when the run ends. |

## How it works
- `/ci-watch` resolves the branch and the pushed commit (`origin/<branch>`) with git, then polls `gh run list --branch <b> --json ...` with `$.process.run` on a `$.clock.every` timer, grouping all workflow runs of that commit into one verdict.
- Stops by itself when the verdict is in, after 5 minutes with no run for the commit, after 3 hours, or after 3 consecutive `gh` errors (each with a toast saying why).
- Sounds play through `afplay` on macOS; other platforms show the toast silently. The watch lives in this session only and ends with it (or when the mod reloads).
