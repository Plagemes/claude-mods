# stack-detector
> Detects your stack and gives Claude the right conventions for it.

**Category:** Prompt & System Prompt · **Version:** 1.0.0

## What it does
When a session starts it reads the project's root files (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, `pom.xml`, `Dockerfile`, `*.tf`, …), works out which frameworks and tools the project uses, and adds a short set of conventions for each one to Claude's system prompt: Server Components by default in a Next.js App Router, migrations for every Django model change, `?` instead of `unwrap()` in Rust, never `terraform apply` without your go-ahead, the right package manager and test command, and so on.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install stack-detector@claude-mods
```

## Usage
Nothing to do: detection runs at session start. `/stack` shows what was found and why:
```
6 detected in /work/app
  ✓ Next.js (next)           package.json: next 14.2.3
  ✓ React (react)            package.json: react 18.3.1
  ✓ TypeScript (typescript)  package.json: typescript ^5.4.0
  ✓ Node.js (node)           package.json, pnpm-lock.yaml
  ✓ Docker (docker)          Dockerfile
  ✓ Terraform (terraform)    main.tf
```
`/stack rescan` scans again (after adding a dependency, say).

Recognised: Next.js, React, Vue/Nuxt, Svelte/SvelteKit, NestJS, Express, TypeScript, Node.js (npm, pnpm, yarn, bun), Django, FastAPI, Flask, Python, Go, Rust, Ruby on Rails, Laravel, Spring Boot, Docker, Terraform.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `inject` | boolean | `true` | Add the conventions to the system prompt. Off, `/stack` still reports the detection. |
| `skip` | string | `""` | Comma-separated ids to leave out of the prompt, e.g. `docker, typescript` (`/stack` shows the ids). |

## How it works
- `session.start` lists the project root and reads only the manifests present; `turn.start` scans again if the project root moved (`/cd`, a worktree).
- `prompt.compose` appends one `session`-scoped section (`stack-detector:conventions`, about 2,000 characters for a typical web app) after the engine's own, so the shared prompt cache is untouched; skipped under `--bare`.
- Limits: only the root directory is scanned, so packages inside a monorepo's subfolders are not seen; frameworks are recognised from dependency names, not from code.
