# deploy-checklist
> Shows a pre-deploy checklist (tests, branch, changelog) and asks you to confirm before deploying.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
When Claude runs a deploy command (`vercel --prod`, `netlify deploy --prod`, `fly deploy`, `firebase deploy`,
`gcloud app deploy`, `kubectl rollout restart|undo|…`, `cap production deploy`, `npm publish`), the command is held
and a **Deploy checklist** pane opens: release branch, uncommitted changes, the last test run of the session and
whether the changelog was updated. Nothing ships until you press **Deploy** (or **Deploy anyway** when something is
red); the approval covers that exact command, once.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install deploy-checklist@claude-mods
```

## Usage
```
✗ Not ready to deploy
Claude wants to run a vercel --prod. It runs only once you approve.
  vercel --prod
✓ Branch        main (2 commits not pushed)
✗ Working tree  2 uncommitted changes: src/app.ts, notes.md
! Tests         no test run seen in this session
✓ Changelog     CHANGELOG.md updated since v1.2.0
[ Deploy anyway ]  [ Cancel ]  Re-check
```
- **Deploy / Deploy anyway** (`d`): approves the command once and tells Claude to run it again.
- **Cancel** (`c`): drops it; Claude is told not to retry. **Re-check** (`r`) refreshes the list after you fix things.
- `/deploy-checklist` reopens the pane while a deploy waits (useful on a narrow terminal where the pane cannot open
  by itself), or prints the checklist right now when nothing waits, as a readiness check.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `branches` | string | `main,master` | Comma-separated branches deploys may go out from. |
| `extraPattern` | string | *(empty)* | Regex for more deploy commands to gate, e.g. `git push heroku\|./scripts/release.sh`. |
| `confirmWhenPassing` | boolean | `true` | Ask before every deploy. Off: an all-green checklist lets the deploy run at once. |

## How it works
- A `tool.call` guard on `Bash` spots deploy commands, gathers the checklist with `git` (branch, `status --porcelain`,
  upstream sync, changelog diff since the last tag or upstream) and denies the call with the checklist, so Claude
  knows why it waits. It fails closed: if the checklist cannot be built, the deploy is blocked.
- A second `tool.call` hook remembers the last test command of the session (`npm test`, `vitest`, `pytest`,
  `go test`, …) and whether it passed; `npm test && vercel --prod` counts as tested. Changelog edits made by Claude count too.
- Approvals expire after 15 minutes. Limits: it reads command text, so a deploy hidden in a script or `make` target
  is only caught through `extraPattern`, and tests run outside this session are not seen.
