# force-push-guard
> Forbids force-pushing to protected branches and suggests --force-with-lease.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Inspects every `git push` Claude runs through `Bash`. A forced push (`-f`, `--force`, `--force-with-lease`,
`--force-if-includes` or a `+refspec`) to `main`, `master`, `develop` or `release/*` is refused. On any other
branch a bare `--force` / `-f` / `+refspec` is quietly rewritten to `--force-with-lease`, which refuses to
overwrite commits you have not seen, and a toast tells you it did.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install force-push-guard@claude-mods
```

## Usage
Nothing to run. Examples:

| Claude runs | What happens |
| --- | --- |
| `git push --force origin main` | denied, with the protected list in the message |
| `git push -f` while on `main` | denied (the current branch is looked up with `git symbolic-ref`) |
| `git push -f origin feat/x` | runs as `git push --force-with-lease origin feat/x` |
| `git push --force --all` | denied: it would rewrite every branch |
| `git push origin main` | untouched |

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `protectedBranches` | string | `main,master,develop,release/*` | Comma-separated branch names or `*` globs that may never be force-pushed. |

## How it works
- A `tool.call` guard on `Bash`: the shared claude-mods shell reader finds each `git push` (also behind `&&`, `;`, pipes, wrappers, `git -C dir`, `bash -c '…'`, `eval`, `su -c`, `$(…)`, a heredoc fed to a shell, `docker exec … sh -c '…'`) and works out which branches it updates; `HEAD` or no refspec means the current branch. A `cat <<EOF` note is only text.
- It fails closed: if the check itself throws, or the target branch cannot be determined for a forced push, the command is denied.
- With [mods-hub](../mods-hub) installed: every deny is also published as `risk.blocked` (rule `protected-branch`, `force-all` or `unknown-target`, severity `high`, the command with secrets masked); every push that went through is published to all sessions as `git.push` (remote, `origin` when none is named; branch; whether it was forced), which ci-watch follows; and the rewrite note goes through the hub's notifications (`info`) instead of a toast. Without the hub it behaves as before and runs no extra git command.
- Limits: a push inside `bash -c '…'` (or any nested script) is checked but never rewritten; shell aliases (`git pf`), scripts that push and `git config` aliases are not seen, and `push.default` rules beyond "the current branch" are not modelled.
