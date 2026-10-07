# telegram-bridge
> Progress, questions and remote control over a Telegram bot, through the mods-hub channel system.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
Every Claude Code session on your machine shares one Telegram bot. Whatever the hub routes to your phone (CI results, failures, budget steps, Claude's own `notify`) arrives as a message, and Claude can ask you a question with real buttons and wait for the tap. From the phone you can steer the sessions: send a prompt, stop a turn, approve a permission prompt with **Allow / Deny**, check status, switch presence and Interaction. Add the bot to a project group and teammates can ask Claude about progress, but never run anything.

It is a **bound** mod: it needs `mods-hub` (installing it installs the hub). It registers itself as the hub's `telegram` channel (push delivery), so presence, Silent, Night and Interaction are the hub's, set once for every channel. If the hub does not answer (disabled mid-session), it falls back to its own simple settings.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install telegram-bridge@claude-mods
```

## Usage
**Setup (once).** Talk to [@BotFather](https://t.me/BotFather): `/newbot`, copy the token, and set it as the `botToken` option (stored as a secret) or export `TELEGRAM_BOT_TOKEN`. Send your bot any message, then run `/telegram setup`: it lists who wrote to the bot (id and name only, never their words). Pick yourself with `/telegram owner <id>` and finish with `/telegram test`.

| Command | What it does |
| --- | --- |
| `/telegram` | Open the status tab (in the hub's Claude Mods panel, or its own pane). Connection, mode, sessions, recent messages, Test / Pause / Interaction / Refresh. |
| `/telegram setup` · `status` · `test` | Say what is missing · show the state · send a test message. |
| `/telegram owner <id>` | The only user that can command Claude, answer or approve. |
| `/telegram link-project [n\|chat id]` · `unlink-project` | Give this project its own group chat (add the bot to the group first). |
| `/telegram pause` · `resume` | Mute this channel (critical messages still go). |
| `/telegram away` · `here` · `auto` · `interact on\|off\|auto` | Presence and Interaction: sent to the hub, so every channel follows. |
| `/telegram label <name>` | This session's `#tag`. |

**From the phone** (only the owner; English or Italian): `status`/`stato`, `sessions`/`sessioni`, `stop`/`ferma`, `stop all`/`ferma tutto`, `pause`/`pausa`, `resume`/`riprendi`, `away`/`via`, `here`/`qui`, `interact on|off|auto`, `silent [min|off]`/`silenzio` (no minutes: until you switch it off), `night [on|off]`/`notte`, `cost`/`costo`, `queue <task>`/`coda <task>`, `help`/`aiuto`. The bot menu forms (`/status`, `/stop@yourbot`) work too; any other `/slash` is refused, never run. Anything else is a prompt: it is confirmed first with **Run / Cancel** buttons (when Interaction allows questions), sent to the session as your words, and Claude's answer comes back to the chat. Start a message with `#label` or `@project`, or reply to a session's message, to pick the session; otherwise it goes to the project of the group you write in, or to the most recently active session. `stop all` aborts every session's turn and asks the hub to stop the automatic work (autopilot, task-queue, night-shift) in all sessions; it needs your PIN when one is set.

**Group members** (people in a linked project group) trigger Claude only with `?` / `claude`, an @mention of the bot or a reply to it (with Telegram's privacy mode on, the bot only hears mentions, replies and commands). They get short answers from a tool-less fork of the session, with everything private masked: costs, paths outside the repo, config values, personal data, code. Their commands, buttons and votes are ignored. Rate limits apply per member and per day.

**Claude's tools:** `notify` (goes through the hub: its level, your presence and Night decide), `ask` (options become buttons; waits for your answer), `send_file` (files inside the project, size-capped, sent with `curl`) and `open_panel`. When Interaction is off (or you are at the keyboard in `auto`, or it is night) `ask` returns "unavailable" at once and Claude proceeds on its best judgement; no approval requests are sent either.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `botToken` | — | The BotFather token (secret). Or `TELEGRAM_BOT_TOKEN`. |
| `ownerId` | — | Your numeric Telegram user id. Also `/telegram owner`. |
| `allowedChats` | — | Extra group chat ids the bot may use. Every other chat is dropped unread. |
| `pin` | — | PIN for `stop all` from the phone (secret). |
| `confirmPrompts` | `true` | "Run this?" buttons before a phone prompt starts a turn. |
| `remoteApprovals` | `true` | Allow / Deny buttons for permission prompts while you are away. |
| `memberTrigger` · `memberRate` · `memberDailyCap` | `?,claude` · `5` · `40` | How members reach Claude: per member per 10 min, and per day. |
| `shareCodeWithMembers` | `false` | Allow code in member answers. |
| `maxMessageChars` · `maxFileMb` · `pollSeconds` | `3000` · `10` · `10` | Caps, and the long-poll length (0: short polls). |
| `notifyMode` · `interaction` · `awayMinutes` · `quietHours` | `away` · `auto` · `10` · `23-8` | Only used **without a hub**: when to notify, may Claude ask, when you count as away, quiet hours. |

## How it works
- **One poller, many sessions.** State is shared in `~/.claude/claude-mods/telegram/`, one writer per file. A lease (renewed every 10 s, taken over after 30 s) elects one session to long-poll `getUpdates`. It starts after the backlog (only learning who wrote, never replaying), saves the offset before handling anything (a crash loses a message rather than running a prompt twice), drops chats that are not allowlisted unread, and routes each message (reply → sender, tag, project group, most recent) into that session's inbox. Each session consumes its own inbox once.
- **Hub.** Publishes `channel.inbound` (redacted) and `approval.answered`; consumes `mods.deliver` for its channel; calls `setMode` / `setPresence` (reason `channel`) from the phone. Everything the hub hands over, and every message the mod writes itself, is masked again with `shared/secrets`; a group gets the strict member rules. The token is only ever in the request URL: errors are scrubbed and it never appears in a log, a message or a process list (uploads read curl's config from stdin).
- **Limits.** Telegram bots cannot read other bots' messages or a group's history; only `getUpdates` while no webhook is set (a second poller gets a 409 and backs off). Permission prompts are answered through `classic.PermissionRequest` while that hook waits for your tap; a keystroke at the terminal ends the wait. `ask` waits by pacing on the host's `sleep`; where there is none it returns a ticket and the answer arrives later as a message. Quiet hours without a hub use this machine's local time. Not supported: photos or documents *from* you, voice notes, slash commands.
- **Trust.** Like every plugin, it reaches the network through the host, so another plugin's `http.fetch` hook could see a request; Telegram only takes its token in the URL path.
