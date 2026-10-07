# env-guard
> Protects .env files, SSH keys and credential stores from being read or modified.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Keeps secrets out of the conversation. env-guard refuses `Read`, `Edit`, `Write`, `NotebookEdit` and `Grep`
calls on credential files, and `Bash` commands such as `cat`, `grep`, `cp`, `curl -d @file` or a `>` redirect
that would read or change them. `.env.example`, `.env.sample` and `.env.template` stay open, so Claude can
still learn which variables exist.

Protected by default: `.env` and `.env.*`, `~/.ssh/*` (except `*.pub`), `id_rsa*`/`id_ed25519*`, `*.pem`,
`*.key`, `*.p12`, `.aws/credentials`, `.netrc`, kubeconfigs, `.git-credentials`, `.pgpass`, `~/.gnupg`, and
an `.npmrc` that holds an auth token (an `.npmrc` that only references `${NPM_TOKEN}` is fine).

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install env-guard@claude-mods
```

## Usage
Nothing to run. A blocked call returns, for example:

```
env-guard: Read of /repo/.env (an environment file) is blocked. Ask the user for the value you need, or work from .env.example.
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `extraProtected` | string | empty | Comma-separated globs to protect as well, e.g. `secrets/*,*.tfvars`. |
| `allowed` | string | empty | Comma-separated globs that are never blocked, e.g. `.env.test,fixtures/*.pem`. |

## How it works
- Two `tool.call` guards: one for the file tools (it also resolves the real path, so a symlink named `notes.txt` that points at `.env` is caught), one for `Bash` (a small shell lexer finds the file arguments of reader/copy/edit commands and redirections).
- Both fail closed: if the check itself throws, the call is denied.
- Limits: a deny-list, so it is best effort. A script that opens a secret (`python -c "open('.env')"`), a glob that expands to one (`cat .e*`) or a `Grep` with no `path` that happens to walk into one is not seen.
