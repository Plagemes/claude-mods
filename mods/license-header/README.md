# license-header
> Adds your license header to every new source file Claude creates.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
When Claude creates a new source file with the Write tool, license-header puts your license header at the top, written in that language's comment syntax (`//`, `#`, `--`, `/* */`, `<!-- -->`). By default that is a single `SPDX-License-Identifier: MIT` line; add a copyright holder and year, or a fully custom header. Existing files, empty files, data and docs formats (JSON, Markdown), vendored folders and files that already carry a notice are left alone.

## Install
```
/plugin install license-header --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. After Claude writes `src/add.ts` you get a `license-header: added to add.ts` toast and the file starts with:

```
// Copyright (c) 2026 Acme Inc.
// SPDX-License-Identifier: Apache-2.0
```

A shebang, `<?php` or `<?xml` first line stays first; the header goes right after it. Claude is told the header was added, so it will not add a second one.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `license` | string | `MIT` | SPDX identifier, written as `SPDX-License-Identifier: <id>`. |
| `holder` | string | empty | Adds `Copyright (c) <year> <holder>`. Empty means the SPDX line alone. |
| `year` | string | empty | Year for the copyright line; empty means the current year. |
| `header` | string | empty | Custom header text that replaces the generated one. Use `\n` for line breaks and `{license}`, `{holder}`, `{year}` as placeholders. |

## How it works
- Hooks `tool.call` for Write. If the target has a supported source extension, does not exist yet (`$.fs.exists`), is not empty and shows no notice in its first 15 lines, the hook calls `next({ ...e, content })` with the header prepended.
- If the existence check fails, the write goes through untouched. A PHP file that does not open with `<?php` (a Blade or HTML template) is left alone, since text outside the tag is output. Only Write is handled: files created with shell redirects, and edits to existing files, are not.
- Supported: JS/TS, Java, Kotlin, Go, Rust, C/C++/C#, Swift, PHP, Python, Ruby, shell, YAML, TOML, Terraform, SQL, Lua, CSS/SCSS, HTML/XML/Vue/Svelte, TeX and a few more.
