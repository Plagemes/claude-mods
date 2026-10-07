# co-author-stamp
> Adds configurable Co-authored-by trailers to commits Claude makes.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
Credit pair-programmers, teammates or a bot on every commit Claude writes. List them once in `coAuthors` and each
`git commit -m …` gets a `Co-authored-by: Name <email>` trailer, so GitHub and GitLab show them as co-authors.
It works at two levels: the commit text Claude is asked to write is extended with your trailers
(`attribution.text`), and any commit command that still lacks one is rewritten with `git commit --trailer`.

## Install
```
/plugin install co-author-stamp --marketplace plagemes/claude-mods
```

## Usage
Set `coAuthors` (via `/config` or settings), then let Claude commit as usual:

```
git commit -m "fix: handle empty input"
  becomes
git commit --trailer 'Co-authored-by: Ada Lovelace <ada@example.com>' -m "fix: handle empty input"
```
Commits that already mention a co-author's email, `git commit --amend --no-edit` and commits with no message
flag are left alone.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `coAuthors` | string | empty | Comma-separated `Name <email>` entries, e.g. `Ada Lovelace <ada@example.com>, Pair Bot <bot@example.com>`. Empty means the mod does nothing. |

## How it works
- `attribution.text` (kind `commit`) appends the missing trailers to the engine's own commit-trailer text, so Claude writes them into the message itself.
- A `tool.call` hook on `Bash` finds each `git commit` that carries a message (`-m`, `-am`, `--message`, `-F`) and inserts `--trailer` flags right after `commit`; git places trailers after the message however many `-m` there are, and the hook quotes names safely.
- The rewrite needs git 2.32 or newer (checked once with `git --version`); on older git it leaves the command alone and only the attribution text applies. It does not touch commits made through other tools or aliases.
