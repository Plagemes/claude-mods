# tracker-guard
> Blocks adding analytics and tracking SDKs that haven't been approved.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
Refuses the tool calls that would add a tracking SDK to your project unless you have approved it: installing the package (`npm`, `pnpm`, `yarn`, `bun`, `pip`, `uv`, `poetry`), adding it to `package.json`, `requirements.txt` or `pyproject.toml`, importing it, or adding its `<script>` URL to a page or to code. Claude is told what was blocked and to ask you first, instead of quietly wiring analytics into your app.

## Install
```
/plugin install tracker-guard --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. When a tracker is about to be added, Claude sees:

```
tracker-guard: blocked. This install command adds Mixpanel (analytics), which is not on the approved list.
Do not add analytics or tracking without the user's say-so: ask whether they want it. They can approve it
by adding "mixpanel" to this mod's approved list or by writing TRACKER-OK in their next message.
Otherwise leave it out.
```

Ways to allow one: list it under `approved`, or write `TRACKER-OK` in your next prompt (it counts for that prompt only, and only when you typed it).

What it knows (28 trackers, matched by package, import and script URL):
- **Analytics:** Google Analytics / Tag Manager (`google-analytics`, alias `gtag`), Segment, Mixpanel, Amplitude, PostHog, Heap, HubSpot tracking, Plausible, Fathom, Matomo, RudderStack
- **Advertising:** Google Ads / DoubleClick, Facebook (Meta) Pixel, TikTok Pixel, LinkedIn Insight Tag, X (Twitter) Pixel, Pinterest Tag, Snap Pixel
- **Session replay:** Hotjar, FullStory, Microsoft Clarity, LogRocket, Smartlook, Mouseflow, Crazy Egg
- **Error tracking** (allowed by default): Sentry, Bugsnag, Rollbar

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `approved` | string | empty | Comma-separated trackers that may be added: an id from the list above (`mixpanel`, `google-analytics` ...), an alias (`gtag`, `fbq`) or a package name (`@segment/analytics-next`). |
| `allowWord` | string | `TRACKER-OK` | When your latest prompt contains this word, trackers may be added for that prompt. Empty = only the approved list. |
| `blockErrorTracking` | boolean | `false` | Also block Sentry, Bugsnag and Rollbar. |

## How it works
- A `tool.call` guard on `Bash` parses install commands, options before the subcommand included (`pnpm --filter web add x`; local paths and URLs are skipped); another on `Edit`, `MultiEdit`, `Write` and `NotebookEdit` looks at what an edit adds to a manifest, a page or a source file. Only trackers the edit adds count: a file that already had one is not a new decision (for a `Write`, the file on disk is the "before").
- Docs and data files (`.md`, `.txt`, `.json` other than `package.json`, lockfiles) are never scanned, so a README that links to a vendor's site is fine.
- It fails closed for installs and for edits that mention tracking-like words; an unrelated call is never blocked by a hook failure.
- Limits: it knows 28 vendors, not every tracker; a tracker loaded from a first-party proxy or a URL assembled at run time is not recognised; it checks what a tool call adds, not what is already in the project.
