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
- A `tool.call` guard on `Bash`: a small shell lexer finds each `git push` (also behind `&&`, `;`, pipes, `git -C dir`) and works out which branches it updates; `HEAD` or no refspec means the current branch.
- It fails closed: if the check itself throws, or the target branch cannot be determined for a forced push, the command is denied.
- Limits: shell aliases (`git pf`), scripts that push and `git config` aliases are not seen, and `push.default` rules beyond "the current branch" are not modelled.
