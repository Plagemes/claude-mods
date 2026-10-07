# commit-composer
> /commit writes a Conventional Commit message from your staged diff and commits it.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
`/commit` reads your staged diff, the files it touches and the last commit subjects, and asks a small fast model for a Conventional Commits message: `type(scope): subject` within 72 characters, then a few bullet points on what changed and why. The draft opens in a pane where you commit it, regenerate it, edit the subject or ask for changes in plain words. If the repository has a commitlint config, its types, scopes and header length are followed and checked.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install commit-composer@claude-mods
```

## Usage
- `/commit` drafts a message for what is staged. With nothing staged it tells you how many files changed.
- `/commit all` stages everything (`git add -A`) first.
- In the **Commit** pane: **Commit** (`c`), **Regenerate** (`r`), **Edit** (`e`: rewrite the subject, or type an instruction such as "use the auth scope" to regenerate with it), **Cancel** (`q`). Anything commitlint would likely reject is listed under the draft as a warning; it never blocks you.
- If another command already owns `/commit` in your setup, the mod registers `/compose-commit` instead.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `haiku` | Model that writes the message: an alias (`haiku`, `sonnet`, `opus`) or a full model id. |

## How it works
- Registers the command at `session.start`; `command.run` checks the repository with `$.process.run(['git', ...])`, opens the pane and calls `$.model.complete` with the diff (cut at 16,000 characters) and the rules.
- Commitlint rules are read from `.commitlintrc*`, `commitlint.config.*` or `package.json`; `type-enum`, `scope-enum` and `header-max-length` are enforced locally, and the whole config text is given to the model. JavaScript configs are read as text, never run.
- Commits with `git commit -m <message>`. Git runs with repository hooks off under Claude Code, so husky / commitlint `commit-msg` hooks do not run for this commit; signing and other git config still apply.
