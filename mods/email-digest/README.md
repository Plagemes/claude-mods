# email-digest
> Daily or weekly email summaries in plain language for clients and managers who don't live in chat.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
Turns what happened on a project into one short email: what was done, what is next, what is blocking, and (if you want it) what the AI cost. It reads `git log`, the `session-journal` day files, the events the other mods publish (CI, deploys, PRs, decisions, tests, repeated errors) and smart-router's daily total, then writes it in the tone of your reader (client, manager or technical) and in English or Italian. Send it by hand with a preview, or on a schedule. Delivery is Resend, SendGrid, or SMTP through `curl`.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install email-digest@claude-mods
```

## Usage
**Setup (once):** `/digest setup` lists it. In `/config` under email-digest: a provider and its key (`resendApiKey`, `sendgridApiKey`, or `smtpUrl` + `smtpUser` + `smtpPassword`), a `from` address on a domain your provider verified, and `recipients`. Nothing is ever sent until all three are set.

| Command | What it does |
| --- | --- |
| `/digest` | Open the preview pane: subject, recipients, the text as it would be sent, and buttons **Send now**, **Edit recipients**, Daily / Weekly, Tone, Language, Refresh. |
| `/digest preview [daily\|weekly]` | The digest as text, with what is missing before it can go out. |
| `/digest send [daily\|weekly]` | Send it now. |
| `/digest recipients a@x.com, b@y.com` | Recipients of **this project** (validated; `clear` empties them). Each project keeps its own list, so a client never gets another client's work. |
| `/digest tone client\|manager\|technical` · `lang en\|it` | The voice for this project. |
| `/digest note <text>` | A one-off line for the next digest ("Demo on Friday"); cleared after it is sent. |
| `/digest status` | Provider, recipients, schedule, who sends. |

**Tones.** *client*: plain bullets, no hashes, authors or links, chores folded into "plus N behind-the-scenes changes", a failing build said simply ("some automated checks are failing; we are looking into it"). *manager*: a count line ("8 changes: 3 new, 4 fixed…"), the main items, build health, alerts as a count. *technical*: short hashes, authors, links, the latest test run, loud alerts.

**What a digest holds.** *What was done* (journal lines first, then commits in plain words: `feat(cart): add codes (#42)` becomes "Cart: add codes"), *Shipped and in review* (deploys, PRs, decisions), *Health* (builds, tests; manager and technical), *What's next* (open todos from the journal), *Blockers and questions* (a CI or deploy failure its next run did not fix, open questions from the journal; with none, a sentence says so), *Alerts*, the optional *Cost* line (`includeCost`, off by default), your note, your signature. An empty period is not sent by the schedule.

**Schedule.** `frequency` off (default), daily, weekly or both (the weekly digest replaces the daily on its day), at `sendAt` local time; weekends are skipped for the daily one. A session opened up to 6 hours late still sends; a failed send is retried after 30 minutes, three times at most, then one error notice.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `provider` | `resend` | `resend`, `sendgrid` or `smtp`. |
| `resendApiKey` · `sendgridApiKey` | — | API keys (secret). Use sending-only keys. |
| `smtpUrl` · `smtpUser` · `smtpPassword` | — | `smtps://host:465` or `smtp://host:587` (TLS is required); the password is secret. |
| `from` · `replyTo` | — | `Acme Studio <digest@acme.com>`; the domain must be verified with the provider. |
| `recipients` | — | Default recipients, comma separated. A project's own list wins. |
| `frequency` · `sendAt` · `weeklyDay` · `skipWeekends` | `off` · `18:00` · `fri` · `true` | The schedule. |
| `tone` · `language` | `client` · `en` | Defaults; a project can change them. |
| `includeCost` | `false` | Add the AI cost of the period. |
| `signature` · `projectName` | — · folder name | Closing text; name used in the subject. |
| `journalDir` · `timezone` | `.claude/journal` · this machine's | Where session-journal writes; zone of the days and the send time. |

## How it works
- **Sources.** `git log --branches --no-merges` over the period (run in the project's repo), `<project>/.claude/journal/YYYY-MM-DD.md` (Work done, Open questions, unchecked Open todos), and with `mods-hub` the bus events and notices of the sessions of that project. A journal line and the commit it describes are said once. Cost: with the hub, this project's `cost.update` figures; otherwise smart-router's `daily.json` (all projects, and the line says so). Without the hub you still get git, the journal and the cost fallback.
- **One sender per project.** State is in `~/.claude/claude-mods/email-digest/`: `config.json` (per-project recipients, tone, language, note), `lease/<project>.json`, `state/<project>.json` (what was sent), `sessions/<id>.json` (the events a session saw, for the leader to read). A lease (renewed every 10 s, taken over after 30 s; the whatsapp-bridge pattern) elects one session per project to check the schedule and send. A manual send works from any session.
- **Hub channel.** It registers the `email` channel (`delivery: pull`, digest only): the notices your routes send to it are drained every 20 s into the day's digest, never mailed one by one. It consumes `ci.result`, `deploy.*`, `pr.opened`, `decision.recorded`, `test.result`, `error.repeated`, `cost.update` by polling `$.mods.recent` (it publishes nothing); on a successful or failed scheduled send it notifies at `success` / `error` for the terminal only.
- **Secrets.** The whole digest (subject, text, HTML) goes through the shared secret masker before it is sent (tokens, keys, card numbers, IBANs, private IPs); a key a provider echoes in an error is replaced by `[key]`. For SMTP the message is written to `outbox/message.eml` (emptied after the send; there is no file delete) and `curl --url … --mail-from … --mail-rcpt … --upload-file` reads the credentials from its **stdin** (`--config -`), never the command line.
- **Limits.** Plain-language here means rule-based: it cleans and groups commit messages and uses your journal's own sentences; it does not rewrite them with a model (so nothing is invented, and nothing costs tokens). Commit messages stay in the language they were written in. Everyone on the list sees the other recipients. HTML is a simple inline-styled body. There is no unsubscribe or tracking.
