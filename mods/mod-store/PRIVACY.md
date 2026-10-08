# mod-store privacy policy

mod-store is an open-source Claude Code plugin that runs on your machine. It has no server, account, telemetry or analytics.

- **What it downloads:** catalog and mod files (`marketplace.json`, `docs/data/mods.json` or `catalog.json`, and a mod's `README.md` and `plugin.json` when you open its page) from `raw.githubusercontent.com`, by plain `GET` requests. The repository and branch are this plugin's settings (default `plagemes/claude-mods`, `main`).
- **What it sends:** nothing from your machine. Requests contain only the repository, branch and file name in the URL, with no credentials, body or identifiers added by the plugin. GitHub receives the usual request metadata (such as your IP address) under [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
- **What it reads locally:** project files, dependency lists and Claude Code transcripts, only to suggest mods (`/mods profile`) or idle ones (`/mods slim`). This stays in memory and in Claude Code's local plugin store; it is never sent anywhere.
- **What it writes:** only the project's `.claude/settings.local.json` (`enabledPlugins` entries), when you apply a change in the store.
- **Programs:** it runs the `claude` CLI to install, update and remove mods; the CLI's own network traffic is governed by Claude Code's terms.
- **Credentials:** it reads none.
- **Other plugins:** with [mods-hub](../mods-hub) installed it exchanges local, in-process events (for example `mod.installed` with a mod name and version). Nothing leaves your machine through this.

Questions: open an issue at https://github.com/Plagemes/claude-mods/issues.
