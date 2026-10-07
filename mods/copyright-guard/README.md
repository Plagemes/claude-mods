# copyright-guard
> Flags pasted code that carries someone else's license or copyright header.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
After Claude edits or writes a file, copyright-guard looks at the lines that were just added for `Copyright (c)`, `SPDX-License-Identifier`, `Licensed under`, `GNU General Public License` and `All rights reserved`. If the holder or the license is not the project's own (taken from `LICENSE` and `package.json`), it shows a toast and tells Claude to check where the code came from before keeping it.

## Install
```
/plugin install copyright-guard --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. When Claude pastes in a header that does not match, you get a toast such as `other license in parser.ts: // Copyright (c) 2015-present, Facebook, Inc.` and Claude is told:

```
copyright-guard: /repo/src/parser.ts now holds a license or copyright notice that does not match this project (MIT, © Plagemes):
- // Copyright (c) 2015-present, Facebook, Inc.
If this text was copied from another project, check that its license lets you use it here, keep its notice, and tell the user where it came from.
If you wrote the notice yourself, remove it or make it match the project's.
```

The project's own holder and license never trigger it, nor do lines that were already in the file, or files that exist to carry notices (`LICENSE`, `COPYING`, `NOTICE`, `node_modules/`, `vendor/`, `third_party/`). A copyright line the app itself shows (`<p>© 2024 Acme</p>`, `© {year} Acme`, a `'© Acme'` string) is a footer, not a pasted header, and is left alone.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allow` | string | empty | Comma-separated holders or licenses that are fine here, on top of what `LICENSE` and `package.json` say, e.g. `Acme Corp, Apache-2.0`. |

## How it works
- Hooks `tool.call` for `Edit`, `Write` and `NotebookEdit`. A `Write` reads the old file first, so only lines that are new count; the edit itself is never blocked or changed, and the note goes to Claude as `context` once the edit succeeded.
- The project's identity is read from `LICENSE`/`COPYING` (license family and `Copyright` lines) and `package.json` (`license`, `author`, `contributors`, `@scope`) at the project root, and cached for a minute. Holders are compared by the words in their names (`Plagemes contributors` matches `Plagemes`), licenses by family (`GPL-3.0-or-later` is `GPL`).
- Limits: it only knows what the added text says, so code pasted without a header is not caught. With no `LICENSE` or `package.json` there is nothing to compare with, so every notice is raised, and the message says no license was found.
