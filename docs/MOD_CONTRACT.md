# The mod contract

The checklist every Claude Mod (and every agent writing one) follows to work with the others. The why is in
[ARCHITECTURE.md](ARCHITECTURE.md); your mod's row in its integration map (section 10) says which events,
facts, surface and libraries apply to you.

## 1. Stand alone

- [ ] The mod works with zero config and **without `mods-hub`**. Every `$.mods` call goes through the `hub-client` functions (they catch and fall back). Never test for the hub with `'mods' in $` or `typeof $.mods`: the validator refuses it.
- [ ] Do not add `"dependencies": ["mods-hub"]` unless the mod is pointless without the hub (today only the push bridges telegram-bridge, slack-bridge, discord-bridge; mission-control and session-sync are soft). It is a hard dependency: the mod does not load until the hub is installed.
- [ ] Never hook `mods.*` events in a mod without that dependency: the module would fail to load when the hub is absent.

## 2. Vendor what you share

```
node scripts/sync-shared.mjs add <your-mod> hub-client          # region in your hooks file + types/mods-hub.d.ts
node scripts/sync-shared.mjs add <your-mod> shell secrets ...   # hooks/shared/<lib>.ts, import from './shared/<lib>'
```

- [ ] Shell commands → `shared/shell` (`simpleCommands`, `unwrap`, `commandNames`). No private lexer.
- [ ] Test runs → `shared/test-runners`. Prices → `shared/prices`. Secrets/PII → `shared/secrets`. Offsets → `shared/line-index`.
- [ ] Never edit a vendored copy. Change `shared/`, run `node scripts/sync-shared.mjs`, then `bun test shared/tests`; CI runs `--check`.
- [ ] The `hub-client` region needs `import type { EngineInterface } from 'claude-code'` in your hooks file. A bound mod skips `hub-client` and `hub-types` (the engine lays the contract) and calls `$.mods` directly.

## 3. Say hello once

```ts
on('session.start', async ($, e, next) => {
  await hubHello($, { version: '1.2.0', publishes: ['ci.result'], consumes: ['git.push'] })
  return next(e)
})
```

## 4. Publish what happened

- [ ] Publish the standard events your row lists: `await hubPublish($, { topic: 'ci.result', data: { provider: 'github', workflow: 'test', outcome: 'failed', url } })`. The payload must match `ModsEventMap` exactly (the hub refuses a bad one; `hubPublish` returns false).
- [ ] Your own events are `x.<your-mod>.<name>` with any JSON (≤ 16 000 characters). Need a new standard topic? Propose it in the hub's catalog (`mods/mods-hub/hooks/catalog.ts` + `types/index.d.ts`).
- [ ] Guards: on every deny, also publish `risk.blocked` (`guard` = your mod, `severity`, the command or path). A guard never waits on the hub before deciding.
- [ ] Use `scope: 'global'` only for events other sessions should see (session summaries, deploys, CI).
- [ ] Never publish or `share` from inside a `ui.render` hook.

## 5. Read, don't recompute

- [ ] Before running or parsing something the hub already knows, read it: `$.mods.latest({ topic: 'test.result' })`, `$.mods.read({ key: 'stack-detector.stack' })`, or in a render hook `$.state.get({ plugin: 'mods-hub', key: 'latest', id: 'cost.update' })` (redraws when it changes).
- [ ] Share your current facts on the blackboard: `await hubShareFact($, { name: 'policy', value })` → readable as `<your-mod>.policy` (`hubReadFact($, 'stack-detector.stack')` reads one; both are quiet without a hub). Document the fact's shape in your README and in ARCHITECTURE section 10; readers parse it defensively.
- [ ] Bound mods subscribe: `on('mods.publish', { topic: 'test.result' }, ($, e, next) => { $.clock.after(0, () => void react($, e)); return next(e) })`. Return `next(e)` promptly; never swallow an event. You do not receive your own publishes.
- [ ] A mod that works on its own (a loop, a queue, a schedule: autopilot, task-queue, night-shift, workflows, mission-control's actions) obeys `control.stop`, `control.pause` and `control.resume`: read them with `$.mods.recent({ prefix: 'control.', since })` on its timer (or the `control` state), and keep any older inference as a fallback. To raise one (a phone's STOP, a STOP ALL): `await hubStop($, { action: 'stop', scope: 'all', reason, by: 'owner via telegram' })`; never publish `control.*` yourself.

## 6. Notify through the hub

- [ ] Anything that may matter away from the terminal is `await hubNotify($, { level, title, body?, url? })`, not `$.ui.toast` (without a hub it shows `title — body` as a toast; pass `{ timeoutMs }` as a third argument for that toast's own timeout). Levels: `info` (FYI), `success` (done), `warning` (needs a look), `error` (failed), `critical` (act now; breaks Silent and Night).
- [ ] A question or approval request is `kind: 'question'` (it obeys Interaction). Team news is `audience: 'team'`. Terminal-only chatter is `audience: 'terminal'` or a plain toast.
- [ ] Respect the mode in your own behaviour: `const mode = await hubMode($)` (undefined without a hub). Ask the person on a channel only when `mode.canAsk`; prefer waiting for `presence === 'here'` before anything that needs them at the keyboard; no sounds of your own at night (the hub holds them anyway).
- [ ] Title ≤ 200 characters, body ≤ 2 000, no secrets (channels get a masked copy, the terminal does not).

## 7. Pick the right surface

- [ ] Dashboard you come back to → a **tab** in the Claude Mods panel:
  1. register it in `session.start`: `hubHello($, hello, { id: 'router', title: 'Router', order: 20, command: 'router' })`;
  2. draw it by hooking the hub's pane, passing through when it is not your tab and composing with `next(e)` when it is:
     ```tsx
     on('ui.render', { component: 'Pane', requestId: 'claude-mods' }, async ($, e, next) => {
       if (!(await hubTabIs($, 'router'))) return next(e)
       const { Box } = $.ui.resolve(e)
       return <Box flexDirection="column">{await next(e)}{await drawRouter($, e)}</Box>
     })
     ```
  3. your command opens it: `if (!(await hubShowTab($, 'router'))) await $.ui.open({ id: 'router', title: 'Router' })` (your own pane is the no-hub fallback; keep both drawing from the same function). Size to `e.props.bodyColumns`.
- [ ] A tab body never binds hotkeys `0`–`9`: the hub's tab strip owns them. Use letters.
- [ ] Workspace, dialog or many instances → your own pane. One line that matters now → a band that composes with `next(e)`. One tiny value → the status line. On-demand report → command output.
- [ ] Never open a pane unasked below the engine's width rules.

## 8. Connectors (channel mods)

- [ ] Register: `$.mods.registerChannel({ id: 'telegram', title: 'Telegram', audience: 'me', delivery: 'push', status: 'connecting' })`; report changes with `channelStatus`.
- [ ] **Pull is the standard** for a soft channel (a soft mod cannot hook `mods.deliver`: the module would fail to load without the hub). Register with `delivery: 'pull'` and drain every few seconds with a cursor, from a top-level function:
  ```ts
  async function drainHub($: EngineInterface, cursor: { last: string | null; sent: Set<string> }): Promise<void> {
    let notices: ModsNotice[]
    try { notices = await $.mods.drain({ channel: 'telegram', after: cursor.last }) } catch { return }   // no hub
    for (const notice of notices) {
      if (!cursor.sent.has(notice.id) && !(await send(notice))) return   // a failed send stays queued: retried next time
      cursor.sent.add(notice.id)
      cursor.last = notice.id                                           // acknowledged by the next drain
    }
  }
  ```
  A notice comes back until a later drain passes an id at or after it (at-least-once: dedupe by `id`, keep `sent` bounded). Each session drains its own hub, so two sessions never take each other's notices. `drain({ channel })` without `after` hands over and forgets (at-most-once); use it only where a lost notice does not matter.
  **A pull channel's `send` must report failure** (return `false` or throw, never swallow the error and carry on): the notice then stays queued and comes back on the next drain. **Cap the retries:** count the failed attempts per notice id and, after a few (3–5), give the notice up (advance the cursor past it, drop it from the outbox) and show one *poison notice* line ("gave up on a notice after 3 failed sends") instead of retrying forever and blocking every notice behind it.
- [ ] Push (bound only): `on('mods.deliver', { channel: 'telegram' }, async ($, e) => { queue(e.notice); return { value: { isDelivered: true } } })`; answer at once and send in the background. A push channel that answers `isDelivered: false` finds the notice in its pull outbox too.
- [ ] Publish what arrives: `channel.inbound`, and `approval.answered` for approvals; a STOP from the phone is `hubStop` (section 5). Change the mode from the phone with `setMode` / `setPresence` (reason `channel`): Silent with no end is `setMode({ isSilent: true })`, for a while `setMode({ silentMinutes: 30 })`, off `setMode({ isSilent: false })`; show the Night schedule from `mode.isNightOn` and `mode.quietHours`, presence from `mode.presence` and `mode.awayMinutes`. Never keep a separate presence or quiet-hours setting.

## 9. Before you finish

- [ ] `check-mod.sh` passes (validate, test, tsc) and `node scripts/lint-dollar.mjs mods/<mod>` is clean.
- [ ] Tests cover the mod **without** the hub (the fallbacks) **and with it**, the hub-present path tested without the real hub:
  - vendor the stand-in: `node scripts/sync-shared.mjs add <mod> fake-hub` copies `shared/testing/hub.ts` to `tests/hub.ts` (the canonical fake, first written as `mods/token-budget/tests/hub.ts`); then `const hub = fakeHub(on, { presence: 'away' }, clock)` before the first `$` call, and assert on `hub.published`, `hub.notified`, `hub.modes`, `hub.controls`, or fill `hub.outbox` / `hub.events` for the mod to drain or read;
  - how it works, if you write your own: a test `on('engine.create', async ($, e, next) => ({ ...(await next(e)), mods }))` makes `$.mods` exist, where `mods` is a plain object whose members are **real functions** (a `Proxy` is refused); each `mods.<method>` the mod calls is answered by a test hook (`on('mods.mode', () => ({ value: mode }))`), and hub state the mod reads by `state.get` hooks with matchers (`on('state.get', { plugin: 'mods-hub', key: 'tab' }, () => ({ value: { value: 'router', version: 1 } }))`);
  - a bound mod's tests load the same stand-in (or an inline plugin named `mods-hub`), since its module needs `$.mods` to load at all.
- [ ] `node scripts/sync-shared.mjs --check` is clean.
- [ ] The README's "How it works" says what the mod publishes and consumes, and what changes when mods-hub is installed.
