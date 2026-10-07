# license-checker
> Warns when a dependency with a copyleft license (GPL, AGPL) lands in a permissively licensed project.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
After Claude installs a package with `npm`, `pnpm`, `yarn`, `bun`, `pip`, `uv` or `poetry`, license-checker looks up the package's license (npm registry or PyPI). If your project is permissively licensed (MIT, Apache-2.0, BSD, ISC ...) and the new package is GPL, AGPL, LGPL, SSPL or another copyleft license, or declares no license at all, you get a toast and Claude gets a note telling it to bring the issue up with you and to suggest an alternative. It warns; it never blocks the install.

## Install
```
/plugin install license-checker --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. After `npm install gpl-lib` in an MIT project:

```
⚠ gpl-lib is GPL-3.0-only (copyleft), but your project is MIT
```

The project's license is read from `package.json`, then `pyproject.toml`, then a `LICENSE` / `COPYING` file. If none names a permissive license, nothing is looked up. Dual licenses are read the SPDX way: `MIT OR GPL-3.0` is fine (you may pick MIT), `MIT AND GPL-3.0` is not. Answers are cached for a week in `$.store`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `projectLicense` | string | empty | SPDX name of your license (`MIT`, `Apache-2.0` ...). Empty = detect it. |
| `allowedPackages` | string | empty | Comma-separated package names that are never flagged (a LGPL library you reviewed). |
| `checkDev` | boolean | `false` | Also check dev dependencies (`-D`, `--dev`); they are not shipped with your code. |
| `timeoutMs` | number | `4000` | How long to wait for the registry before giving up on a package. |

## How it works
- A `tool.call` hook on `Bash` parses install commands (global installs, paths, URLs and `-r requirements.txt` are skipped), lets the command run, and only if it succeeded asks the registry, in parallel, with a timeout. A slow or failing registry means no warning, never a failed install.
- The note goes into the tool result's `context`, so the model reads it and you do not see it twice; the toast is for you.
- Limits: only the packages named in the command are checked, not their own dependencies, and `npm install` with no names (or a requirements file) is not looked into. The license is what the registry metadata says, and "copyleft" classification is by name: this is a prompt to look closer, not legal advice.
