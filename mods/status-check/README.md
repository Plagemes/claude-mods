# status-check
> /service-status checks whether GitHub, npm, PyPI or the Anthropic API are having an outage before you blame your code.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
`/service-status` asks the public status pages of GitHub, npm, PyPI and the Anthropic API (and any you add) in parallel and prints one line per service with an indicator, plus the open incidents of the ones that have a problem. When a Bash command fails with a network-looking error (`ETIMEDOUT`, `503 Service Unavailable`, `Could not resolve host`, a failed `git push` to GitHub, a failed `npm install`), status-check also looks at the service that command involves and, if it reports an incident, tells Claude and you that the failure is probably not the code.

## Install
```
/plugin install status-check --marketplace plagemes/claude-mods
```

## Usage
`/status` is built into Claude Code, so the command is `/service-status`:

```
Service status at 12:00:00 UTC
✖ GitHub         Partial System Outage
    Incident with Git Operations and Actions (critical) https://stspg.io/abc
✓ npm            All Systems Operational
✓ PyPI           All Systems Operational
⚠ Anthropic API  Minor Service Outage
    Elevated errors on platform.claude.com (major) https://stspg.io/xyz
```
`/service-status npm` checks just the services whose name contains the text. A status page that does not answer shows as `? PyPI  could not be checked (no answer within 5 s)` and does not hold up the rest.

After a failed command you may see the toast `npm reports an incident ("Partial System Outage"): the failed command is probably not your code`, and Claude is given `status-check: npm reports "Partial System Outage" right now (https://status.npmjs.org), so the failure above is probably not your code. Open incidents: ... Retry later or work around it rather than changing code.` Nothing is added when the services report no incident.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `extra` | string | empty | Extra Statuspage sites, comma-separated, as `Name=https://status.example.com` (a bare URL is named after its host). They are included in `/service-status`. |
| `timeoutSec` | number | `5` | How long `/service-status` waits for each status page. (After a failed command the wait is 3 seconds.) |
| `autoCheck` | boolean | `true` | Check the status page of the involved service after a network-looking failure. |

## How it works
- `/service-status` fetches `https://<site>/api/v2/status.json` for each service with `$.http.fetch` and a timeout, and `incidents/unresolved.json` only for those reporting a problem. The endpoints are Atlassian Statuspage's public JSON API; GitHub (`githubstatus.com`), npm (`status.npmjs.org`), PyPI (`status.python.org`, the Python infrastructure page) and Anthropic (`status.claude.com`, the page `status.anthropic.com` redirects to) all use it.
- Hooks `tool.call` for `Bash`: only when a command has failed, its output looks like a network failure and mentions or involves one of the four built-in services (GitHub from `gh` or github.com, npm from `npm`/`pnpm`/`yarn`/`bun` or the registry, PyPI from `pip`/`uv`/`poetry` or pypi.org, Anthropic from api.anthropic.com). Each service is asked at most once a minute. It never blocks and fails open.
- Limits: it can only report what the status pages say, which lags real outages; extra services are included in `/service-status` but not matched to failures automatically; the check after a failure can add up to 3 seconds before Claude sees the error.
