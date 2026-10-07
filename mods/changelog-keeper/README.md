# changelog-keeper
> Keeps CHANGELOG.md's Unreleased section up to date as you commit.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
Each time Claude makes a git commit, the commit subject is read as a Conventional Commit and filed under `## [Unreleased]` in the right [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) subsection: `feat` → Added, `fix` → Fixed, `perf`/`refactor` → Changed, `deprecate`, `remove` and `security` to theirs. Scopes become a bold prefix, `!` or `BREAKING CHANGE:` adds **Breaking:**, and the file (with its Unreleased heading and subsections) is created in canonical order when missing. Claude is told what was added, so it never works from a stale copy.

## Install
```
/plugin install changelog-keeper --marketplace plagemes/claude-mods
```

## Usage
- Commit as usual through Claude (`git commit -m "feat(api): add pagination"`); a toast shows the entry, e.g. `Added · **api:** Add pagination`.
- `/changelog` opens the **Unreleased** pane with **Copy** (`c`), **Reload** (`r`) and **Close**.
- The edit to `CHANGELOG.md` stays uncommitted, so it rides along with your next commit (or amend it in).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | string | `CHANGELOG.md` | Changelog path, relative to the repository root. |
| `createIfMissing` | boolean | `true` | Start a Keep a Changelog file on the first entry. |
| `untyped` | `changed` \| `skip` | `changed` | What a subject that is not a Conventional Commit becomes. |
| `includeChores` | boolean | `false` | Also log `docs`, `test`, `chore`, `ci`, `build` and `style` commits (under Changed). |
| `includeHash` | boolean | `false` | Append the short hash, e.g. `(a1b2c3d)`. |

## How it works
- `tool.call` on `Bash` watches commands that run `git commit`; after a successful run it reads the commit with `git log -1` (the engine's git record names the commit, or HEAD is used when it was made during the call) and edits the file with `$.fs`. Amends, merges, `fixup!`/`squash!` and identical entries are skipped.
- The entry is reported back to Claude as tool-result context; `/changelog` reads the section on demand.
- Only commits made through Claude's Bash tool are seen, not ones you make in another terminal.
