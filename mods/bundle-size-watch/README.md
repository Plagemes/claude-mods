# bundle-size-watch
> Compares bundle size after each build and warns when it grows.

**Category:** Frontend & Accessibility · **Version:** 1.0.0

## What it does
After Claude runs a build (`npm run build`, `pnpm build`, `vite build`, `next build`, `webpack`, ...), bundle-size-watch measures the output folder, compares it with the previous build of the same project, and pins the result in the status line: `📦 431 KB (+18 KB)`. When the bundle grew by more than 5% it also raises a toast that names the files that changed most and estimates the gzipped download.

## Install
```
/plugin install bundle-size-watch --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. You will see `📦 412 KB` after the first build and `📦 430 KB (+18 KB)` after the next. A toast like this appears on bigger growth:

`bundle grew +40 KB (+9.7%) to 453 KB (≈ 136 KB gzipped, largest files). Biggest changes: assets/index-[hash].js +40 KB`

Source maps (`*.map`) are not counted, since users never download them. Hash suffixes in file names (`index-DgWgUv9n.js`) are ignored when comparing builds.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `growthPercent` | number | `5` | A toast appears when a build is bigger than the previous one by more than this many percent (and by at least 1 KB). |
| `outputDirs` | string | `dist,build,.next/static,out,.output/public` | Comma-separated build output folders; the one the build just wrote to is measured. |
| `gzip` | boolean | `true` | Gzip the ten largest JS/CSS/HTML/SVG/JSON files to estimate the download size. |

## How it works
- Hooks `tool.call` for `Bash`, recognises build commands (not watchers, dev servers or commands that only mention a build in a quoted string), and after a successful build measures in the background (`$.clock.after`), so the build result is never held up.
- It lists the output folders with `$.fs.list` and measures the one whose newest file is newer than the build's start, so a stale `dist/` next to a fresh `build/` is ignored. The last snapshot (total plus the 30 largest files) is kept in `$.store` per project and folder. Gzip sizes come from `gzip -c | wc -c`.
- Limits: it measures from the session's working directory (or a leading `cd dir &&`); builds started with `--filter`, `-w` or `--prefix` in a monorepo are measured only if the output lands in a configured folder under that directory. Folders with more than 4000 files are measured partially.
