# venv-guard
> Blocks pip install outside an active virtualenv so system Python stays clean.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
Before Claude runs a Bash command, venv-guard looks for `pip install`, `pip3 install` and `python -m pip install`. If no virtualenv is active, the command is refused and Claude is told how to create or activate one (or to use `uv`). `pip install --user` is refused too, and so is `sudo pip install`.

## Install
```
/plugin install venv-guard --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. A refused command comes back to Claude as:

```
venv-guard: no virtualenv is active, so "pip install requests" would install into the system Python.
This project has .venv/: run source .venv/bin/activate && pip install ... (or .venv/bin/pip install ...), or use uv pip install.
```

An install passes when the command activates or names an environment itself:
`source .venv/bin/activate && pip install x`, `.venv/bin/pip install x`, `conda activate api && pip install x`,
`VIRTUAL_ENV=... pip install x`. `uv`, `poetry`, `pipenv` and `pipx` are not pip and are never blocked, nor are
`--dry-run`, `--target` and `pip list`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allowGlobal` | boolean | `false` | Turn the guard off and let `pip install` run outside a virtualenv. |

## How it works
- A `tool.call` guard on `Bash` splits the command line the way a shell would (quotes respected, so `echo "pip install x"` is ignored) and checks each `pip install` against what runs before it in the same line, then against `VIRTUAL_ENV` and `CONDA_PREFIX` of the session's environment.
- It fails closed: if the check itself throws, a command that mentions pip is refused; other commands are not affected.
- Limits: the Bash tool does not keep an activated shell between calls, so an activation in an earlier call does not count; it reads text only and cannot see what a script or `make` target runs.
