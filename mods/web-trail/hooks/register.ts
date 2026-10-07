import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { WebTrailVisit } from '../types'

const KEPT = 500

const visits = atom({ plugin: 'web-trail', key: 'visits' } as const, [])

const clockTime = (ms: number): string => {
  const date = new Date(ms)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const bullet = (visit: WebTrailVisit): string => {
  const what =
    visit.kind === 'fetch' ? `fetched <${visit.target}>` : `searched \`${visit.target.replace(/`/g, "'")}\``
  return `- **${clockTime(visit.at)}** ${what}${visit.isFailed ? ' (failed)' : ''}`
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sources',
      description: 'Lists every page Claude fetched or searched this session.',
    })
    return next(e)
  })

  on('tool.call', { tool: ['WebFetch', 'WebSearch'] }, async ($, e, next) => {
    const at = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const visit: WebTrailVisit =
      e.tool === 'WebFetch'
        ? { at, kind: 'fetch', target: e.url, isFailed: ran.isError === true }
        : { at, kind: 'search', target: e.query, isFailed: ran.isError === true }
    await update($, visits, kept => [...kept, visit].slice(-KEPT))
    return ran
  })

  on('command.run', { command: 'sources' }, async $ => {
    const all = await read($, visits)
    if (all.length === 0) return { text: 'web-trail: Claude has not fetched or searched anything yet.' }

    const pages = all.filter(visit => visit.kind === 'fetch').length
    const heading = `**web-trail:** ${count(pages, 'page')} fetched, ${count(all.length - pages, 'search')} this session`
    return { text: [heading, '', ...all.map(bullet)].join('\n') }
  })
}
