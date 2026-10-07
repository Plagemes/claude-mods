# The mod contract

The checklist every Claude Mod (and every agent writing one) follows to work with the others. The why is in
[ARCHITECTURE.md](ARCHITECTURE.md); your mod's row in its integration map (section 10) says which events,
facts, surface and libraries apply to you.

## 1. Stand alone

- [ ] The mod works with zero config and **without `mods-hub`**. Every `$.mods` call goes through the `hub-client` functions (they catch and fall back). Never test for the hub with `'mods' in $` or `typeof $.mods`: the validator refuses it.
- [ ] Do not add `"dependencies": ["mods-hub"]` unless the mod is pointless without the hub (a channel bridge, mission-control). It is a hard dependency: the mod does not load until the hub is installed.
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
- [ ] Share your current facts on the blackboard: `$.mods.share({ name: 'policy', value })` → readable as `<your-mod>.policy`.
- [ ] Bound mods subscribe: `on('mods.publish', { topic: 'test.result' }, ($, e, next) => { $.clock.after(0, () => void react($, e)); return next(e) })`. Return `next(e)` promptly; never swallow an event. You do not receive your own publishes.

## 6. Notify through the hub

- [ ] Anything that may matter away from the terminal is `await hubNotify($, { level, title, body?, url? })`, not `$.ui.toast`. Levels: `info` (FYI), `success` (done), `warning` (needs a look), `error` (failed), `critical` (act now; breaks Silent and Night).
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
- [ ] Workspace, dialog or many instances → your own pane. One line that matters now → a band that composes with `next(e)`. One tiny value → the status line. On-demand report → command output.
- [ ] Never open a pane unasked below the engine's width rules.

## 8. Connectors (channel mods)

- [ ] Register: `$.mods.registerChannel({ id: 'telegram', title: 'Telegram', audience: 'me', delivery: 'push', status: 'connecting' })`; report changes with `channelStatus`.
- [ ] Push (bound): `on('mods.deliver', { channel: 'telegram' }, async ($, e) => { queue(e.notice); return { value: { isDelivered: true } } })`; answer at once and send in the background. Pull (soft): `delivery: 'pull'` and `$.mods.drain({ channel })` every few seconds.
- [ ] Publish what arrives: `channel.inbound`, and `approval.answered` for approvals. Change the mode from the phone with `setMode` / `setPresence` (reason `channel`); never keep a separate presence or quiet-hours setting.

## 9. Before you finish

- [ ] `check-mod.sh` passes (validate, test, tsc) and `node scripts/lint-dollar.mjs mods/<mod>` is clean.
- [ ] Tests cover the mod **without** the hub (the fallbacks); a bound mod's tests load an inline stand-in that provides `$.mods`.
- [ ] `node scripts/sync-shared.mjs --check` is clean.
- [ ] The README's "How it works" says what the mod publishes and consumes, and what changes when mods-hub is installed.
