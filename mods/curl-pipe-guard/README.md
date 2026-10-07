# curl-pipe-guard
> Blocks piping downloaded scripts straight into a shell.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Stops `Bash` commands that run a download before anyone has read it: `curl … | sh`, `wget -qO- … | sudo bash`,
`… | python3 -` or `| node -`, `bash <(curl …)`, `sh -c "$(curl …)"`, `eval "$(curl …)"`,
`source <(wget …)`, and PowerShell's `iwr … | iex`. Claude is told to download the script, read it, then run it.
Pipes that only parse the download (`curl … | jq .`, `| python3 -m json.tool`, `| node -e '…'`) and downloads
saved to a file pass untouched.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install curl-pipe-guard@claude-mods
```

## Usage
Nothing to run. A blocked command returns:

```
curl-pipe-guard: a download is being run as code by sh before anyone has read it. Instead:
curl -fsSLo script.sh https://example.com/install.sh, inspect it (less script.sh), then run it with bash script.sh.
```

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowedHosts` | string | empty | Comma-separated hostnames whose scripts may be piped into a shell, e.g. `sh.rustup.rs,get.docker.com`. |

## How it works
- A `tool.call` guard on `Bash`. A small shell lexer splits the line into pipelines, so it can tell a pipe into a shell that reads its program from stdin (`sh`, `bash -s`, `python -`) from one that only reads data (`python parse.py`, `bash -c '…'`).
- It fails closed: if the check itself throws, the command is denied.
- Limits: it reads command text only. A download written to disk by one command and run by another (`curl -o x … && bash x`) is allowed on purpose, that is the recommended flow, and tools it does not know as downloaders are not seen.
