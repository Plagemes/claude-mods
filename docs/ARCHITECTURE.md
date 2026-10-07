# Claude Mods platform architecture

> How 200+ independent mods work together organically: one shared core (`mods-hub`), one contract
> (`docs/MOD_CONTRACT.md`), one set of shared libraries (`shared/`), one integration map (section 10).
> Written against Claude Code 2.1.292. Every engine claim in section 2 was checked by an experiment or a
> live run, and says how.

## 1. Principles

1. **Every mod stands alone.** Installing one mod never requires another. The hub multiplies value; it is never a prerequisite. The only exceptions are mods that are pointless without the hub, which may declare it as a hard dependency (section 4); today that is the push channel bridges (telegram-bridge, slack-bridge, discord-bridge). Every other system mod, mission-control and session-sync included, is soft.
2. **One core noun, flat and typed.** The hub adds `$.mods` to the engine interface. Its methods are engine events (`mods.publish`, `mods.notify`, …) that run through every plugin's hooks, so subscription, observation and veto use the engine's own hook chain rather than a second event system.
3. **The hub stamps, mods never self-describe.** Source (`next.origin.plugin`), time and session are stamped by the hub from the engine's origin record, so an event's provenance can be trusted.
4. **The person is in charge of attention.** Presence, Silent, Night and Interaction are global, shared by every session, and enforced centrally (the hub holds other mods' toasts and sounds), so a mod that knows nothing about them still respects them.
5. **Vendored, not imported.** Code shared by many mods lives once in `shared/` and is copied, with a hash header, into each mod that uses it; CI fails when a copy drifts.

## 2. What the engine allows (feasibility findings)

| Question | Answer | How it was established |
| --- | --- | --- |
| Can a plugin add a noun to `$`? | Yes: an `engine.create` hook returns `{ ...await next(e), mods }`; the contract is the plugin's `types/index.d.ts` declaring `interface EngineInterface { mods: Mods }`. `claude plugin validate` reports "declares on $: $.mods". | experiment (a provider plugin), then `mods/mods-hub` itself |
| What runs when a mod calls `$.mods.publish(x)`? | The event `mods.publish` runs through **every** plugin's hooks (matchers on the argument work: `on('mods.publish', { topic: 'test.result' }, …)`); its bottom is the function the provider returned in `engine.create`, which receives only the argument (no `$`). The provider therefore does its real work in its **own hooks** on its noun's events, where it has `$`. | experiment: a third plugin hooked the noun's event, rewrote the argument and saw the call |
| Does a provider see its own calls? | **No.** A plugin's call on its own noun skips that plugin's hooks on the event (the hub's sensors reached the bottom, not the hub's `mods.publish` hook). The hub records its own events directly, then raises them for subscribers (`publishSelf`). | mods-hub test "built-in sensors" (failed before the fix) |
| Can a mod call `$.mods.*` when the hub is not installed? | Yes, if it guards the call: `$.mods` is then `undefined` and the call throws a `TypeError` the mod catches. The module loads and validates normally. | experiment: a consumer mod with the vendored `hub-client` region, no hub loaded (validate, test, tsc, lint all pass) |
| Can it test for the hub first (`'mods' in $`, `typeof $.mods`)? | **No.** The validator refuses any use of `$` other than `$.noun.method(...)`: the module does not load. Use try/catch. | experiment: "$ itself is used in a BinaryExpression (bound, passed, spread, returned or read)" |
| Can a mod **hook** `mods.*` events without the hub? | **No.** Registering `on('mods.publish', …)` when no loaded plugin provides `$.mods` fails the whole module ("the $ build failed (registered hubx.publish, but no loaded plugin provides $.hubx)"). Subscribing requires the hub. | experiment |
| Is there an optional dependency? | **No.** `plugin.json` `dependencies` entries are a name or `{ name, marketplace }` ("Plugins that must be enabled for this plugin to function"); an extra `optional: true` is accepted and ignored. Installing a dependent installs and force-enables the dependency; a dependent whose dependency is missing does not load at all (`plugin_errors: dependency-unsatisfied`). | Manifest schema in the 2.1.292 binary; live `claude -p --plugin-dir <consumer>` run with `dependencies: ["mods-hub"]` and no hub |
| How does a soft (non-dependent) mod get the hub's types? | It vendors the contract as `types/mods-hub.d.ts` (not named in its manifest's `types`, which stays its own). `tsc` types `$.mods`; `validate` passes cleanly. A dependent gets the same file laid by the engine in `.claude-plugin/types/mods-hub/` and must **not** also vendor it. | experiments |
| Can one plugin read another's `$.state`? | Yes ("any plugin reads any value; its owner alone writes it"), given the owner's `PluginState` declaration (vendored contract). An absent owner reads `{ version: 0 }`. A read inside `ui.render` subscribes the drawing, across plugins. Family members take computed ids (`{ plugin: 'mods-hub', key: 'latest', id: 'test.result' }`). | experiment; mods-hub tests |
| Can another plugin draw inside the hub's pane? | **Yes, with its own buttons.** A plugin hooking `ui.render` for `{ component: 'Pane', requestId: 'claude-mods' }` sees the hub's pane; what it returns (or what the hub gets back from `next(e)`) is drawn, and its `Button`s keep their handlers in the plugin that drew them (`ui.press({ plugin: 'probe', key })` reached the probe). Verified on terminal and desktop in the test kit, with the tab owner beneath the hub; the convention in section 7 is order-independent by construction. | experiment; mods-hub test "the shared panel" |
| Can the hub host another plugin's `Client`? | **No.** A `Client`'s `module` is a string literal path inside the drawing plugin; a path outside the plugin is refused. A tab owner may draw its own `Client` inside its tab body (it draws its own tree). Also absent on `mobile` and `vscode`. | `ClientProps` in claude-code.d.ts |
| Does the engine already tab panes? | Yes: every open pane is a tab of one docked/inline region ("one shown, the rest tabs"), titled by `title`. But each pane is opened separately, an **unasked** open waits undrawn below 144 columns (110 once the person opened that id), and each pane is a full sibling region. | `PaneOpenArgs`, `UiOpenResult` |
| Can a mod silence other mods? | Yes: hooking `ui.toast`, `audio.play`, `audio.speak` and answering without `next` for callers whose `next.origin.tier === 'user'` (the pattern `quiet-mode` proved). The hub does this for Silent and Night. | quiet-mode; mods-hub tests |
| Does a plugin's own `prompt.submit` hook see a prompt that plugin submits (`$.prompt.submit`)? | **No.** A plugin's call skips that plugin's own hooks on the event, as for a provider's noun (row 3): its `prompt.submit` hook never runs for it (so it cannot attach `context` to it), whatever the plugins' order; another plugin's hook sees it with `origin: { kind: 'plugin', name, asUser }` and no context. Text the model must read with the prompt goes into the submitted text itself (whatsapp-bridge's phone note). | live: `claude -p --plugin-dir selfprobe --plugin-dir otherprobe`, both orders; selfprobe submitted from a timer and logged its own hook, otherprobe logged every `prompt.submit` |
| Can a hook submit a prompt from `command.run`? | **No.** `$.prompt.submit` there is refused ("it would wait on the turn this hook is holding"); submit from a timer (`$.clock.after`) instead. | the same live run |
| Per-session vs cross-session | `$.state` is per session (survives hot reload); `$.store` is per plugin, cross-session; files under `~/.claude/claude-mods/<mod>/` (via `$.fs` and `$.env.get('HOME')`) are visible to every session and every mod. `$.fs` has no append or delete: shared files are small read-modify-write JSON, one writer per file where possible. | API types; whatsapp-bridge and smart-router already use `~/.claude/claude-mods/<mod>/` |

## 3. The `mods-hub` noun

`$.mods` is flat because only a noun's direct function members become events (`mods.registerTab`, not `mods.panel.registerTab`). The contract, with every type, is [`mods/mods-hub/types/index.d.ts`](../mods/mods-hub/types/index.d.ts).

| Method | Does | Who calls it |
| --- | --- | --- |
| `publish({ topic, data, scope? })` → `{ id }` | Validates a standard topic's payload (or an `x.<mod>.<name>` topic), runs the event through every subscriber, stamps and records it (`feed`, `latest[topic]`, and for `scope: 'global'` the cross-session feed). Refuses bad payloads with `{ deny }`. | any mod |
| `recent({ topic?, prefix?, since?, limit? })`, `latest({ topic })` | Pull access to this session's events, for mods that cannot subscribe (no dependency) or start late. | any mod |
| `notify({ level, title, body?, audience?, kind?, topic?, url? })` → `{ id, targets, held, reason? }` | Routes a notification (section 6). | any mod (instead of `$.ui.toast` for things that matter) |
| `mode()`, `setMode({ interaction?, isSilent?, silentMinutes?, isNightOn?, quietHours? })`, `setPresence({ presence, reason? })` | The global mode, read and changed. The mode carries `isNightOn` (the Night schedule is on) beside `isNight` (it applies now), and the presence thresholds `idleMinutes` / `awayMinutes`. Silent with no end is `{ isSilent: true }`; with an end `{ silentMinutes: n }` (or both); off is `{ isSilent: false }` or `{ silentMinutes: null }`. | any mod reads; focus-timer, calendar-sync, quiet-mode, channel bridges change |
| `registerTab({ id, title, order?, command? })`, `showTab({ id })` | Adds a tab to the shared panel (owner = caller); opens the panel on it. | dashboard mods |
| `registerChannel({ id, title, audience, delivery, status, detail? })`, `channelStatus(...)`, `drain({ channel, after })` | Connectors: register, report status, and (pull channels, the soft standard) collect their queued notices with a cursor (section 6). | channel mods |
| `deliver({ channel, notice })` → `{ isDelivered }` | Raised **by the hub**; the channel's owner answers it from its hook (`on('mods.deliver', { channel: 'telegram' }, …)`). Only a bound mod can hook it. | the hub → push channels |
| `stop({ action?, scope?, reason, by? })` → the control | Stops (default), pauses or resumes the automatic work: raises `control.stop` / `control.pause` / `control.resume` with the caller as source, sets the `control` state, and with `scope: 'all'` reaches every session within 5 s (`control.json`). A mod cannot publish `control.*` itself. `/hub stop\|pause\|resume [all]` and a Resume button on Home do the same. | whatsapp-bridge (phone STOP / STOP ALL), any mod or the person; consumed by autopilot, task-queue, night-shift, mission-control, workflow-studio |
| `hello({ version, publishes?, consumes? })`, `installed()` | Capability discovery: who is on the bus, plus `claude plugin list --json` (cached 10 min). | any mod; mod-advisor, mod-doctor |
| `share({ name, value })`, `read({ key })` | The blackboard: current facts keyed `<owner>.<name>` (`smart-router.policy`, `stack-detector.stack`), owner stamped by the hub, readable by key or reactively as state. | any mod |

Public state (`$.state`, owner `mods-hub`, readable by every mod and subscribing render hooks): `mode`, `prefs`, `tab`, `tabs`, `channels`, `latest` (family by topic), `facts` (family by key), `feed`, `inbox`, `installed`, `outbox` (pull channels' waiting notices), `control` (the last stop, pause or resume).

**Evolving the contract.** Soft mods vendor `types/mods-hub.d.ts` and may meet a hub of another version, or a test stand-in written for an older contract, so a field added to an existing type after the first release is optional (`ModsMode.isNightOn?`), and a new input field keeps the old meaning when absent (`setMode` without `isSilent`, `drain` without `after`). A new method is added to `Mods` and to `shared/testing/hub.ts` together.

**Events vs facts.** An event is something that happened (`test.result`); a fact is how things stand (`smart-router.policy`). Consumers that only need "the latest test result" read `latest` (or `$.mods.latest`) rather than subscribing.

**Built-in sensors.** So the bus is useful on day one, the hub itself publishes `test.result` (from test commands Claude runs, via `shared/test-runners`), `error.repeated` (the same failing command three times), `cost.update` and `turn.finished` (from `turn.complete` usage, via `shared/prices`), `context.pressure` (crossing 70/85/95 %), and `session.started/idle/away/back/ended`. A mod that runs its own tests (test-watch) publishes its own richer `test.result`; consumers can filter on `source`.

## 4. Two ways to integrate: soft and bound

| | **Soft** (default for all 203 existing mods) | **Bound** (`"dependencies": ["mods-hub"]`) |
| --- | --- | --- |
| Works without the hub | yes, identical to today | no: not loaded until the hub is installed (installing the mod installs and enables the hub) |
| Publish, notify, mode, tabs, facts | yes, through the vendored `hub-client` region (each call try/catch with a fallback) | yes, direct calls |
| Receive events | pull: `$.mods.recent/latest`, or read `latest[topic]` state (reactive in render hooks) | push: `on('mods.publish', { topic }, …)` |
| Receive deliveries (channels) | **pull, the standard for every soft channel**: `registerChannel({ delivery: 'pull' })` + `drain({ channel, after: cursor })` every few seconds (section 6) | push: `on('mods.deliver', { channel }, …)` (hooking it without the hub would make the module fail to load) |
| Types | `types/mods-hub.d.ts` vendored by `sync-shared` | laid by the engine; do not vendor |
| Use for | everything that must keep working alone, including system mods that are richer with the hub but still useful without it: mission-control and session-sync (they read the session files themselves), autopilot, workflow-studio, guardian, team-hub, project-brain, calendar-sync, email-digest, whatsapp-bridge | mods that are pointless without the hub: the push channel bridges telegram-bridge, slack-bridge, discord-bridge |

A subscriber must return `next(e)` promptly and defer work (`$.clock.after(0, …)`); answering `mods.publish` without `next` hides the event from the hub and from every subscriber beneath it, and is reserved for deliberate vetoes (a guardian refusing a `deploy.started`, say).

## 5. Where state lives

| Scope | Mechanism | Holds |
| --- | --- | --- |
| This session, redraw-reactive | `$.state` owned by `mods-hub` | mode, prefs mirror, tabs, channels, `latest`, `facts`, `feed` (50), `inbox` (30), installed |
| This session, hub-private | module memory (lost on hot reload, by design) | dedupe window, held notices, failure counts |
| This session, survives hot reload | `$.state` `outbox` | pull channels' notices until their owner acknowledges them (100 per channel; lost when the session ends) |
| All sessions, the hub | `~/.claude/claude-mods/hub/prefs.json` | the global mode and routing (`ModsPrefs`): changed in one session, picked up by the others within 30 s |
| | `~/.claude/claude-mods/hub/activity.json` | the person's last activity, so a session idle in the background does not think the person is away while they type in another |
| | `~/.claude/claude-mods/hub/control.json` | the last 20 stops, pauses and resumes raised with `scope: 'all'` (one hour); every session polls it every 5 s and raises each new one once |
| | `~/.claude/claude-mods/hub/sessions.json` | one heartbeat per live session (project, presence, turns, cost, its last 20 `scope: 'global'` events); entries older than 10 min are dropped; a session removes itself at `session.end` |
| All sessions, a mod | `~/.claude/claude-mods/<mod>/…` (convention) or `$.store` | mod data other sessions (or mods) read: `smart-router/daily.json`, `whatsapp-bridge/sessions/` |

When the hub is absent nothing above exists: soft mods use their own `$.state`/`$.store` exactly as today.

## 6. Presence, the global mode and notification routing

**Presence** is `here` (activity within `idleMinutes`, 10), `idle`, or `away` (no activity for `awayMinutes`, 30), or set by hand (`/hub away`, a channel's "I'm away", `setPresence`) until the next activity. Activity is a prompt typed by the person (origins `composer`, `bridge`, `sdk`, `slack-ping`, or a plugin prompt `asUser`) or a press in the hub's panel. Changes publish `session.idle`, `session.away`, `session.back`.

**Modes** (global, all sessions): **Interaction** `auto | on | off` (may mods *start* a conversation on a channel: auto = only while away and not at night; `mode.canAsk` is the answer), **Silent** (on with no end, or for N minutes: other mods' toasts and sounds are held in the Home tab's Recent), **Night** (inside quiet hours, default 22:00–07:00: other mods' sounds are held, only `critical` reaches channels, the rest goes out as one digest when the night ends).

**Routing** of `notify()`: each level has a route (Home tab or `/hub route <level> <where>`):

| Level | Default route | Meaning |
| --- | --- | --- |
| `info` | `terminal` | toast only |
| `success` | `away` | toast; also the person's channels while they are not `here` |
| `warning` | `away` | same |
| `error` | `away` | same |
| `critical` | `always` | toast and channels, even at night and when Silent |

Then: Silent removes the toast (not for `critical`); `audience: 'team'` goes to team channels (slack/discord) whatever the presence, `'terminal'` never leaves the terminal; `kind: 'question'` needs `mode.canAsk`; each channel has an on/off switch and a lowest level; at Night non-critical channel deliveries are held for the digest; identical notifications within 30 s are dropped; titles and bodies leaving the machine are masked with `shared/secrets`. The router is a pure function (`mods/mods-hub/hooks/router.ts`, unit-tested).

**Channels** are any mod that registers one: `whatsapp`, `email` (digest), `desktop` (desktop-notify), `webhook` (webhook-notify) pull; `telegram`, `slack`, `discord` push. Push channels answer `mods.deliver`, which only a bound mod can hook (a soft mod hooking it fails to load without the hub). **Pull is the standard for soft channels:**

```ts
// every few seconds, in a top-level function (the cursor lives in the mod's memory or $.store)
const notices = await $.mods.drain({ channel: 'whatsapp', after: cursor.last })   // null the first time
for (const notice of notices) {
  if (!cursor.sent.has(notice.id)) await send(notice)        // at-least-once: dedupe by id
  cursor.sent.add(notice.id)
  cursor.last = notice.id                                    // acknowledged by the NEXT drain
}
```

The hub keeps each pull channel's notices (masked, oldest first) in this session's `outbox` state until a drain acknowledges them: `after` drops everything up to and including that id and returns what still waits, without removing it, so a send that failed, a crash, a hot reload or a second drainer (a timer and a command racing) sees the notice again; an id the hub no longer knows acknowledges nothing. Notice ids carry the session and the hub's load, so they never repeat. Every session has its own hub and outbox, and a channel mod drains the hub of the session it runs in: two sessions never take each other's notices, so two sessions draining at once lose nothing and send nothing twice. Beyond 100 unacknowledged notices the oldest are dropped; what is still waiting when the session ends is lost. `drain({ channel })` without `after` (the first contract) still hands over and forgets in one step (at-most-once). Inbound messages are published as `channel.inbound`; approvals as `approval.requested` / `approval.answered`; a phone's STOP as `$.mods.stop(...)`.

## 7. The panel policy

**Decision: one hub-owned pane, `claude-mods` ("Claude Mods"), with a tab strip the hub draws; each tab's body is drawn by its owning mod, which hooks the same pane.** The engine's own pane tabs stay for workspace panes.

Why not the alternatives:
- *Every mod its own pane* (today): each is opened separately and, unasked, waits undrawn below 144 columns; ten dashboards are ten sibling regions, and there is no home for cross-mod settings.
- *The hub renders other mods' content*: a tree crosses `$` only as data, so the owner's button handlers would be lost; and a `Client` cannot be hosted across plugins. Rejected.
- *A shared tab-strip convention across separate panes*: duplicates the engine's own tab row. Rejected.

How a tab works (verified, section 2): the owner registers it (`registerTab`), then

```tsx
on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
  if (!(await hubTabIs($, 'router'))) return next(e)      // not our tab: pass through
  const { Box } = $.ui.resolve(e)
  return <Box flexDirection="column">{await next(e)}{await drawRouter($, e)}</Box>
})
```

Above the hub, `next(e)` returns the hub's frame (tab strip) and the owner appends its body; beneath it, the hub calls `next(e)` for the body and puts its strip on top. Either way the person sees strip + body, and the owner's buttons, inputs and state reads stay its own. Without the hub, `hubTabIs` reads `undefined` and the hook passes through; the mod keeps its own pane (opened by its own command). `$.mods.showTab` from a command the person typed opens the panel at any width.

**Placement rules** (applied to every mod in section 10):

| Surface | When | Examples |
| --- | --- | --- |
| **Tab** in Claude Mods | a dashboard or control centre for a subsystem the person returns to during the session; reactive, glanceable, not a dialog | Advisor, Router, Mission Control, Brain, Channels, Guardian, Autopilot, Workflows, Cost, Tests, Changes, Timeline, Errors, Tasks, Notes, Team, Issues, Calendar |
| **Own pane** | a workspace: needs the full region, keyboard-heavy, many instances, or a dialog (`focus`, `closeOnEscape`) | mod-store, http-client, log-tail (one per tail), session-replay, terraform-plan-pane, lighthouse-run, schema-pane, quiz-me, deploy-checklist's confirm |
| **Band** (`AbovePrompt`) | one line that matters now and disappears when it does not; must compose with `next(e)` | context-gauge, token-sparkline, daily-goal, token-budget near its limit |
| **Status line** | one tiny persistent value (one per plugin) | cost-meter, git-status-line, test-watch, focus-timer, streaks |
| **`notify(level)`** | anything that used to be a toast and might matter away from the terminal | ci-watch, long-run-alert, typecheck-gate, night-shift |
| **Command output / guard text** | on-demand reports; refusals | bash-history, standup; every guard's deny |

Tab order convention (`order`): 10 Advisor, 20 Router, 30 Mission Control, 40 Autopilot, 50 Workflows, 60 Brain, 70 Guardian, 80 Channels, 90 Cost, 100 Tests, then the rest at 200+. Hotkeys `0`–`9` follow the order and belong to the hub's tab strip: a tab body never binds a digit (use letters).

## 8. Event catalog

Standard topics are validated at publish (`mods/mods-hub/hooks/catalog.ts`, same shapes as `ModsEventMap`). A topic that is not standard is published as `x.<mod>.<name>` with any JSON payload; a custom topic used by two or more mods is promoted to the catalog in the next hub release. Payloads are capped at 16 000 characters of JSON. Publisher/consumer columns come from the integration map (section 10).

| Topic | Payload (`?` optional) | Published by | Consumed by |
| --- | --- | --- | --- |
| `test.result` | runner: string, outcome: 'passed'\|'failed'\|'error', passed: number\|null, failed: number\|null, durationMs: number?, command: string?, failures: string[]? | mods-hub, quick-commands, test-watch | mod-advisor, test-first, session-stats, error-buzz, celebrate, session-journal, deploy-checklist, smart-router +10 |
| `build.result` | tool: string, outcome: 'passed'\|'failed'\|'error', durationMs: number?, command: string?, errors: number? | quick-commands, schema-sync, dev-server-pane, bundle-size-watch | screenshot-check, autopilot |
| `lint.result` | tool: string, errors: number, warnings: number, files: string[]? | quick-commands, lint-on-save, debug-catcher, no-any, file-size-watch, readme-sync, i18n-guard, react-doctor +15 | autopilot |
| `typecheck.result` | tool: string, errors: number, files: string[]? | typecheck-gate | autopilot |
| `cost.update` | turnUsd: number, sessionUsd: number, model: string, tokens: number, isEstimate: boolean | mods-hub, smart-router | cost-meter, token-budget, cache-hit-meter, daily-spend, session-stats, token-sparkline, context-optimizer |
| `budget.threshold` | kind: 'usd'\|'tokens', scope: 'session'\|'day'\|'week'\|'month', used: number, limit: number, percent: number | token-budget, daily-spend | smart-router, whatsapp-bridge, autopilot |
| `context.pressure` | percent: number, tokens: number, window: number | mods-hub, context-optimizer | context-gauge, compact-coach, context-optimizer |
| `ci.result` | provider: string, workflow: string, outcome: 'passed'\|'failed'\|'cancelled', branch: string?, url: string?, durationMs: number? | ci-watch | mod-advisor, issue-drafter, deploy-checklist, achievements, whatsapp-bridge, autopilot, team-hub, email-digest +1 |
| `deploy.started` | target: string, environment: string, version: string?, url: string? | k8s-dry-run, terraform-plan-pane, deploy-checklist | prod-guard, team-hub, email-digest |
| `deploy.finished` | target: string, environment: string, version: string?, url: string?, durationMs: number? | deploy-checklist | team-hub |
| `deploy.failed` | target: string, environment: string, reason: string, url: string? | deploy-checklist | team-hub |
| `git.commit` | sha: string, message: string, branch: string, files: number | commit-composer | git-status-line, diff-pane, pr-describer, session-journal, changelog-keeper, standup, skill-tracker, achievements +1 |
| `git.push` | remote: string, branch: string, isForce: boolean | force-push-guard | git-status-line, ci-watch |
| `pr.opened` | url: string, title: string, branch: string | pr-describer | team-hub |
| `decision.recorded` | title: string, summary: string?, path: string?, status: string? | decision-log | session-journal, recall, handoff, why-log, project-brain, session-sync, team-hub |
| `lesson.learned` | lesson: string, context: string?, path: string? | lessons-learned | recall, project-brain |
| `error.repeated` | signature: string, count: number, tool: string, command: string? | mods-hub, loop-breaker | error-feed, error-buzz, lessons-learned, issue-drafter, status-check, command-coach, issue-pilot, email-digest |
| `tool.failed` | tool: string, summary: string, command: string? | error-feed | — |
| `risk.blocked` | guard: string, tool: string, reason: string, severity: 'low'\|'medium'\|'high', command: string?, path: string? | secret-shield, env-guard, rm-rf-guard, force-push-guard, prod-guard, path-jail, curl-pipe-guard, dependency-sentinel +26 | permission-log, audit-trail, soundpack, guardian |
| `secret.detected` | kind: string, where: 'edit'\|'result'\|'prompt'\|'command', action: 'blocked'\|'redacted'\|'warned', path: string? | secret-shield, redactor, pii-in-logs | guardian |
| `agent.routed` | agentType: string, tier: 'light'\|'standard'\|'deep', model: string, reason: string, agentId: string? | smart-router | model-advisor, subagent-monitor, parallel-explore, subagent-cap, workflow-studio |
| `agent.finished` | agentType: string, outcome: 'ok'\|'failed', durationMs: number, agentId: string?, usd: number? | subagent-monitor, review-agent, second-opinion, parallel-explore, self-check, smart-router | workflow-studio |
| `turn.finished` | durationMs: number, tools: number, isAborted: boolean | mods-hub | auto-checkpoint, diff-pane, turn-timer, compact-coach, todo-tracker, tool-timeline, session-stats, done-chime +5 |
| `session.started` | project: string, cwd: string, branch: string? | mods-hub | activity-heatmap, resume-brief, node-version-check, shortcut-tips, achievements, streaks, whatsapp-bridge, session-sync |
| `session.ended` | durationMs: number, turns: number, usd: number? | mods-hub | activity-heatmap, session-journal, standup, handoff, daily-goal, whatsapp-bridge, project-brain, session-sync +1 |
| `session.idle` | since: number, reason: 'activity'\|'timer'\|'manual'\|'channel' | mods-hub | idle-nudge, break-reminder, task-queue, command-coach, whatsapp-bridge, session-sync |
| `session.away` | since: number, reason: 'activity'\|'timer'\|'manual'\|'channel' | mods-hub | focus-timer, night-shift, whatsapp-bridge, autopilot, session-sync |
| `session.back` | since: number, reason: 'activity'\|'timer'\|'manual'\|'channel', awayMs: number | mods-hub | whatsapp-bridge, session-sync |
| `mod.recommended` | name: string, reason: string, score: number? | mod-advisor, command-coach | — |
| `mod.installed` | name: string, version: string | mod-store, mod-profiles | mod-advisor, mod-doctor |
| `screenshot.taken` | path: string, url: string?, width: number?, height: number?, purpose: string? | screenshot-check | — |
| `issue.drafted` | title: string, body: string?, url: string?, labels: string[]? | issue-drafter, issue-pilot | ticket-linker, team-hub |
| `task.queued` | id: string, title: string | task-queue, workflow-studio | — |
| `task.started` | id: string, title: string | todo-pane, task-queue, night-shift, autopilot, workflow-studio | — |
| `task.finished` | id: string, title: string, outcome: 'ok'\|'failed'\|'cancelled' | todo-pane, task-queue, night-shift, autopilot, workflow-studio | — |
| `approval.requested` | id: string, question: string, tool: string? | permission-ping, autopilot | — |
| `approval.answered` | id: string, answer: 'allow'\|'deny', by: string | whatsapp-bridge, telegram-bridge | autopilot |
| `channel.inbound` | channel: string, from: string, text: string, isOwner: boolean | whatsapp-bridge, telegram-bridge, slack-bridge, discord-bridge | autopilot |
| `focus.started` | minutes: number, label: string? | focus-timer | — |
| `focus.ended` | minutes: number, isCompleted: boolean | focus-timer | break-reminder |
| `notification.sent` | level: 'info'\|'success'\|'warning'\|'error'\|'critical', title: string, source: string, targets: string[], held: boolean | mods-hub | — (email-digest gets its notices by draining its `email` channel) |
| `control.stop` | id: string, scope: 'session'\|'all', reason: string, by: string, session: string | mods-hub, for `$.mods.stop` (whatsapp-bridge STOP / STOP ALL, `/hub stop`) | autopilot; next wave: task-queue, night-shift, mission-control, workflow-studio |
| `control.pause` | same | mods-hub, for `$.mods.stop({ action: 'pause' })` | same |
| `control.resume` | same | mods-hub, for `$.mods.stop({ action: 'resume' })`, `/hub resume`, Home's Resume | same |

`control.*` events are raised only by the hub (a mod publishing one is refused), with the asking mod as `source`; with `scope: 'all'` each session's hub raises them again for its own subscribers. A mod that runs work on its own (a loop, a queue, a schedule) stops, pauses or resumes on them, and keeps any inference it had (a phone's "stop" in `channel.inbound`, a spent budget) as a fallback for an older hub.

Deliveries to channels are not bus events: the router hands each notice to push channels (`mods.deliver`) or keeps it for pull channels (`drain`), section 6.

## 9. Shared libraries

Mods cannot import across plugin folders at run time, and a function taking `$` cannot even be imported from a sibling file. So:

- `shared/*.ts` holds one pure implementation of each thing many mods re-implemented. `node scripts/sync-shared.mjs add <mod> <lib>` copies it to `mods/<mod>/hooks/shared/<lib>.ts` with a header `// @vendored shared/<lib>.ts sha256:<hash> …`; the mod imports it as `./shared/<lib>`.
- `hub-client` is the exception: its functions take `$`, so it is pasted as a marked region (`// #region @vendored shared/hub-client.ts sha256:<hash>` … `// #endregion …`) into the mod's hooks entry file, and `hub-types` (the hub's contract) is copied to `types/mods-hub.d.ts` with it.
- `fake-hub` (`shared/testing/hub.ts`) is the test stand-in for the hub, copied to `tests/hub.ts` (`add <mod> fake-hub`, after `hub-client`): one copy, kept in step with the contract by the same sync.
- `node scripts/sync-shared.mjs` rewrites every copy from its source; `--check` (CI, `.github/workflows/shared.yml`) fails when a copy is stale or was edited by hand; `list` shows who vendors what. `bun test shared/tests` tests the sources.

| Library | Extracted from (best existing implementation) | Replaces copies in |
| --- | --- | --- |
| `shell.ts` — tokenizer, `simpleCommands()` with pipelines, wrappers (sudo, env, timeout, nice, xargs, …), `bash -c`/`eval`/`$()`/backticks to depth 3, heredocs and here-strings fed to a shell read as scripts; substitutions are recorded where they are read (`ShellWord.substitutions`), so `'$(…)'` and `$'…'` expand nothing while `"$(…)"` does | `path-jail/hooks/bash.ts` (tokenizer, heredocs, wrappers), `curl-pipe-guard/hooks/pipes.ts` (pipelines, nesting), `offline-mode/hooks/network.ts` (xargs, builtin) | the identical 73-line `shell.ts` in 8 guards plus 13 bespoke lexers (42 mods in section 10) |
| `test-runners.ts` — `isTestCommand`, `runnerOfCommand`, `runnerOfOutput`, `countsOf`, `summarizeRun`, `describeRun` (vitest, jest, pytest, go, cargo, rspec, mocha, bun, deno, phpunit; `isTestCommand` also knows tox, nox, ctest, dotnet/swift/mix test, unittest, Maven and Gradle test goals) | `flaky-detector/hooks/runners.ts` (launcher-aware detection), `test-watch/hooks/runners.ts` (counts) | 14 mods |
| `prices.ts` — one table (checked against the 2026-09-25 price list), overrides, `costOf` with `isKnownModel`, families | `smart-router/hooks/pricing.ts`, `cost-meter/hooks/pricing.ts` | 4 disagreeing tables (fallback was Opus 5.5 in two, Sonnet 5 in two; only one knew Opus 4/4.1 legacy rates); 8 mods |
| `secrets.ts` — secret and PII rules with Luhn/IBAN/entropy checks, placeholders, `redactText`, `findSecrets` (lines, previews), `hasSecret` | `redactor/hooks/patterns.ts` (bounded rules), `secret-shield/hooks/scan.ts` (placeholder list) | 11 mods (and the hub, before anything leaves for a channel) |
| `line-index.ts` — `lineFinder`, cached `lineAt`, `columnAt`, `lineText` | `contrast-checker/hooks/css.ts`, `react-doctor/hooks/scan.ts` | 6 private copies, 2 of them linear per lookup; 23 mods |
| `hub-client.ts` (region) — `hubPublish`, `hubNotify` (toast fallback, `title — body`, optional `{ timeoutMs }`), `hubMode`, `hubHello`, `hubShowTab`, `hubStop`, `hubShareFact`, `hubReadFact`, `hubTabIs` (the fact helpers are not named `hubShare`/`hubRead` because guardian, calendar-sync, project-brain and team-hub already declare local functions with those names) | new | every mod that integrates |
| `testing/hub.ts` (`fake-hub`, copied to `tests/hub.ts`) — `fakeHub(on, mode?, clock?)`: `$.mods` from an `engine.create` hook, every `mods.*` answered from memory, `state.get` hooks for `tab`, `mode`, `control` | `token-budget/tests/hub.ts` | the W1 mods' identical copies (W2 copies are identical too and can switch with `add <mod> fake-hub`) |

## 10. Integration map

Columns: **Publishes** / **Consumes** are bus topics (`x.<mod>.*` are the mod's own); **State** is what it shares on the blackboard or reads from the hub; **Surface** is where its UI belongs under the panel policy (`notify(level)` = its toasts become `$.mods.notify` at that level); **Libs** are the `shared/` libraries it should vendor; **W** is its migration wave (section 9).


#### Core (3)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `mod-store` | mod.installed | — | reads installed() | pane (store browser; keeps its own) | — | 4 |
| `mods-hub` | test.result, error.repeated, cost.update, turn.finished, context.pressure, session.*, notification.sent | everything (feed, latest) | owns mode/prefs/tabs/channels/latest/facts | pane `claude-mods` (Home) | test-runners, prices, secrets | 0 |
| `mod-advisor` | mod.recommended | mod.installed, test.result, ci.result (signals) | fact `mod-advisor.stack` | **tab** Advisor (+ own pane when no hub) | — | 1 |

#### Security & Guardrails (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `secret-shield` | risk.blocked, secret.detected | — | — | guard | secrets, line-index | 2 |
| `env-guard` | risk.blocked | — | — | guard | shell | 2 |
| `rm-rf-guard` | risk.blocked | — | — | guard | shell | 2 |
| `force-push-guard` | risk.blocked, git.push | — | — | guard | shell | 2 |
| `prod-guard` | risk.blocked | deploy.started | — | guard | shell | 2 |
| `redactor` | secret.detected | — | — | status (counts) + notify | secrets | 2 |
| `path-jail` | risk.blocked | — | — | guard | shell | 2 |
| `curl-pipe-guard` | risk.blocked | — | — | guard | shell | 2 |
| `dependency-sentinel` | risk.blocked | — | — | guard | shell | 2 |
| `lockfile-guard` | risk.blocked | — | — | guard | shell | 2 |

#### Git & Versioning (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `git-status-line` | — | git.commit, git.push | fact `git-status-line.branch` | status | — | 4 |
| `auto-checkpoint` | x.auto-checkpoint.saved | turn.finished | — | cmd + notify | — | 4 |
| `commit-composer` | git.commit | — | — | cmd | — | 3 |
| `branch-namer` | — | — | — | cmd | — | 5 |
| `main-branch-warn` | risk.blocked | — | — | guard/notify(warning) | shell | 2 |
| `diff-pane` | — | git.commit, turn.finished | — | **tab** Changes | — | 4 |
| `pr-describer` | pr.opened | git.commit | — | cmd | — | 3 |
| `conflict-helper` | x.conflict-helper.found | — | — | cmd + notify(warning) | line-index | 5 |
| `co-author-stamp` | — | — | — | — | shell | 5 |
| `gitignore-guard` | risk.blocked | — | — | guard | shell | 2 |

#### Cost, Tokens & Context (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `cost-meter` | — | cost.update | — | status | prices | 1 |
| `token-budget` | budget.threshold | cost.update | fact `token-budget.status` | band at 80% + notify(warning/critical) | prices | 1 |
| `context-gauge` | — | context.pressure | — | band | — | 4 |
| `cache-hit-meter` | — | cost.update | — | status | prices | 4 |
| `turn-timer` | — | turn.finished | — | notify(info) | — | 4 |
| `big-read-guard` | risk.blocked | — | — | guard | — | 4 |
| `output-trimmer` | — | — | — | — | test-runners | 5 |
| `daily-spend` | budget.threshold | cost.update (all sessions via sessions.json) | fact `daily-spend.today` | **tab** Cost | prices | 1 |
| `model-advisor` | x.model-advisor.suggested | agent.routed | reads fact `smart-router.policy` | notify(info) | prices | 3 |
| `compact-coach` | — | context.pressure, turn.finished | — | notify(info) | — | 4 |

#### Productivity (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `quote-selection` | — | — | — | cmd | — | 5 |
| `prompt-snippets` | — | — | — | — | — | 5 |
| `todo-pane` | task.started, task.finished | — | — | **tab** Tasks | — | 4 |
| `focus-timer` | focus.started, focus.ended | session.away | calls setMode(silentMinutes) during focus | status | — | 3 |
| `scratchpad` | — | — | — | **tab** Notes | — | 4 |
| `recent-files` | — | — | — | cmd | — | 5 |
| `copy-last` | — | — | — | cmd | — | 5 |
| `prompt-history` | — | — | — | pane (search) | — | 5 |
| `quick-commands` | test.result, build.result, lint.result | — | — | cmd | test-runners | 3 |
| `idle-nudge` | — | session.idle | — | notify(info) | — | 3 |

#### Code Quality & Tests (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `auto-format` | — | — | — | — | — | 5 |
| `lint-on-save` | lint.result | — | — | notify(warning) | line-index | 3 |
| `test-watch` | test.result | — | fact `test-watch.plan` | status + **tab** Tests | test-runners | 1 |
| `typecheck-gate` | typecheck.result | — | — | notify(error) | — | 3 |
| `no-skip-tests` | risk.blocked | — | — | guard | test-runners, line-index | 3 |
| `todo-tracker` | x.todo-tracker.added | turn.finished | — | notify(info) | line-index | 5 |
| `debug-catcher` | lint.result | — | — | notify(warning) | line-index | 5 |
| `no-any` | lint.result | — | — | notify(warning) | line-index | 5 |
| `file-size-watch` | lint.result | — | — | notify(info) | — | 5 |
| `test-first` | risk.blocked | test.result | — | guard + status | test-runners | 3 |

#### Panes & Dashboards (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `tool-timeline` | — | turn.finished | — | **tab** Timeline | — | 4 |
| `files-touched` | — | — | — | **tab** Changes (merged with diff-pane) | — | 4 |
| `session-stats` | — | cost.update, test.result, turn.finished | — | **tab** Stats | prices | 4 |
| `subagent-monitor` | agent.finished | agent.routed | — | merged into **tab** Mission Control | — | 3 |
| `error-feed` | tool.failed | error.repeated | — | **tab** Errors | — | 3 |
| `activity-heatmap` | — | session.started, session.ended | — | pane | — | 5 |
| `bash-history` | — | — | — | cmd | shell | 5 |
| `web-trail` | — | — | — | cmd | — | 5 |
| `permission-log` | — | risk.blocked | — | cmd | — | 3 |
| `token-sparkline` | — | cost.update | — | band | — | 4 |

#### Prompt & System Prompt (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `house-style` | — | — | — | — | — | 5 |
| `language-lock` | — | — | — | — | — | 5 |
| `concise-mode` | — | — | — | — | — | 5 |
| `prompt-enhancer` | — | — | — | cmd | — | 5 |
| `ticket-linker` | — | issue.drafted | — | — | — | 5 |
| `date-context` | — | — | — | — | — | 5 |
| `persona-switch` | — | — | fact `persona-switch.persona` | status | — | 5 |
| `explain-level` | — | — | — | — | — | 5 |
| `stack-detector` | — | — | fact `stack-detector.stack` (the stack every mod reads) | — | — | 3 |
| `prompt-lint` | — | — | — | notify(info) | — | 5 |

#### Notifications & Audio (11)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `done-chime` | — | turn.finished | — | sound (held at night/silent by the hub) | — | 2 |
| `speak-summary` | — | turn.finished | — | speech (held by the hub) | — | 2 |
| `permission-ping` | approval.requested | — | — | notify(warning, kind question) | — | 2 |
| `error-buzz` | — | test.result, error.repeated | — | sound | test-runners | 2 |
| `webhook-notify` | — | turn.finished | — | channel `webhook` (team or me) | secrets | 2 |
| `desktop-notify` | — | — | — | channel `desktop` (pull or push) | — | 2 |
| `long-run-alert` | — | — | — | notify(warning) | shell | 2 |
| `ci-watch` | ci.result | git.push | — | status + notify(success/error) | — | 1 |
| `break-reminder` | — | session.idle, focus.ended | — | notify(info) | — | 3 |
| `celebrate` | — | test.result | — | notify(success) + sound | test-runners | 2 |
| `whatsapp-bridge` | channel.inbound, approval.answered, control.stop (via `stop`) | notify via pull + `drain`; session.*; test.result; ci.result; budget.threshold | reads hub mode (replaces its own presence/interaction prefs) | channel `whatsapp` (pull) + **tab** Channels | secrets | 1 |

#### Memory & Knowledge (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `decision-log` | decision.recorded | — | — | cmd | — | 3 |
| `session-journal` | — | session.ended, git.commit, decision.recorded, test.result | — | — | — | 3 |
| `glossary` | — | — | fact `glossary.terms` | — | — | 5 |
| `bookmark` | — | — | — | cmd | — | 5 |
| `resume-brief` | — | session.started | reads sessions.json | band (first prompt) | — | 3 |
| `lessons-learned` | lesson.learned | error.repeated | — | notify(question) | — | 3 |
| `codebase-map` | — | — | fact `codebase-map.summary` | cmd | — | 4 |
| `snippet-vault` | — | — | — | cmd | — | 5 |
| `link-vault` | — | — | — | cmd | — | 5 |
| `recall` | — | decision.recorded, lesson.learned | — | — (tool) | — | 3 |

#### Team & Docs (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `changelog-keeper` | — | git.commit | — | notify(info) | — | 3 |
| `readme-sync` | lint.result | — | — | notify(warning) | — | 5 |
| `standup` | — | git.commit, session.ended (sessions.json) | — | cmd | — | 4 |
| `review-agent` | agent.finished | — | — | cmd | — | 4 |
| `license-header` | — | — | — | — | — | 5 |
| `issue-drafter` | issue.drafted | error.repeated, ci.result | — | cmd | secrets | 3 |
| `handoff` | — | session.ended, decision.recorded | — | cmd | — | 4 |
| `i18n-guard` | lint.result | — | — | notify(warning) | line-index | 5 |
| `migration-guard` | risk.blocked | — | — | guard | — | 4 |
| `codeowners-hint` | — | — | — | notify(info) | — | 5 |

#### Languages & Frameworks (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `react-doctor` | lint.result | — | — | notify(warning) | line-index | 5 |
| `next-guard` | lint.result | — | — | notify(warning) | line-index | 5 |
| `venv-guard` | risk.blocked | — | — | guard | shell | 2 |
| `node-version-check` | — | session.started | — | notify(warning) | shell | 5 |
| `django-migrate-watch` | x.django-migrate-watch.missing | — | — | notify(warning) | — | 5 |
| `go-mod-tidy` | — | — | — | — | — | 5 |
| `strict-types` | — | — | — | — | — | 5 |
| `schema-sync` | build.result | — | — | notify(warning) | — | 5 |
| `env-example-sync` | lint.result | — | — | notify(info) | — | 5 |
| `monorepo-scope` | — | — | fact `monorepo-scope.package` | status | test-runners, shell | 4 |

#### DevOps & Cloud (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `docker-lint` | lint.result | — | — | notify(warning) | line-index | 5 |
| `k8s-dry-run` | risk.blocked, deploy.started | — | — | guard + pane (diff) | shell | 3 |
| `terraform-plan-pane` | deploy.started | — | — | pane | shell | 4 |
| `ci-yaml-check` | lint.result | — | — | notify(warning) | line-index | 5 |
| `port-check` | — | — | — | notify(warning) | shell | 5 |
| `dev-server-pane` | build.result | — | — | pane (+ **tab** Dev server) | — | 4 |
| `cloud-cost-warn` | risk.blocked | — | — | guard | shell | 2 |
| `log-tail` | — | — | — | pane per tail | — | 5 |
| `docker-prune-guard` | risk.blocked | — | — | guard | shell | 2 |
| `deploy-checklist` | deploy.started, deploy.finished, deploy.failed | test.result, ci.result | — | dialog pane (focus) | shell, test-runners | 3 |

#### Databases & Data (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `sql-safety` | risk.blocked, lint.result | — | — | guard/notify | line-index | 4 |
| `query-explain` | — | — | — | cmd/pane | — | 5 |
| `seed-guard` | risk.blocked | — | — | guard | shell | 2 |
| `schema-pane` | — | — | — | pane | — | 5 |
| `n-plus-one-hint` | lint.result | — | — | notify(info) | line-index | 5 |
| `migration-namer` | — | — | — | — | — | 5 |
| `query-result-cap` | — | — | — | — | shell | 2 |
| `backup-before-migrate` | x.backup-before-migrate.saved | — | — | notify(info) | shell | 3 |
| `csv-peek` | — | — | — | cmd | — | 5 |
| `fixture-factory` | — | — | — | cmd | — | 5 |

#### Frontend & Accessibility (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `a11y-guard` | lint.result | — | — | notify(warning) | line-index | 5 |
| `screenshot-check` | screenshot.taken | build.result | — | notify(info) | — | 3 |
| `bundle-size-watch` | build.result | — | — | notify(warning) | shell | 4 |
| `css-token-guard` | lint.result | — | — | notify(info) | line-index | 5 |
| `lighthouse-run` | x.lighthouse-run.scores | — | — | pane | — | 5 |
| `heavy-asset-warn` | risk.blocked | — | — | notify(warning) | shell | 5 |
| `storybook-nudge` | — | — | — | notify(info) | — | 5 |
| `contrast-checker` | lint.result | — | — | notify(warning) | line-index | 5 |
| `dark-mode-check` | lint.result | — | — | notify(info) | line-index | 5 |
| `component-catalog` | — | — | fact `component-catalog.components` | cmd | — | 5 |

#### APIs & Network (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `http-client` | — | — | — | pane | secrets | 5 |
| `openapi-sync` | lint.result | — | — | notify(warning) | — | 5 |
| `url-allowlist` | risk.blocked | — | — | guard | shell | 2 |
| `offline-mode` | risk.blocked | — | fact `offline-mode.on` | status + guard | shell | 2 |
| `mock-server` | — | — | — | cmd/status | — | 5 |
| `rate-limit-guard` | risk.blocked | — | — | guard | shell | 2 |
| `jwt-decode` | — | — | — | cmd | secrets | 5 |
| `status-check` | — | error.repeated | — | cmd | — | 5 |
| `graphql-context` | — | — | — | — | — | 5 |
| `curl-to-code` | — | — | — | cmd | shell | 5 |

#### Agents & Orchestration (11)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `scope-lock` | risk.blocked | — | fact `scope-lock.scope` | status + guard | shell | 2 |
| `second-opinion` | agent.finished | — | — | cmd | — | 4 |
| `parallel-explore` | agent.finished | agent.routed | — | cmd | — | 4 |
| `subagent-cap` | risk.blocked | agent.routed | reads fact `smart-router.policy` | guard | — | 3 |
| `task-queue` | task.queued, task.started, task.finished | session.idle, control.* | — | band/**tab** Queue | — | 3 |
| `night-shift` | task.started, task.finished | session.away, control.* | — | notify(success/error) → channels | — | 3 |
| `loop-breaker` | error.repeated | — | — | guard + notify | shell | 3 |
| `self-check` | agent.finished | turn.finished | — | — | — | 4 |
| `edit-limit` | risk.blocked | — | — | guard | — | 4 |
| `agent-presets` | — | — | — | — | — | 5 |
| `smart-router` | agent.routed, agent.finished, cost.update (subagents) | budget.threshold, test.result | fact `smart-router.policy`; writes daily.json | **tab** Router (+ own pane when no hub) | prices | 1 |

#### Learning & Onboarding (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `explain-diff` | — | turn.finished | — | cmd | — | 5 |
| `quiz-me` | — | — | — | pane (dialog) | — | 5 |
| `learning-mode` | — | — | — | — | — | 5 |
| `onboarding-tour` | — | — | — | pane | — | 5 |
| `command-coach` | mod.recommended | error.repeated, session.idle | — | notify(info) | shell | 4 |
| `shortcut-tips` | — | session.started | — | notify(info) | — | 5 |
| `why-log` | — | decision.recorded | — | cmd | — | 5 |
| `cheatsheet` | — | — | — | cmd | — | 5 |
| `pair-mode` | — | — | — | guard | shell | 5 |
| `skill-tracker` | — | test.result, git.commit | — | cmd | — | 5 |

#### Privacy & Compliance (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `license-checker` | risk.blocked | — | — | notify(warning) | shell | 4 |
| `pii-in-logs` | secret.detected, lint.result | — | — | notify(warning) | secrets, line-index | 2 |
| `data-map` | — | — | — | cmd | secrets | 5 |
| `tracker-guard` | risk.blocked | — | — | guard | shell | 2 |
| `no-upload` | risk.blocked | — | — | guard | shell | 2 |
| `crypto-guard` | lint.result | — | — | notify(warning) | line-index | 5 |
| `sbom` | — | — | — | cmd | — | 5 |
| `audit-trail` | — | everything (feed) + risk.blocked | — | — | secrets | 3 |
| `vuln-scan` | x.vuln-scan.found | — | — | pane + notify(error) | shell | 4 |
| `copyright-guard` | lint.result | — | — | notify(warning) | line-index | 5 |

#### Performance & Reliability (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `benchmark-compare` | x.benchmark-compare.result | — | — | cmd/pane | — | 5 |
| `slow-test-flag` | — | test.result | — | notify(info) | test-runners | 2 |
| `flaky-detector` | x.flaky-detector.suspect | test.result | — | notify(warning) + **tab** Tests section | test-runners | 2 |
| `leak-hint` | lint.result | — | — | notify(info) | line-index | 5 |
| `outdated-deps` | — | — | — | cmd | — | 5 |
| `profile-run` | — | — | — | pane | line-index | 5 |
| `net-retry` | — | — | — | — | shell | 4 |
| `disk-guard` | risk.blocked | — | — | notify(warning) | shell | 4 |
| `regression-guard` | x.regression-guard.regressed | test.result | — | notify(error) | test-runners | 2 |
| `watch-mode-guard` | risk.blocked | — | — | guard | shell, test-runners | 2 |

#### Mod Ecosystem (10)

| Mod | Publishes | Consumes | State | Surface | Libs | W |
| --- | --- | --- | --- | --- | --- | --- |
| `mod-maker` | — | — | — | cmd | — | 5 |
| `mod-doctor` | — | mod.installed | reads installed() | cmd | — | 4 |
| `mod-profiles` | mod.installed | — | — | cmd | — | 4 |
| `settings-sync` | — | — | exports hub prefs.json too | cmd | — | 4 |
| `quiet-mode` | — | — | calls setMode (alias of hub Silent; `/quiet on` is `isSilent: true`, no end) | status | — | 1 |
| `achievements` | — | test.result, git.commit, ci.result, session.started | — | pane + notify(success) | — | 3 |
| `streaks` | — | session.started | — | status | — | 5 |
| `soundpack` | — | turn.finished, test.result, risk.blocked | — | sound (held by the hub) | — | 3 |
| `daily-goal` | — | session.ended | — | band | — | 4 |
| `session-replay` | — | — | — | pane | — | 5 |

#### The system mods

All soft (they work without the hub) except the three push bridges, which depend on it.

| Mod | Publishes | Consumes | State | Surface | Libs |
| --- | --- | --- | --- | --- | --- |
| `guardian` | risk.blocked (as policy owner) | risk.blocked, secret.detected | fact `guardian.policy`: `{ level: 'permissive'\|'standard'\|'strict'\|'custom', base: 'permissive'\|'standard'\|'strict' (the level a custom policy builds on), fallback: boolean, project: string, guards: { <guard>: options } }`; read by team-hub (the level that counts is `base` when `level` is custom) | **tab** Guardian | shell, secrets |
| `autopilot` | task.started, task.finished, approval.requested | control.*, session.away, test.result, typecheck.result, lint.result, build.result, ci.result, budget.threshold, channel.inbound, approval.answered | reads mode.canAsk | **tab** Autopilot | test-runners |
| `project-brain` | x.project-brain.updated | decision.recorded, lesson.learned, git.commit, test.result, session.ended | facts `project-brain.*` | **tab** Brain | line-index |
| `context-optimizer` | context.pressure, x.context-optimizer.saved | context.pressure, decision.recorded | reads facts `codebase-map.summary`, `stack-detector.stack` | band (when pressure) + tab section in Cost | prices |
| `workflow-studio` | task.queued, task.started, task.finished | agent.routed, agent.finished, control.* | reads fact `smart-router.policy` | **tab** Workflows | — |
| `mission-control` (soft) | — | everything incl. sessions.json (all sessions), control.* | reads sessions.json, latest/*; works from its own session files without the hub | **tab** Mission Control (own pane without the hub) | prices |
| `session-sync` (soft) | x.session-sync.synced | session.*, decision.recorded | reads/writes sessions.json neighbours; its own files without the hub | tab section in Mission Control | — |
| `team-hub` | — | pr.opened, ci.result, deploy.*, decision.recorded, issue.drafted | reads fact `guardian.policy` and the hub's routes (drift from the team's rules) | **tab** Team | secrets |
| `telegram-bridge` (bound) | channel.inbound, approval.answered | mods.deliver | — | channel `telegram` (push) | secrets |
| `slack-bridge` (bound) | channel.inbound | mods.deliver (audience team) | — | channel `slack` (team, push) | secrets |
| `discord-bridge` (bound) | channel.inbound | mods.deliver (audience team) | — | channel `discord` (team, push) | secrets |
| `calendar-sync` | x.calendar-sync.busy | — | calls setMode/setPresence from meetings | **tab** Calendar | — |
| `email-digest` | — | its `email` channel (`drain`); ci.result, deploy.finished, deploy.failed, pr.opened, decision.recorded, test.result, error.repeated, cost.update (`recent`) | — | channel `email` (pull, digest) | secrets |
| `issue-pilot` | issue.drafted | ci.result, error.repeated, test.result | — | **tab** Issues | secrets |

### Overlaps, and how they cooperate

| Cluster | Mods | Cooperation |
| --- | --- | --- |
| Shell guards | rm-rf-guard, force-push-guard, prod-guard, curl-pipe-guard, env-guard, path-jail, scope-lock, no-upload, offline-mode, seed-guard, docker-prune-guard, cloud-cost-warn, k8s-dry-run, venv-guard, watch-mode-guard, gitignore-guard, url-allowlist, rate-limit-guard, tracker-guard, main-branch-warn, dependency-sentinel, lockfile-guard → **guardian** | One lexer (`shared/shell`): a bypass fixed once is fixed in all. Every deny also publishes `risk.blocked`; guardian's tab shows them together and owns the policy fact `guardian.policy` (later, the single place to allow-list). |
| Secrets & PII | secret-shield, redactor, env-guard, pii-in-logs, audit-trail, data-map, webhook-notify, whatsapp-bridge, the hub | One rule set (`shared/secrets`); `secret.detected` on every hit; nothing reaches a channel unmasked (the hub masks). |
| Cost | cost-meter, token-budget, daily-spend, cache-hit-meter, session-stats, token-sparkline, model-advisor, smart-router, context-optimizer | One price table (`shared/prices`). The hub's `cost.update` is the per-turn number everyone shows; smart-router adds subagent cost. token-budget and daily-spend publish `budget.threshold`, which smart-router (bias to cheaper tiers) and autopilot (pause) consume. daily-spend owns the **Cost** tab and the cross-session ledger (reading `sessions.json` and smart-router's `daily.json`); cost-meter keeps the status line. |
| Tests | test-watch, flaky-detector, slow-test-flag, regression-guard, celebrate, error-buzz, no-skip-tests, test-first, quick-commands, achievements, deploy-checklist, autopilot | One detector (`shared/test-runners`) and one event: consumers stop parsing Bash output themselves and subscribe to `test.result`. test-watch owns the **Tests** tab (flaky and slow lists as its sections). |
| Notifiers | done-chime, desktop-notify, webhook-notify, permission-ping, error-buzz, long-run-alert, speak-summary, break-reminder, celebrate, soundpack, idle-nudge, quiet-mode | Toasts become `notify(level)`; desktop-notify and webhook-notify become channels (`desktop`, `webhook`); quiet-mode's `/quiet` becomes an alias of hub Silent (`setMode`); sounds are held by the hub at night and when Silent. |
| Activity views | tool-timeline, files-touched, diff-pane, error-feed, bash-history, web-trail, permission-log, recent-files, session-replay, audit-trail | **Timeline** (tool-timeline), **Changes** (diff-pane + files-touched in one tab), **Errors** (error-feed, consuming `error.repeated`); the rest stay commands. |
| Memory | decision-log, lessons-learned, session-journal, resume-brief, recall, glossary, codebase-map, handoff, standup, why-log → **project-brain** | Publish `decision.recorded` / `lesson.learned`; project-brain consumes and owns **Brain**; recall indexes them; resume-brief and handoff read `sessions.json`. |
| Agents | smart-router, subagent-monitor, subagent-cap, parallel-explore, task-queue, night-shift, second-opinion, self-check, loop-breaker → **autopilot, workflow-studio, mission-control** | smart-router publishes `agent.routed`/`agent.finished` and the fact `smart-router.policy` (subagent-cap and model-advisor read it instead of guessing); subagent-monitor folds into **Mission Control**; task-queue/night-shift publish `task.*`, which autopilot and workflow-studio drive; all of them obey `control.stop` / `control.pause` / `control.resume` (autopilot already does; the others in the next wave). |
| Git, CI, deploy | commit-composer, pr-describer, ci-watch, changelog-keeper, standup, deploy-checklist, k8s-dry-run, terraform-plan-pane, prod-guard → **issue-pilot, team-hub** | `git.commit`, `git.push`, `pr.opened`, `ci.result`, `deploy.*`; ci-watch's failures feed issue-pilot (draft an issue) and team-hub (post to team channels). |
| Presence & time | idle-nudge, break-reminder, focus-timer, daily-goal, streaks, activity-heatmap, calendar-sync | Consume `session.idle/away/back`; focus-timer turns Silent on for a focus block; calendar-sync sets presence and Silent from meetings. |
| Mod ecosystem | mod-store, mod-advisor, mod-doctor, mod-profiles, settings-sync, command-coach, shortcut-tips | `installed()` replaces each mod's own `claude plugin list` run; `mod.recommended` / `mod.installed` events; settings-sync also exports the hub's `prefs.json`. |
| Channels | whatsapp-bridge, telegram-bridge, slack-bridge, discord-bridge, email-digest, desktop-notify, webhook-notify | `registerChannel` + pull `drain` (soft: whatsapp, email, desktop, webhook) or `mods.deliver` (bound: telegram, slack, discord); whatsapp-bridge's own presence/interaction/night prefs are replaced by the hub's mode (it reads `mode()`), so all channels obey one switch; a phone's STOP is `$.mods.stop`. |

## 11. Migration order

Wave 0 is this phase. Each wave lands in one PR per cluster; a mod changes only by vendoring libraries, swapping a toast for `hubNotify`, publishing its events, and (dashboards) registering a tab, so each change is small and the mod keeps working without the hub.

- **Wave 0 — the core** (1): `mods-hub`
- **Wave 1 — first publishers and the three flagships** (9): `cost-meter`, `token-budget`, `daily-spend`, `test-watch`, `ci-watch`, `quiet-mode`, `mod-advisor`, `smart-router`, `whatsapp-bridge`
- **Wave 2 — security guards (shared shell/secrets) and notifiers (notify, sounds)** (36): `secret-shield`, `env-guard`, `rm-rf-guard`, `force-push-guard`, `prod-guard`, `redactor`, `path-jail`, `curl-pipe-guard`, `dependency-sentinel`, `lockfile-guard`, `main-branch-warn`, `gitignore-guard`, `done-chime`, `speak-summary`, `permission-ping`, `error-buzz`, `webhook-notify`, `desktop-notify`, `long-run-alert`, `celebrate`, `venv-guard`, `cloud-cost-warn`, `docker-prune-guard`, `seed-guard`, `query-result-cap`, `url-allowlist`, `offline-mode`, `rate-limit-guard`, `scope-lock`, `pii-in-logs`, `tracker-guard`, `no-upload`, `slow-test-flag`, `flaky-detector`, `regression-guard`, `watch-mode-guard`
- **Wave 3 — cross-mod stories: memory, agents, deploy, quality gates** (33): `commit-composer`, `pr-describer`, `model-advisor`, `focus-timer`, `quick-commands`, `idle-nudge`, `lint-on-save`, `typecheck-gate`, `no-skip-tests`, `test-first`, `subagent-monitor`, `error-feed`, `permission-log`, `stack-detector`, `break-reminder`, `decision-log`, `session-journal`, `resume-brief`, `lessons-learned`, `recall`, `changelog-keeper`, `issue-drafter`, `k8s-dry-run`, `deploy-checklist`, `backup-before-migrate`, `screenshot-check`, `subagent-cap`, `task-queue`, `night-shift`, `loop-breaker`, `audit-trail`, `achievements`, `soundpack`
- **Wave 4 — dashboards into tabs, cost/context views, ecosystem** (38): `mod-store`, `git-status-line`, `auto-checkpoint`, `diff-pane`, `context-gauge`, `cache-hit-meter`, `turn-timer`, `big-read-guard`, `compact-coach`, `todo-pane`, `scratchpad`, `tool-timeline`, `files-touched`, `session-stats`, `token-sparkline`, `codebase-map`, `standup`, `review-agent`, `handoff`, `migration-guard`, `monorepo-scope`, `terraform-plan-pane`, `dev-server-pane`, `sql-safety`, `bundle-size-watch`, `second-opinion`, `parallel-explore`, `self-check`, `edit-limit`, `command-coach`, `license-checker`, `vuln-scan`, `net-retry`, `disk-guard`, `mod-doctor`, `mod-profiles`, `settings-sync`, `daily-goal`
- **Wave 5 — long tail: edit-time checkers (`line-index`, `lint.result`) and command-only mods** (88): `branch-namer`, `conflict-helper`, `co-author-stamp`, `output-trimmer`, `quote-selection`, `prompt-snippets`, `recent-files`, `copy-last`, `prompt-history`, `auto-format`, `todo-tracker`, `debug-catcher`, `no-any`, `file-size-watch`, `activity-heatmap`, `bash-history`, `web-trail`, `house-style`, `language-lock`, `concise-mode`, `prompt-enhancer`, `ticket-linker`, `date-context`, `persona-switch`, `explain-level`, `prompt-lint`, `glossary`, `bookmark`, `snippet-vault`, `link-vault`, `readme-sync`, `license-header`, `i18n-guard`, `codeowners-hint`, `react-doctor`, `next-guard`, `node-version-check`, `django-migrate-watch`, `go-mod-tidy`, `strict-types`, `schema-sync`, `env-example-sync`, `docker-lint`, `ci-yaml-check`, `port-check`, `log-tail`, `query-explain`, `schema-pane`, `n-plus-one-hint`, `migration-namer`, `csv-peek`, `fixture-factory`, `a11y-guard`, `css-token-guard`, `lighthouse-run`, `heavy-asset-warn`, `storybook-nudge`, `contrast-checker`, `dark-mode-check`, `component-catalog`, `http-client`, `openapi-sync`, `mock-server`, `jwt-decode`, `status-check`, `graphql-context`, `curl-to-code`, `agent-presets`, `explain-diff`, `quiz-me`, `learning-mode`, `onboarding-tour`, `shortcut-tips`, `why-log`, `cheatsheet`, `pair-mode`, `skill-tracker`, `data-map`, `crypto-guard`, `sbom`, `copyright-guard`, `benchmark-compare`, `leak-hint`, `outdated-deps`, `profile-run`, `mod-maker`, `streaks`, `session-replay`
- **System mods (new, after wave 1):** channels first (telegram-bridge, slack-bridge, discord-bridge, email-digest), then guardian, mission-control, session-sync, project-brain, issue-pilot, team-hub, calendar-sync, context-optimizer, autopilot, workflow-studio — each built for the hub from the start, soft unless pointless without it (only the three push bridges are bound).
- **Next:** task-queue, night-shift, mission-control and workflow-studio consume `control.*` (autopilot already does).

Rationale: wave 1 gives the hub its first real publishers and consumers (cost, tests, CI, mode) and aligns the three flagships while they are fresh; wave 2 is the security and notification clusters, where one shared lexer and one router fix the most bugs and noise at once; wave 3 wires the cross-mod stories (memory, agents, deploy) the 12 system mods build on; waves 4 and 5 are dashboards moving into tabs and the long tail of edit-time checkers (mostly `line-index` and `lint.result`).

## 12. Open points

- Cross-plugin pane drawing is verified in the engine's test kit (terminal and desktop), with the tab owner beneath the hub, and the hub was run live headlessly (`claude -p --plugin-dir mods/mods-hub "/hub status"`); a first interactive session with a tab owner installed should confirm the drawing order the convention relies on.
- `mods.deliver` runs in the hub's background timer; a slow channel delays the next delivery, not the session. Channel mods should queue and answer at once.
- A pull channel's notices live in its session's state: they survive a hot reload, not the end of the session. A channel that must not lose a notice across sessions keeps its own durable outbox after draining. The pull channels written before the cursor (whatsapp-bridge, email-digest, desktop-notify, webhook-notify) still drain without `after` (at-most-once); moving them to the cursor is a one-line change each.
- `control.json` is read-modify-write like the other shared files: two sessions raising a STOP ALL in the same instant may keep only one of the two entries (both stop everything, so nothing is lost in effect).
- Presence counts prompts and hub presses, not other mods' slash commands or buttons (the hub cannot see those cheaply).
- Promote `x.*` topics used by two or more mods into the catalog at each hub release; bump the contract's version in `plugin.json` and re-run `sync-shared` so soft mods pick up the new types.
