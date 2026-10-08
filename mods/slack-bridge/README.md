# slack-bridge
> Posts progress and reports to Slack and takes questions and commands from a channel, through the mods-hub channel system.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
Your team's Slack channel becomes a window on every Claude Code session on your machine. Whatever the hub routes to the team (CI results, deploys, failures: notices with `audience: 'team'`, and Claude's own `notify`) is posted there. In the same channel the **owner** (one configured member) can steer the sessions: send a prompt, stop a turn, approve a permission prompt, answer Claude's question, check status, switch presence and Interaction. **Everyone else** can only ask Claude about progress, and gets a short, redacted answer. With only an Incoming Webhook it is post-only: the simplest setup.

It is a **bound** mod: it needs `mods-hub` (installing it installs the hub). It registers itself as the hub's `slack` channel (team audience, push delivery), so presence, Silent, Night and Interaction are the hub's, set once for every channel. If the hub does not answer (disabled mid-session), it falls back to its own simple settings.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install slack-bridge@claude-mods
```

## Usage
**Post only (two minutes).** Create an [Incoming Webhook](https://api.slack.com/messaging/webhooks) for the channel and set it as the `webhookUrl` option (a secret). Run `/slack test`. Claude can post; nothing can be asked or commanded.

**Full mode.** Run `/slack setup`: it prints the steps. In short: create a Slack app in your workspace (an internal, non-distributed app: Slack rate-limits reading history of distributed apps to one request a minute), add the bot scopes `chat:write`, `channels:history`, `channels:read`, `reactions:read` and `reactions:write` (a private channel needs `groups:history` and `groups:read` instead), install it, and set the **Bot User OAuth Token** as `botToken` (or `SLACK_BOT_TOKEN`). `/invite @yourbot` in the channel, then `/slack channel <C…id>`. Say something in the channel and run `/slack setup` again to see member ids (ids only, never what was said); pick yours with `/slack owner <U…id>`. Finish with `/slack test`.

| Command | What it does |
| --- | --- |
| `/slack` | Open the status tab (in the hub's Claude Mods panel, or its own pane). Connection, mode, sessions, recent messages, Test / Pause / Interaction / Refresh. |
| `/slack setup` · `status` · `test` | Say what is missing · show the state · post a test message. |
| `/slack channel <id>` · `owner <id>` | The one channel to post to and read · the only member that can command Claude, answer or approve. |
| `/slack pause` · `resume` | Mute this channel (critical messages still go). |
| `/slack away` · `here` · `auto` · `interact on\|off\|auto` | Presence and Interaction: sent to the hub, so every channel follows. |
| `/slack label <name>` | This session's `#tag`. |

**From the channel** (only the owner; English or Italian): `status`/`stato`, `sessions`/`sessioni`, `stop`/`ferma`, `stop all`/`ferma tutto`, `pause`/`pausa`, `resume`/`riprendi`, `away`/`via`, `here`/`qui`, `interact on|off|auto`, `silent [min|off]`/`silenzio` (no minutes: until you switch it off), `night [on|off]`/`notte`, `queue <task>`/`coda <task>`, `help`/`aiuto`. `stop all` aborts every session's turn and asks the hub to stop the automatic work in all sessions; it needs your PIN when one is set. Slack takes `/slash` messages for itself, so type the words. Anything else is a prompt: it is confirmed first (reply yes / no, or react ✅ / ❌, when Interaction allows questions), sent to the session as your words, and Claude's answer is posted back. Start a message with `#label` or `@project` to pick a session; otherwise it goes to the most recently active one. `cost` is refused here: everyone in the channel would read it.

**Members** (everyone else in the channel) trigger Claude only with `?` / `claude` or an @mention of the bot. They get short answers from a tool-less fork of the session, with everything private masked: costs, paths outside the repo, config values, personal data, code. Their commands and reactions are ignored. Rate limits apply per member and per day.

**Claude's tools:** `notify` (team news, through the hub: its level and your routing decide), `ask` (numbered options, ✅ ❌ or number reactions to tap; waits for the owner's answer) and `open_panel`. When Interaction is off, you are at the keyboard in `auto`, it is night, or Slack is post-only, `ask` returns "unavailable" at once and Claude proceeds on its best judgement; no approval requests are posted either.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `botToken` | — | Bot User OAuth Token (secret). Or `SLACK_BOT_TOKEN`. |
| `channelId` | — | The one channel to post to and read. Also `/slack channel`. |
| `ownerId` | — | The member id that may command Claude. Also `/slack owner`. |
| `webhookUrl` | — | Incoming Webhook URL (secret): post-only mode. Or `SLACK_WEBHOOK_URL`. |
| `pin` | — | PIN for `stop all` (secret). |
| `confirmPrompts` · `remoteApprovals` | `true` · `true` | "Run this?" before a prompt from the channel; permission prompts answered from the channel while you are away. |
| `memberTrigger` · `memberRate` · `memberDailyCap` | `?,claude` · `5` · `40` | How members reach Claude: per member per 10 min, and per day. |
| `shareCodeWithMembers` | `false` | Allow code in member answers. |
| `maxMessageChars` · `pollSeconds` | `3000` · `8` | Text cap; how often the channel is read while you are away or a question is open (three times slower otherwise). |
| `notifyMode` · `interaction` · `awayMinutes` · `quietHours` | `away` · `auto` · `10` · `23-8` | Only used **without a hub**. |

## How it works
- **Tools on demand.** Claude's tools (`notify`, `ask`, ...) are registered only once the bridge is set up, so an unconfigured bridge adds nothing to the prompt.
- **One poller, many sessions.** State is shared in `~/.claude/claude-mods/slack/`, one writer per file. A lease (renewed every 10 s, taken over after 30 s) elects one session to read `conversations.history` of the configured channel with a `ts` cursor. It starts at "now" (never replays), saves the cursor before handling anything (a crash loses a message rather than running a prompt twice), skips bots, joins and edits, and routes each message (tag, most recent session) into that session's inbox. Each session consumes its own inbox once. Every shared file has one writer: a leader writes a session's inbox into its own file (`inbox/<session>/<leader>.jsonl`), so two leaders overlapping during a takeover never overwrite each other's messages; each session keeps its own member log (`members/<session>.jsonl`); a session that lost the lease never clears the new leader's when it ends; and a leader re-reads the lease before every poll. While a question is open the leader also reads that message's reactions and thread replies (a few at a time: `reactions.get` is rate limited).
- **Hub.** Publishes `channel.inbound` (redacted) and `approval.answered`; consumes `mods.deliver` for its channel; calls `setMode` / `setPresence` (reason `channel`) and `stop` (STOP ALL) from the channel. Everything the hub hands over, and every message the mod writes itself, is masked again with `shared/secrets` and gets the strict member rules (it is a team channel). The token and webhook URL are never in a log, a message or a status text.
- **Limits.** Slack buttons (Block Kit) need a public endpoint to be received, and a hooks module cannot listen on a port: so answers are text replies and reactions. Threads are read only for open questions; other thread replies are not seen. One channel only. No file uploads. Permission prompts are answered through `classic.PermissionRequest` while that hook waits for your reply; a keystroke at the terminal ends the wait. `ask` waits by pacing on the host's `sleep`; where there is none it returns a ticket and the answer arrives later as a message. Quiet hours without a hub use this machine's local time.
- **Trust.** Like every plugin, it reaches the network through the host, so another plugin's `http.fetch` hook could see a request, its `Authorization` header included.
