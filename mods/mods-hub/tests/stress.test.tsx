import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * Load: ~165 mods call `hubMode` / `hello` / `registerTab` / `recent` / `latest` / `publish` at session.start and on
 * their timers, so the hub sees hundreds of `mods.*` calls at once. They must all be answered quickly, from memory,
 * without a state write (or a file read) per call.
 */

const NOON = new Date(2026, 9, 7, 12, 0, 0).getTime()

type Burst = { n: number; method: string; input?: (i: number) => unknown }

/** A mod that fires `n` concurrent `$.mods.<method>` calls when a Bash command `burst <json>` reaches it. */
const burster: Plugin = {
  name: 'burster',
  register(on) {
    on('tool.call', async ($, e, next) => {
      if (e.tool !== 'Bash' || !String(e.command).startsWith('burst ')) return next(e)
      const calls = JSON.parse(String(e.command).slice(6)) as { method: string; inputs: unknown[] }[]
      const one = (method: string, input: any): Promise<unknown> => {
        switch (method) {
          case 'mode': return $.mods.mode()
          case 'hello': return $.mods.hello(input)
          case 'registerTab': return $.mods.registerTab(input)
          case 'publish': return $.mods.publish(input)
          case 'recent': return $.mods.recent(input)
          case 'latest': return $.mods.latest(input)
          case 'installed': return $.mods.installed()
          case 'notify': return $.mods.notify(input)
          case 'inbox': return $.state.get({ plugin: 'mods-hub', key: 'inbox' }).then(read => read.value ?? [])
          default: return Promise.reject(new Error(`no ${method}`))
        }
      }
      const settled = await Promise.allSettled(calls.flatMap(call => call.inputs.map(input => one(call.method, input))))
      const failed = settled.filter(one => one.status === 'rejected').map(one => String((one as PromiseRejectedResult).reason))
      const values = settled.map(one => (one.status === 'fulfilled' ? one.value : null))
      return { result: JSON.stringify({ ok: settled.length - failed.length, failed: failed.slice(0, 3), last: values.at(-1) }) }
    })
  },
}

type Counts = { stateSets: number; fsReads: number; fsLists: number; processRuns: number }

function world(on: On): { clock: ReturnType<typeof mock.clock>; counts: Counts } {
  const clock = mock.clock(on, { now: NOON })
  mock.env(on, { HOME: '/home/me' })
  const counts: Counts = { stateSets: 0, fsReads: 0, fsLists: 0, processRuns: 0 }
  const files = new Map<string, string>()
  on('state.set', ($, e, next) => {
    counts.stateSets += 1
    return next(e)
  })
  on('fs.read', ($, e) => {
    counts.fsReads += 1
    return files.has(e.path) ? { value: files.get(e.path) ?? '' } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => {
    counts.fsLists += 1
    return { deny: 'ENOENT' }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => {
    counts.processRuns += 1
    return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  return { clock, counts }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/shop', surface: 'terminal', isInteractive: true })

async function burst($: Engine, bursts: Burst[]): Promise<{ ok: number; failed: string[]; last: any; ms: number }> {
  const calls = bursts.map(one => ({ method: one.method, inputs: Array.from({ length: one.n }, (_, i) => (one.input === undefined ? undefined : one.input(i))) }))
  const started = Date.now()
  const ran = await $.tool.call({ tool: 'Bash', command: `burst ${JSON.stringify(calls)}` })
  const ms = Date.now() - started
  ;(globalThis as unknown as { console: { log: (text: string) => void } }).console.log(`burst ${bursts.map(one => `${one.n}x${one.method}`).join(' + ')}: ${ms} ms`)
  return { ...(JSON.parse(String((ran as { result?: unknown }).result)) as { ok: number; failed: string[]; last: any }), ms }
}

test('500 concurrent mods.mode calls are answered from memory in well under a second, with no state write or file read each', { plugins: [burster] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  const before = { ...w.counts }
  const ran = await burst($, [{ n: 500, method: 'mode' }])
  expect(ran.failed).toEqual([])
  expect(ran.ok).toBe(500)
  expect(ran.last).toMatchObject({ presence: 'here', isSilent: false })
  expect(ran.ms).toBeLessThan(1_000)
  // A mode read writes nothing and reads no file.
  expect(w.counts.stateSets - before.stateSets).toBeLessThan(5)
  expect(w.counts.fsReads - before.fsReads).toBe(0)
})

test('a session.start storm: 165 mods say hello, register a tab, read the mode, publish and read recent at once', { plugins: [burster] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  const before = { ...w.counts }
  const ran = await burst($, [
    { n: 165, method: 'mode' },
    { n: 165, method: 'hello', input: i => ({ version: `1.0.${i}`, publishes: ['x.burster.ping'] }) },
    { n: 165, method: 'registerTab', input: i => ({ id: `tab-${i}`, title: `Tab ${i}` }) },
    { n: 165, method: 'publish', input: i => ({ topic: 'x.burster.ping', data: { i } }) },
    { n: 165, method: 'recent', input: () => ({ prefix: 'x.burster.', limit: 5 }) },
    { n: 165, method: 'latest', input: () => ({ topic: 'x.burster.ping' }) },
    { n: 50, method: 'installed' },
  ])
  expect(ran.failed).toEqual([])
  expect(ran.ok).toBe(165 * 6 + 50)
  expect(ran.ms).toBeLessThan(5_000) // 50 s and 11 s before the fix; ~1-1.7 s alone, more on a loaded machine
  // Writes are coalesced: far fewer state writes than calls, no listing per `installed()`.
  await w.clock.settle()
  expect(w.counts.stateSets - before.stateSets).toBeLessThan(165 * 2)
  expect(w.counts.processRuns - before.processRuns).toBeLessThanOrEqual(1)
  expect(w.counts.fsReads - before.fsReads).toBe(0)

  // Every hello and every tab landed, and the feed holds the latest events.
  const after = await burst($, [{ n: 1, method: 'installed' }])
  expect(after.last.hello).toHaveLength(1)
  const tabs = await burst($, [{ n: 1, method: 'registerTab', input: () => ({ id: 'tab-last', title: 'Last' }) }])
  expect(tabs.last.tabs).toHaveLength(166)
  const recent = await burst($, [{ n: 1, method: 'recent', input: () => ({ prefix: 'x.burster.' }) }])
  expect(recent.last.length).toBe(50)
})

test('500 concurrent notifications are routed, deduplicated and kept to the inbox size without crashing', { plugins: [burster] }, async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.settle()
  const ran = await burst($, [{ n: 500, method: 'notify', input: i => ({ level: 'info', title: `n${i % 250}` }) }])
  expect(ran.failed).toEqual([])
  expect(ran.ok).toBe(500)
  expect(ran.ms).toBeLessThan(5_000) // 50 s and 11 s before the fix; ~1-1.7 s alone, more on a loaded machine
  await w.clock.settle()
  const inbox = await burst($, [{ n: 1, method: 'inbox' }])
  expect(inbox.last.length).toBeGreaterThan(0)
  expect(inbox.last.length).toBeLessThanOrEqual(30)
})
