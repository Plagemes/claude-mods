# lockfile-guard
> Prevents hand-editing lockfiles; they must change through the package manager.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
A lockfile edited by hand drifts from its manifest and can pin versions nobody resolved. lockfile-guard refuses
`Edit`, `Write` and `MultiEdit` on `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Cargo.lock`,
`poetry.lock`, `uv.lock`, `Gemfile.lock`, `composer.lock`, `go.sum` and a few more, as well as `Bash` commands that
rewrite one by hand (a redirection onto it, `tee`, `sed -i`, `perl -i`), and tells Claude which command regenerates
the file.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install lockfile-guard@claude-mods
```

## Usage
Nothing to run. A blocked edit returns, for example:

```
lockfile-guard: package-lock.json is generated, so it is not edited by hand. Change the manifest, then regenerate it with: npm install (or npm install <package>).
```

## Configuration
No configuration needed.

## How it works
- A `tool.call` guard on `Edit`, `Write` and `MultiEdit` (where a build has that tool) matches the file's name, in any directory; `Cargo.toml` or `docs/yarn.lock.md` are not lockfiles and pass.
- A second guard on `Bash` reads the command with the shared claude-mods shell reader (also inside `bash -c`, `eval`, `$(…)` and heredocs fed to a shell) and refuses redirections onto a lockfile, `tee` into one and in-place `sed`/`perl` edits. Package managers that rewrite it (`npm install`), reads, copies and `rm` pass.
- Both fail closed: if the check itself throws, the edit (or a command that names a lockfile) is denied.
- With [mods-hub](../mods-hub) installed, every deny is also published as `risk.blocked` (rule `hand-edited-lockfile`, severity `low`, the path or the command with secrets masked). Without the hub nothing changes.
- Limits: a script or another language (`python -c`, `node -e`) that rewrites a lockfile is not seen.
