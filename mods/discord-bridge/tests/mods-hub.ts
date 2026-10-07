import type { Engine, Plugin } from 'claude-code/testing'

import type { ModsMode } from '../types/mods-hub'

/**
 * A stand-in for mods-hub: the `$.mods` noun, a mode that follows the hub's formula, and a router that delivers to
 * channels. Its hooks are run by the engine on their own, so everything they use lives inside `register`; the tests
 * reach its state through Bash commands (`hub-state`, `hub-set <json>`, `hub-deliver <json>`).
 */
export const hub: Plugin = {
  name: 'mods-hub',
  register(on) {
    const state = {
      isDown: false,
      mode: { presence: 'away', isSilent: false, silentUntil: null, isNight: false, quietHours: '22:00-07:00', interaction: 'auto', canAsk: true } as Record<string, unknown>,
      channels: [] as Record<string, unknown>[],
      statuses: [] as string[],
      published: [] as { topic: string; data: unknown }[],
      notices: [] as Record<string, unknown>[],
      tabs: [] as { id: string; title: string }[],
      tab: 'home',
      hellos: [] as string[],
      controls: [] as Record<string, unknown>[],
    }
    const settle = (): void => {
      const mode = state.mode
      const interaction = String(mode.interaction)
      mode.canAsk = interaction === 'on' ? mode.isNight !== true : interaction === 'auto' ? mode.presence === 'away' && mode.isNight !== true : false
    }
    const down = { deny: 'mods-hub is not answering' }
    const names = ['publish', 'recent', 'latest', 'notify', 'mode', 'setMode', 'setPresence', 'registerTab', 'showTab', 'registerChannel', 'channelStatus', 'deliver', 'drain', 'hello', 'installed', 'share', 'read', 'stop']
    const bottom = Object.fromEntries(names.map(name => [name, async () => { throw new Error('mods-hub is not answering') }]))

    on('engine.create', async ($, e, next) => ({ ...(await next(e)), mods: bottom as never }))
    on('mods.mode', () => (state.isDown ? down : { value: state.mode as never }))
    on('mods.setMode', (_$, e) => {
      if (state.isDown) return down
      if (e.interaction !== undefined) state.mode.interaction = e.interaction
      if (e.isNightOn !== undefined) state.mode.isNight = e.isNightOn
      if (e.isSilent !== undefined) state.mode.isSilent = e.isSilent
      else if (e.silentMinutes !== undefined) state.mode.isSilent = e.silentMinutes !== null && e.silentMinutes > 0
      settle()
      return { value: state.mode as never }
    })
    on('mods.setPresence', (_$, e) => {
      if (state.isDown) return down
      state.mode.presence = e.presence === 'away' ? 'away' : 'here'
      settle()
      return { value: state.mode as never }
    })
    on('mods.registerChannel', (_$, e) => {
      if (state.isDown) return down
      state.channels = [...state.channels.filter(one => one.id !== e.id), { ...e, owner: 'bridge' }]
      return { value: { channels: state.channels as never } }
    })
    on('mods.channelStatus', (_$, e) => {
      state.statuses.push(`${e.id}:${e.status}`)
      return { value: { channels: state.channels as never } }
    })
    on('mods.hello', (_$, e) => {
      if (state.isDown) return down
      state.hellos.push(`${e.version}:${(e.publishes ?? []).join(',')}`)
      return { value: { installed: { hello: [], plugins: [], listedAt: null } } }
    })
    on('mods.registerTab', (_$, e) => {
      if (state.isDown) return down
      state.tabs.push({ id: e.id, title: e.title })
      return { value: { tabs: [] } }
    })
    on('mods.showTab', (_$, e) => {
      if (state.isDown) return down
      state.tab = e.id
      return { value: { isPlaced: true } }
    })
    on('mods.publish', (_$, e) => {
      if (state.isDown) return down
      state.published.push({ topic: e.topic, data: e.data })
      return { value: { id: 'e1' } }
    })
    on('mods.stop', (_$, e) => {
      if (state.isDown) return down
      state.controls.push({ ...e })
      return { value: { id: 'c1', scope: e.scope ?? 'session', reason: e.reason, by: e.by ?? 'x', session: 's', action: e.action ?? 'stop', source: 'bridge', at: 0 } as never }
    })
    on('mods.notify', async ($, e) => {
      if (state.isDown) return down
      state.notices.push({ ...e })
      const mode = state.mode
      const channel = state.channels.find(one => one.audience === (e.audience === 'team' ? 'team' : 'me'))
      const isQuestionBlocked = e.kind === 'question' && mode.canAsk !== true
      const goes = channel !== undefined && !isQuestionBlocked && (e.level === 'critical' || e.audience === 'team' || (mode.presence === 'away' && e.level !== 'info'))
      if (channel === undefined || !goes) return { value: { id: 'n1', targets: ['toast'], held: false, reason: 'the stand-in keeps it on the terminal' } }
      const id = String(channel.id)
      await $.mods.deliver({ channel: id, notice: { ...e, id: 'n1', source: 'ci-watch', at: 0, targets: ['toast', id], held: false } })
      return { value: { id: 'n1', targets: ['toast', id], held: false } }
    })
    on('state.get', (_$, e, next) => (e.plugin === 'mods-hub' && e.key === 'tab' ? { value: { value: state.tab, version: 1 } } : next(e)))
    on('tool.call', async ($, e, next) => {
      const command = e.tool === 'Bash' ? String(e.command) : ''
      if (command === 'hub-state') return { result: JSON.stringify(state) }
      if (command.startsWith('hub-set ')) {
        const change = JSON.parse(command.slice('hub-set '.length)) as { isDown?: boolean; tab?: string; mode?: Record<string, unknown> }
        if (change.isDown !== undefined) state.isDown = change.isDown
        if (change.tab !== undefined) state.tab = change.tab
        Object.assign(state.mode, change.mode ?? {})
        settle()
        return { result: 'ok' }
      }
      if (command.startsWith('hub-deliver ')) {
        const notice = JSON.parse(command.slice('hub-deliver '.length)) as { channel: string; id: string; level: string; title: string; source: string; at: number; targets: string[]; held: boolean }
        return { result: JSON.stringify(await $.mods.deliver({ channel: notice.channel, notice: notice as never })) }
      }
      return next(e)
    })
  },
}

export type HubSnapshot = {
  isDown: boolean
  mode: ModsMode
  channels: { id: string; audience: string; delivery: string }[]
  statuses: string[]
  published: { topic: string; data: Record<string, unknown> }[]
  notices: { level: string; title: string; body?: string; audience?: string; kind?: string }[]
  tabs: { id: string; title: string }[]
  tab: string
  hellos: string[]
  controls: { action?: string; scope?: string; reason: string; by?: string }[]
}

const bash = async ($: Engine, command: string): Promise<string> => String(((await $.tool.call({ tool: 'Bash', command })) as { result?: unknown }).result)

export const hubState = async ($: Engine): Promise<HubSnapshot> => JSON.parse(await bash($, 'hub-state')) as HubSnapshot

/** Changes the stand-in: the mode (presence, interaction, night, silent), whether it answers, the shared panel's tab. */
export const hubSet = async ($: Engine, change: { isDown?: boolean; tab?: string; mode?: Partial<ModsMode> }): Promise<void> => {
  await bash($, `hub-set ${JSON.stringify(change)}`)
}

/** The hub hands a notice to a channel, as it does for a push channel: the channel's answer. */
export const hubDeliver = async ($: Engine, channel: string, notice: { level: string; title: string; body?: string; source?: string }): Promise<{ isDelivered: boolean }> =>
  JSON.parse(await bash($, `hub-deliver ${JSON.stringify({ id: 'n1', source: 'ci-watch', at: 0, targets: [channel], held: false, channel, ...notice })}`)) as { isDelivered: boolean }
