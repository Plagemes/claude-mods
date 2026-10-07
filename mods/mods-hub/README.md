# mods-hub
> The shared core that lets mods talk to each other: one event bus, one side panel with tabs, one place that routes notifications to your channels.

**Category:** Core · **Version:** 1.0.0

## What it does
Adds `$.mods` to every mod: an event bus with typed standard events (`test.result`, `ci.result`, `cost.update`, `deploy.failed`, …), a blackboard of shared facts, and a notification router that knows whether you are here, idle or away, Silent, or inside your Night hours, and sends each notification to the terminal, your phone or your team's channel accordingly. It also opens one **Claude Mods** panel whose tabs other mods fill (Advisor, Router, Mission Control, Channels, …), with a Home tab for the global mode, channels, routing and the last notifications.

Every mod keeps working without the hub; with it, they cooperate.

## Install
```
/plugin install mods-hub --marketplace plagemes/claude-mods
```

## Usage
- `/hub` opens the Claude Mods panel on Home: **Mode** (Interaction auto/on/off, Silent, Night with your quiet hours, I'm away / I'm back), **Channels** (each connector mod's status, on/off), **Routing** (where each level goes: terminal, when away, always, off), **Mods** (installed, on the bus, tabs) and **Recent** (notifications and every mod's toasts). Tabs are switched with `0`–`9`.
- `/hub status` prints the mode, channels and tabs.
- `/hub silent [minutes|off]` holds every mod's toasts and sounds in Recent; `/hub night [on|off|22:00-07:00]`; `/hub away` / `/hub back`; `/hub interaction auto|on|off`; `/hub route error always`; `/hub tab <id>`; `/hub test [level]` sends a test notification and says where it went.
- Without any other mod it already publishes `test.result` (from test commands Claude runs), `error.repeated` (the same failing command three times), `cost.update`, `turn.finished`, `context.pressure` and `session.started/idle/away/back/ended`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `idleMinutes` | number | `10` | Minutes without a prompt before you count as idle. |
| `awayMinutes` | number | `30` | Minutes without a prompt before you count as away; "away" routes then reach your channels. |
| `sensors` | boolean | `true` | Publish the built-in events listed above. |
| `captureToasts` | boolean | `true` | Keep every mod's toasts in Recent (and hold them there while Silent). |

Mode and routing are changed from the Home tab or `/hub` and shared by every session (`~/.claude/claude-mods/hub/prefs.json`).

## How it works
- Adds the noun `$.mods` in `engine.create`; each method is an event (`mods.publish`, `mods.notify`, …) that runs through every plugin's hooks, so a mod subscribes by hooking `mods.publish` with a topic matcher. The contract is `types/index.d.ts`; mods that only publish and notify vendor it and keep working with no hub (see docs/MOD_CONTRACT.md).
- Notifications are routed by level × presence × Silent × Night × Interaction; channels (whatsapp, telegram, slack, discord, email, desktop mods) register with `$.mods.registerChannel` and receive `mods.deliver`, with secrets masked first. While Silent it holds other mods' toasts and sounds; at Night, sounds, and what would have gone to your phone waits for one morning digest.
- Presence is shared across sessions through `~/.claude/claude-mods/hub/activity.json`; each session writes a heartbeat with its recent global events to `sessions.json` for mission-control-style mods. Limits: activity is your prompts and the hub's own buttons (other mods' slash commands do not count); the panel's tabs are drawn by their own mods, which must be installed and follow the tab convention.
