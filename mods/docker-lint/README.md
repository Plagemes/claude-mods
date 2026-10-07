# docker-lint
> Flags Dockerfile smells: :latest tags, running as root, apt without cleanup, ADD instead of COPY.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
After Claude edits or writes a Dockerfile (`Dockerfile`, `Dockerfile.dev`, `app.dockerfile`, `Containerfile`), docker-lint reads it and tells Claude about: `FROM` with `:latest` or no tag, no non-root `USER` in the final stage, `apt-get install` without `--no-install-recommends` or without removing `/var/lib/apt/lists`, a lone `apt-get update`, `ADD` of a local path, `curl | sh`, and secret-looking `ENV`/`ARG` names. If [hadolint](https://github.com/hadolint/hadolint) is installed it runs it too.

## Install
```
/plugin install docker-lint --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. You see a toast such as `3 Dockerfile issues in Dockerfile`, and Claude gets the list so it can fix them:

```
docker-lint: 3 issues in /repo/Dockerfile:
  line 1: node:latest uses the :latest tag, which changes under you; pin a version
  line 1: no USER instruction in the final stage, so the container runs as root; create a user and switch to it
  line 6: ADD ./src copies a local path; use COPY (ADD is for URLs and archives it unpacks)
```

Multi-stage builds are understood: a `FROM build` that names an earlier stage is not a tag problem, and only the final stage needs a `USER`. `ADD` of URLs and `.tar`/`.tgz` archives, and `*_FILE`/`*_PATH` variable names, are fine.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `ignore` | string | empty | Comma-separated rule ids to skip: `latest-tag`, `root-user`, `apt-recommends`, `apt-cleanup`, `apt-update-alone`, `add-local`, `curl-pipe`, `secret-name`. hadolint codes such as `DL3008` work too. |
| `useHadolint` | boolean | `true` | Run hadolint when it is on the PATH. Its findings (errors, warnings, info) replace the built-in rules it also checks (latest tag, apt, ADD); the built-ins it lacks (no `USER`, lone `apt-get update`, `curl | sh`, secret names) still apply. |

## How it works
- Hooks `tool.call` for `Edit`, `MultiEdit` and `Write`. After a successful change to a Dockerfile it reads the file, joins continuation lines, and checks each instruction; it never blocks anything.
- hadolint is run once per edit with a 15 second limit (`hadolint --format json`); if it is not installed it is not asked again for the session.
- Limits: it reads the whole file, so existing problems are listed again on every edit of that file. It does not resolve `ARG` values in `FROM`, `.dockerignore`, or Compose files.
