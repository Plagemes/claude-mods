# no-any
> Flags new any types, @ts-ignore and eslint-disable comments as Claude writes them.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
Watches every `Edit` and `Write` on TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`) and counts the escape hatches the change *adds*: `: any`, `as any`, `<any>` (also inside generics such as `Record<string, any>`), `@ts-ignore`, `@ts-nocheck` and `eslint-disable`. In `warn` mode the edit goes through and Claude is told to replace it with a real type; in `block` mode the edit is refused before it touches the file.

## Install
```
/plugin install no-any --marketplace plagemes/claude-mods
```

## Usage
In `warn` mode you see a toast such as `no-any: as any added to user.ts`, and Claude gets a note to fix it. In `block` mode Claude receives a refusal naming what was found and tries again with a better type. A line that really needs an escape hatch can carry `no-any: allow` plus the reason, and is then left alone.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `warn` or `block` | `warn` | `warn` lets the edit through and asks Claude to fix it; `block` refuses the edit. |

## How it works
- Hooks `tool.call` for `Edit` and `Write` and compares the lines before and after (for `Write`, the file on disk against the new content), so existing `any`s that an edit merely leaves in place are not counted.
- `any` patterns are matched against code only: string contents, `//` comments and block-comment lines are ignored, while the directive comments (`@ts-ignore`, `@ts-nocheck`, `eslint-disable`) are matched as written.
- Limits: it is line-based pattern matching, not a type checker, so exotic spellings (`any` split across lines, `| any`) are missed. A guard that fails open lets the edit through.
