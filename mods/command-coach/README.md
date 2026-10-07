# command-coach
> Suggests Claude Code commands and mods that fit the way you work.

**Category:** Learning & Onboarding · **Version:** 1.0.0

## What it does
command-coach watches how you use a session and, when a pattern shows up, tells you about the command or mod that would help: very long command outputs (output-trimmer), repeated commits (`/commit`), repeated "run the tests" prompts (quick-commands' `/t`), a filling context window (`/compact`), a session that has gone on for hours (`/clear` and resume-brief), many approval dialogs (`/permissions`), many changed files (`/diff`) and a pile of failures (error-feed). It speaks at most once every two hours, never repeats a tip within two weeks, and never advertises a mod you already have.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install command-coach@claude-mods
```

## Usage
A tip arrives as a toast after a turn, for example:

```
💡 3 commands printed very long output and all of it went into the context. The output-trimmer mod keeps the head, tail and error lines. Install it: /plugin install output-trimmer@claude-mods
```

```
/coach          everything worth trying right now, plus what the coach has seen this session
/coach reset    forget the tips shown so far and this session's counts
```

| Rule | Fires when |
| --- | --- |
| `/compact` | the context window is 70% full |
| output-trimmer | 3 commands printed 6,000+ characters or 120+ lines |
| `/commit` (commit-composer) | Claude ran 3 successful `git commit` commands |
| `/t` `/l` `/b` (quick-commands) | you asked 3 times to run the tests, linter or build |
| `/clear` + resume-brief | the session has run for 2 hours |
| `/permissions` | 6 permission dialogs |
| `/diff` | 10 different files changed |
| error-feed | 5 failed tool calls |

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `cooldownMinutes` | number | `120` | At most one tip in this many minutes, counted across sessions. |
| `showToasts` | boolean | `true` | Turn off to get suggestions only when you run `/coach`. |

## How it works
- The rule table is a pure module (`hooks/rules.ts`) of thresholds, priorities and wording, with its own tests. When several rules are due the first in the table speaks.
- Hooks count what the session shows: `tool.call` results (long Bash output, `git commit`, failures, changed files), `prompt.submit` from a person, `classic.PermissionRequest` dialogs. The context fill comes from `$.session.usage()`.
- After a main-loop `turn.complete` it checks the cooldown and the tips already shown (both kept in `$.store`), and asks `claude plugin list --json` plus the session's command list which mods you have. If the CLI cannot be run it assumes nothing is installed and still tips.
- Limits: the counts live in memory, so a mod reload or a new session starts them at zero; only commits Claude made through the Bash tool are counted, not ones you typed with `!`.
- Shell commands are read with the shared shell reader as well as the pattern, so `git --no-pager commit` and `sudo git -c user.name=x commit` count as commits too. With [mods-hub](../mods-hub) installed: tips go out as info notices through the hub (a toast, held while you are Silent); a tip that recommends a mod is also published as `mod.recommended` (for mod-advisor); the list of installed plugins is the hub's cached `claude plugin list`, not a second CLI run; and a command the hub saw fail three times in a row (`error.repeated`) makes the error-feed tip due at once. `session.idle` is not used: a tip is only ever shown right after a turn, when you are there. Without the hub nothing changes.
