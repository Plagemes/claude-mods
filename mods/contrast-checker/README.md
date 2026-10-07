# contrast-checker
> Checks that the colors Claude changes in CSS meet WCAG AA contrast.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
After Claude edits a stylesheet or a component, contrast-checker finds the text color / background pairs the edit
touched, computes their WCAG contrast ratio and, when one falls short, tells Claude the ratio, the bar it misses
(4.5:1 for text, 3:1 for large text) and the closest color that passes. It follows CSS variables through `:root`
and dark-theme overrides, so changing `--muted` re-checks every rule that uses it, in light and dark mode.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install contrast-checker@claude-mods
```

## Usage
Nothing to run. When a pair fails you see a toast (`⚠ 1 contrast issue in button.css (lowest 2.84:1, WCAG AA)`)
and Claude reads a note right after its edit:

```
contrast-checker: src/button.css has 1 text/background pair below WCAG AA:
- .btn-secondary (line 14): #999999 on #ffffff is 2.84:1, needs 4.5:1 for normal text. Try color #767676 (4.54:1).
- .card__meta (line 31, dark theme): var(--muted) (#475569) on var(--surface) (#0f172a) is 2.35:1, needs 4.5:1 …
```

It reads `.css`, `.scss`, `.less`, `.pcss`, `<style>` blocks in `.html`/`.vue`/`.svelte`/`.astro`, and in
JS/TS components: styled-components/emotion templates, Tailwind classes (`text-gray-400 bg-white`, `dark:`
variants, `/50` opacity, arbitrary `[#hex]`) and inline `style={{ color, backgroundColor }}`.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `level` | `AA` \| `AAA` | `AA` | `AA`: 4.5:1 for text, 3:1 for large text. `AAA`: 7:1 and 4.5:1. |

## How it works
- A `tool.call` hook on Edit, MultiEdit and Write rereads the file after a successful edit and checks only what the
  edit wrote (the new text of an Edit, the whole file of a Write), plus every rule reading a variable it changed.
- Pairs are a `color` and a `background(-color)` in the same rule (or a parent rule, for SCSS nesting). Large text
  is `font-size` ≥ 24px, or bold from 18.66px. Semi-transparent text is blended over its background, and a
  semi-transparent background over white. Fixes move only the lightness (HSL) to the nearest passing value.
- Limits: it cannot see the rendered page, so a color without a background in the same rule, gradients and
  images are skipped; `:disabled` rules are exempt, as WCAG allows. Tailwind uses the default v3 palette.
