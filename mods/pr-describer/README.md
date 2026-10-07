# pr-describer
> /pr-desc drafts a pull request title and description from your branch diff.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
`/pr-desc` compares your branch with its base (origin's default branch unless you name one), collects the commits, the diff stat and the diff since the merge base, and asks the model for a title plus **Summary**, **Changes**, **Testing** and **Risks** sections. When the repository has a pull request template, the model fills that in instead, keeping its headings and checklists. The draft opens in a pane, ready to copy into GitHub or hand to Claude to open the PR.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install pr-describer@claude-mods
```

## Usage
- `/pr-desc` uses `origin/HEAD`, else the first of `origin/main`, `origin/master`, `origin/develop`, `main`, `master`, `develop` that exists.
- `/pr-desc release/2.4` compares with that branch (local, or `origin/` of the same name).
- In the **Pull request** pane: **Insert into prompt** (`i`, puts an "open a pull request with this title and description" request in your prompt box to edit and send), **Copy title**, **Copy description** (`d`), **Copy all** (`a`), **Regenerate** (`r`), **Close** (`q`).
- The pane warns when you have uncommitted changes, which are not part of the description.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | `sonnet` | Model that writes the description: an alias (`haiku`, `sonnet`, `opus`) or a full model id. |

## How it works
- `command.run` resolves the base and merge base with `$.process.run(['git', ...])`, reads the template with `$.fs.read`, and calls `$.model.complete`; the draft lives in session state and the pane redraws from it.
- Templates are looked up at `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `docs/` and the repository root.
- Limits: the diff sent to the model is cut at 24,000 characters and the log at 60 commits, so very large branches are described from the stat and commit messages; copying needs a clipboard on the surface you press from.
