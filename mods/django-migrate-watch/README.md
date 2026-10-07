# django-migrate-watch
> After Django model changes, checks for missing migrations and offers to create them.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
When Claude edits a `models.py` (or a file in a `models/` package) in a Django project, this mod waits for the edits to settle. Then it asks Django whether migrations are missing, with `manage.py makemigrations --check --dry-run`, using your virtualenv's python. If any are missing, a band above the prompt lists the pending changes, with a **Create migrations** button that asks Claude to write and review them.

## Install
```
/plugin install django-migrate-watch --marketplace plagemes/claude-mods
```

## Usage
- After a model edit with no migration:
  ```
  ⚠ Django models changed without migrations  shop (2), accounts (1)
    shop: Add field status to order
    shop: Alter field total on order
    accounts: Create model Profile
  [ Create migrations ]  [ Dismiss ]
  ```
- **Create migrations** (`m`) asks Claude to run `makemigrations` with the project's python. Claude then reviews each new file for data loss, renames that came out as remove plus add, and needed data migrations. **Dismiss** hides the band until the pending changes differ.
- Status line: `⚠ migrations missing: shop (2), accounts (1)`. It clears once a check finds no changes, which happens after `makemigrations` / `migrate` runs or a migration file is written.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `debounceSeconds` | number | `3` | How long model edits must settle before the check runs. |
| `timeoutSeconds` | number | `60` | How long the check may take. |

## How it works
- `tool.call` hooks on `Edit` / `Write` catch changes to `models.py`, `models/*.py` and `migrations/*.py`. A Bash hook catches `manage.py makemigrations|migrate|squashmigrations`. The nearest `manage.py` up to the repository root marks the project. Anything outside a Django project is ignored.
- The python used is the first one that exists: `.venv`, `venv` or `env` beside `manage.py`, then `$VIRTUAL_ENV`, then a virtualenv one folder up, then `python3`.
- The check runs on a `$.clock` debounce, one at a time. It parses the `Migrations for '<app>':` blocks (Django 4's `-` and 5.1+'s `+ ~ -` operation lines). The result lives in session state, which the band reads.
- Limits:
  - When the check itself fails (settings error, database unreachable, Django not installed), the mod stays silent and writes the reason to the debug log.
  - Models defined outside `models.py` / `models/` aren't watched.
