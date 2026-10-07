# i18n-guard
> Flags hard-coded user-facing strings in UI components.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
When Claude edits or writes a `.jsx`, `.tsx`, `.vue` or `.svelte` file, i18n-guard looks at what the change adds: literal text between tags (`<button>Save</button>`) and literal values of attributes such as `title`, `placeholder`, `aria-label` and `alt`. Anything already translated, like `{t('save')}` or `:title="$t('x')"`, is an expression and passes. In warn mode Claude is told what to move into the translation files; in block mode the edit is refused until it does.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install i18n-guard@claude-mods
```

## Usage
- Warn (default): the edit goes through, you see `2 hard-coded strings in Button.tsx`, and Claude gets a note such as `Button.tsx now has hard-coded user-facing strings: title="Save the form", "Save changes". …` so it fixes them next.
- Block: the edit is denied with the same list and the instruction to use the project's i18n function (`t('key')`) and add the keys.

Only strings the edit introduces are reported, never the ones already in the file. Test, story and fixture files are skipped.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `warn` or `block` | `warn` | Warn tells Claude and shows a toast; block refuses the edit. |
| `attributes` | string | `title,placeholder,aria-label,alt` | Comma-separated attribute names whose literal values count as user-facing. |

## How it works
- Hooks `tool.call` for Edit and Write. For an Edit it compares the strings found in `old_string` and `new_string`; for a Write it compares the new content with the file's current text (`$.fs.read`).
- A small scanner (`hooks/scan.ts`) reads JSX/markup directly: elements, attributes, `{...}` expressions, comments, Vue `<template>` and Svelte markup (their `<script>` and `<style>` are ignored). It is a heuristic, not a full parser.
- Limits: a text-only Edit with no surrounding tags cannot be recognised as markup, and strings assigned to variables are not tracked. If the scan itself fails, the edit goes through.
