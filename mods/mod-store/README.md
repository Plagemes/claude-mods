# mod-store
> An in-terminal app store: browse, search, install and update every Claude Mod from GitHub.

**Category:** Core · **Version:** 1.3.0

## What it does
`/mods` opens a store pane listing every mod of the collection, grouped by category, with what you already have installed, what has an update and what is new in the latest release. Search as you type, narrow by category and by status (*All*, *Installed*, *Updates*, *New in v2*), install or update a mod straight from its row, or open it to read its README, settings and commands. Installs run in the background with a progress bar you can stop, so you can keep browsing while 200 mods install. The catalog is cached, so the store still opens offline, and a session start tells you once when a new update is out.

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
| `/mods install <mod>` · `update <mod>` · `uninstall <mod>` | Do it without browsing. |
| `/mods stop` | Stop the running install or update after the mod it is on. |

Every change runs in the background, one at a time: the command answers at once (`◆ Installing 79 mods in the background. Progress is in the store; s stops it.`), the store opens on its progress bar, and the outcome arrives as the store's message and a toast. Asking for a second one while one runs says so instead of starting it. A mod that fails to install does not stop the rest; the summary names it and offers **Retry**.

### What you see

**The list.** The header reads `▪▪▪ Claude Mods` (the last tile lit) with `219 available · 12 installed · 3 updates`, and below it the source and how fresh it is (`plagemes/claude-mods@main · synced 2 min ago`, or `● Offline · catalog cached 3 h ago` with **Retry**). One row of pickers follows: **Search**, **Category** (counts follow the status picked) and **Show** (*All*, *Installed*, *Updates*, *New in v2*). On the home view a `▪ NEW IN V2 · PICKS` shelf features mods-hub, mod-advisor, smart-router, project-brain and autopilot, and with [mods-hub](../mods-hub) and [mod-advisor](../mod-advisor) installed a `▪ RECOMMENDED FOR THIS PROJECT` shelf shows what the advisor suggested. The list groups mods under their category (an icon, the title, the count and the tagline); each row has the mod's name, a status badge (`✓ Installed`, `↑ Update 1.2.0`, `● New`, or the version), the description cut to one line, and its one action, **Install** or **Update**. An action bar closes the page: `‹ Prev  Page 1/10  Next ›  Install all (N)  Update all (N)  Refresh  Close`.

**A mod's page.** A breadcrumb (`← Mods › Security & Guardrails › secret-shield`) leads back to the list or to the category. The hero line has the category icon, the name, the version, a status pill (`✓ Installed · user`, `↑ 1.0.0 → 1.2.0`, `● New in v2`) and the main action (**Install** or **Update to 1.2.0**). Then the description, the tier and author, the mod's slash commands as chips, **Uninstall**, **Copy install line**, **Copy README link** and a link to the README on GitHub, the mod's settings (key, default, what it does) read from its manifest, the README itself, and *More in <category>*.

**Progress.** While a job runs a single line sits under the pickers: a bar (Ember cells in the terminal, a rounded bar on the desktop), `Installing status-check · 10/79 · 1 failed`, and **Stop**. It never changes height and never moves you: Back, search, pickers, paging and opening mods all keep working while it runs, and the actions that would start a second job are hidden until it ends.

On the desktop the categories are drawn with the collection's icons and badges as rounded pills; in the terminal each category has a one-cell glyph (`◈` security, `⑂` git, `◔` cost, …) and the bar is a row of cells.

### Keys
Keys work while the pane has the keyboard; Tab walks the controls, Esc closes it.

| Where | Keys |
| --- | --- |
| List | `1`–`9` open the mod on that row · `n` / `p` next / previous page · `u` update all · `r` refresh (or retry offline) · `q` close · `a` show every mod when nothing matches |
| Mod page | `b` back · `g` the category · `i` install · `u` update · `x` uninstall · `c` copy the install line · `o` copy the README link · `m` load the README |
| While a job runs | `s` stop it after the current mod |
| After a job | `l` run `/reload-plugins` · `t` retry the mods that failed · `d` dismiss |

**Install all (N)** installs every mod the list shows that you do not have yet, so it follows the search and both pickers; it has no key, so Tab to it.

## Configuration
| Key | Default | Description |
| --- | --- | --- |
| `repository` | `plagemes/claude-mods` | GitHub `owner/repo` whose `.claude-plugin/marketplace.json` the store reads. |
| `branch` | `main` | Branch the catalog and READMEs are read from. |
| `checkForUpdates` | `true` | At session start, compare installed mods with the catalog and toast once per new update. |

## How it works
- Fetches `.claude-plugin/marketplace.json` (and `docs/data/mods.json` for category titles, tiers, each mod's release and commands, falling back to `catalog.json`) raw from GitHub with `$.http.fetch`, caches it in `$.store` with its timestamp, and falls back to that cache when GitHub cannot be reached.
- Installed versions and every change go through the `claude plugin` CLI (`list`, `marketplace add/update`, `install`, `update`, `uninstall`, all with `--json`) via `$.process.run`; there is no `$` API for plugins. The marketplace is added on first install.
- Navigation (search, pickers, page, the open mod) and a job's progress are kept apart, and a job runs on a timer of its own rather than inside the press or the command that started it. So the press or command settles at once, and a job moving its bar never writes over where you are. A desktop click names the drawing it was made on, so a pane that redraws less often loses fewer clicks: the store redraws once per mod during a bulk job and keeps the progress line one row tall.
- Changes take effect after `/reload-plugins`. Installs come from the marketplace's default branch whatever `branch` says, and every step runs the `claude` CLI: the session's own binary when the engine names it, else the one the desktop app installed (under `%APPDATA%\Claude\claude-code` on Windows, `~/Library/Application Support/Claude/claude-code` on macOS), else `claude` from PATH. If none is found, the pane says "install status unknown" and shows why.
- With [mods-hub](../mods-hub) installed the store reads the `mod.recommended` events [mod-advisor](../mod-advisor) published in this session (`$.mods.recent`) for its *Recommended for this project* shelf, and every mod the store installs or updates (one by one, or with install-all / update-all) is also published as `mod.installed` (name and version) on the hub's bus, for mod-advisor and mod-doctor; a failed install, an uninstall and an update that found nothing new publish nothing. The store keeps running `claude plugin list --json` itself rather than reading the hub's cached list: its install, update and uninstall need each mod's scope and whether your organization manages it, which the hub's list does not carry. The store stays its own pane in every case. Without the hub nothing changes.

## What it fetches, runs and sends
mod-store has no telemetry and sends none of your data anywhere. This is everything it reaches outside the session.

**Network** (`$.http.fetch`, `hooks/register.tsx`): only `GET` requests, with no body and no credentials, to
`https://raw.githubusercontent.com/<repository>/<branch>/<file>`. `<repository>` and `<branch>` are the `repository` and `branch` settings (default `plagemes/claude-mods` and `main`). `<file>` is one of:
- `.claude-plugin/marketplace.json`, the list of mods and their versions;
- `docs/data/mods.json` (or, when a repository has none, `catalog.json`), category titles, tiers, releases and commands;
- `mods/<mod>/README.md` and `mods/<mod>/.claude-plugin/plugin.json`, the README and the settings shown on a mod's page, fetched only when you open that page.

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

**mods-hub** (`$.mods`, only when [mods-hub](../mods-hub) is installed): at session start it says hello to the hub with its version, when the store opens or refreshes it reads the session's `mod.recommended` events, and after each successful install or update it publishes `mod.installed` with that mod's name and version. All of it stays on the hub's bus; without the hub nothing is sent.

**Local data**: it reads the list of installed plugins through the CLI and its own `.claude-plugin/plugin.json` (for its version, when the hub is installed), and keeps the catalog cache, the README cache and the last update toast in `$.store` and `$.state`.
