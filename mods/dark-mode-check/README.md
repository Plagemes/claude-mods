# dark-mode-check
> Flags colors added without a dark-mode variant in projects that support a dark theme.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
In a project that has a dark theme, dark-mode-check reads what Claude adds to markup and style files and points out colors that only work on a light page: Tailwind classes such as `bg-white`, `text-gray-900` or `border-gray-200` with no `dark:` counterpart in the same class list, and plain near-grey colors in CSS or SCSS rules that no dark block overrides. Claude is told which dark classes to add, or which rule is missing its override. Projects without a dark theme are never bothered.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install dark-mode-check@claude-mods
```

## Usage
Nothing to run. After an edit you see the toast `3 colors without a dark variant in Card.tsx` and Claude reads:

```
dark-mode-check: this project supports dark mode, but this edit to /app/src/Card.tsx adds colors with no dark variant:
- line 2: bg-white, text-gray-900, border-gray-200 -> dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700
- line 40: .card { background: #fff } -> no override in a dark block (...), or use a color variable that the dark theme redefines
Add the dark counterparts, or use colors the dark theme redefines. Put "dark-ok" on a line where a light-only color is intended.
```
`hover:bg-gray-100` asks for `dark:hover:bg-gray-800` (the same state). Accent colors (`bg-blue-600`), `text-white`, `bg-black`, mid greys and CSS variables are left alone, as are lines marked `dark-ok` and `@media (prefers-color-scheme: light)` blocks.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` for `Edit` and `Write` on `.jsx`, `.tsx`, `.vue`, `.svelte`, `.html`, `.astro` (class lists) and `.css`, `.scss`, `.sass`, `.less` and `<style>` blocks (rules). It replays the edit on the file and reports only what the edit adds; it never blocks.
- A project counts as dark-capable when the edited file has a `dark:` class or a dark rule, or when Tailwind's `darkMode`, `@custom-variant dark`, `prefers-color-scheme: dark`, `[data-theme=dark]`, `.dark`, `color-scheme: dark` or `next-themes` shows up in `tailwind.config.*`, `package.json` or the style sheets in the project root, `src`, `app`, `styles` and similar folders (looked up at most once a minute, and only when something was found).
- In CSS a color counts as light-assuming when it is near grey (small chroma) and a background or border that is pale, or text that is dark. A dark override is a rule for the same selector (`.dark .card`, `html[data-theme=dark] .card`, or inside `prefers-color-scheme: dark`) that sets the same kind of property. Limits: class lists built from variables, CSS-in-JS and colors set through theme variables are not analysed, and the project check is heuristic.
- With [mods-hub](https://github.com/plagemes/claude-mods/tree/main/mods/mods-hub) installed it publishes `lint.result` (`tool: dark-mode-check`, the file, and how many findings) after each edit with findings and sends its note through `notify` (level info) instead of a toast. Without the hub nothing changes; the mod stands alone.
