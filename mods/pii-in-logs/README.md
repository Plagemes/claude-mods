# pii-in-logs
> Flags log statements that print emails, passwords, tokens or other personal data.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
After every edit that adds a log statement, pii-in-logs checks what the statement prints. `console.*`, `logger.*` / `log.*`, `print`, `puts`, `fmt.Print*`, `System.out`, `Log.d`, `println!`, `error_log` and friends are recognised; if their arguments include something like `password`, `token`, `apiKey`, `ssn`, `creditCard`, `email`, `phone`, `dob`, a whole `user` object or `req.body`, Claude is told which line and why. Text that only mentions the word (`console.log("Enter your password")`) is not flagged.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install pii-in-logs@claude-mods
```

## Usage
Nothing to run. In the default warn mode the edit goes through, you get a toast, and Claude sees a note:

```
pii-in-logs: this edit added a log statement to src/login.ts that may print personal data or secrets:
- console.log("login", email, password)  (prints email, password)
Log an id or a masked value instead (for example the last 4 characters, or a hash), or leave the value out.
If this is intended, put "pii-in-logs: allow" in a comment on that line.
```

In block mode the edit is refused until the statement is fixed. A comment with `pii-in-logs: allow` on the statement's line, or the line above, silences it (an audit log that is meant to hold the address, say).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | string | `warn` | `warn` lets the edit through and tells Claude; `block` refuses it. |

## How it works
- A `tool.call` hook on `Edit`, `MultiEdit`, `Write` and `NotebookEdit` compares the log statements in the new text with those in the text it replaces (for a `Write`, the file on disk), so only statements an edit adds are judged. Multi-line calls are read to their closing parenthesis.
- Arguments are read as code: strings are reduced to nothing apart from what they interpolate (`${x}`, `#{x}`, `$x`, `f"{x}"`, Rust `{x}`), `x['key']` reads like `x.key`, and names are split into words (`userEmail` is `user` + `email`). Harmless attributes are skipped: `password.length`, `tokenCount`, `isEmailValid`, `emailInput`, `{ password: "***" }`.
- Keys and tokens written into the call itself (`console.log("using ghp_…")`) are found with the shared claude-mods secret rules (`shared/secrets`).
- Only code files are scanned; tests, fixtures and docs are not, and lines over 2,000 characters (minified code) are skipped.
- With [mods-hub](../mods-hub) installed, each flagged edit publishes `secret.detected` (kind `log-statement`, action `warned` or `blocked`, the path) and, when it went through, `lint.result` (the count as warnings) or, when it was refused, `risk.blocked`; the toast becomes a `warning` notification. Never the values. Without the hub nothing changes.
- Limits: it is a heuristic. It sees names, not values, so `console.log(x)` where `x` holds an email is invisible, and a variable that is called `token` but means an LLM token is flagged; the allow marker is there for those cases.
