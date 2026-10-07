# mod-store
> An in-terminal app store: browse, search, install and update every Claude Mod from GitHub.

**Category:** Core · **Version:** 1.2.0

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
- Changes take effect after `/reload-plugins`. Installs come from the marketplace's default branch whatever `branch` says, and every step runs the `claude` CLI: the session's own binary when the engine names it, else the one the desktop app installed (under `%APPDATA%\Claude\claude-code` on Windows, `~/Library/Application Support/Claude/claude-code` on macOS), else `claude` from PATH. If none is found, the pane says "install status unknown" and shows why.
- With [mods-hub](../mods-hub) installed every mod the store installs or updates (one by one, or with install-all / update-all) is also published as `mod.installed` (name and version) on the hub's bus, for mod-advisor and mod-doctor; a failed install, an uninstall and an update that found nothing new publish nothing. The store keeps running `claude plugin list --json` itself rather than reading the hub's cached list: its install, update and uninstall need each mod's scope and whether your organization manages it, which the hub's list does not carry. The store stays its own pane in every case. Without the hub nothing changes.

## What it fetches, runs and sends
mod-store has no telemetry and sends none of your data anywhere. This is everything it reaches outside the session.

**Network** (`$.http.fetch`, `hooks/register.tsx`): only `GET` requests, with no body and no credentials, to
`https://raw.githubusercontent.com/<repository>/<branch>/<file>`. `<repository>` and `<branch>` are the `repository` and `branch` settings (default `plagemes/claude-mods` and `main`). `<file>` is one of:
- `.claude-plugin/marketplace.json`, the list of mods and their versions;
- `catalog.json`, category titles and tiers;
- `mods/<mod>/README.md`, the README shown on a mod's page, fetched only when you open that page.

Each request has a 15 s timeout. The answers are cached in `$.store` on this machine.

**Programs** (`$.process.run`): only the `claude` CLI, always with a fixed argument list and never through a shell. It runs the session's own binary, else the desktop app's, else `claude` from PATH. These are the only commands:

| Command | When |
| --- | --- |
| `claude plugin list --json` | opening the store, `/mods refresh`, after every change, and at session start for the update check (off with `checkForUpdates: false`) |
| `claude plugin marketplace list --json` | before the first install, to see whether the marketplace is already added |
| `claude plugin marketplace add <repository> --json` | on the first install, when the marketplace is missing |
| `claude plugin marketplace update <marketplace> --json` | before updates, before `install-all`, and when an install reports the mod as not found |
| `claude plugin install <mod>@<marketplace> --scope user --json` | when you press Install, or run `/mods install <mod>` or `/mods install-all` |
| `claude plugin update <mod>@<marketplace> --scope <scope> --json` | when you press Update, or run `/mods update <mod>` or `/mods update-all` |
| `claude plugin uninstall <mod>@<marketplace> --scope <scope> --json` | when you press Uninstall, or run `/mods uninstall <mod>` |

`<mod>` is always a name from the fetched catalog that passes a strict name check. `<scope>` is the scope the CLI reported for that mod. Nothing fetched is ever run as a command.

**Slash commands** (`$.command.run`): only `/reload-plugins`, and only when you press **Reload plugins** (`l`) after a change.

**Hooks**:
- `session.start` registers `/mods` and, unless `checkForUpdates` is off, checks for updates.
- `command.run` answers `/mods` only. It does not see or change any other command.
- `ui.render` draws the store's own pane.

mod-store does not hook tool calls, prompts or files.

**mods-hub** (`$.mods`, only when [mods-hub](../mods-hub) is installed): at session start it says hello to the hub with its version, and after each successful install or update it publishes `mod.installed` with that mod's name and version. Both go only to the hub's bus; without the hub nothing is sent.

**Local data**: it reads the list of installed plugins through the CLI and its own `.claude-plugin/plugin.json` (for its version, when the hub is installed), and keeps the catalog cache, the README cache and the last update toast in `$.store` and `$.state`.
