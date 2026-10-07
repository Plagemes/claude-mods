# css-token-guard
> Flags hard-coded hex colors and pixel values where your design tokens should be used.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
In a project that has design tokens, css-token-guard watches what Claude adds to `.css`, `.scss`, `.jsx`, `.tsx`, `.vue`, `.svelte` and `.html` files. A new `#3366ff`, `rgb(...)` or `hsl(...)` literal is matched against the tokens' own colors and Claude is told which token to use instead, with how close it is (`the same color`, `very close`, `no token is close`). With `checkSpacing` on, a `16px` in a padding, margin, gap or radius gets the size token that has exactly that value. Projects without tokens never hear from it.

## Install
```
/plugin install css-token-guard --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. A toast says `2 hard-coded values in Button.tsx, tokens exist`, and Claude reads:

```
css-token-guard: this edit to /app/src/Button.tsx hard-codes values that the project's design tokens cover:
- #3366FF (line 1) -> var(--color-primary) (the same color)
- rgb(17, 24, 39) (line 1) -> var(--color-text) (the same color)
Use the tokens instead of literals. If a literal is intended, put "token-ok" in a comment on that line.
```
Tokens are found in files such as `tokens.css`, `variables.scss`, `theme.ts`, `colors.ts`, `globals.css` (Tailwind v4 `@theme`), `tailwind.config.*` and any CSS/TS/JSON file in a `tokens/` or `theme/` folder under the project root, `src`, `src/styles`, `app` and a few similar places. Custom properties, Sass/Less variables, Tailwind `theme.extend.colors` and `theme.ts` objects (including Style Dictionary and W3C `$value` files) are read.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `allow` | string | `#fff,#000` | Comma-separated colors that may stay hard-coded, in any notation. |
| `checkSpacing` | boolean | `false` | Also flag px values in spacing, size and radius properties when a size token has exactly that value (`0.5rem` counts as 8px). |
| `tokenFiles` | string | empty | Comma-separated extra token files, relative to the project root. |

## How it works
- Hooks `tool.call` for `Edit` and `Write` on style and markup files (not tests or stories, not the token files themselves). Only the literals the edit adds are looked at: an `Edit` compares the old and new text, a `Write` compares with the file on disk. After the edit succeeds Claude gets the note and you get the toast; it never blocks.
- Tokens are looked up with `$.fs.list` and `$.fs.read` and cached for a minute. At least two color tokens are needed for the check to run. The closest token is chosen by CIE76 color distance (ΔE), so `#3468fd` finds `#3366ff`. Alpha is ignored.
- Skipped on purpose: custom property declarations, Sass/Less variable declarations, comments, `url()`/`href` fragments, `var(--x, #fff)` fallbacks and any line containing `token-ok`. Limits: only the project root and a fixed set of folders are searched (monorepo packages are not), and colors written as names (`red`) or built at run time are not seen.
