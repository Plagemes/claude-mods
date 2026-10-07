# outdated-deps
> /outdated shows stale dependencies and how risky each upgrade is.

**Category:** Performance & Reliability · **Version:** 1.0.0

## What it does
`/outdated` asks each package manager in the project what is out of date and lists every package riskiest first: a **MAJOR** jump (breaking by semver, 0.x minors included), then minor, then patch, with deprecated packages flagged. When a major is out, it also shows the newest version you can take without one. One button asks Claude to apply all the patch and minor upgrades and run the tests; each row copies its own upgrade command.

## Install
```
/plugin install outdated-deps --marketplace plagemes/claude-mods
```

## Usage
`/outdated` opens the pane and checks in the background:

```
📦 14 outdated · 8 major · 4 minor · 2 patch · 1 deprecated
npm outdated: 8 outdated
pip list: 6 outdated
react          17.0.2      → 19.3.0       MAJOR npm                     Copy
express        4.17.1      → 5.2.1        MAJOR minor to 4.22.3 · npm   Copy
request ⚠      2.88.0      → 2.88.2       patch npm                     Copy
  deprecated: request has been deprecated, see …
urllib3        1.26.20     → 2.8.0        MAJOR indirect · pip          Copy
[ Upgrade all patch/minor (8) ]  [ Refresh ]  [ Close ]
```

## Configuration
| Key | Default | What it does |
| --- | --- | --- |
| `checkDeprecated` | `true` | Ask the npm registry whether each outdated npm/yarn version is deprecated. |
| `timeoutSeconds` | `120` | How long one package manager may take. |

## How it works
- Runs, from the project root: `npm outdated --json --long`, `pnpm outdated --format json`, `yarn outdated --json` (Yarn 1), `pip list --outdated --format=json` with the project's `.venv` python (or `uv pip list --outdated` when the venv has no pip), `cargo outdated --root-deps-only --format json` when cargo-outdated is installed, and `go list -u -m -json all`; each output goes through a pure parser.
- Jumps are classified from current to latest; the safe target is npm's/yarn's `wanted`, cargo's `compat`, or latest when that is not a major jump. Python packages not named in `pyproject.toml` or `requirements*.txt`, and Go's indirect modules, are shown dimmed and left out of "Upgrade all".
- Limits: Yarn 2+ has no outdated command; pip needs the project's virtualenv; registries are queried over the network, so checks take a few seconds.
