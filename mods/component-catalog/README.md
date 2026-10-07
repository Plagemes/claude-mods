# component-catalog
> /components lists your existing UI components so Claude reuses them instead of creating duplicates.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
At session start it scans your component folders and reads every React, Vue, Svelte and Angular component it finds: its name, its props (from destructuring, `interface XProps`, `defineProps`, `export let`, `@Input()`) and a one-line purpose from its JSDoc or the comment above it. Claude gets the list in its system prompt, so it reaches for the `Button` you already have. When Claude writes a new component whose name is a near-miss of an existing one (`UserCards` next to `UserCard`), it is told right away and you get a toast.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install component-catalog@claude-mods
```

## Usage
- `/components` — open the **Components** pane: a filter field (name, prop, path or purpose), and each component with its path, purpose and typed props. **mention** puts `the existing Button component (src/components/Button.tsx)` into your prompt; **Rescan** (`r`) re-reads the folders.
- `/components <words>` — open the pane already filtered.
- `/components rescan` — re-read the folders now and print the count.
- Near-duplicate toast: `UserCards looks like the existing UserCard (src/components/users/UserCard.tsx)`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `componentDirs` | string | `components, src/components, ui, src/ui, app/components, src/app/components, src/lib/components, lib/components` | Comma-separated folders scanned for components. |
| `promptChars` | number | `3000` | Most characters of the list added to Claude's system prompt; `0` turns the section off. |
| `warnSimilar` | boolean | `true` | Tell Claude (and you) when a new component's name is close to an existing one. |

## How it works
- `session.start` walks the folders with `$.fs` (skipping tests, stories, `node_modules` and build output; at most 1,500 files) and parses each file; `tool.call` on `Edit`/`Write` re-parses files in those folders as Claude changes them.
- `prompt.compose` adds a `component-catalog:components` section (session scope). It is refreshed at `turn.start` only, so the prompt cache holds within a turn.
- After a `Write` that creates a component file, names are compared by Levenshtein distance (1 edit for short names, up to 3 for long ones) and a note is added to the tool result. Limits: parsing is pattern-based, not a compiler: props declared in another file show as destructured names only, and files deleted from the shell drop out on the next rescan.
