# node-version-check
> Warns when your Node version doesn't match .nvmrc, .node-version or package.json engines.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
When a session starts, node-version-check runs `node --version` and compares it with what the project asks for: `.nvmrc`, `.node-version`, `.tool-versions` (asdf) and `engines.node` in `package.json`. On a mismatch you get one toast and a warning in the status line. When Claude later runs `npm`, `pnpm` or `yarn` to install packages, it is told that Node does not match, so it can suggest switching before native modules are built for the wrong version.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install node-version-check@claude-mods
```

## Usage
Nothing to run. On a mismatch you see:

```
toast:   node v18.19.0 is running, but the project wants v20.11.0 (.nvmrc)
status:  ⚠ node v18.19.0, project wants v20.11.0
```

and an install command's result carries a note for Claude: `node v18.19.0 is running, but the project wants ... switch Node (nvm use, fnm use, volta) and install again.` Nothing is blocked, and it is silent when Node matches, when no requirement is declared, or when `node` is not installed.

## Configuration
No configuration needed.

## How it works
- Hooks `session.start` (the check runs in the background right after, `$.clock.after(0)`) and `tool.call` for `Bash` (install commands only). `node --version` is asked once per session and the answer is kept.
- Version files: `.nvmrc` and `.node-version` (`20`, `v20.11`, `20.11.0` match by prefix, like nvm; `lts/iron` and the other LTS names are known; `lts/*`, `node`, `system` name no fixed version and are skipped), `.tool-versions` (`nodejs 20.11.0`), and `engines.node` as an npm semver range (`^`, `~`, `>=`, `>`, `<=`, `<`, `x`-ranges, `a - b`, `||`). They are read in the working directory and the project root.
- Limits: it checks the `node` the Claude Code process finds on its PATH. If your shell switches versions with `nvm` after startup, the Bash tool may see a different Node than this check does.
- With [mods-hub](../mods-hub) installed: the start-up toast goes through `notify` at `warning` level (so it can reach your phone while you are away); the status line and the note on installs are unchanged. It publishes no events. Install commands are read with the shared shell reader (`shared/shell.ts`), which also sees them behind `sudo`, `env` or `bash -c`. Without the hub nothing else changes.
