# discord-bridge
> Posts progress and reports to Discord and takes questions and commands from a channel, through the mods-hub channel system.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
A Discord channel becomes a window on every Claude Code session on your machine. Whatever the hub routes to the team (CI results, deploys, failures: notices with `audience: 'team'`, and Claude's own `notify`) is posted there, and Claude can send a file. In the same channel the **owner** (one configured user) can steer the sessions: send a prompt, stop a turn, approve a permission prompt with a ✅ reaction, answer Claude's question, check status, switch presence and Interaction. **Everyone else** can only ask Claude about progress, and gets a short, redacted answer. With only a channel webhook it is post-only: the simplest setup.

It is a **bound** mod: it needs `mods-hub` (installing it installs the hub). It registers itself as the hub's `discord` channel (team audience, push delivery), so presence, Silent, Night and Interaction are the hub's, set once for every channel. If the hub does not answer (disabled mid-session), it falls back to its own simple settings.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install discord-bridge@claude-mods
```

## Usage
**Post only (two minutes).** Channel settings → Integrations → Webhooks → copy the URL, and set it as the `webhookUrl` option (a secret). Run `/discord test`. Claude can post and send files; nothing can be asked or commanded.

**Full mode.** Run `/discord setup`: it prints the steps. In short: create an application at discord.com/developers, add a Bot, copy its token as `botToken` (or `DISCORD_BOT_TOKEN`), enable the privileged **Message Content intent** (without it Discord sends messages empty; setup warns when it sees that), and add the bot to your server with the permissions View Channel, Send Messages, Read Message History, Add Reactions and Attach Files. With Developer Mode on, copy the channel id (`/discord channel <id>`) and your own user id (`/discord owner <id>`); `/discord setup` also lists who wrote in the channel (id and name only, never what was said). Finish with `/discord test`.

| Command | What it does |
| --- | --- |
| `/discord` | Open the status tab (in the hub's Claude Mods panel, or its own pane). Connection, mode, sessions, recent messages, Test / Pause / Interaction / Refresh. |
| `/discord setup` · `status` · `test` | Say what is missing · show the state · post a test message. |
| `/discord channel <id>` · `owner <id>` | The one channel to post to and read · the only user that can command Claude, answer or approve. |
| `/discord pause` · `resume` | Mute this channel (critical messages still go). |
| `/discord away` · `here` · `auto` · `interact on\|off\|auto` | Presence and Interaction: sent to the hub, so every channel follows. |
| `/discord label <name>` | This session's `#tag`. |

**From the channel** (only the owner; English or Italian): `status`/`stato`, `sessions`/`sessioni`, `stop`/`ferma`, `stop all`/`ferma tutto`, `pause`/`pausa`, `resume`/`riprendi`, `away`/`via`, `here`/`qui`, `interact on|off|auto`, `silent [min|off]`/`silenzio` (no minutes: until you switch it off), `night [on|off]`/`notte`, `queue <task>`/`coda <task>`, `help`/`aiuto`. `stop all` aborts every session's turn and asks the hub to stop the automatic work in all sessions; it needs your PIN when one is set. Any other `/slash` is refused, never run. Anything else is a prompt: it is confirmed first (reply yes / no, or react ✅ / ❌, when Interaction allows questions), sent to the session as your words, and Claude's answer comes back as a reply to your message. Start a message with `#label` or `@project`, or reply to a session's message, to pick the session; otherwise it goes to the most recently active one. `cost` is refused here: everyone in the channel would read it.

**Members** (everyone else in the channel) trigger Claude only with `?` / `claude`, an @mention of the bot or a reply to one of its messages. They get short answers from a tool-less fork of the session, with everything private masked: costs, paths outside the repo, config values, personal data, code. Their commands and reactions are ignored. Rate limits apply per member and per day.

**Claude's tools:** `notify` (team news, through the hub: its level and your routing decide), `ask` (numbered options with number reactions to tap, or ✅ ❌; waits for the owner's answer), `send_file` (files inside the project, size-capped, sent with `curl`; Claude Code asks you each time) and `open_panel`. When Interaction is off, you are at the keyboard in `auto`, it is night, or Discord is post-only, `ask` returns "unavailable" at once and Claude proceeds on its best judgement; no approval requests are posted either.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `botToken` | — | The bot's token (secret). Or `DISCORD_BOT_TOKEN`. |
| `channelId` | — | The one channel to post to and read. Also `/discord channel`. |
| `ownerId` | — | The user id that may command Claude. Also `/discord owner`. |
| `webhookUrl` | — | Channel webhook URL (secret): post-only mode. Or `DISCORD_WEBHOOK_URL`. |
| `pin` | — | PIN for `stop all` (secret). |
| `confirmPrompts` · `remoteApprovals` | `true` · `true` | "Run this?" before a prompt from the channel; permission prompts answered from the channel while you are away. |
| `memberTrigger` · `memberRate` · `memberDailyCap` | `?,claude` · `5` · `40` | How members reach Claude: per member per 10 min, and per day. |
| `shareCodeWithMembers` | `false` | Allow code in member answers. |
| `maxMessageChars` · `maxFileMb` · `pollSeconds` | `1900` · `8` · `5` | Text cap (Discord: 2000), file cap, and how often the channel is read while you are away or a question is open (three times slower otherwise). |
| `notifyMode` · `interaction` · `awayMinutes` · `quietHours` | `away` · `auto` · `10` · `23-8` | Only used **without a hub**. |

## How it works
- **One poller, many sessions.** State is shared in `~/.claude/claude-mods/discord/`, one writer per file. A lease (renewed every 10 s, taken over after 30 s) elects one session to read `GET /channels/{id}/messages?after=` with a message-id cursor. It starts at "now" (never replays), saves the cursor before handling anything (a crash loses a message rather than running a prompt twice), skips bots, webhooks and system messages, and routes each message (reply → sender, tag, most recent) into that session's inbox. Each session consumes its own inbox once. While a question is open the leader also reads the reactions on that message, a few at a time.
- **Hub.** Publishes `channel.inbound` (redacted) and `approval.answered`; consumes `mods.deliver` for its channel; calls `setMode` / `setPresence` (reason `channel`) and `stop` (STOP ALL) from the channel. Everything the hub hands over, and every message the mod writes itself, is masked again with `shared/secrets` and gets the strict member rules (it is a team channel); mentions never ping (`allowed_mentions`). The token and webhook URL are never in a log, a message or a process list (uploads read curl's config from stdin).
- **Limits.** A hooks module cannot hold the Discord gateway (a websocket), so it polls the REST API: answers are text replies and reactions, and new messages are seen within the poll pace. Reading content needs the Message Content intent. One channel only. Permission prompts are answered through `classic.PermissionRequest` while that hook waits for your reply or reaction; a keystroke at the terminal ends the wait. `ask` waits by pacing on the host's `sleep`; where there is none it returns a ticket and the answer arrives later as a message. Quiet hours without a hub use this machine's local time.
- **Trust.** Like every plugin, it reaches the network through the host, so another plugin's `http.fetch` hook could see a request, its `Authorization` header included.
