# permission-log
> Keeps a log of every tool call that was denied, and why.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
Records each tool call that did not go ahead: refused by a guard plugin, denied by your permission rules or mode, or turned down by you at a permission prompt. Each entry keeps the tool, what the call was about (the command, file, URL or query) and the reason given. The status line shows how many calls were denied, and `/denied` lists them.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install permission-log@claude-mods
```

## Usage
```
/denied          list the denied calls, newest last
/denied clear    empty the log and the status line
```
Output looks like:
```
2 denied tool calls (newest last)

14:02:11  Bash  rm -rf build
          why: rm-rf-guard: refusing to delete outright.
14:05:40  Bash  curl example.com
          why: Bash(curl:*) is denied by settings (rule Bash(curl:*))
```
The status line shows `⛔ 2 denied` while the log is not empty.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` and waits for `next`: a `{ deny }` answer is logged with its reason. It also logs a result carrying Claude Code's "The user doesn't want to proceed" wording, which is how a "no" at the permission prompt reads.
- Hooks `tool.check`, the engine's own allow/ask/deny verdict, and logs a `deny` with the rule that decided it. A call seen by both hooks is logged once, by its tool-call id.
- Keeps the last 200 entries in `$.state`, so the log survives a plugin reload but not a new session.
- Limits: the prompt-rejection check depends on the engine's wording, so a build that words it differently simply logs fewer of those; it never blocks or changes a call.
- With [mods-hub](../mods-hub) installed, `/denied` also reads the guards' `risk.blocked` reports: each refusal names the guard and severity behind it (`[rm-rf-guard · high]`), and what guards reported without a refused tool call here (a redacted edit, a blocked prompt) is listed under "Also reported by guards". Without the hub nothing changes.
