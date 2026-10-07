# issue-pilot
> Picks up a GitHub, Jira or Linear issue, sizes it with smart-router, works it in a dedicated session and opens the PR.

**Category:** Team & Docs · **Version:** 1.0.0

## What it does
`/issues` lists your open issues from GitHub (through `gh`, detected from the git remote), Jira or Linear, each sized the way smart-router rates work (**light / standard / deep**, size **S–XL**) with a time and cost estimate. **Start** creates a branch `<type>/<number>-<slug>`, marks the issue in progress, optionally comments "🤖 working on it", and hands Claude a structured prompt: the issue, its acceptance criteria (from checklists, an "Acceptance criteria" section or Given/When/Then lines), its links and the definition of done. **Finish** (or autopilot reporting the issue done) runs the tests, writes the commit and a PR titled `Fixes #N: …` with Summary, Changes, Testing and Risks, then commits, pushes and opens a **draft** PR, links it to the issue, moves Jira/Linear to review and posts a summary comment.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install issue-pilot@claude-mods
```

## Usage
- **`/issues`** opens the **Issues** tab of the Claude Mods panel (or its own pane without mods-hub) and loads the list.
  - Header: tracker switch (**GitHub / Jira / Linear**, those set up here), **Assigned to me / Everyone** (`m`), **Refresh** (`r`), **Label** and **Milestone** fields (not on mobile), **Clear filters**.
  - Each row: `#12 Login redirect loops after SSO`, then `deep · M` and `~1.5 h · ~$2.83 on opus · bug` and **Start**. Press the title for why it got that tier and its acceptance criteria.
  - The issue in progress: branch and phase, test result, PR title, what happened, and **Finish** (`f`), **Open draft PR** (`o`; "anyway" when tests fail), **Run tests again**, **Copy PR link** (`c`), **Stop** / **Clear**.
- `/issues start 12` · `/issues start SHOP-7` · `/issues finish` · `/issues pr` (open the composed PR) · `/issues stop` · `/issues refresh` · `/issues github|jira|linear`.
- Status line while an issue is worked: `⚑ #12 working`.

**Nothing is pushed and no PR is opened without your click** (Finish or Open draft PR), unless `autoPR` is on. When autopilot reports the issue done, issue-pilot runs the tests and composes the PR, then waits for you; with `autoPR` and green tests it opens the draft PR itself, unless a stop or pause was raised through mods-hub since Start (a STOP from your phone). Failing tests always wait for you.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | auto / github / jira / linear | `auto` | auto: Linear if its key is set, else Jira if configured, else GitHub from the remote. |
| `assignedToMe` | boolean | `true` | Only issues assigned to you. |
| `label` / `milestone` | string | `""` | Default filters (milestone = Jira fix version, Linear project or cycle). |
| `autoPR` | boolean | `false` | Open the draft PR when autopilot reports done and tests pass. |
| `startComment` | boolean | `false` | Comment "🤖 Working on it on branch …" when you start. |
| `finishComment` | boolean | `true` | Comment the PR link and summary when the PR opens. |
| `inProgressLabel` | string | `in progress` | GitHub label added on start (created if missing). |
| `testCommand` | string | `""` | Detected when empty: npm/pnpm/yarn/bun test, pytest, go test, cargo test. |
| `baseBranch` | string | `""` | PR base; the repository default when empty. |
| `jiraBaseUrl` / `jiraEmail` / `jiraApiToken` | string (token secret) | `""` | Jira Cloud site, account email, API token. |
| `jiraJql` | string | `""` | Extra JQL, e.g. `project = SHOP`. |
| `jiraStartStatus` / `jiraReviewStatus` | string | `In Progress` / `In Review` | Transitions taken on start and when the PR opens. |
| `linearApiKey` | string (secret) | `""` | Linear personal API key. |
| `linearReviewState` | string | `In Review` | Linear state when the PR opens. |

## How it works
- **Trackers:** GitHub through the `gh` CLI (`issue list/view/edit/comment`, `label create`, `pr create --draft`); Jira Cloud through REST v3 (`/search/jql`, transitions, comments, remote links) with basic auth; Linear through GraphQL (issues, `issueUpdate`, `commentCreate`, `attachmentLinkURL`). Pull requests always go through `gh`, so the origin remote must be on GitHub. Everything posted (PR, commit, comments) has credentials masked with `shared/secrets`.
- **Sizing:** a compact re-implementation of smart-router's rules (risky subjects and root causes → deep, docs and chores → light, else standard; tier labels like `security`, `epic`, `good first issue`), smart-router's learned rules when it keeps them in `~/.claude/claude-mods/smart-router/rules.json`, size from story points or criteria, length and files named; minutes and dollars are rough figures for the tier's model (haiku / sonnet / opus).
- **Hooks:** `command.run` (`/issues`), `ui.render` (its pane and the hub's `claude-mods` pane), `turn.complete` (looks for autopilot's signal). The work runs in **this** session on the issue's own branch (a plugin cannot open a new session); the issue in progress is remembered per project in `$.store`. The finish commit stages everything except `.env*`, keys and certificates in any folder; git runs with repo hooks off, so commit hooks do not run.
- **mods-hub (optional):** with the hub, the list is a tab (order 210), notifications go through `notify` (channels, silent, night), and issue-pilot publishes `task.started`, `test.result`, `git.commit`, `git.push`, `pr.opened`, `task.finished`; it reads the hub's latest `task.finished` (autopilot: any of its runs that succeeds after Start, or a task id issue-pilot published) and `ci.result` for its branch, polling every 20 s and after each turn. Without the hub it keeps its own pane and toasts.
