# webhook-notify
> Posts to Slack, Discord, Teams or ntfy when a long task finishes.

**Category:** Notifications & Audio · **Version:** 1.0.0

## What it does
When a turn runs longer than a minute (configurable), it posts a short report to your webhook: project and branch, how long it took, the first 200 characters of Claude's answer, and which tools it used (`Bash ×4 · Edit ×2`). Start a big refactor, walk away, and your phone tells you when it is done or stopped on an error.

## Install
```
/plugin install webhook-notify --marketplace plagemes/claude-mods
```
The install screen asks for the webhook URL (stored in secure storage).

## Usage
- Long turns post automatically; interrupted turns (you pressed Esc) and subagent turns never do.
- `/notify-test` sends a test message and prints what the webhook answered, e.g. `📬 webhook-notify: slack webhook answered 200 OK`.
- If a delivery fails, a toast says why: `📭 webhook-notify: discord webhook answered HTTP 404 ...`.

| Service | URL to use | What arrives |
| --- | --- | --- |
| Slack | Incoming webhook `https://hooks.slack.com/services/...` | One formatted message |
| Discord | Channel webhook `https://discord.com/api/webhooks/...` | A colored embed (mentions disabled) |
| Teams | Workflows "post to a channel when a webhook request is received" URL | An Adaptive Card |
| ntfy | Topic URL `https://ntfy.sh/<topic>` (or your server) | A push notification with title and tag |
| Anything else | Any URL accepting a JSON POST | `{ source, event, title, project, branch, outcome, durationMs, summary, tools }` |

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `webhookUrl` | string (secret) | `""` | Where to post. Nothing is sent until it is set. |
| `kind` | `auto` \| `slack` \| `discord` \| `teams` \| `ntfy` \| `generic` | `auto` | Payload format; `auto` picks it from the URL's host. |
| `minDurationSec` | number | `60` | Only notify for turns at least this long. |

## How it works
- Counts tool calls between `turn.start` and `turn.complete` (subagents' calls included) and, for main-loop turns over the threshold, posts with `$.http.fetch` after the turn has finished, so it never delays you.
- Reads the project name from the repository root and the branch with `git rev-parse` (2 s timeout); outside a repo it uses the folder name and no branch.
- One POST per turn, no retries. The summary is the answer's opening text, not a model-written digest, so nothing extra is sent to a model.
