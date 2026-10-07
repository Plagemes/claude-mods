# guardian
> One security policy for every guard mod — permissive, standard or strict — plus a project safety score.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Picks one security level for the project and translates it into the real settings of 31 guard mods (secret-shield, rm-rf-guard, force-push-guard, env-guard, curl-pipe-guard, prod-guard, redactor, path-jail, dependency-sentinel, sql-safety, …): stricter branch protection, `block` instead of `warn`, older-package thresholds and so on. It shows you the exact diff for your `settings.json` and writes it only when you confirm, after a backup. At **strict** it also runs a small fallback guard of its own for the most critical cases of every guard you have not installed. A **safety score** (0–100) tells you how protected the project is and the three changes that would raise it most, each one click away.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install guardian@claude-mods
```

## Usage
- `/guardian` opens the **Guardian** tab (in the Claude Mods panel with mods-hub, its own pane without) and prints the score:
  - **Level** chips `permissive` `standard` `strict` `custom` (hotkeys `p` `s` `t` `c`);
  - **Safety** gauge, what it is made of, and **Top fixes** with Install / Review buttons;
  - **Apply N changes** (`a`) shows the diff first; **Confirm** writes it, **Reload plugins** (`r`) activates it;
  - the **guard matrix**: ✓ installed, ◐ covered by the fallback, ✗ missing, its status (configured / changes pending) and its last block; **Install** installs a missing guard with `claude plugin install`;
  - **Recent blocks** from every guard over the last 7 days.
- `/guardian level strict` sets the level for this project; `/guardian apply` prints the diff and `/guardian apply --yes` writes it; `/guardian install <guard>`; `/guardian score`.
- A fallback block reads `guardian: rm -r / deletes far more than a project file (strict-level fallback for rm-rf-guard, which is not installed). Ask the user, or install rm-rf-guard for the full guard.`

Levels: **permissive** recommends 4 guards and loosens them (git reset allowed, test fixtures exempt from secret scans, a few trusted install scripts); **standard** recommends 16 at their own defaults; **strict** recommends 24 with the tightest values and turns the fallback on; **custom** starts from a base level and keeps your edits in `.claude/guardian.json`. Guards that do not fit the project (sql-safety without a database folder, venv-guard without Python) are left out of recommendations and the score.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `level` | string | `standard` | The level for projects with no `.claude/guardian.json`: `permissive`, `standard`, `strict` or `custom`. |
| `fallback` | boolean | `true` | At strict, block the critical cases of guards that are not installed. |
| `marketplace` | string | `claude-mods` | Where guard mods are installed from (pluginConfigs keys, install command). |

## How it works
- **Policy files.** The chosen level and every guard's mapped options are written to `.claude/guardian.json` (per project; commit it to share it, edit it for `custom`) and to `~/.claude/claude-mods/guardian/policy.json` (the last chosen policy, for other mods). Guards cannot import each other, so guardian applies the options for you in your user `settings.json` under `pluginConfigs["<guard>@claude-mods"].options`, only for installed guards, only the keys that differ, after a backup (`settings.json.guardian-<time>.bak`); nothing else in the file changes. Plugin options are user-wide in Claude Code (project settings are not read), so the applied values follow the project you last applied from.
- **Fallback (strict only)** hooks `tool.call` and uses the shared shell lexer and secret patterns: `rm -r` of `/`, `~`, `.` or system folders; force pushes or deletes of main/master/production (or a force push with no branch named); `curl | sh` and `bash <(curl …)`; secrets written into source files; reading `.env` files; `terraform destroy`, `kubectl delete` / `helm uninstall` on production. Each case is skipped when its guard is installed. Every block publishes `risk.blocked`.
- **Score:** guards installed (55, the fallback counts half), guards configured (15), secrets that got through (15), critical commands that ran unguarded (10) and blocked attempts in the last 7 days (5). Blocks come from mods-hub's `risk.blocked` events, from guardian's own fallback and from guard denies it sees; secrets from `secret.detected` (warned) and its own check of edits. With mods-hub it registers the Guardian tab, publishes `risk.blocked`, shares the fact `guardian.policy` and reads the hub's list of installed plugins; without it, it runs `claude plugin list` and keeps its own pane. Limits: options reach running guards after `/reload-plugins`; the installed list is refreshed every 10 minutes.
