# Changelog

All notable changes to Claude Mods are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the collection uses [Semantic Versioning](https://semver.org/).
Each mod also carries its own version in `mods/<name>/.claude-plugin/plugin.json`.

## [2.0.0] - 2026-10-07

### Added

- 100 new mods in 10 new categories, for 201 mods in 21 categories.
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

### Fixed

<!-- REVIEW-FIXES -->

## [1.0.0] - 2026-10-07

### Added

- First release: 101 mods in 11 categories, including `mod-store`, the in-terminal store opened with `/mods`.
- Marketplace file, so any mod installs with `/plugin install <mod> --marketplace plagemes/claude-mods`.
- Showcase site on GitHub Pages, README, contribution guide and issue templates.

[2.0.0]: https://github.com/plagemes/claude-mods/releases/tag/v2.0.0
[1.0.0]: https://github.com/plagemes/claude-mods/releases/tag/v1.0.0
