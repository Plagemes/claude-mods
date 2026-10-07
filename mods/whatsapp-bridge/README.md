# whatsapp-bridge
> Lets Claude keep you posted on WhatsApp — progress, problems, reports, questions — and lets you steer every session from your phone, through one self-hosted OpenWA number.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
Every Claude Code session on your machine shares one WhatsApp number, served by your own [OpenWA](https://github.com/rmyndharis/OpenWA) gateway on `127.0.0.1`. While you are away, Claude reports long jobs, failures, red tests, CI results and budget steps, and it can ask you a question and wait for the answer. From your phone you can send prompts, stop turns, approve permission prompts with 👍, queue tasks, and ask for status, cost or a digest. Each project gets its own WhatsApp group: you can add teammates, who can ask Claude about progress or report bugs but can never run anything.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install whatsapp-bridge@claude-mods
```

## Usage
**Setup (once):** run `/wa setup`. If no OpenWA answers, it prints a `docker run` bound to `127.0.0.1:2785`, never `0.0.0.0`. Then it prints the `curl` steps to mint a **scoped operator key** (`allowedSessions`, and `allowedChats` if you link your own number). Paste the key in the panel (Privacy tab), set it as the `apiKey` option, or export `OPENWA_API_KEY`. `/wa key` also works but puts the key in the transcript. An admin key is refused and never stored. Then set yourself as owner with `/wa owner +39…` and link the number: the panel shows the QR on terminals with image support (kitty, Ghostty), and a link to the OpenWA dashboard elsewhere. You can also use `/wa pair +<number>` to get a pairing code. Finish with `/wa test`.

**Use a dedicated bot number.** Recommended and the default: OpenWA drives an unofficial WhatsApp client, and its README warns of ban risk on primary numbers. If you link your own number anyway, the mod reads and writes only the allowlist (your direct chat and the project groups), and never sends typing, read receipts or presence.

| Command | What it does |
| --- | --- |
| `/wa` | Open the side panel. Tabs: Status (connection, project group, sessions, quick actions), Chat (conversation, reply box, member Q&A), Settings (interaction, quiet hours, away minutes, one toggle per update), Privacy (allowlist, key, redaction preview), Log. |
| `/wa setup` · `test` · `status` | Walk through what is missing · send a test · show the state. |
| `/wa link-project [n]` · `unlink-project` | Create "Claude · <project>" with only you in it, or pick one of the bot's groups. |
| `/wa away` · `here` · `auto` | Presence. Auto means away after N minutes without typing. |
| `/wa interact on\|off\|auto` · `silent` · `night` | Whether Claude may ask you things (see below). |
| `/wa pause` · `resume` · `digest` · `report` · `label <name>` | Notifications, digest now, PNG charts, this session's `#tag`. |

**From the phone** (only your `ownerNumbers`; English or Italian): `status`/`stato`, `sessions`/`sessioni`, `stop`/`ferma`, `STOP ALL`/`ferma tutto`, `pause`/`pausa`, `resume`/`riprendi`, `digest`/`riepilogo`, `cost`/`costo`, `report`/`grafico`, `queue <task>`/`coda <task>`, `interact on|off`, `night`/`notte`, `help`/`aiuto`. Any other text is a prompt. By default it is confirmed first ("Run this on #login? sì/no"), then sent to the session as your words, and Claude's answer comes back to the chat. Start a message with `#label` or `@project`, or reply to a session's message, to pick the session. Otherwise it goes to the project of the group you write in, or to the most recently active session. React 👍 approve · ❌ reject · ⏸ pause · 🔁 retry on a question or alert. Photos and documents are saved under `.claude/whatsapp/inbox/` and handed to Claude by path. Voice notes are transcribed only if a local `whisper` CLI exists. `STOP ALL` and `/slash` commands need your PIN when one is set.

**Group members** (people you add to a project group) trigger Claude only with `?` / `claude`, an @mention or a reply to the bot. They get short, redacted answers from a tool-less fork of the session: no costs, paths outside the repo, config values or code. `bug: …` (or 🐞) drafts a GitHub issue, which is filed with `gh issue create` only after **your** 👍. Members' commands, votes and reactions are ignored.

**Claude's tools:** `notify`, `ask` (a numbered question that waits for your reply), `send_file` (files inside the project, size-capped) and `open_panel`. The system prompt tells Claude to use them only when blocked on your decision or when a long job ends. **Interaction off** (Silent, Night, or the `23-8` off-hours) means `ask` returns "unavailable" at once, and Claude proceeds on its best judgement. The parked questions arrive when interaction is back on, or with the morning briefing. Confirmations, approvals and previews are suppressed too.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `ownerNumbers` | — | Your number(s): the only ones that can command, answer or approve. Also `/wa owner`. |
| `apiKey` | — | Scoped operator key (secret). Optional: panel, `OPENWA_API_KEY` or `/wa key`. |
| `baseUrl` | `http://127.0.0.1:2785/api` | Your OpenWA API. |
| `allowedChats` | — | Extra chat ids to allow. Everything outside the allowlist is dropped before storage. |
| `autoCreateGroup` | `true` | Create the project group on first use (Baileys engine only). |
| `notifyMode` | `away` | `away`, `always` or `off`. |
| `awayMinutes` | `10` | No typing for this long = away. |
| `quietHours` | `23-8` | Only critical messages go out. |
| `interactionOffHours` | `23-8` | No questions; they are parked. |
| `digestMinutes` | `45` | Info updates are batched (30–60). |
| `maxPerHour` | `20` | Global cap across sessions; the excess goes to the digest. |
| `pin` | — | PIN for `STOP ALL` and `/slash` from the phone (secret). |
| `remoteApprovals` | `true` | Answer permission prompts with 👍/❌ while away. |
| `longTurnMinutes` | `5` | Report turns at least this long. |
| `budgetSteps` | `5,10,25` | USD steps that alert, once per session. |
| `briefingTime` · `eveningTime` | `08:30` · `19:00` | Morning briefing, evening digest (empty = off). |
| `memberTrigger` · `memberRate` · `memberDailyCap` | `?,claude` · `5` · `40` | How members reach Claude: per member per 10 min, and per day. |
| `shareCodeWithMembers` | `false` | Allow code in member answers. |
| `ownerOnlyAlertsInGroup` | `false` | Cost, budget and approval alerts go to the group instead of your direct chat. |
| `maxMessageChars` · `maxFileMb` · `pollSeconds` | `1500` · `5` · `6` | Caps and the poll pace. |

Per-update toggles live in the panel (Settings). They cover long turn, failure, tool errors, tests, CI, budget, session end, briefing, evening, permissions, live status, phone-prompt confirmation, member answers, bug reports, UI previews and visual reports. Live status and visual reports start off.

**With [mods-hub](../mods-hub) installed** the bridge becomes the hub's `whatsapp` channel: what any mod sends through the hub's notifications (CI failed, budget reached, a deploy done) reaches WhatsApp by the hub's routing, and the WhatsApp panel is the **Channels** tab of the shared Claude Mods panel (`/wa` opens it there). Presence, interaction and night are then the hub's global mode, shared by every session and every channel: `/wa away|here|auto`, `interact`, `silent` and `night` (from the terminal, the panel or the phone) change the hub's mode, and the bridge's own presence, off-hours, quiet hours and away minutes wait unused as the fallback for when the hub is gone. Pause, the update toggles and the hourly cap stay the bridge's.

## How it works
- **One poller, many sessions.** State is shared in `~/.claude/claude-mods/whatsapp/`, one writer per file. A lease (renewed every 10 s, taken over after 30 s) elects one session to poll OpenWA's `GET /messages` with a row-id cursor, walking pages back to the stored row. It dedupes by row id and backs off on 429. It drops non-allowlisted chats, then routes each message (reply → sender, tag, project group, most recent) into that session's `inbox/<id>.jsonl`. Each session consumes its inbox with its own seq and id set, so every message is handled exactly once. OpenWA's webhooks and Socket.IO are not used: a hooks module can't listen on a port or open a socket.
- **What it uses from OpenWA:** health, `auth/validate` (an admin key is refused), session status, QR and pairing code, start, `send-text`/`reply` with `Idempotency-Key`, `send-image`/`send-document` (base64), `edit` (live status), `react` (👀 on your prompt), group create/info/description/invite link, `contacts/{lid}/phone`, and reactions read from the message row. **Not used:** native polls. OpenWA does not surface poll votes (no `vote_update` handling, `getPollVotes` not exposed), so questions are numbered lists answered by reply or reaction. Group creation works only on the Baileys engine; on whatsapp-web.js, create the group on your phone and use `/wa link-project`.
- **Limits.** Permission prompts are answered through the `classic.PermissionRequest` decision, while that hook waits for your reaction. A keystroke at the terminal ends the wait. `ask` waits by pacing on the host's `sleep`: a `$` call does not use the hook budget, but `$.clock.sleep` would. Where there is no `sleep`, it returns a ticket and the answer arrives later as a message. Media goes to disk through `openssl`/`base64`/`python3`, since `$.fs` writes text only. PNG charts need `rsvg-convert`, ImageMagick or a headless Chromium; otherwise they come as text tables. Smart-router savings are read from `~/.claude/claude-mods/smart-router/daily.json` when present. Quiet hours use this machine's local time.
- **With mods-hub.** At start the bridge says hello, registers the Channels tab and the `whatsapp` channel (status follows the OpenWA link), and drains the hub's outbox for it every 3 s: each notice goes out by its level (critical at once, info in the digest, the rest as normal) to the project chat; the hub has already judged presence and night, so the bridge only applies pause, `notifyMode: off` and the hourly cap. It is a **pull** channel: answering the hub's push (`mods.deliver`) needs `"dependencies": ["mods-hub"]`, and the bridge must keep working without the hub. Every heartbeat it re-reads the hub's mode and its bus: test runs other mods published (test-watch's) count as red/green like Bash ones, and its own CI watch steps aside when ci-watch already reported the branch (that notice reaches WhatsApp through the hub). It publishes what arrives from the phone as `channel.inbound` and a permission answered with 👍/❌ as `approval.answered`. With the hub, `/wa night` switches on the hub's Night mode (its quiet hours, every night), not a one-off "until morning".
