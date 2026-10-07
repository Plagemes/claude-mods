# k8s-dry-run
> Turns kubectl apply into a server-side dry run with a diff you approve first.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
When Claude runs `kubectl apply`, `replace` or `delete`, this mod first runs a server-side dry run (`kubectl diff`, or a dry-run delete) and holds the real command. Claude gets a summary of what would change and asks you. A band above the prompt shows the same summary with **Approve**, **Show diff** and **Reject** buttons. An approval lets that exact command run once.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install k8s-dry-run@claude-mods
```

## Usage
- Claude runs `kubectl apply -f k8s/ -n shop`. The command is held, and this band appears:
  ```
  ⎈ kubectl change held  kubectl apply -f k8s/ -n shop  · staging
    ~ Deployment shop/web          +1 −1
    + Service shop/web-internal    +4 −0
  [ Approve ]  [ Show diff ]  [ Reject ]
  ```
- **Approve** (`a`) records a one-time approval for the exact command on that context (valid for 30 minutes) and tells Claude to run it again. **Reject** (`x`) tells Claude not to run it. **Show diff** (`d`) opens a pane with each object's diff.
- `/k8s-approve` approves from the prompt, and `/k8s-diff` opens the diff pane.
- Outside production, a short reply such as `yes`, `ok` or `go ahead` approves too. On production contexts, only the button or `/k8s-approve` does.
- If the dry run shows no changes, the command runs right away, with a note to Claude.
- Status line while a change is held: `⎈ kubectl apply awaiting approval · PRODUCTION`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `prodPattern` | string | `""` | Regex (case-insensitive) for production context or namespace names. Empty: `prod`, `production`, `prd` or `live` as a word. |
| `timeoutSeconds` | number | `30` | How long the dry run may take. |

## How it works
- A guard on `tool.call` (Bash) finds kubectl `apply` / `replace` / `delete`, also behind `sudo`, `timeout`, `env`, a subshell or `bash -c '…'`. It skips commands that already use `--dry-run`, and reads `--context`, `-n`, `-f`, `-k` and `-R`. A command that makes two kubectl changes is refused, so each gets its own dry run. Without `--context`, it reads the current context (`kubectl config current-context`).
- The dry run:
  - apply and replace: `kubectl diff` with the same sources and connection flags, using `KUBECTL_EXTERNAL_DIFF="diff -u -N"`
  - delete: the same command with `--dry-run=server -o name`
  - manifests from a heredoc, `< file` or `cat file |` are fed to the dry run too
- When no dry run is possible (cluster unreachable, timeout, no kubectl, manifests piped from another command), production contexts fail closed: the command is blocked. Everywhere else it fails open: the command runs, and Claude gets a note that it ran unreviewed. If the guard itself crashes, the same rule applies.
- Limits:
  - Only commands Claude runs through Bash are checked. Commands run inside scripts or Makefiles aren't seen.
  - The diff shows what the API server would change. Admission webhooks that act only on the real write aren't covered.
