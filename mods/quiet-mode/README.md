# quiet-mode
> /quiet silences toasts and sounds from every mod while you focus.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
`/quiet` switches quiet mode on: while it is on, the toasts, sounds and speech that your other mods raise are swallowed before they reach you, and the status line shows `🔕 quiet`. Give it a length, `/quiet 25`, and it counts down in the status line (`🔕 quiet 24m`) and switches itself off, with one toast of its own to say so.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install quiet-mode@claude-mods
```

## Usage
```
/quiet            switch quiet mode on, or off if it is on
/quiet 25         on for 25 minutes (also 25m, 1h, 90 minutes; at most 24 hours)
/quiet on         on until you switch it off
/quiet off        off again
/quiet status     how long is left
```

With [mods-hub](../mods-hub) installed, `/quiet` is an alias of the hub's **Silent** mode: the same words switch Silent on and off for every session at once, other mods' toasts and sounds wait in the Claude Mods panel's Recent list instead of being dropped, `critical` notifications still get through, and the status line follows Silent however it was set (`/hub silent`, the panel, another session). `/quiet on` asks the hub for a Silent with no end, until `/quiet` (or `/hub silent off`) switches it off.

## Configuration
No configuration needed.

## How it works
- Every `$.ui.toast`, `$.audio.play` and `$.audio.speak` call a plugin makes passes through the other plugins' hooks as an event, with the caller named in `next.origin`. quiet-mode hooks those three and answers them itself, without calling `next`, when the caller is another plugin from the user tier (the mods you installed). Its own toasts, the engine's, bundled plugins' and a managed (administrator) plugin's are never muted.
- The on/off state lives in `$.state` for the session, so it survives a reload of the mod, and a 30-second timer keeps the countdown and ends a timed period. It does not persist across sessions: a new session starts with quiet mode off.
- With mods-hub installed: `/quiet` calls `$.mods.setMode({ silentMinutes })` (or `null` to switch it off) and reads `$.mods.mode()` for `/quiet status` and the status line; its own muting stays off, since the hub already holds every mod's toasts and sounds while Silent. Without the hub it works exactly as described above.
- Limits: it silences what mods raise through those three calls. A mod that shows a desktop notification by running `osascript` or `notify-send` itself, Claude Code's own bell and notifications, and status lines (which are not toasts) are not touched. The test kit cannot make one plugin call another's `$.ui.toast`, so the unit tests cover the muting decision (who is muted and who is not); the interception itself was checked in a headless session, where a toast raised by another mod after `/quiet` never appeared and showed up normally without it.
