import type { Engine, Plugin } from 'claude-code/testing'

/**
 * Stands in for mods-hub in tests: provides `$.mods`, records every call in the hub's `feed` state (topic = method,
 * data = its input, source = the plugin that called), keeps the hub's `prefs` and `tab` state the way the real hub
 * does for setPresence / setMode / showTab, and answers recent / latest / read / drain / installed from facts the test
 * scripts with `script($, id, value)`. Self-contained, as a test plugin must be: it closes over nothing.
 */
export const hubStandIn = (): Plugin => ({
  name: 'mods-hub',
  register(on) {
    const nothing = { hello: [], plugins: [], listedAt: null }
    on('session.start', async ($, e, next) => {
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, 'home')
      await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [])
      await $.state.set(
        { plugin: 'mods-hub', key: 'prefs' },
        {
          interaction: 'auto',
          silentUntil: null,
          isSilent: false,
          isNightOn: true,
          quietHours: '22:00-07:00',
          presence: 'auto',
          routes: { info: 'terminal', success: 'away', warning: 'away', error: 'away', critical: 'always' },
          channels: {},
        },
      )
      return next(e)
    })
    // The test reaches the hub's state through a Bash command, as mods-hub's own tests do with their probe.
    on('tool.call', async ($, e, next) => {
      if (e.tool !== 'Bash' || !String(e.command).startsWith('hub ')) return next(e)
      const [verb = '', ...rest] = String(e.command).slice(4).split(' ')
      const prefs = (await $.state.get({ plugin: 'mods-hub', key: 'prefs' })).value
      if (verb === 'set-prefs' && prefs !== undefined) await $.state.set({ plugin: 'mods-hub', key: 'prefs' }, { ...prefs, ...JSON.parse(rest.join(' ')) })
      if (verb === 'script') await $.state.set({ plugin: 'mods-hub', key: 'facts', id: rest[0] ?? '' }, { key: rest[0] ?? '', owner: 'test', value: JSON.parse(rest.slice(1).join(' ')), at: 0 })
      const value =
        verb === 'feed' ? (await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value : verb === 'tab' ? (await $.state.get({ plugin: 'mods-hub', key: 'tab' })).value : (await $.state.get({ plugin: 'mods-hub', key: 'prefs' })).value
      return { result: JSON.stringify(value ?? null) }
    })
    on('engine.create', async ($, e, next) => ({
      ...(await next(e)),
      mods: {
        publish: async () => ({ id: '' }),
        recent: async () => [],
        latest: async () => null,
        notify: async () => ({ id: '', targets: [], held: false }),
        mode: async () => ({ presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: false }),
        setMode: async () => ({ presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: false }),
        setPresence: async () => ({ presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: false }),
        registerTab: async () => ({ tabs: [] }),
        showTab: async () => ({ isPlaced: false }),
        registerChannel: async () => ({ channels: [] }),
        channelStatus: async () => ({ channels: [] }),
        deliver: async () => ({ isDelivered: false }),
        drain: async () => [],
        stop: async () => ({ id: '', scope: 'session' as const, reason: '', by: '', session: '', action: 'stop' as const, source: '', at: 0 }),
        hello: async () => ({ installed: nothing }),
        installed: async () => nothing,
        share: async input => ({ key: input.name, owner: '', value: input.value, at: 0 }),
        read: async () => null,
      },
    }))
      on('mods.publish', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'publish', topic: 'publish', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { id: 'evt' } }
      })
      on('mods.share', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'share', topic: 'share', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { key: `x.${e.name}`, owner: 'x', value: e.value, at: 0 } }
      })
      on('mods.hello', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'hello', topic: 'hello', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { installed: nothing } }
      })
      on('mods.registerTab', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'registerTab', topic: 'registerTab', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { tabs: [] } }
      })
      on('mods.showTab', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'showTab', topic: 'showTab', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        await $.state.set({ plugin: 'mods-hub', key: 'tab' }, e.id)
        return { value: { isPlaced: true } }
      })
      on('mods.setPresence', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'setPresence', topic: 'setPresence', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        const prefs = (await $.state.get({ plugin: 'mods-hub', key: 'prefs' })).value
        if (prefs !== undefined) await $.state.set({ plugin: 'mods-hub', key: 'prefs' }, { ...prefs, presence: e.presence })
        return { value: { presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: false } }
      })
      on('mods.setMode', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'setMode', topic: 'setMode', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        const prefs = (await $.state.get({ plugin: 'mods-hub', key: 'prefs' })).value
        if (prefs !== undefined) await $.state.set({ plugin: 'mods-hub', key: 'prefs' }, { ...prefs, ...(e.isNightOn === undefined ? {} : { isNightOn: e.isNightOn }), ...(e.quietHours === undefined ? {} : { quietHours: e.quietHours }), ...(e.interaction === undefined ? {} : { interaction: e.interaction }) })
        return { value: { presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: false } }
      })
      on('mods.registerChannel', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'registerChannel', topic: 'registerChannel', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { channels: [] } }
      })
      on('mods.channelStatus', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'channelStatus', topic: 'channelStatus', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { channels: [] } }
      })
      on('mods.notify', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'notify', topic: 'notify', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { id: 'n', targets: ['toast'], held: false } }
      })
      on('mods.mode', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'mode', topic: 'mode', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: false } }
      })
      on('mods.drain', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'drain', topic: 'drain', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        const all = ((await $.state.get({ plugin: 'mods-hub', key: 'facts', id: 'script.notices' })).value?.value ?? []) as { id: string }[]
        const index = e.after === undefined || e.after === null ? -1 : all.findIndex(notice => notice.id === e.after)
        return { value: all.slice(index + 1) as never }
      })
      on('mods.recent', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'recent', topic: 'recent', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        const all = ((await $.state.get({ plugin: 'mods-hub', key: 'facts', id: 'script.recent' })).value?.value) ?? []
        return { value: (all as { at: number }[]).filter(event => event.at > (e.since ?? 0)) as never }
      })
      on('mods.latest', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'latest', topic: 'latest', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        const found = ((await $.state.get({ plugin: 'mods-hub', key: 'facts', id: `latest.${e.topic}` })).value?.value) ?? null
        return { value: found as never }
      })
      on('mods.read', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'read', topic: 'read', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        const found = ((await $.state.get({ plugin: 'mods-hub', key: 'facts', id: `read.${e.key}` })).value?.value) ?? null
        return { value: found === null ? null : { key: e.key, owner: 'x', value: found, at: 0 } }
      })
      on('mods.installed', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'installed', topic: 'installed', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        const plugins = ((await $.state.get({ plugin: 'mods-hub', key: 'facts', id: 'script.installed' })).value?.value) ?? []
        return { value: { hello: [], plugins: plugins as never, listedAt: 0 } }
      })
  },
})

const ask = async ($: Engine, command: string): Promise<unknown> => JSON.parse(String(((await $.tool.call({ tool: 'Bash', command })) as { result?: unknown }).result)) as unknown

/** The calls a plugin made on `$.mods`, by method: their inputs, in order. */
export async function callsOf($: Engine, method: string, source: string): Promise<unknown[]> {
  const feed = (await ask($, 'hub feed')) as { topic: string; data: unknown; source: string }[]
  return feed.filter(entry => entry.topic === method && entry.source === source).map(entry => entry.data)
}

/** The hub's `prefs` state as the stand-in holds it. */
export const prefsOf = ($: Engine): Promise<unknown> => ask($, 'hub prefs')

/** Changes the hub's prefs (what a person does with `/hub`). */
export const setPrefs = async ($: Engine, change: Record<string, unknown>): Promise<void> => {
  await ask($, `hub set-prefs ${JSON.stringify(change)}`)
}

/** Scripts what the hub answers: `script.recent` (events), `script.notices` (queued for a channel), `latest.<topic>` (an event), `read.<key>` (a fact's value), `script.installed` (plugins). */
export const script = async ($: Engine, id: string, value: unknown): Promise<void> => {
  await ask($, `hub script ${id} ${JSON.stringify(value)}`)
}
