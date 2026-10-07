# docker-prune-guard
> Blocks docker system prune -a --volumes and volume deletion that can wipe local databases.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
Before Claude runs a Bash command, docker-prune-guard checks it for Docker and Podman commands that delete volumes or every unused image: `system prune` with `--volumes` or `-a`, `volume prune`, `volume rm`, `compose down -v` (also `docker-compose` and `podman-compose`), and `rm -v`. The command is refused with what would be lost and a safer alternative. The user can approve it by typing `PRUNE-OK`.

## Install
```
/plugin install docker-prune-guard --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. A refused command comes back to Claude as:

```
docker-prune-guard: "docker compose down -v" would delete the volumes of this compose project
(anonymous ones, and the named ones for down), which usually hold the local database. Safer: docker
compose down (keeps the volumes) or docker compose stop. Blocked until the user's latest message
contains PRUNE-OK. Ask them to confirm and add it.
```

To allow it, put `PRUNE-OK` in your next message. It applies to that message only; the following message closes the gate again. `PRUNE-OK` that arrives from a notification or another plugin does not count. Plain `docker system prune`, `image prune`, `builder prune`, `compose down` and `volume ls` are never blocked.

## Configuration
No configuration needed.

## How it works
- A `tool.call` guard on `Bash` splits the command line like a shell (quotes respected, so `echo "docker volume prune"` is ignored, while the script of `bash -c "…"` is read too), looks past wrappers such as `sudo -u root`, `xargs -r`, `timeout 60` and `env`, reads the engine, subcommand and flags (`-af` counts as `-a -f`), and matches them against the delete rules. A `prompt.submit` hook remembers the latest message that came from the person.
- It fails closed: if the check itself throws, a command that mentions docker or podman together with prune, volume, down or rm is refused.
- Limits: it reads text only, so a script or `make` target that runs these commands is not seen, and it does not list the volumes that exist.
