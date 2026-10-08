# whatsapp-bridge
> Lets Claude keep you posted on WhatsApp — progress, problems, reports, questions — and lets you steer every session from your phone, through one self-hosted OpenWA number.

**Category:** Notifications & Audio · **Version:** 1.1.0

## What it does
Every Claude Code session on your machine shares one WhatsApp number, served by your own [OpenWA](https://github.com/rmyndharis/OpenWA) gateway on `127.0.0.1`. While you are away, Claude reports long jobs, failures, red tests, CI results and budget steps, and it can ask you a question and wait for the answer. From your phone you can send prompts, stop turns, approve permission prompts with 👍, queue tasks, and ask for status, cost or a digest. Each project gets its own WhatsApp group: you can add teammates, who can ask Claude about progress or report bugs but can never run anything.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install whatsapp-bridge@claude-mods
```

## Quick start
You need **Docker** (OpenWA ships as a Docker image only; there is no npm package to `npx`) and a WhatsApp number to link, ideally a spare one.

1. **Install Docker.** Windows and macOS: [Docker Desktop](https://docs.docker.com/get-started/get-docker/), then start it once (whale icon in the tray / menu bar). Linux: Docker Engine (`sudo apt install docker.io` or your distro's package), with your user in the `docker` group.
2. **Open the panel:** `/wa`. The Status tab shows a three-step setup.
3. **Press "Start OpenWA"** (or run `/wa start`). The mod checks Docker, downloads `ghcr.io/rmyndharis/openwa:0.24` (about 1 GB, once), runs it as the container `claude-openwa` on `127.0.0.1:2785` only, with the WhatsApp link kept in the volume `claude-openwa-data`. It then creates the WhatsApp session and a **scoped operator key** by itself: it reads OpenWA's admin key from the container for those two calls and never stores it.
4. **Scan the QR** with your phone: WhatsApp › Settings › Linked devices › Link a device. The desktop app draws it in the panel; a terminal draws it in the panel when it is wide enough, and `/wa qr` prints it in the conversation otherwise. `/wa pair +<number>` gives an 8-character pairing code instead.
5. **Type your own number** in the "Me" field (or `/wa owner +39…`): the only number that can command Claude. Then press **Send test**.

Nothing starts without your press. Tick **Start OpenWA automatically** (or `/wa autostart on`) to have the next session start the container when nothing answers. Only one session starts it: `~/.claude/claude-mods/whatsapp/server.json` names the session doing it, and the others wait and use the same server. The container keeps running for the other sessions when the one that started it ends; **Stop OpenWA** (or `/wa stop`) stops it, and the link survives in the volume.

**Running OpenWA yourself?** Press **I run it myself → set URL** and enter its URL and a scoped operator key (`/wa setup` prints the `docker run` and `curl` steps, or `/wa url http://host:2785/api` and `/wa key`).

## Usage
**Setup** is the Quick start above; `/wa setup` re-checks and says the next step in words. An admin key is refused and never stored. `/wa key <key>` works but puts the key in the transcript: prefer the panel's field, the `apiKey` option or `OPENWA_API_KEY`.

**Use a dedicated bot number.** Recommended and the default: OpenWA drives an unofficial WhatsApp client, and its README warns of ban risk on primary numbers. If you link your own number anyway, the mod reads and writes only the allowlist (your direct chat and the project groups), and never sends typing, read receipts or presence.

| Command | What it does |
| --- | --- |
| `/wa` | Open the side panel. Tabs: Status (connection, project group, sessions, quick actions), Chat (conversation, reply box, member Q&A), Settings (interaction, quiet hours, away minutes, one toggle per update), Privacy (allowlist, key, redaction preview), Log. |
| `/wa setup` · `test` · `status` | Walk through what is missing · send a test · show the state. |
| `/wa start` · `stop` · `qr` | Run OpenWA in Docker on this machine · stop it · print the linking QR. |
| `/wa url <url>` · `autostart on\|off` | Use your own OpenWA · start the container by itself at session start. |
| `/wa link-project [n]` · `unlink-project` | Create "Claude · <project>" with only you in it, or pick one of the bot's groups. |
| `/wa away` · `here` · `auto` | Presence. Auto means away after N minutes without typing. |
| `/wa interact on\|off\|auto` · `silent` · `night` | Whether Claude may ask you things (see below). |
| `/wa pause` · `resume` · `digest` · `report` · `label <name>` | Notifications, digest now, PNG charts, this session's `#tag` (by default the branch, or the project folder's name: `C:\Users\you\OneDrive\my-app` → `#my-app`). |

**From the phone** (only your `ownerNumbers`; English or Italian): `status`/`stato`, `sessions`/`sessioni`, `stop`/`ferma`, `STOP ALL`/`ferma tutto`, `pause`/`pausa`, `resume`/`riprendi`, `digest`/`riepilogo`, `cost`/`costo`, `report`/`grafico`, `queue <task>`/`coda <task>`, `interact on|off`, `night`/`notte`, `help`/`aiuto`. Any other text is a prompt. By default it is confirmed first ("Run this on #login? sì/no"), then sent to the session as your words, and Claude's answer comes back to the chat. Start a message with `#label` or `@project`, or reply to a session's message, to pick the session. Otherwise it goes to the project of the group you write in, or to the most recently active session. React 👍 approve · ❌ reject · ⏸ pause · 🔁 retry on a question or alert. Photos and documents are saved under `.claude/whatsapp/inbox/` and handed to Claude by path. Voice notes are transcribed only if a local `whisper` CLI exists. `STOP ALL` and `/slash` commands need your PIN when one is set.

**Group members** (people you add to a project group) trigger Claude only with `?` / `claude`, an @mention or a reply to the bot. They get short, redacted answers from a tool-less fork of the session: no costs, paths outside the repo, config values or code. `bug: …` (or 🐞) drafts a GitHub issue, which is filed with `gh issue create` only after **your** 👍. Members' commands, votes and reactions are ignored.

**Claude's tools:** `notify`, `ask` (a numbered question that waits for your reply), `send_file` (files inside the project, size-capped) and `open_panel`. The system prompt tells Claude to use them only when blocked on your decision or when a long job ends. **Interaction off** (Silent, Night, or the `23-8` off-hours) means `ask` returns "unavailable" at once, and Claude proceeds on its best judgement. The parked questions arrive when interaction is back on, or with the morning briefing. Confirmations, approvals and previews are suppressed too.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `ownerNumbers` | — | Your number(s): the only ones that can command, answer or approve. Also `/wa owner`. |
| `apiKey` | — | Scoped operator key (secret). Optional: panel, `OPENWA_API_KEY` or `/wa key`. |
| `baseUrl` | `http://127.0.0.1:2785/api` | Your OpenWA API (the panel's "I run it myself" URL overrides it). |
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

## Troubleshooting
| You see | What to do |
| --- | --- |
| **OpenWA isn't running** (`ECONNREFUSED` in the dim line) | Nothing listens on `127.0.0.1:2785`. Press **Start OpenWA**, or start your own server. The panel re-checks with a growing pause (5 s up to 60 s), so it does not hammer the port; **Check again** checks now. |
| **Docker is not installed** / **not running** | Install Docker Desktop (Windows, macOS) or Docker Engine (Linux); start it (Windows: wait until the whale icon says "running"; WSL 2 must be enabled), then press Start again. |
| **Port 2785 is already in use** | Another program (often an OpenWA you started earlier, `docker ps`) holds the port. Stop it (`docker stop <name>`), or keep it and use **I run it myself** with its URL and key. |
| **QR expired** / the phone says the code is invalid | WhatsApp rotates the QR about every 20 s; the panel fetches a fresh one every 3 s. In a terminal, run `/wa qr` again, or use `/wa pair +<number>` for a pairing code. Some accounts cannot link at all (WhatsApp's passkey step); OpenWA cannot pass it. |
| **Multi-device**: the phone shows a new linked device | That is OpenWA: it is a linked device of your number, like WhatsApp Web, and works while the phone is offline. Unlink it from the phone (Linked devices) to cut it off. WhatsApp allows four linked devices. A number linked under one engine must be re-linked if you switch `ENGINE_TYPE`. |
| **Disconnected** after a restart | Press **Reconnect**. The managed container starts the session by itself (`AUTO_START_SESSIONS=true`); a logged-out session needs a new QR. |
| The label is `#c-users-…` | Versions before 1.1.0 built it from the whole Windows path; 1.1.0 replaces it with the project folder's name at the next start. `/wa label <name>` renames it. |

## How it works
- **Tools on demand.** Claude's tools (`notify`, `ask`, ...) are registered only once the bridge is set up, so an unconfigured bridge adds nothing to the prompt.
- **One poller, many sessions.** State is shared in `~/.claude/claude-mods/whatsapp/`, one writer per file. A lease (renewed every 10 s, taken over after 30 s) elects one session to poll OpenWA's `GET /messages` with a row-id cursor, walking pages back to the stored row. It dedupes by row id and backs off on 429. It drops non-allowlisted chats, then routes each message (reply → sender, tag, project group, most recent) into that session's inbox, in a file of the leader's own (`inbox/<session>/<leader>.jsonl`). Each session consumes its inbox with a seq per leader and its id set, so every message is handled exactly once. Every shared file has one writer: two leaders overlapping during a takeover never overwrite each other's inbox lines; each session keeps its own member log (`members/<session>.jsonl`); a session that lost the lease never clears the new leader's when it ends; and a leader re-reads the lease before every poll. OpenWA's webhooks and Socket.IO are not used: a hooks module can't listen on a port or open a socket.
- **Starting OpenWA:** only on a press of Start (or with Start automatically on). `docker image inspect`, then `docker pull` as a background child (`$.process.spawn`) whose last line is the progress row, then `docker run -d --rm --name claude-openwa -p 127.0.0.1:2785:2785 -v claude-openwa-data:/app/data --shm-size 1g -e AUTO_START_SESSIONS=true -e ENGINE_TYPE=baileys ghcr.io/rmyndharis/openwa:0.24` (`whatsapp-web.js` when `autoCreateGroup` is off). No restart policy: Docker never starts it again by itself. Once `GET /api/health` answers: `docker exec claude-openwa cat /app/data/.api-key` (the admin key, in memory only), `GET /api/sessions?name=claude` or `POST /api/sessions`, `POST /api/auth/api-keys` with `role: operator` and `allowedSessions`, then `POST /api/sessions/{id}/start`. The QR is OpenWA's PNG (`GET /api/sessions/{id}/qr`), decoded in the mod into an SVG or half-block characters.
- **What it uses from OpenWA:** health, `auth/validate` (an admin key is refused), session status, QR and pairing code, start, `send-text`/`reply` with `Idempotency-Key`, `send-image`/`send-document` (base64), `edit` (live status), `react` (👀 on your prompt), group create/info/description/invite link, `contacts/{lid}/phone`, and reactions read from the message row. **Not used:** native polls. OpenWA does not surface poll votes (no `vote_update` handling, `getPollVotes` not exposed), so questions are numbered lists answered by reply or reaction. Group creation works only on the Baileys engine; on whatsapp-web.js, create the group on your phone and use `/wa link-project`.
- **Limits.** Permission prompts are answered through the `classic.PermissionRequest` decision, while that hook waits for your reaction. A keystroke at the terminal ends the wait. `ask` waits by pacing on the host's `sleep`: a `$` call does not use the hook budget, but `$.clock.sleep` would. Where there is no `sleep`, it returns a ticket and the answer arrives later as a message. Media goes to disk through `openssl`/`base64`/`python3`, since `$.fs` writes text only. PNG charts need `rsvg-convert`, ImageMagick or a headless Chromium; otherwise they come as text tables. Smart-router savings are read from `~/.claude/claude-mods/smart-router/daily.json` when present. Quiet hours use this machine's local time.
- **With mods-hub.** At start the bridge says hello, registers the Channels tab and the `whatsapp` channel (status follows the OpenWA link), and drains the hub's outbox for it every 3 s with a cursor (at least once: a notice is acknowledged only after it was sent, held for the digest or dropped on purpose, so one whose send failed comes back on the next drain; five failed tries, then it is given up): each notice goes out by its level (critical at once, info in the digest, the rest as normal) to the project chat; the hub has already judged presence and night, so the bridge only applies pause, `notifyMode: off` and the hourly cap. It is a **pull** channel: answering the hub's push (`mods.deliver`) needs `"dependencies": ["mods-hub"]`, and the bridge must keep working without the hub. Every heartbeat it re-reads the hub's mode and its bus: test runs other mods published (test-watch's) count as red/green like Bash ones, and its own CI watch steps aside when ci-watch already reported the branch (that notice reaches WhatsApp through the hub). It publishes what arrives from the phone as `channel.inbound` and a permission answered with 👍/❌ as `approval.answered`. With the hub, `/wa night` switches on the hub's Night mode (its quiet hours, every night), not a one-off "until morning".
