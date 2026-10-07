# screenshot-check
> After UI edits, takes a Playwright screenshot of the page and shows it to Claude.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
`/screenshot` captures your running app at desktop (1280×800) and mobile (390×844) widths with Playwright, shows
both shots in a **Screenshots** pane and tells Claude where the PNGs are, so it looks at the real page instead of
guessing from the code. It also reports the HTTP status, uncaught errors and console errors the page produced.
Turn on `auto` and it does this by itself a few seconds after Claude edits components, pages or styles.

## Install
```
/plugin install screenshot-check --marketplace plagemes/claude-mods
```

## Usage
```
/screenshot                         → the running dev server (found on its usual port)
/screenshot /checkout               → a path on it
/screenshot http://localhost:8000/admin
```
The pane shows the screenshots as images in terminals that draw them (kitty, Ghostty, WezTerm…), small
previews on the desktop app, and the file paths everywhere. **Both / Desktop / Mobile** switch views,
**Ask Claude to review** (`a`) asks for a layout review and fixes, **Retake** (`r`) shoots again.
Screenshots are saved in `.claude/screenshots/` (git-ignored, the newest 10 captures kept).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `auto` | boolean | `false` | Capture by itself after Claude edits UI files (`.tsx`, `.vue`, `.svelte`, `.html`, `.css`, …) while a dev server runs. |
| `delaySeconds` | number | `5` | How long edits must settle before an automatic capture. |
| `baseUrl` | string | *(auto)* | The app's URL; empty finds the dev server on the ports your `package.json` names, then 5173, 3000, 4321, 8080 … |
| `fullPage` | boolean | `false` | Capture the whole scrollable page instead of the first screen. |
| `keep` | number | `10` | Captures kept in `.claude/screenshots`. |

## How it works
- With Playwright in the project (`node_modules/playwright` or `@playwright/test`) it runs a small script with
  `node -e` that shoots both widths, records console and page errors and draws JPEG previews; otherwise it runs
  `npx --yes playwright screenshot` once per width (no error capture then).
- Claude cannot be handed image bytes by a plugin in this release (prompt attachments carry only their kind), so
  `/screenshot` leaves Claude a note with the file paths and the browser's errors and Claude opens the PNGs with its
  Read tool. Automatic captures leave the same note in the conversation without starting a turn.
- Limits: Playwright's Chromium must be installed (`npx playwright install chromium`); pages behind a login show
  the login page; desktop-app previews depend on the app drawing embedded SVG images.
