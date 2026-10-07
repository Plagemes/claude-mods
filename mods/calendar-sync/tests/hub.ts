import type { Engine, Plugin } from 'claude-code/testing'

/**
 * Stands in for mods-hub in tests: provides `$.mods`, records every call in the hub's `feed` state (topic = method,
 * data = its input, source = the plugin that called) and keeps the hub's `prefs` and `tab` state the way the real hub
 * does for setPresence / setMode / showTab. Self-contained, as a test plugin must be: it closes over nothing.
 * Read the calls with `callsOf`, set the starting prefs with `$.state.set` in the test.
 */
export const hubStandIn = (): Plugin => ({
  name: 'mods-hub',
  register(on) {
    const nothing = { hello: [], plugins: [], listedAt: null }
    on('session.start', async ($, e, next) => {
      await $.state.set({ plugin: 'mods-hub', key: 'tab' }, 'home')
      await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [])
      await $.state.set({ plugin: 'mods-hub', key: 'inbox' }, [])
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
        return { value: { installed: { hello: [], plugins: [], listedAt: null } } }
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
        // A test may make the hub refuse presence changes (`hub set-prefs {"refusePresence":true}`).
        if ((prefs as { refusePresence?: boolean } | undefined)?.refusePresence === true) return { deny: 'presence refused' }
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
      on('mods.drain', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'drain', topic: 'drain', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        const all = ((await $.state.get({ plugin: 'mods-hub', key: 'facts', id: 'script.notices' })).value?.value ?? []) as { id: string }[]
        const index = e.after === undefined || e.after === null ? -1 : all.findIndex(notice => notice.id === e.after)
        return { value: all.slice(index + 1) as never }
      })
      on('mods.latest', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'latest', topic: 'latest', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: null }
      })
      on('mods.recent', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'recent', topic: 'recent', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: [] }
      })
      on('mods.notify', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'notify', topic: 'notify', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { id: 'n', targets: ['toast'], held: false } }
      })
      on('mods.mode', async ($, e, next) => {
        await $.state.set({ plugin: 'mods-hub', key: 'feed' }, [...((await $.state.get({ plugin: 'mods-hub', key: 'feed' })).value ?? []), { id: 'mode', topic: 'mode', data: e as never, source: next.origin.plugin ?? '', at: 0, session: 's', scope: 'session' }])
        return { value: { presence: 'here' as const, isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto' as const, canAsk: false } }
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

/** Changes the hub's prefs before the calendar looks at them (what a person does with `/hub`). */
export const setPrefs = async ($: Engine, change: Record<string, unknown>): Promise<void> => {
  await ask($, `hub set-prefs ${JSON.stringify(change)}`)
}
