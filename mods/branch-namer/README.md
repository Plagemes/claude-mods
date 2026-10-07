# branch-namer
> /git-branch creates a well-named git branch from a short task description.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
Type what you are about to do and get a clean branch: the description is slugified into
`<type>/<kebab-slug>`, the type (`fix`, `feat`, `chore`, `docs`, `refactor`, `test`) is inferred from keywords or
from a conventional-commit prefix, and `git switch -c` creates and checks it out. With no description it
names the branch from your last prompt.

**Deviation from the catalog text:** Claude Code already ships a built-in `/branch` (it forks the
*conversation*), and a plugin cannot register a built-in's name. This mod's command is therefore
**`/git-branch`**.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install branch-namer@claude-mods
```

## Usage
```
/git-branch fix the login redirect loop      ->  fix/login-redirect-loop
/git-branch add dark mode toggle to settings ->  feat/dark-mode-toggle-settings
/git-branch add unit tests for the parser    ->  test/unit-tests-parser
/git-branch fix(auth): token refresh race    ->  fix/token-refresh-race
/git-branch                                  ->  named from your last prompt
```
The answer is a one-line result such as `branch-namer: created and switched to fix/login-redirect-loop`; Claude is
told the branch changed. If the branch already exists or you are not in a repository, it says so and changes nothing.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `prefix` | string | empty | Put in front of every branch, e.g. initials: `ab` gives `ab/fix/login-redirect-loop`. |
| `maxSlugLength` | number | `40` | Longest kebab-case part, in characters; whole words only (minimum 8). |

## How it works
- `session.start` registers the command with `$.command.register`; `command.run` answers it itself, running `git switch -c <name>` with an argument vector (no shell, so a description cannot inject commands).
- `prompt.submit` remembers your last typed prompt (not slash commands, not other plugins' prompts); after a hot reload it falls back to the transcript.
- Limits: the type is a keyword heuristic (priority test, docs, fix, refactor, chore, feat; default feat), so unusual wording lands on `feat/`. Rename with `git branch -m` if it guessed wrong.
