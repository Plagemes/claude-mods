/**
 * shared/hub-client.ts — the mods-hub client every mod pastes into its hooks file.
 *
 * Functions that take `$` must be declared at the top level of the hooks module itself (the engine refuses a
 * module that passes `$` to an imported function), so this is NOT imported: scripts/sync-shared.mjs copies the
 * region below into the mod's hooks file, between `// #region @vendored shared/hub-client.ts` markers, and
 * `types/mods-hub.d.ts` (the hub's contract) beside it: `node scripts/sync-shared.mjs add <mod> hub-client`.
 *
 * The hooks file needs `import type { EngineInterface } from 'claude-code'`. Nothing else: the region names
 * the hub's types through `EngineInterface['mods']`, which the vendored contract declares.
 *
 * Every function here works with no hub installed: `$.mods` is then absent, the call throws a TypeError, and
 * the function falls back (a toast, `false`, `undefined`). A hub that refuses a call (a bad payload) is
 * treated the same way, so a mod never fails because of the hub.
 */
import type { EngineInterface } from 'claude-code'

// #region hub-client
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/** Routes a notification through the hub (channels, silent, night, presence), or shows a toast when there is no hub. */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0]): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    $.ui.toast(input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`)
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion hub-client

export { hubHello, hubMode, hubNotify, hubPublish, hubShowTab, hubTabIs }
