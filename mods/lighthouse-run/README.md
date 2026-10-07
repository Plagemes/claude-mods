# lighthouse-run
> /lighthouse runs Lighthouse on a URL and shows performance, a11y, SEO and best-practice scores in a pane.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
`/lighthouse` audits a page with Google Lighthouse in headless Chrome and opens a **Lighthouse** pane: the four
category scores as colored tiles (rings on the desktop app), the core metrics (FCP, LCP, TBT, CLS, SI), and the
five failing audits most worth fixing, biggest win first. Each run is remembered, so the next run of the same page
shows what changed (`+8`, `−4`), and one button hands the top issues to Claude.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install lighthouse-run@claude-mods
```

## Usage
```
/lighthouse                          → your running dev server (vite, next, astro… found on its usual port)
/lighthouse /pricing desktop         → a path on the dev server, desktop preset
/lighthouse https://example.com
```
In the pane:
- **Ask Claude to fix top issues** (`a`) sends Claude the scores and the top audits with the elements or files they
  point at (`<img src="big.png">`, `http://localhost:5173/big.png`).
- **Run desktop / Run mobile** (`m`) audits the other device; **Re-run** (`r`) repeats the run.

A run takes 20–60 s (longer the first time, while `npx` fetches Lighthouse); a toast reports the scores when done.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `formFactor` | `mobile` \| `desktop` | `mobile` | Device Lighthouse emulates when `/lighthouse` names none. |
| `timeoutSeconds` | number | `180` | How long one run may take before it is stopped (600 at most). |

## How it works
- Runs `lighthouse --output=json` through the project's `node_modules/.bin/lighthouse` or `npx --yes lighthouse@12`,
  limited to the four categories and without screenshots, as a background job with a timeout. Chrome comes from
  `CHROME_PATH`, else the newest Chromium Playwright downloaded (`PLAYWRIGHT_BROWSERS_PATH` or its cache folder),
  else Lighthouse's own search; as root (containers) it adds `--no-sandbox`, which Chrome requires there.
- With no URL it probes `localhost` on the ports your `package.json` scripts name, then 5173, 3000, 4321, 8080,
  4200, 8000, 5000 and a few more. The last scores per page and device are kept in the mod's store.
- Limits: it needs Node.js and network access the first time; scores vary a little from run to run, so treat
  small deltas as noise.
