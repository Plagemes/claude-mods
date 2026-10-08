# mods-hub
> The shared core that lets mods talk to each other: one event bus, one side panel with tabs, one place that routes notifications to your channels.

**Category:** Core · **Version:** 1.1.1

## What it does
Adds `$.mods` to every mod: an event bus with typed standard events (`test.result`, `ci.result`, `cost.update`, `deploy.failed`, …), a blackboard of shared facts, and a notification router that knows whether you are here, idle or away, Silent, or inside your Night hours, and sends each notification to the terminal, your phone or your team's channel accordingly. It also opens one **Claude Mods** panel whose tabs other mods fill (Advisor, Router, Mission Control, Channels, …), with a Home tab for the global mode, channels, routing and the last notifications.

Every mod keeps working without the hub; with it, they cooperate.

## Install
```
/plugin install mods-hub --marketplace plagemes/claude-mods
```

## Usage
- `/hub` opens the Claude Mods panel on Home: **Mode** (Interaction auto/on/off, Silent, Night with your quiet hours, I'm away / I'm back), **Channels** (each connector mod's status, on/off), **Routing** (where each level goes: terminal, when away, always, off), **Mods** (installed, on the bus, tabs) and **Recent** (notifications and every mod's toasts). Tabs are switched with `0`–`9`: the tab strip shows each tab with its digit (`0: Home`, `1: Advisor`, …).
- `/hub status` prints the mode, channels and tabs.
- `/hub silent [minutes|off]` holds every mod's toasts and sounds in Recent; `/hub night [on|off|22:00-07:00]`; `/hub away` / `/hub back`; `/hub interaction auto|on|off`; `/hub route error always`; `/hub tab <id>`; `/hub test [level]` sends a test notification and says where it went (`status`, `tab` and `test` do not end an away you set, so `/hub away` then `/hub test error` shows what reaches your phone).
- `/hub stop`, `/hub pause`, `/hub resume` (add `all` for every session) stop, pause or resume the mods that work on their own (autopilot, and in the next wave task-queue, night-shift, workflows); a STOP from your phone does the same through whatsapp-bridge. While stopped or paused, Home shows who asked and a **Resume** button.
- Without any other mod it already publishes `test.result` (from test commands Claude runs), `error.repeated` (the same failing command three times), `cost.update`, `turn.finished`, `context.pressure` and `session.started/idle/away/back/ended`.

### What you see

**The frame.** Every tab of the Claude Mods panel shares one header: `▪▪▪ Claude Mods · Hub` (the Slot mark, the last tile lit; *Mods* in italic Ember), then the counts `165 mods · 25 tabs · 6 channels` and the mode as a pill (`● Here`, `◐ Idle`, `○ Away`, with `· Silent 12m` and `· Night` when they hold). The counts give way first on a narrow pane. Under it is the tab bar: `0: ▦ Home  1: ⋔ Router  2: ◔ Cost …`. Each tab carries its owner's category glyph in the terminal and its category icon on the desktop and the phone. The shown tab is drawn at full strength, the rest dim. Home and the first nine tabs are pinned with their digits `0`–`9`; the rest sit behind **More**: a menu on the desktop, a dim second row on the terminal (what fits, then `+N more ▾`), a `More ▾` fold on the phone. A registered tab opens under a title line (`⋔ Router by smart-router · full view: /router`). When its mod draws nothing there, the tab says so and names the command that opens it.

**Home.** It is a stack of cards, each opened by a small Ember kicker (`▪ MODE`, `▪ CHANNELS`, `▪ ROUTING`, `▪ MODS`, `▪ RECENT`):
- **Mode** is segmented controls with a fixed label column: Presence `[ Here ] [ Away ]`, Interaction `[ Auto ] [ On ] [ Off ]`, Silent `[ Off ] [ On · 15m ]`, Night `[ Off ] [ On ] 22:00-07:00`. The current value is the primary.
- **The control strip** is one line: `● Automatic work is running  [ Pause ] [ Stop ]`, or `⏸ Paused by you, at the terminal: … [ Resume ]`. Its height never changes.
- **Channels** have a health dot (`●` connected, `◐` connecting, `○` disconnected, `◌` not set up; a filled SVG dot on the desktop), a short state (`Connected`, `Not set up`, `Error`, `Offline`), and an `[ On ] [ Off ]` switch drawn like the mode's segments. A channel that is not set up or failing shows its mod's hint dim under the row (two lines at most) and a **Set up** button: it opens that mod's tab in the panel, or, when the mod has none, unfolds the whole hint and where its options live.
- **Routing** is one button per level that cycles terminal → when away → always → off.
- **Mods** counts the installed Claude Mods, the enabled ones and those on the bus.
- **Recent** is the activity feed, newest first, one line per row: the time (`now`, `4m`, `2h`), the level glyph in its colour, the mod's name as a fixed-width badge, the text cut to the line, and where it went (`→ phone`, `held for the morning`).

Every row is a single line cut with an ellipsis to the pane's width on every surface (the hub cuts the text itself as well as asking the surface to), so nothing runs past the edge and new data never moves what is below it; only a channel's hint and the empty-state sentences wrap.

**`/hub status`** prints the same in aligned rows:
```
▪▪▪ Claude Mods · Hub
Mode      here · silent 15m · interaction auto
Work      running
Channels  ● desktop connected
Tabs      3: home, router, errors
Mods      5 mods · 5 on the bus
```
**The status line** stays empty on a quiet afternoon. It shows only what differs: `▪ silent 15m · night · away · paused`. The hub's toasts read `✗ ci-watch: CI failed — acme/shop`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `idleMinutes` | number | `10` | Minutes without a prompt before you count as idle. |
| `awayMinutes` | number | `30` | Minutes without a prompt before you count as away; "away" routes then reach your channels. |
| `sensors` | boolean | `true` | Publish the built-in events listed above. |
| `captureToasts` | boolean | `true` | Keep every mod's toasts in Recent (and hold them there while Silent). |

Mode and routing are changed from the Home tab or `/hub` and shared by every session (`~/.claude/claude-mods/hub/prefs.json`).

## How it works
- Under load (about 200 mods in one session, each calling `hubMode`, `hello`, `registerTab`, `recent` and `latest` at start and on timers), every `$.mods.*` call answers from memory: the mode is derived from the prefs held in memory, at most once a second. Hellos, tabs, channels, the feed, the inbox and the latest events are written to `$.state` by one coalesced flush, with plain writes. Before, every call did an optimistic read-modify-write that retried whenever another call had written first. 500 concurrent calls took 22 s and hooks were skipped; now they take about 0.3 s. No call reads a file. The 30 s tick and the 5 s control poll never overlap themselves, and they re-read a shared file only when its mtime moved. `claude plugin list` runs at most once per 10 minutes, one at a time. A hook that still fails answers from memory in its `.catch`. Its session.start only registers `/hub` and reads its own two small files; the rest waits for a timer.
- Adds the noun `$.mods` in `engine.create`; each method is an event (`mods.publish`, `mods.notify`, …) that runs through every plugin's hooks, so a mod subscribes by hooking `mods.publish` with a topic matcher. The contract is `types/index.d.ts`; mods that only publish and notify vendor it and keep working with no hub (see docs/MOD_CONTRACT.md).
- Notifications are routed by level × presence × Silent × Night × Interaction; channels (whatsapp, telegram, slack, discord, email, desktop mods) register with `$.mods.registerChannel`, with secrets masked first: push channels (bound to the hub) answer `mods.deliver`; pull channels (the standard for mods that also work alone) drain their notices with `$.mods.drain({ channel, after })`, at-least-once: a notice comes back until a later drain acknowledges it, and survives a hot reload. While Silent it holds other mods' toasts and sounds; at Night, sounds, and what would have gone to your phone waits for one morning digest.
- Presence is shared across sessions through `~/.claude/claude-mods/hub/activity.json`; each session writes a heartbeat with its recent global events to its own `sessions/<id>.json` and rebuilds from those files the merged `sessions.json` mission-control-style mods read; a stop, pause or resume for all sessions goes into the raising session's own `control/<id>.json`, and every session reads that folder every 5 seconds (one writer per file, so sessions writing at the same moment never drop each other's line). A change of mode or routing is applied to `prefs.json` as it is on disk, so a change another session made a moment before is kept. Limits: activity is your prompts and the hub's own buttons (other mods' slash commands do not count); the panel's tabs are drawn by their own mods, which must be installed and follow the tab convention.
