import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

/** Answers `$.state` from memory, as the host does: a value and the version it stands at. */
const memoryState = (on: On) => {
  const cells = new Map<string, { value: unknown; version: number }>()
  const keyOf = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('state.get', (_$, e) => ({ value: cells.get(keyOf(e)) ?? { value: undefined, version: 0 } }))
  on('state.set', (_$, e) => {
    const held = cells.get(keyOf(e)) ?? { value: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) {
      return { value: { isSet: false, version: held.version } }
    }
    cells.set(keyOf(e), { value: e.value, version: held.version + 1 })
    return { value: { isSet: true, version: held.version + 1 } }
  })
}

/** Web tools that succeed, except for a URL containing "broken" (error) or "blocked" (refused). */
const web = (on: On) => {
  memoryState(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 7, 12, 0, 0) })
  on('tool.call', (_$, e) => {
    const target = e.tool === 'WebFetch' ? e.url : e.tool === 'WebSearch' ? e.query : ''
    if (target.includes('blocked')) return { deny: 'domain not allowed' }
    return target.includes('broken') ? { isError: true as const, result: 'HTTP 500' } : { result: 'ok' }
  })
}

const fetchPage = ($: Engine, url: string) =>
  $.tool.call({ tool: 'WebFetch', url, prompt: 'summarise' })

const search = ($: Engine, query: string) => $.tool.call({ tool: 'WebSearch', query, mode: 'standard' })

const sources = async ($: Engine) =>
  (
    await $.command.run({
      command: 'sources',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  ).text ?? ''

test('registers /sources when the session starts', async ($, on) => {
  const registered: string[] = []
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['sources'])
})

test('lists fetched pages and searches as a Markdown list in order', async ($, on) => {
  web(on)
  await fetchPage($, 'https://example.com/docs')
  await search($, 'react `use` hook')
  await fetchPage($, 'https://example.com/broken')

  const lines = (await sources($)).split('\n')

  expect(lines[0]).toBe('**web-trail:** 2 pages fetched, 1 search this session')
  expect(lines[2]).toMatch(/^- \*\*\d\d:\d\d:\d\d\*\* fetched <https:\/\/example\.com\/docs>$/)
  expect(lines[3]).toMatch(/^- \*\*\d\d:\d\d:\d\d\*\* searched `react 'use' hook`$/)
  expect(lines[4]).toMatch(/fetched <https:\/\/example\.com\/broken> \(failed\)$/)
})

test('leaves out calls that were refused, and says so when there is nothing yet', async ($, on) => {
  web(on)
  expect(await sources($)).toContain('has not fetched or searched anything yet')

  await fetchPage($, 'https://blocked.example.com')

  expect(await sources($)).toContain('has not fetched or searched anything yet')
})
