# Changelog

All notable changes to Claude Mods are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the collection uses [Semantic Versioning](https://semver.org/).
Each mod also carries its own version in `mods/<name>/.claude-plugin/plugin.json`.

## [Unreleased]

### Fixed

- **The Claude Mods panel no longer goes blank** ("Nothing to show yet — mods-hub has not drawn in this pane" in Claude Code Desktop, an empty panel in the terminal) on any tab a mod fills. Tab owners composed with `{await next(e)}`; beneath every plugin that is the engine's own drawing, which the engine refuses under the hub's sized Boxes, so it threw away the whole panel. The hub and the 28 tab owners now drop it (`hubTabBelow`, new `shared/render-safe.ts`), and a tab whose owner draws nothing shows a friendly empty state.
- Every pane (75 mods) now draws a card with **Retry** when its drawing fails, instead of leaving the engine's blank pane; log-tail draws a note for a tail that has ended.
- New `scripts/check-render.mjs` (in `check-all.sh` and CI) flags render hooks that embed the engine's node, answer nothing, open a pane they do not draw, are unguarded, or wait on slow work.

## [2.0.0] - 2026-10-07

### Added

- 118 new mods, for 219 mods in 21 categories: 100 in 10 new categories (below) and 18 system and platform mods.
- **The platform.** [mods-hub](mods/mods-hub) is the shared core: one event bus with typed standard events (`test.result`, `ci.result`, `cost.update`, `control.stop`, ...), one side panel whose tabs the mods fill (switch with `0`-`9`), one notification router that knows if you are here, away, Silent or in your Night hours, shared facts, and a **STOP** (`/hub`, or from your phone) that halts the automatic mods in one session or all of them. Every mod still works alone; the hub only makes them cooperate. The architecture is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the rules for mod authors in [docs/MOD_CONTRACT.md](docs/MOD_CONTRACT.md).
- **System and platform mods:** [mods-hub](mods/mods-hub), [mod-advisor](mods/mod-advisor) (recommends mods for your project and what you ask, installs in one click), [smart-router](mods/smart-router) (routes subagents by task difficulty), [project-brain](mods/project-brain) (an associative project memory), [autopilot](mods/autopilot) (goal and criteria, plan, delegate, verify, retry), [workflow-studio](mods/workflow-studio) (reusable recipes), [mission-control](mods/mission-control) (one dashboard for every session), [session-sync](mods/session-sync) (file leases and hand-offs), [guardian](mods/guardian) (one security policy and a safety score), [context-optimizer](mods/context-optimizer), [issue-pilot](mods/issue-pilot) (issue to draft PR on GitHub, Jira or Linear), [team-hub](mods/team-hub), [calendar-sync](mods/calendar-sync) and [email-digest](mods/email-digest).
- **Channels:** [whatsapp-bridge](mods/whatsapp-bridge) (one self-hosted OpenWA number), [telegram-bridge](mods/telegram-bridge), [slack-bridge](mods/slack-bridge) and [discord-bridge](mods/discord-bridge) post progress, questions and approvals and take commands and STOP back; only the owner's messages through a bridge are trusted.
- Showcase site: a second shelf on the rack, a *New in v2* filter, badges and a *What's new* section.
- README catalog grouped into collapsible categories.

- **Languages & Frameworks:** [react-doctor](mods/react-doctor), [next-guard](mods/next-guard), [venv-guard](mods/venv-guard), [node-version-check](mods/node-version-check), [django-migrate-watch](mods/django-migrate-watch), [go-mod-tidy](mods/go-mod-tidy), [strict-types](mods/strict-types), [schema-sync](mods/schema-sync), [env-example-sync](mods/env-example-sync), [monorepo-scope](mods/monorepo-scope).
- **DevOps & Cloud:** [docker-lint](mods/docker-lint), [k8s-dry-run](mods/k8s-dry-run), [terraform-plan-pane](mods/terraform-plan-pane), [ci-yaml-check](mods/ci-yaml-check), [port-check](mods/port-check), [dev-server-pane](mods/dev-server-pane), [cloud-cost-warn](mods/cloud-cost-warn), [log-tail](mods/log-tail), [docker-prune-guard](mods/docker-prune-guard), [deploy-checklist](mods/deploy-checklist).
- **Databases & Data:** [sql-safety](mods/sql-safety), [query-explain](mods/query-explain), [seed-guard](mods/seed-guard), [schema-pane](mods/schema-pane), [n-plus-one-hint](mods/n-plus-one-hint), [migration-namer](mods/migration-namer), [query-result-cap](mods/query-result-cap), [backup-before-migrate](mods/backup-before-migrate), [csv-peek](mods/csv-peek), [fixture-factory](mods/fixture-factory).
- **Frontend & Accessibility:** [a11y-guard](mods/a11y-guard), [screenshot-check](mods/screenshot-check), [bundle-size-watch](mods/bundle-size-watch), [css-token-guard](mods/css-token-guard), [lighthouse-run](mods/lighthouse-run), [heavy-asset-warn](mods/heavy-asset-warn), [storybook-nudge](mods/storybook-nudge), [contrast-checker](mods/contrast-checker), [dark-mode-check](mods/dark-mode-check), [component-catalog](mods/component-catalog).
- **APIs & Network:** [http-client](mods/http-client), [openapi-sync](mods/openapi-sync), [url-allowlist](mods/url-allowlist), [offline-mode](mods/offline-mode), [mock-server](mods/mock-server), [rate-limit-guard](mods/rate-limit-guard), [jwt-decode](mods/jwt-decode), [status-check](mods/status-check), [graphql-context](mods/graphql-context), [curl-to-code](mods/curl-to-code).
- **Agents & Orchestration:** [scope-lock](mods/scope-lock), [second-opinion](mods/second-opinion), [parallel-explore](mods/parallel-explore), [subagent-cap](mods/subagent-cap), [task-queue](mods/task-queue), [night-shift](mods/night-shift), [loop-breaker](mods/loop-breaker), [self-check](mods/self-check), [edit-limit](mods/edit-limit), [agent-presets](mods/agent-presets).
- **Learning & Onboarding:** [explain-diff](mods/explain-diff), [quiz-me](mods/quiz-me), [learning-mode](mods/learning-mode), [onboarding-tour](mods/onboarding-tour), [command-coach](mods/command-coach), [shortcut-tips](mods/shortcut-tips), [why-log](mods/why-log), [cheatsheet](mods/cheatsheet), [pair-mode](mods/pair-mode), [skill-tracker](mods/skill-tracker).
- **Privacy & Compliance:** [license-checker](mods/license-checker), [pii-in-logs](mods/pii-in-logs), [data-map](mods/data-map), [tracker-guard](mods/tracker-guard), [no-upload](mods/no-upload), [crypto-guard](mods/crypto-guard), [sbom](mods/sbom), [audit-trail](mods/audit-trail), [vuln-scan](mods/vuln-scan), [copyright-guard](mods/copyright-guard).
- **Performance & Reliability:** [benchmark-compare](mods/benchmark-compare), [slow-test-flag](mods/slow-test-flag), [flaky-detector](mods/flaky-detector), [leak-hint](mods/leak-hint), [outdated-deps](mods/outdated-deps), [profile-run](mods/profile-run), [net-retry](mods/net-retry), [disk-guard](mods/disk-guard), [regression-guard](mods/regression-guard), [watch-mode-guard](mods/watch-mode-guard).
- **Mod Ecosystem:** [mod-maker](mods/mod-maker), [mod-doctor](mods/mod-doctor), [mod-profiles](mods/mod-profiles), [settings-sync](mods/settings-sync), [quiet-mode](mods/quiet-mode), [achievements](mods/achievements), [streaks](mods/streaks), [soundpack](mods/soundpack), [daily-goal](mods/daily-goal), [session-replay](mods/session-replay).

### Changed

- **Hub integration across 165 mods:** every v1 mod and the v2 mods that have something to say publish to, read from or notify through mods-hub when it is installed (a vendored `types/mods-hub.d.ts` and a small hub-client block), and behave exactly as before when it is not. Dashboards moved into the shared panel as tabs (every tab has its own order, and the tab buttons show their digit, `1: Advisor`), notifications go through one router (here, away, Silent, Night, per-level routes) instead of each mod's toast, and test, CI, cost, deploy and lint results travel on the bus.
- **Shared libraries:** one shell lexer, test-runner detection, model prices, secret patterns, a line index and the hub client live in `shared/` and are vendored into the mods that use them with `node scripts/sync-shared.mjs` (`--check` fails when a copy drifts), so a fix lands in every guard at once.
- **Install line:** the same two steps everywhere, `/plugin marketplace add plagemes/claude-mods` then `/plugin install <mod>@claude-mods`.
- Every changed mod moved to a new minor version (148 mods; mods new in v2 start at 1.0.0), and the site and README count 219 mods in 21 categories with the platform in *What's new*.
- A pull channel's `send` must report failure and cap its retries, and the four older pull channels now drain on the cursor (at-least-once): see the contract.

### Fixed

A review of every mod found and fixed about 180 bugs, each with a test. By theme:

- **Guard bypasses:** guards that a quoted, nested, chained or aliased command slipped past (nested shell scripts, `bash -c`, command substitution, env prefixes, relative and `~` paths); a gap between what a guard read and what ran; approvals that could be answered by the wrong party. Remote commands now count as the owner's only from a known bridge (whatsapp, telegram, slack, discord).
- **False positives:** checks that cried wolf on comments, strings, test fixtures, generated files, lockfiles and watch-mode runs, so a guard no longer blocks work it should not and test, type-check and watch detection read real runs.
- **Data safety:** edits and checkpoints that could lose or overwrite work (rollbacks, migrations, backups, files written non-atomically), memory that kept private text it should not, and auto-compaction that could drop what was still needed.
- **Cross-session races:** shared files that two sessions rewrote at once (heartbeats, prefs, inboxes, control, leases, outboxes) now have one writer per file or are merged from disk, a lease handover cannot leave two leaders, and a hot reload no longer steals the visible tab (mod-advisor).
- **Secrets:** tokens, keys and passwords in nested commands, finish commits, logs, notices and phone messages are masked or kept out; bridges refuse spoofed owners.
- **Performance:** slow scans, backtracking regular expressions and per-keystroke work on large repos and long sessions were bounded, cached or moved off the hot path.
- **Bands and panes:** a band no longer hides the ones beneath it, and every pane draws on terminal, desktop and the fallbacks.
- **Lost notices:** a notice that failed to send comes back on the next drain instead of vanishing, and one that can never be sent is dropped with a single notice rather than blocking the queue.
- **Small polish:** every tab in the shared panel has its own order (no more ties between error-feed, issue-pilot and the Telegram tab, or task-queue and team-hub), and the daily-goal question is no longer asked the moment a goal is set after the ask hour.

## [1.0.0] - 2026-10-07

### Added

- First release: 101 mods in 11 categories, including `mod-store`, the in-terminal store opened with `/mods`.
- Marketplace file: `/plugin marketplace add plagemes/claude-mods`, then `/plugin install <mod>@claude-mods`.
- Showcase site on GitHub Pages, README, contribution guide and issue templates.

[2.0.0]: https://github.com/plagemes/claude-mods/releases/tag/v2.0.0
[1.0.0]: https://github.com/plagemes/claude-mods/releases/tag/v1.0.0
