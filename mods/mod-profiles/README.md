# mod-profiles
> Switch between sets of mods — work, personal, demo — with one command.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
Save which of your installed plugins are on as a named profile, then switch back to it with one command. mod-profiles enables and disables plugins through the `claude` CLI so they match the profile, then reloads plugins so the change takes effect right away. It changes nothing but the plugins' enabled state.

## Install
```
/plugin install mod-profiles --marketplace plagemes/claude-mods
```

## Usage
- `/profile-mods save work` records which installed plugins are on now, and which are off.
- `/profile-mods use work`:
  - enables the plugins the profile had on and disables the ones it had off
  - reloads plugins
  - reports what changed, what failed, and plugins the profile wants that are no longer installed
- `/profile-mods list` prints every profile with what using it would change (`matches now`, `+2 −3`).
- `/profile-mods delete demo`
- `/profile-mods` opens the **Mod Profiles** pane:
  - how many plugins are on now
  - a **Save current as** field: type a name and press Enter
  - one row per profile: `●` marks the active one; each row shows its plugin count, when it was saved and what using it would change
  - **Use** on each row, with hotkeys `1`–`9`. **Delete** asks once more before it deletes.
  - click a profile's name to see exactly what it would enable, disable or leave alone

The command is `/profile-mods`, so it cannot be confused with Claude Code's own `/plugin` commands.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `autoReload` | boolean | `true` | Run `/reload-plugins` right after a profile changes which plugins are on. Off: you are told to run it. |

## How it works
- Lists plugins with `claude plugin list --json`. Switching runs `claude plugin enable|disable <id> --scope <scope> --json` for each change, one after another, through `$.process.run`.
- Profiles and the active profile's name are kept in `$.store`, so they work in every project and session. The pane draws from `$.state`.
- Limits:
  - Plugins installed after a profile was saved are left as they are, and the profile lists them under "left as they are".
  - mod-profiles never disables itself.
  - Plugins your organization manages can't be changed and are skipped.
  - It doesn't install or uninstall anything, and it never touches other settings.
