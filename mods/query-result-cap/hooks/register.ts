import type { Register } from 'claude-code'

import { capQueries } from './cap'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1_000_000

const limitFrom = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, MAX_LIMIT) : DEFAULT_LIMIT

const noteFor = (count: number, limit: number): string =>
  `query-result-cap: ${count === 1 ? 'the SELECT in this command had' : `${count} SELECTs in this command had`} no row limit, so " LIMIT ${limit}" was added ` +
  `(the command shown is the one that ran). If you need more rows, add your own LIMIT, aggregate in SQL, or write the result to a file; ` +
  'put /* nocap */ in the SQL to leave a query alone.'

export const register: Register = (on, options) => {
  const limit = limitFrom(options.limit)

  on('tool.call', { tool: 'Bash' }, async (_$, e, next) => {
    const capped = capQueries(e.command, limit)
    if (capped === undefined) return next(e)

    const ran = await next({ ...e, command: capped.command })
    return ran.deny === undefined ? { ...ran, context: [...(ran.context ?? []), noteFor(capped.count, limit)] } : ran
  }).catch(($, e, next) => next(e))
}
