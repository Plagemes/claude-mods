# redactor
> Masks secrets and personal data in tool results before the model ever reads them.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
Every tool result (a `cat .env`, a log dump, an API response) is scanned before it is stored in the conversation, and anything sensitive is replaced with a typed marker such as `[REDACTED:aws-key]` or `[REDACTED:email]`. The model, the transcript file and every later request only ever see the masked text. Detection is checksum-backed where possible (Luhn for cards, mod-97 for IBANs) so ordinary numbers stay readable.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install redactor@claude-mods
```

## Usage
Nothing to run. Once something is masked, the status line under the prompt keeps a running tally for the session:

```
redactor: 4 masked (email ×2, aws-key, card)
```

What gets masked:

| Kind | Examples |
| --- | --- |
| Secrets | AWS `AKIA…`, GitHub `ghp_…` / `github_pat_…`, Anthropic `sk-ant-…`, OpenAI `sk-…`, Stripe `sk_live_…`, Slack `xox…`, Google `AIza…`, JWTs, PEM private keys, high-entropy values of `*_KEY` / `*_SECRET` / `*_TOKEN` / `PASSWORD` assignments |
| Emails | `jane.doe@acme.io` |
| Phones | `+44 20 7946 0958`, `(415) 555-0134`, `415-555-0134` |
| IBANs | `DE89 3704 0044 0532 0130 00` (checksum verified) |
| Cards | Visa, Mastercard, Amex, Discover, Diners, JCB numbers that pass Luhn |
| Private IPs | `10.x`, `172.16–31.x`, `192.168.x` (off by default) |

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `secrets` | boolean | `true` | Mask API keys, tokens, JWTs, private keys and secret assignments. |
| `emails` | boolean | `true` | Mask email addresses. |
| `phones` | boolean | `true` | Mask phone numbers. |
| `ibans` | boolean | `true` | Mask IBANs. |
| `cards` | boolean | `true` | Mask payment card numbers. |
| `privateIps` | boolean | `false` | Mask private IPv4 addresses. |
| `allowlist` | string (regex) | `^git@\|^noreply@\|@users\.noreply\.github\.com$\|@example\.(com\|org\|net)$` | Matches of this regex stay visible. Empty to mask everything. |

## How it works
- Hooks `session.append` on the `tool-result` door: the row's text blocks and `tool_result` contents are rewritten before the engine stores them, in the main conversation and in subagents alike.
- If scanning ever fails, the result is replaced with a placeholder rather than let through unscanned; the tally lives in session state and is shown with `$.ui.status`.
- Limits: the terminal may briefly draw the raw output before the rewrite lands, and masked text cannot be quoted back exactly, so an `Edit` whose `old_string` spans a masked value will not match. Pattern-based detection can miss unusual secret formats.
