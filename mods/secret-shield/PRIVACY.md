# secret-shield privacy policy

secret-shield is an open-source Claude Code plugin that runs entirely on your machine.

- **What it reads:** the text that a write-type tool call (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) is about to put on disk, the target path of that call, and this plugin's own `.claude-plugin/plugin.json` (for its version).
- **What it collects or sends:** nothing. It makes no network requests, has no telemetry or analytics, and stores no data outside the current Claude Code session.
- **Other plugins:** if the separate [mods-hub](../mods-hub) plugin is installed, secret-shield publishes local, in-process events to it when it blocks a write (secret kind, tool, pattern names, severity, redacted path). The secret value is never included. Nothing leaves your machine through this call.
- **Third parties:** none.

Questions: open an issue at https://github.com/Plagemes/claude-mods/issues.
