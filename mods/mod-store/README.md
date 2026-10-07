# mod-store
> An in-terminal app store: browse, search, install and update every Claude Mod from GitHub.

**Category:** Core · **Version:** 1.1.0

## What it does
`/mods` opens a store pane listing every mod of the collection, grouped by category, with what you already have installed and what has an update. Search as you type, filter by category (or by *Installed* / *Updates*), open a mod to read its README, then install, update or uninstall it with one key. The catalog is cached, so the store still opens offline, and a session start tells you once when a new update is out.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install mod-store@claude-mods
```

## Usage
| Command | What it does |
| --- | --- |
| `/mods` | Open the store. |
| `/mods search <words>` | Open the store with a search (`/mods <words>` works too). |
| `/mods refresh` | Fetch the catalog again and report counts. |
| `/mods install-all` | Install every mod you do not have yet (`/mods install all` works too). |
| `/mods update-all` | Update every installed mod that has a newer version. |
| `/mods install <mod>` · `update <mod>` · `uninstall <mod>` | Do it without opening the pane. |

In the pane (keys work while it has the keyboard; Tab walks the controls, Esc closes it):

- **List:** `1`–`9` open the mod on that row · `n` / `p` next / previous page · `u` update all · `r` refresh · `q` close. **Install all (N)** installs every mod the list shows that you do not have yet, so it follows the search and the category filter; it has no key, so Tab to it. Badges: `✓ installed`, `↑ 1.2.0` (update available), `v1.0.0` (not installed).
- **Mod page:** `i` install · `u` update · `x` uninstall · `c` copy the install line · `o` copy the README link · `b` back. The README is shown below.
- After a change: `l` runs `/reload-plugins` for you (or type it), `d` dismisses the message.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `repository` | `plagemes/claude-mods` | GitHub `owner/repo` whose `.claude-plugin/marketplace.json` the store reads. |
| `branch` | `main` | Branch the catalog and READMEs are read from. |
| `checkForUpdates` | `true` | At session start, compare installed mods with the catalog and toast once per new update. |

## How it works
- Fetches `.claude-plugin/marketplace.json` (and `catalog.json` for category titles, when present) raw from GitHub with `$.http.fetch`, caches it in `$.store` with its timestamp, and falls back to that cache when GitHub cannot be reached.
- Installed versions and every change go through the `claude plugin` CLI (`list`, `marketplace add/update`, `install`, `update`, `uninstall`, all with `--json`) via `$.process.run`; there is no `$` API for plugins. The marketplace is added on first install.
- Changes take effect after `/reload-plugins`. Installs come from the marketplace's default branch whatever `branch` says, and the install step needs the `claude` CLI on this machine (the session's own binary is used when known).
- With [mods-hub](../mods-hub) installed every mod the store installs or updates (one by one, or with install-all / update-all) is also published as `mod.installed` (name and version) on the hub's bus, for mod-advisor and mod-doctor; a failed install, an uninstall and an update that found nothing new publish nothing. The store keeps running `claude plugin list --json` itself rather than reading the hub's cached list: its install, update and uninstall need each mod's scope and whether your organization manages it, which the hub's list does not carry. The store stays its own pane in every case. Without the hub nothing changes.
