/**
 * The collection's category icons and glyphs (docs/DESIGN.md section 6), as mod-store draws them, and which category
 * each mod of the collection belongs to, so a tab shows its owner's icon: an Svg on the desktop and the phone, a
 * one-cell glyph in the terminal. A mod outside the collection (or a newer one) falls back to the Slot.
 * Generated from catalog.json and mods/mod-store/hooks/icons.ts; refresh it when a category or a mod is added.
 */

/** Ember, the one accent (docs/DESIGN.md section 3). */
export const EMBER = '#ee8a4f'
/** The unlit strokes: a warm grey that reads on ink and on paper alike. */
const QUIET = '#8f877b'

/** Each category's inner markup; `LIT` marks its lit element. */
const PATHS: Readonly<Record<string, string>> = {
  core: '<rect x="3.5" y="3.5" width="4.5" height="4.5" rx="1.2"/><rect x="9.75" y="3.5" width="4.5" height="4.5" rx="1.2"/><rect x="16" y="3.5" width="4.5" height="4.5" rx="1.2"/><rect x="3.5" y="9.75" width="4.5" height="4.5" rx="1.2"/><rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1.2"/><rect x="16" y="9.75" width="4.5" height="4.5" rx="1.2"/><rect x="3.5" y="16" width="4.5" height="4.5" rx="1.2"/><rect x="9.75" y="16" width="4.5" height="4.5" rx="1.2"/><rect x="16" y="16" width="4.5" height="4.5" rx="1.2" fill="LIT" stroke="LIT"/>',
  security: '<path d="M12 3.2 19 6v5.2c0 4.4-2.9 8.1-7 9.6-4.1-1.5-7-5.2-7-9.6V6l7-2.8Z"/><path d="m9.2 12.2 2 2 3.8-4" stroke="LIT"/>',
  git: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><path d="M6.5 7.5v9"/><path d="M17.5 9.5c0 4.5-6 3.5-10 7.2"/><circle cx="17.5" cy="7.5" r="2" fill="LIT" stroke="LIT"/>',
  cost: '<path d="M3.8 16.5a8.2 8.2 0 1 1 16.4 0"/><path d="M6.6 16.5h.01M12 8.6v.01M17.4 16.5h.01M8.1 11h.01M15.9 11h.01"/><path d="m12 16.5 3.6-4.4" stroke="LIT"/><circle cx="12" cy="16.5" r="1.4" fill="LIT" stroke="LIT"/>',
  productivity: '<path d="m5 6.5 5.5 5.5L5 17.5"/><path d="m12.5 6.5 5.5 5.5-5.5 5.5" stroke="LIT"/>',
  quality: '<path d="M7.5 4C5.5 4 5.5 5 5.5 7v2c0 1.6-.8 3-2 3 1.2 0 2 1.4 2 3v2c0 2 0 3 2 3"/><path d="M16.5 4c2 0 2 1 2 3v2c0 1.6.8 3 2 3-1.2 0-2 1.4-2 3v2c0 2 0 3-2 3"/><path d="m9.3 12.2 1.9 1.9 3.6-3.9" stroke="LIT"/>',
  observability: '<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M9.5 4.5v15M5.5 8.5h1.8M5.5 11.5h1.8M5.5 14.5h1.8"/><path d="m11.8 14.5 2-3.2 2 2.2 1.6-3 1.4 1.8" stroke="LIT"/>',
  prompting: '<path d="M4 6.2c0-1.2 1-2.2 2.2-2.2h11.6c1.2 0 2.2 1 2.2 2.2v8.6c0 1.2-1 2.2-2.2 2.2H10l-4.5 3.5V17H6.2C5 17 4 16 4 14.8V6.2Z"/><path d="M8 8.6h5.2M8 12h3.2"/><path d="M15.6 7.8v5" stroke="LIT"/>',
  notifications: '<path d="M6.2 16.2v-5a5.8 5.8 0 0 1 9.4-4.6"/><path d="M17.8 11.4v4.8l1.6 2H4.6l1.6-2"/><path d="M10 20.2a2.1 2.1 0 0 0 4 0"/><circle cx="18" cy="6.4" r="2.4" fill="LIT" stroke="LIT"/>',
  memory: '<path d="M6.8 3.5h10.4c1.1 0 2 .9 2 2v13c0 1.1-.9 2-2 2H6.8c-1.1 0-2-.9-2-2v-13c0-1.1.9-2 2-2Z"/><path d="M8.5 11.5h4.5M8.5 14.8h6.5"/><path d="M12.8 3.5v5.2l1.9-1.4 1.9 1.4V3.5" stroke="LIT"/>',
  team: '<circle cx="9" cy="8.2" r="3.2"/><path d="M3.2 19.5c0-3.4 2.6-5.5 5.8-5.5s5.8 2.1 5.8 5.5"/><circle cx="16.8" cy="9" r="2.5" stroke="LIT"/><path d="M16.2 14.2c2.9 0 4.8 1.9 4.8 5" stroke="LIT"/>',
  stacks: '<path d="m3.5 12.3 8.5 4.2 8.5-4.2"/><path d="m3.5 16.3 8.5 4.2 8.5-4.2"/><path d="M12 3.5 20.5 7.8 12 12 3.5 7.8 12 3.5Z" stroke="LIT"/>',
  devops: '<path d="M7.4 18.6h9.8a3.9 3.9 0 0 0 .5-7.8 5.7 5.7 0 0 0-11.1.9 3.5 3.5 0 0 0 .8 6.9Z"/><path d="M12 16.2v-5M9.8 13.3l2.2-2.2 2.2 2.2" stroke="LIT"/>',
  data: '<ellipse cx="12" cy="6.2" rx="7" ry="2.7"/><path d="M5 6.2v11.6c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6.2"/><path d="M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7" stroke="LIT"/>',
  frontend: '<path d="M2.8 12c2.2-4 5.4-6.2 9.2-6.2s7 2.2 9.2 6.2c-2.2 4-5.4 6.2-9.2 6.2S5 16 2.8 12Z"/><circle cx="12" cy="12" r="2.5" fill="LIT" stroke="LIT"/>',
  api: '<path d="M4 8.5h15M15.5 5 19 8.5 15.5 12" stroke="LIT"/><path d="M20 15.5H5M8.5 12 5 15.5 8.5 19"/>',
  agents: '<path d="M12 9.3v3.1M5.6 16.1v-2.1c0-.9.7-1.6 1.6-1.6h9.6c.9 0 1.6.7 1.6 1.6v2.1M12 12.4v3.7"/><circle cx="5.6" cy="18.3" r="2.2"/><circle cx="12" cy="18.3" r="2.2"/><circle cx="18.4" cy="18.3" r="2.2"/><rect x="9.2" y="3.5" width="5.6" height="5.6" rx="1.5" fill="LIT" stroke="LIT"/>',
  learning: '<path d="M12 4.8 21 9.2l-9 4.4-9-4.4 9-4.4Z"/><path d="M6.8 11.7v4.1c0 1.5 2.3 2.9 5.2 2.9s5.2-1.4 5.2-2.9v-4.1"/><path d="M19.4 10v5.2" stroke="LIT"/><circle cx="19.4" cy="17.3" r="1.3" fill="LIT" stroke="LIT"/>',
  compliance: '<path d="M12.4 20.5H7.2c-1 0-1.7-.8-1.7-1.7V5.2c0-1 .8-1.7 1.7-1.7h6.6l4.7 4.7v4"/><path d="M13.8 3.5v3.3c0 .8.6 1.4 1.4 1.4h3.3"/><path d="M8.6 11h5.4M8.6 14.3h3"/><circle cx="16.8" cy="17.4" r="2.6" fill="LIT" stroke="LIT"/>',
  performance: '<circle cx="12" cy="13.2" r="7.3"/><path d="M10 3.3h4M12 3.3v2.6M18 6.8l1.4-1.4"/><path d="m12 13.2 3.4-3.4" stroke="LIT"/><circle cx="12" cy="13.2" r="1.2" fill="LIT" stroke="LIT"/>',
  ecosystem: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><path d="M17 13.8v6.4M13.8 17h6.4" stroke="LIT"/>',}

/** One cell per category for the terminal: told apart by shape, never by colour. */
const GLYPHS: Readonly<Record<string, string>> = {
  core: '▦',
  security: '◈',
  git: '⑂',
  cost: '◔',
  productivity: '»',
  quality: '✓',
  observability: '▤',
  prompting: '❯',
  notifications: '♪',
  memory: '¶',
  team: '⁂',
  stacks: '≡',
  devops: '⇡',
  data: '◫',
  frontend: '◉',
  api: '⇄',
  agents: '⋔',
  learning: '✎',
  compliance: '§',
  performance: '↯',
  ecosystem: '⊞',
}

/** The mods of each category, space-separated. */
const MODS_BY_CATEGORY: Readonly<Record<string, string>> = {
  core: 'mod-advisor mod-store mods-hub',
  security: 'curl-pipe-guard dependency-sentinel env-guard force-push-guard guardian lockfile-guard path-jail prod-guard redactor rm-rf-guard secret-shield',
  git: 'auto-checkpoint branch-namer co-author-stamp commit-composer conflict-helper diff-pane git-status-line gitignore-guard main-branch-warn pr-describer',
  cost: 'big-read-guard cache-hit-meter compact-coach context-gauge context-optimizer cost-meter daily-spend model-advisor output-trimmer token-budget turn-timer',
  productivity: 'calendar-sync copy-last focus-timer idle-nudge prompt-history prompt-snippets quick-commands quote-selection recent-files scratchpad todo-pane',
  quality: 'auto-format debug-catcher file-size-watch lint-on-save no-any no-skip-tests test-first test-watch todo-tracker typecheck-gate',
  observability: 'activity-heatmap bash-history error-feed files-touched mission-control permission-log session-stats subagent-monitor token-sparkline tool-timeline web-trail',
  prompting: 'concise-mode date-context explain-level house-style language-lock persona-switch prompt-enhancer prompt-lint stack-detector ticket-linker',
  notifications: 'break-reminder celebrate ci-watch desktop-notify discord-bridge done-chime error-buzz long-run-alert permission-ping slack-bridge speak-summary telegram-bridge webhook-notify whatsapp-bridge',
  memory: 'bookmark codebase-map decision-log glossary lessons-learned link-vault project-brain recall resume-brief session-journal snippet-vault',
  team: 'changelog-keeper codeowners-hint email-digest handoff i18n-guard issue-drafter issue-pilot license-header migration-guard readme-sync review-agent standup team-hub',
  stacks: 'django-migrate-watch env-example-sync go-mod-tidy monorepo-scope next-guard node-version-check react-doctor schema-sync strict-types venv-guard',
  devops: 'ci-yaml-check cloud-cost-warn deploy-checklist dev-server-pane docker-lint docker-prune-guard k8s-dry-run log-tail port-check terraform-plan-pane',
  data: 'backup-before-migrate csv-peek fixture-factory migration-namer n-plus-one-hint query-explain query-result-cap schema-pane seed-guard sql-safety',
  frontend: 'a11y-guard bundle-size-watch component-catalog contrast-checker css-token-guard dark-mode-check heavy-asset-warn lighthouse-run screenshot-check storybook-nudge',
  api: 'curl-to-code graphql-context http-client jwt-decode mock-server offline-mode openapi-sync rate-limit-guard status-check url-allowlist',
  agents: 'agent-presets autopilot edit-limit loop-breaker night-shift parallel-explore scope-lock second-opinion self-check session-sync smart-router subagent-cap task-queue workflow-studio',
  learning: 'cheatsheet command-coach explain-diff learning-mode onboarding-tour pair-mode quiz-me shortcut-tips skill-tracker why-log',
  compliance: 'audit-trail copyright-guard crypto-guard data-map license-checker no-upload pii-in-logs sbom tracker-guard vuln-scan',
  performance: 'benchmark-compare disk-guard flaky-detector leak-hint net-retry outdated-deps profile-run regression-guard slow-test-flag watch-mode-guard',
  ecosystem: 'achievements daily-goal mod-doctor mod-maker mod-profiles quiet-mode session-replay settings-sync soundpack streaks',
}

const CATEGORY_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(MODS_BY_CATEGORY).flatMap(([category, names]) => names.split(' ').map(name => [name, category] as const)),
)

/** The category a mod belongs to; `core` for one the collection does not know. */
export const categoryOf = (mod: string): string => CATEGORY_OF.get(mod) ?? 'core'

export const glyphOf = (category: string): string => GLYPHS[category] ?? GLYPHS.core ?? '▦'

/** A category's icon as an SVG document, `size` CSS pixels square. */
export function iconSvg(category: string, size = 16): string {
  const body = (PATHS[category] ?? PATHS.core ?? '').replaceAll('LIT', EMBER)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${QUIET}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

/** The mark: the Slot, a 3x3 grid with only the bottom-right tile lit. */
export const markSvg = (size = 18): string => iconSvg('core', size)

/** A status dot as an SVG document: filled in `color` (a hex), or a hairline ring when `isHollow`. */
export function dotSvg(color: string, isHollow: boolean, size = 8): string {
  const r = size / 2 - 1
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" ${isHollow ? `fill="none" stroke="${color}" stroke-width="1.2"` : `fill="${color}"`}/></svg>`
}
