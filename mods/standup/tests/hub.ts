// @vendored shared/testing/hub.ts sha256:d9e762d89c54 by scripts/sync-shared.mjs: edit the source, then run `node scripts/sync-shared.mjs`; never this copy.
/**
 * shared/testing/hub.ts — a stand-in for mods-hub in a mod's tests, so the hub-present path is tested without
 * the hub (docs/MOD_CONTRACT.md section 9). Vendored as `tests/hub.ts`:
 * `node scripts/sync-shared.mjs add <mod> fake-hub` (it imports the hub's contract from `../types/mods-hub`,
 * which `add <mod> hub-client` lays). Import it as `import { fakeHub } from './hub'`.
 *
 * How it stands in: an `engine.create` hook returns `$.mods` with REAL function members (a Proxy is refused),
 * which only makes the noun exist; every `mods.*` event is answered by a hook from memory, and the hub's public
 * state the mod reads (`tab`, `mode`, `control`) by `state.get` hooks with matchers. Register it before the first
 * `$` call, like any other test hook, and at most once per test.
 */
import type { On } from 'claude-code'

import type {
  Mods,
  ModsChannelInput,
  ModsControl,
  ModsHelloInput,
  ModsMode,
  ModsNotice,
  ModsNotifyInput,
  ModsPublishInput,
  ModsSetModeInput,
  ModsTabInput,
} from '../types/mods-hub'

/** The hub's mode on a quiet afternoon: the person is here, nothing silenced. */
export const HERE: ModsMode = {
  presence: 'here',
  isSilent: false,
  silentUntil: null,
  isNight: false,
  isNightOn: true,
  quietHours: '22:00-07:00',
  idleMinutes: 10,
  awayMinutes: 30,
  interaction: 'auto',
  canAsk: false,
}

/** What the stand-in hub was asked, and what it answers with. */
export type FakeHub = {
  mode: ModsMode
  /** The shared panel's tab shown (`mods-hub.tab` state); `showTab` sets it. */
  tab: string
  published: ModsPublishInput[]
  notified: ModsNotifyInput[]
  hellos: ModsHelloInput[]
  tabs: ModsTabInput[]
  shown: string[]
  facts: Map<string, unknown>
  modes: ModsSetModeInput[]
  presences: { presence: 'auto' | 'away' | 'here'; reason?: string }[]
  channels: ModsChannelInput[]
  statuses: { id: string; status: string; detail?: string }[]
  /**
   * Notices waiting for a pull channel, oldest first. `drain({ after })` acknowledges up to `after` and returns the
   * rest without removing them (at-least-once); `drain({ channel })` without `after` empties it.
   */
  outbox: ModsNotice[]
  /** Every `$.mods.stop` call as the hub answered it; the last one is the `control` state. */
  controls: ModsControl[]
  /** What `recent` / `latest` answer, oldest first; `stop` adds its `control.<action>` here. */
  events: { topic: string; data: unknown; at: number; source: string }[]
}

const METHODS = [
  'publish', 'recent', 'latest', 'notify', 'mode', 'setMode', 'setPresence', 'registerTab', 'showTab', 'registerChannel',
  'channelStatus', 'deliver', 'drain', 'stop', 'hello', 'installed', 'share', 'read',
] as const satisfies readonly (keyof Mods)[]

/** Never reached: every method the mod calls is answered by a hook below. It only makes `$.mods` exist. */
const BOTTOM = Object.fromEntries(METHODS.map(method => [method, async () => undefined])) as unknown as Mods

/**
 * Stands for mods-hub in a test: provides `$.mods` (as the hub's `engine.create` does) and answers every
 * `mods.*` event from memory. Register it before the first `$` call, like any other test hook; pass the
 * test's mock clock when the mod sets Silent for some minutes or raises a stop.
 */
export function fakeHub(on: On, mode: Partial<ModsMode> = {}, clock: { now: () => number } = { now: () => 0 }): FakeHub {
  const hub: FakeHub = {
    mode: { ...HERE, ...mode },
    tab: 'home',
    published: [],
    notified: [],
    hellos: [],
    tabs: [],
    shown: [],
    facts: new Map(),
    modes: [],
    presences: [],
    channels: [],
    statuses: [],
    outbox: [],
    controls: [],
    events: [],
  }
  let seq = 0
  const event = (e: (typeof hub.events)[number]) => ({ id: `e${(seq += 1)}`, topic: e.topic, data: e.data as never, source: e.source, at: e.at, session: 's1', scope: 'session' as const })
  on('engine.create', async (_$, e, next) => ({ ...(await next(e)), mods: BOTTOM }))
  on('mods.publish', (_$, e) => {
    hub.published.push(e)
    return { value: { id: `p${hub.published.length}` } }
  })
  on('mods.notify', (_$, e) => {
    hub.notified.push(e)
    return { value: { id: `n${hub.notified.length}`, targets: hub.mode.isSilent ? [] : ['toast'], held: false } }
  })
  on('mods.mode', () => ({ value: hub.mode }))
  on('mods.setMode', (_$, e) => {
    hub.modes.push(e)
    if (e.interaction !== undefined) hub.mode = { ...hub.mode, interaction: e.interaction, canAsk: e.interaction === 'on' }
    if (e.isNightOn !== undefined) hub.mode = { ...hub.mode, isNightOn: e.isNightOn, isNight: e.isNightOn }
    const minutes = typeof e.silentMinutes === 'number' && e.silentMinutes > 0 ? e.silentMinutes : null
    if (e.isSilent !== undefined) {
      hub.mode = { ...hub.mode, isSilent: e.isSilent, silentUntil: e.isSilent && minutes !== null ? clock.now() + 60_000 * minutes : null }
    } else if (e.silentMinutes !== undefined) {
      hub.mode = { ...hub.mode, isSilent: minutes !== null, silentUntil: minutes === null ? null : clock.now() + 60_000 * minutes }
    }
    return { value: hub.mode }
  })
  on('mods.setPresence', (_$, e) => {
    hub.presences.push(e)
    hub.mode = { ...hub.mode, presence: e.presence === 'auto' ? 'here' : e.presence }
    return { value: hub.mode }
  })
  on('mods.hello', (_$, e) => {
    hub.hellos.push(e)
    return { value: { installed: { hello: [], plugins: [], listedAt: null } } }
  })
  on('mods.registerTab', (_$, e) => {
    hub.tabs.push(e)
    return { value: { tabs: hub.tabs.map(tab => ({ order: 50, ...tab, owner: 'test' })) } }
  })
  on('mods.showTab', (_$, e) => {
    hub.shown.push(e.id)
    hub.tab = e.id
    return { value: { isPlaced: true } }
  })
  on('mods.share', (_$, e) => {
    hub.facts.set(e.name, e.value)
    return { value: { key: e.name, owner: 'test', value: e.value, at: 0 } }
  })
  on('mods.registerChannel', (_$, e) => {
    hub.channels.push(e)
    return { value: { channels: [] } }
  })
  on('mods.channelStatus', (_$, e) => {
    hub.statuses.push(e)
    return { value: { channels: [] } }
  })
  on('mods.drain', (_$, e) => {
    if (e.after === undefined) {
      const waiting = hub.outbox
      hub.outbox = []
      return { value: waiting }
    }
    const handled = e.after === null ? -1 : hub.outbox.findIndex(notice => notice.id === e.after)
    hub.outbox = hub.outbox.slice(handled + 1)
    return { value: hub.outbox }
  })
  on('mods.stop', (_$, e, next) => {
    const control: ModsControl = {
      id: `c${hub.controls.length + 1}`,
      action: e.action ?? 'stop',
      scope: e.scope ?? 'session',
      reason: e.reason,
      by: e.by ?? next.origin.plugin,
      session: 's1',
      source: next.origin.plugin,
      at: clock.now(),
    }
    hub.controls.push(control)
    hub.events.push({ topic: `control.${control.action}`, data: { id: control.id, scope: control.scope, reason: control.reason, by: control.by, session: control.session }, at: control.at, source: control.source })
    return { value: control }
  })
  on('mods.recent', (_$, e) => ({
    value: hub.events
      .filter(one => (e.topic === undefined || one.topic === e.topic) && (e.prefix === undefined || one.topic.startsWith(e.prefix)) && (e.since === undefined || one.at > e.since))
      .map(event),
  }))
  on('mods.latest', (_$, e) => {
    const found = hub.events.filter(one => one.topic === e.topic).at(-1)
    return { value: found === undefined ? null : event(found) }
  })
  on('state.get', { plugin: 'mods-hub', key: 'tab' }, () => ({ value: { value: hub.tab, version: 1 } }))
  on('state.get', { plugin: 'mods-hub', key: 'mode' }, () => ({ value: { value: hub.mode, version: 1 } }))
  on('state.get', { plugin: 'mods-hub', key: 'control' }, () => ({ value: { value: hub.controls.at(-1) ?? null, version: hub.controls.length } }))
  return hub
}
