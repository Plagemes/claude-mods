import type { On } from 'claude-code'

import type {
  Mods,
  ModsChannelInput,
  ModsDrainInput,
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
  quietHours: '22:00-07:00',
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
  /** Notices waiting for a pull channel; a `drain` with a cursor drops what it acknowledges, one without empties it. */
  outbox: ModsNotice[]
  /** Every `drain` the mod made. */
  drains: ModsDrainInput[]
  /** What `recent` / `latest` answer, oldest first. */
  events: { topic: string; data: unknown; at: number; source: string }[]
}

const METHODS = [
  'publish', 'recent', 'latest', 'notify', 'mode', 'setMode', 'setPresence', 'registerTab', 'showTab', 'registerChannel',
  'channelStatus', 'deliver', 'drain', 'hello', 'installed', 'share', 'read',
] as const satisfies readonly (keyof Mods)[]

/** Never reached: every method the mod calls is answered by a hook below. It only makes `$.mods` exist. */
const BOTTOM = Object.fromEntries(METHODS.map(method => [method, async () => undefined])) as unknown as Mods

/**
 * Stands for mods-hub in a test: provides `$.mods` (as the hub's `engine.create` does) and answers every
 * `mods.*` event from memory. Register it before the first `$` call, like any other test hook; pass the
 * test's mock clock when the mod sets Silent for some minutes.
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
    drains: [],
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
    if (e.isNightOn !== undefined) hub.mode = { ...hub.mode, isNight: e.isNightOn }
    if (e.silentMinutes !== undefined) {
      const isSilent = e.silentMinutes !== null && e.silentMinutes > 0
      hub.mode = { ...hub.mode, isSilent, silentUntil: isSilent ? clock.now() + 60_000 * (e.silentMinutes ?? 0) : null }
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
    hub.drains.push(e)
    if (e.after === undefined) {
      const waiting = hub.outbox
      hub.outbox = []
      return { value: waiting }
    }
    // The cursor contract: drop everything up to and including `after`, return what is left without removing it.
    hub.outbox = hub.outbox.slice(hub.outbox.findIndex(notice => notice.id === e.after) + 1)
    return { value: [...hub.outbox] }
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
  return hub
}
