# lockfile-guard
> Prevents hand-editing lockfiles; they must change through the package manager.

**Category:** Security & Guardrails · **Version:** 1.0.0

## What it does
A lockfile edited by hand drifts from its manifest and can pin versions nobody resolved. lockfile-guard refuses
`Edit`, `Write` and `MultiEdit` on `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Cargo.lock`,
`poetry.lock`, `uv.lock`, `Gemfile.lock`, `composer.lock`, `go.sum` and a few more, and tells Claude which command
regenerates the file.

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
- It fails closed: if the check itself throws, the edit is denied.
- Limits: it guards the edit tools only. A `sed -i` or a redirect in `Bash` that rewrites a lockfile is not seen.
