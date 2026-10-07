# permission-ping
> Pings you with a sound and toast when Claude is waiting on your approval.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
When Claude opens a permission dialog (a Bash command, a file edit, an MCP tool), permission-ping plays a short two-note chime and shows a toast naming the tool and, for commands and files, what it wants to touch. You can look away from the terminal and still know a decision is waiting. Each dialog pings once, however many internal events announce it.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install permission-ping@claude-mods
```

## Usage
Nothing to run. When approval is needed you hear the chime and see a toast such as `🔔 Approval needed: Bash — npm test`. Requests that another hook or a permission rule already answered stay silent.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `sound` | boolean | `true` | Play the bundled chime (`assets/ping.wav`). |
| `toast` | boolean | `true` | Show the toast. |

## How it works
- Hooks `classic.PermissionRequest` (raised as the dialog opens) and, as a fallback, `classic.Notification` with type `permission_prompt`; events within two seconds of each other count as the same request.
- The chime is played with `$.audio.play`. The engine plays it with `afplay` on macOS only, so on Linux and Windows terminals you get the toast without the sound.
- It never answers or delays the request: the hook only observes, and a failing sound never blocks the dialog.
- With **mods-hub** installed it publishes `approval.requested` (id, the question as shown, the tool) and sends the toast as a hub notification: level `warning`, kind `question`, so it reaches your phone channels only when the hub's Interaction mode lets mods ask you, and is held while Silent. The sound is held by the hub at night and while Silent. The `toast` option still switches the notification off. Without the hub it is the toast and the sound, as before.
