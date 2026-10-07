# secret-shield
> Blocks edits and writes that would commit API keys, tokens or private keys.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Before Claude edits or writes a file, secret-shield scans the new text for well-known credential formats:
AWS, GitHub, Anthropic, OpenAI, Stripe live, Slack and Google API keys, PEM private-key headers, and
high-entropy values assigned to names like `*_KEY`, `*_SECRET`, `*_TOKEN` or `*_PASSWORD`. A match refuses
the tool call and tells Claude which pattern hit and on which line, with the secret masked.

## Install
```
/plugin install secret-shield --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. When a write is refused, Claude sees a message like:

```
secret-shield: refusing to write /repo/config.ts; it looks like it contains a secret.
  line 2: AWS access key -> export const key = 'AKIA…[20]'
Use an environment variable or a secret manager and reference it by name.
```

Placeholders (`your-key-here`, `changeme`, `replace_me…`, `generate-with-…`, `AKIA…EXAMPLE`) and variable references
(`process.env.X`, `${X}`) are not flagged. In template files (`.env.example`, `*.sample`, `*.template`, `*.dist`)
only the known key formats are checked, not the high-entropy heuristic, since their values are made up.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowlist` | string | empty | Regular expression. A finding is ignored when the matched secret, its line or the file path matches it, e.g. `fixtures/\|EXAMPLE`. An invalid regex is ignored (nothing is allowed). |

## How it works
- A `tool.call` guard on `Edit`, `Write`, `NotebookEdit` (and `MultiEdit` where a build has it) scans only the text being added (`new_string`, `content`, `new_source`).
- It fails closed: if the scan itself throws, the write is denied.
- Limits: pattern-based, so a secret in an unknown format slips through, and it does not look at what is already on disk or at secrets written through `Bash`.
