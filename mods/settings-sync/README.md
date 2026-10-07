# settings-sync
> Exports and imports your mods' configuration so you can move it between machines.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
`/mods-export` collects the settings you changed for your installed claude-mods plugins (from `pluginConfigs` in `~/.claude/settings.json`) into one JSON file. `/mods-import <path>` merges such a file into another machine's settings.json: it first shows exactly what would change, and only applies it when you repeat the command with `--yes`, after saving a backup of settings.json.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install settings-sync@claude-mods
```

## Usage
```
/mods-export                          writes ~/claude-mods-settings.json
/mods-export ~/Dropbox/mods.json      writes it there instead

/mods-import ~/claude-mods-settings.json
3 changes from /home/ana/claude-mods-settings.json (exported 2026-09-30):
  done-chime.seconds: 30 → 45
  token-budget.budgetTokens: 500000 → 750000
  new-mod.mode: (not set) → "strict"
Nothing has been changed. To apply, run: /mods-import /home/ana/claude-mods-settings.json --yes (your settings.json is backed up first).

/mods-import ~/claude-mods-settings.json --yes
```

`--yes` only counts when you type it yourself: if Claude, a plugin or an automated source runs the command with `--yes`, the summary is shown and nothing is written. Backups are saved next to settings.json as `settings.json.bak-YYYYMMDD-HHMMSS`. After an import, run `/reload-plugins` (or restart Claude Code) so the mods read their new values.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `marketplace` | string | `claude-mods` | Plugins from this marketplace are the ones exported and imported. Change it only for a fork with another marketplace name. |

## How it works
- Reads `settings.json` (in `CLAUDE_CONFIG_DIR` when set, else `~/.claude`) with `$.fs`. A `pluginConfigs` entry counts as a mod when its key is `name@claude-mods`, or a bare `name` that `enabledPlugins` lists from that marketplace. The export stores plain plugin names, so it imports into `name@claude-mods`, or into the bare key if that is the one the other machine already has.
- Options whose name contains `token`, `secret`, `key` or `password` and whose value is text are left out of the export and ignored on import (numbers and switches such as `budgetTokens` or `showTokens` travel). Options the engine keeps in secure storage, like a webhook URL, are not in settings.json at all and are never exported.
- Limits: the whole settings.json is rewritten with 2-space indentation, so custom formatting is lost (the backup keeps it), and a settings.json with comments is refused rather than rewritten. Only `options` are synced, not each mod's enabled state: install the mods on the new machine first, or let the import note which ones are missing.
