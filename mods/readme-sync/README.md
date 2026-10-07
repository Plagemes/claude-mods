# readme-sync
> Warns when public APIs, CLI flags or env vars change but the docs do not.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
While Claude works, every `Edit` and `Write` to a code file is compared before and after for documented surface: exported symbols (JS/TS `export`, public Python `def`/`class`, Go capitalised names, Rust `pub`), CLI flags in option definitions, and environment variables read through `process.env`, `os.environ`, `os.Getenv`, `env::var` and friends. When a turn ends with such changes and no README or docs file was touched, a band above the prompt lists them with one button that asks Claude to bring the docs up to date.

## Install
```
/plugin install readme-sync --marketplace plagemes/claude-mods
```

## Usage
After a turn that drifted, the band shows for example:

```
⚠ readme-sync  docs untouched after 1 export, 1 CLI flag, 1 env var changed
  − env var LEGACY_TOKEN (src/config.ts)
  + export parseConfig (src/config.ts)
  + CLI flag --strict (src/cli.ts)
[ Ask Claude to update docs ]  [ Dismiss ]
```

**Ask Claude to update docs** (`u`) sends Claude the list as your prompt; **Dismiss** (`d`) clears it. Editing any doc also clears it. Findings from several turns add up until then.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `apiPaths` | string | `src/,lib/` | Path prefixes whose exports count as public API. Leave empty to watch only CLI flags and env vars. |

## How it works
- `tool.call` on `Edit`/`Write` reads the file through `$.fs` before and after the tool runs and diffs its surface; edits to `*.md`, `*.rst`, `*.txt` or anything under `docs/` count as doc updates. Test files are ignored.
- `turn.start` / `turn.complete` scope the check to a turn; the `AbovePrompt` band draws from `$.state` and its button calls `$.prompt.submit`.
- Detection is regex-based, so it can miss exotic declarations (multi-line export lists, flags defined from variables) and stays silent in projects with no README or docs folder.
