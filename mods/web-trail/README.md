# web-trail
> /sources lists every page Claude fetched or searched this session.

**Category:** Panes & Dashboards · **Version:** 1.0.0

## What it does
Records each page Claude fetches with WebFetch and each query it runs with WebSearch, with a timestamp. `/sources` prints them as a Markdown list, so you can check where an answer came from and open the pages yourself.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install web-trail@claude-mods
```

## Usage
Type `/sources` at any time:
```
2 pages fetched, 1 search this session

- **14:02:11** fetched <https://example.com/docs>
- **14:02:40** searched `react use hook`
- **14:03:05** fetched <https://example.com/broken> (failed)
```
A call that errored is marked `(failed)`; a call that a guard refused never reached the web and is left out.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` for `WebFetch` and `WebSearch`, and keeps the last 500 entries in `$.state`, so the list survives a plugin reload but not a new session.
- Registers `/sources` at session start and answers it from the recorded list.
- Limits: it records what Claude asked for, so a redirect shows as the URL Claude requested, and pages read through other tools (an MCP browser, `curl` in Bash) are not seen.
