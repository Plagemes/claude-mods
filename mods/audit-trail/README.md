# audit-trail
> Writes every action Claude takes to an append-only JSONL audit log.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
Every tool call, prompt and finished turn becomes one JSON line in a file per day, `.claude/audit/YYYY-MM-DD.jsonl`. Each line says when it happened, in which session, what was run (a command, a path, a URL; cut to 200 characters), and whether it went `ok`, `error` or was `denied`. Credentials are masked before anything is written, and prompts are logged as a SHA-256 hash unless you ask for the text.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install audit-trail@claude-mods
```

## Usage
Nothing to run; the log fills as you work. `/audit` shows today's totals and the file path:

```
12 entries logged today (2026-10-07): 9 tool calls (1 denied, 1 failed) · 2 prompts · 1 turns
/repo/.claude/audit/2026-10-07.jsonl
```

A line looks like this:

```json
{"ts":"2026-10-07T12:00:00.000Z","session":"4f1c…","kind":"tool","tool":"Bash","summary":"npm test","outcome":"ok"}
{"ts":"2026-10-07T12:00:09.000Z","session":"4f1c…","kind":"prompt","origin":"composer","outcome":"ok","chars":17,"sha256":"9b2e…"}
{"ts":"2026-10-07T12:00:41.000Z","session":"4f1c…","kind":"turn","outcome":"ok","durationMs":32000,"inputTokens":18200,"outputTokens":640}
```

Add `.claude/audit/` to your `.gitignore` unless you want the log in the repository.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directory` | string | `.claude/audit` | Where the daily files go. Relative paths start at the project root; a leading `~/` is your home folder. |
| `prompts` | string | `hash` | `hash` logs a SHA-256 of each prompt, `text` logs the prompt itself (redacted, cut at 2,000 characters), `none` logs only its length. |

## How it works
- Hooks `tool.call`, `prompt.submit` and `turn.complete`, and records the outcome after the rest of the chain has answered, so a call another mod or a permission rule refused, or that you rejected at the prompt, shows as `denied`. It never changes or delays anything: lines are queued and written from a timer, and `session.end` writes what is still waiting.
- Claude Code has no append call for files, so each write reads the day's file and writes it back with the new lines; a session's writes are serialized, and a day's file moves on to `YYYY-MM-DD.2.jsonl` once it passes about 1 MB. Two sessions writing the same project's log at the same instant can still lose a batch of lines, since nothing locks the file between sessions.
- Limits: the log is append-only by convention, not enforced, so anyone with write access to the folder can edit it. Redaction is pattern-based (keys, tokens, URL passwords, `password=…` assignments, `Authorization` headers, `curl -u user:password`, `mysql -p…`) and will miss secrets in unusual formats. File contents and command output are never logged.
