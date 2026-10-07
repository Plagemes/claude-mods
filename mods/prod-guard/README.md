# prod-guard
> Stops production-affecting commands (terraform apply, kubectl on prod, DROP TABLE) unless explicitly allowed.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Blocks `Bash` commands that can change a production system until you say so: `terraform`/`tofu`/`terragrunt`
`apply` and `destroy`, `pulumi up` and `destroy`, `kubectl` and `helm` writes aimed at a production context or
namespace (or at the current context when it is production), `DROP`/`TRUNCATE` and `DELETE FROM` without
`WHERE` in `psql`/`mysql`/`mariadb`/`sqlite3`, and `aws ... delete-*` / `terminate-*`. Read-only commands
(`terraform plan`, `kubectl get`, `kubectl rollout status`, `--dry-run`) always pass.

## Install
```
/plugin install prod-guard --marketplace plagemes/claude-mods
```

## Usage
When a command is blocked, Claude is told to ask you. Include the word **PROD-OK** in your next message and
the guarded commands run for that turn:

```
you:    roll out the new chart to prod. PROD-OK
claude: helm upgrade api ./chart --kube-context prod-eu   <- runs
you:    thanks, now fix the README                       <- the gate closes again
```

Only the latest message that you typed counts. A background-task notification, another session or another
plugin that happens to contain "PROD-OK" does not approve anything.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `prodPattern` | string | `prod`, `production`, `prd`, `live` as whole words | Case-insensitive regex tested against kubectl/helm contexts, namespaces, release names and values files. |

## How it works
- `prompt.submit` remembers your latest message (only when it came from you); a `tool.call` guard on `Bash` checks each command against the rules and the approval word.
- When `kubectl`/`helm` names no `--context`, it asks `kubectl config current-context` (3 s timeout) to see where the command would land.
- It fails closed: if the check itself throws, the command is denied, and a failing prompt hook revokes the approval.
- Limits: it reads command text. Scripts (`./deploy.sh`), `make` targets, CI triggers and tools it does not know are not seen, and "production" is whatever your pattern says it is.
