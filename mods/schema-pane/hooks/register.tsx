import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SchemaPaneSnapshot as Snapshot, SchemaPaneTable as Table } from '../types'
import { errorSummary, parseRows, readOnlyQuery } from './client'
import type { Invocation } from './client'
import { ENV_VAR, ENV_FILES, SQLITE_FALLBACKS, describeTarget, environmentRisk, parseEnv, resolveUrl } from './db'
import type { DbTarget } from './db'
import { buildTables, compactSchema, filterTables, schemaQueries } from './schema'

const PANE = 'schema'
const SECTION_ID = 'schema-pane:schema'
const QUERY_TIMEOUT_MS = 20_000
const REFRESH_DELAY_MS = 1500
const SEND_LIMIT_CHARS = 40_000
const DEFAULT_CONTEXT_CHARS = 6000
const MAX_TABLES_DRAWN = 300
const NAME_WIDTH_MAX = 24
const TYPE_WIDTH_MAX = 22
const SCHEMA_CHANGING = /\b(?:migrate|migrations?|db:push|db\s+push|db:schema:load|db:reset|alembic|flyway|goose|sqlx|diesel)\b/
const EMPTY: Snapshot = { phase: 'idle', label: '', source: '', tables: [], error: null, loadedAt: 0 }

const snapshot = atom({ plugin: 'schema-pane', key: 'snapshot' } as const, EMPTY)
const expanded = atom({ plugin: 'schema-pane', key: 'expanded' } as const, [])
const filter = atom({ plugin: 'schema-pane', key: 'filter' } as const, '')
const isInjected = atom({ plugin: 'schema-pane', key: 'isInjected' } as const, false)

type Settings = { maxContextChars: number }
type Found = { ok: true; target: DbTarget; source: string } | { ok: false; error: string }
type Ran = { ok: true; stdout: string } | { ok: false; error: string }
type Timers = { refresh: Timer | undefined }

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => false)
}

/** The project's database, only when it is on this machine: the variable from the environment or an env file, else a framework's SQLite file. */
async function findDatabase($: EngineInterface): Promise<Found> {
  const root = (await $.session.cwd()).replace(/[\\/]+$/, '')
  let url = (await $.env.get('DATABASE_URL').catch(() => undefined))?.trim()
  let source = 'the environment'
  if (url === undefined || url === '') {
    url = undefined
    for (const file of ENV_FILES) {
      const text = await readText($, `${root}/${file}`)
      const value = text === undefined ? undefined : parseEnv(text).get(ENV_VAR)?.trim()
      if (value !== undefined && value !== '') {
        url = value
        source = file
        break
      }
    }
  }
  if (url === undefined) {
    for (const file of SQLITE_FALLBACKS) {
      if (await exists($, `${root}/${file}`)) return { ok: true, target: { kind: 'sqlite', path: `${root}/${file}` }, source: `${file}, no ${ENV_VAR} set` }
    }
    return { ok: false, error: `No ${ENV_VAR} in the environment or in .env, and no SQLite database in the usual places.` }
  }

  const resolved = resolveUrl(url, root)
  if (!resolved.ok) return { ok: false, error: `${ENV_VAR} from ${source} was not used: ${resolved.reason}. Only databases on this machine are read.` }
  if ('target' in resolved) {
    const risk = environmentRisk(resolved.target, {
      PGHOSTADDR: await $.env.get('PGHOSTADDR').catch(() => undefined),
      PGSERVICE: await $.env.get('PGSERVICE').catch(() => undefined),
      PGHOST: await $.env.get('PGHOST').catch(() => undefined),
    })
    if (risk !== undefined) return { ok: false, error: `Refused: ${risk}, which could send the connection elsewhere.` }
    return { ok: true, target: resolved.target, source }
  }
  // Prisma resolves `file:` paths from the schema's folder.
  const prisma = /^file:/i.test(url) ? resolveUrl(url, `${root}/prisma`) : undefined
  const candidates = [...(prisma !== undefined && prisma.ok && 'sqlitePaths' in prisma ? prisma.sqlitePaths : []), ...resolved.sqlitePaths]
  for (const path of candidates) {
    if (await exists($, path)) return { ok: true, target: { kind: 'sqlite', path }, source }
  }
  return { ok: false, error: `${ENV_VAR} from ${source} names a SQLite file that does not exist: ${candidates[0] ?? url}.` }
}

async function runClient($: EngineInterface, target: DbTarget, invocation: Invocation): Promise<Ran> {
  const [binary = ''] = invocation.argv
  try {
    const run = await $.process.run(invocation.argv, {
      env: invocation.env,
      timeoutMs: QUERY_TIMEOUT_MS,
      ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
    })
    return run.exitCode === 0 ? { ok: true, stdout: run.stdout } : { ok: false, error: errorSummary(run.stderr, run.exitCode) }
  } catch (error) {
    const text = String(error)
    if (/ENOENT/.test(text)) return { ok: false, error: `${binary} is not installed or not on PATH (it reads ${target.kind} databases).` }
    if (/still running/.test(text)) return { ok: false, error: `${binary} did not answer within ${QUERY_TIMEOUT_MS / 1000}s.` }
    return { ok: false, error: text }
  }
}

/** Reads the schema into the pane's state. */
async function load($: EngineInterface, settings: Settings): Promise<Snapshot> {
  await update($, snapshot, (current: Snapshot) => ({ ...current, phase: 'loading' as const, error: null }))
  const found = await findDatabase($)
  const loadedAt = await $.clock.now()
  if (!found.ok) return update($, snapshot, () => ({ ...EMPTY, phase: 'error' as const, error: found.error, loadedAt }))

  const label = describeTarget(found.target)
  const ran = await runClient($, found.target, readOnlyQuery(found.target, schemaQueries(found.target.kind)))
  if (!ran.ok) return update($, snapshot, () => ({ ...EMPTY, phase: 'error' as const, label, source: found.source, error: ran.error, loadedAt }))
  const tables = buildTables(found.target.kind, parseRows(found.target.kind, ran.stdout))
  return update($, snapshot, () => ({ phase: 'ready' as const, label, source: found.source, tables, error: null, loadedAt }))
}

async function shownTables($: EngineInterface): Promise<{ current: Snapshot; tables: Table[] }> {
  const current = await read($, snapshot)
  return { current, tables: filterTables(current.tables, await read($, filter)) }
}

async function sendToClaude($: EngineInterface): Promise<void> {
  const { current, tables } = await shownTables($)
  if (current.phase !== 'ready' || tables.length === 0) return
  const filled = await $.prompt.fill({ text: `${compactSchema(current.label, tables, SEND_LIMIT_CHARS)}\n\n`, mode: 'insert' })
  $.ui.toast(filled.isFilled ? `Schema of ${tables.length} table${tables.length === 1 ? '' : 's'} added to your prompt` : 'The prompt box is not available right now')
}

async function toggleTable($: EngineInterface, name: string): Promise<void> {
  await update($, expanded, (list: string[]) => (list.includes(name) ? list.filter(entry => entry !== name) : [...list, name]))
}

async function refreshSoon($: EngineInterface, settings: Settings, timers: Timers): Promise<void> {
  const isOpen = (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)
  if (!isOpen && !(await read($, isInjected))) return
  timers.refresh?.cancel()
  timers.refresh = $.clock.after(REFRESH_DELAY_MS, () => {
    timers.refresh = undefined
    void load($, settings).catch(() => undefined)
  })
}

function summary(current: Snapshot): string {
  if (current.phase === 'error') return current.error ?? 'The schema could not be read.'
  const count = current.tables.length
  return `Schema of ${current.label} (from ${current.source}): ${count} table${count === 1 ? '' : 's'}.`
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    maxContextChars: Number(options.maxContextChars) >= 500 ? Number(options.maxContextChars) : DEFAULT_CONTEXT_CHARS,
  }
  const timers: Timers = { refresh: undefined }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'schema',
      description: 'Pane of your local database tables and columns, ready to hand to Claude',
      argumentHint: '[table filter]',
    })
    return next(e)
  })

  on('command.run', { command: 'schema' }, async ($, e) => {
    await update($, filter, () => e.args.trim())
    const current = await load($, settings)
    if (current.phase === 'error' && current.label === '') return { text: summary(current) }
    await $.ui.open({ id: PANE, title: 'Schema' })
    return { text: summary(current) }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, isInjected))) return composed
    const { current, tables } = await shownTables($)
    if (current.phase !== 'ready' || tables.length === 0) return composed
    const text =
      `${compactSchema(current.label, tables, settings.maxContextChars)}\n` +
      'This is the local development database of the project, read by the schema-pane mod. Use these exact table and column names in queries, models and migrations.'
    return { sections: [...composed.sections, { id: SECTION_ID, scope: 'session' as const, text }] }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && SCHEMA_CHANGING.test(e.command)) await refreshSoon($, settings, timers)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements && e.surface !== 'mobile' ? elements.Input : undefined
    const current = await read($, snapshot)
    const open = await read($, expanded)
    const query = await read($, filter)
    const injected = await read($, isInjected)
    const refresh = (
      <Button key="refresh" label={current.phase === 'loading' ? 'Reading…' : 'Refresh'} hotkey="r" plain dimColor onPress={() => void load($, settings)} />
    )

    if (current.phase !== 'ready') {
      return (
        <Box flexDirection="column" gap={1}>
          <Box key="title" flexDirection="row" justifyContent="space-between" gap={1}>
            <Text bold>{current.label === '' ? 'Database schema' : current.label}</Text>
            {refresh}
          </Box>
          {current.phase === 'error' ? (
            <Box key="error">
              <Text color="error">{current.error}</Text>
            </Box>
          ) : (
            <Text dimColor>Reading the schema…</Text>
          )}
        </Box>
      )
    }

    const tables = filterTables(current.tables, query)
    const drawn = tables.slice(0, MAX_TABLES_DRAWN)
    const columns = e.props.bodyColumns
    const isNarrow = columns < 60
    const nameWidth = Math.min(NAME_WIDTH_MAX, Math.max(6, ...drawn.flatMap(table => table.columns.map(column => column.name.length)))) + 1
    const typeWidth = Math.min(TYPE_WIDTH_MAX, Math.max(6, ...drawn.flatMap(table => table.columns.map(column => column.type.length)))) + 1
    const contextChars = injected ? compactSchema(current.label, tables, settings.maxContextChars).length : 0
    const counted = query === '' ? `${current.tables.length} tables` : `${tables.length} of ${current.tables.length} tables`
    const isAllOpen = drawn.length > 0 && drawn.every(table => open.includes(table.name))

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="title" flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text bold wrap="truncate-end">
              {current.label}
            </Text>
            {refresh}
          </Box>
          <Text dimColor>
            from {current.source} · {counted}
          </Text>
        </Box>
        {Input !== undefined && (
          <Input
            key="filter"
            label="Filter: "
            placeholder="table name"
            value={query}
            submitLabel="filter"
            onInput={(value: string) => void update($, filter, () => value)}
            onSubmit={(value: string) => void update($, filter, () => value)}
          />
        )}
        <Box key="actions" flexDirection="row" gap={2} flexWrap="wrap">
          <Button key="send" label={`Send to Claude (${tables.length})`} hotkey="s" variant="primary" onPress={() => void sendToClaude($)} />
          <Button
            key="inject"
            label={`${injected ? '[x]' : '[ ]'} Inject in context`}
            hotkey="i"
            plain
            onPress={() => void update($, isInjected, (value: boolean) => !value)}
          />
          <Button
            key="expand"
            label={isAllOpen ? 'Collapse all' : 'Expand all'}
            hotkey="e"
            plain
            dimColor
            onPress={() => void update($, expanded, () => (isAllOpen ? [] : drawn.map(table => table.name)))}
          />
        </Box>
        {injected && (
          <Box key="injected">
            <Text color="suggestion">
              {`✓ Claude sees ${tables.length} table${tables.length === 1 ? '' : 's'} in its context (~${(contextChars / 1000).toFixed(1)}k of ${settings.maxContextChars / 1000}k chars).`}
            </Text>
          </Box>
        )}
        <Box key="tables" flexDirection="column">
          {tables.length === 0 && <Text dimColor>{query === '' ? 'The database has no tables yet.' : `No table matches "${query}".`}</Text>}
          {drawn.map(table => {
            const isOpen = open.includes(table.name)
            const facts = `${table.columns.length} col${table.columns.length === 1 ? '' : 's'}${table.indexes.length > 0 ? ` · ${table.indexes.length} idx` : ''}`
            return (
              <Box key={`table:${table.name}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Button key={`toggle:${table.name}`} label={`${isOpen ? '▾' : '▸'} ${table.name}`} plain onPress={() => void toggleTable($, table.name)} />
                  <Text dimColor>{facts}</Text>
                </Box>
                {isOpen &&
                  table.columns.map(column => (
                    <Box key={`column:${table.name}.${column.name}`} flexDirection={isNarrow ? 'column' : 'row'} paddingLeft={2}>
                      <Box flexDirection="row" flexShrink={0}>
                        <Box width={isNarrow ? undefined : nameWidth} flexShrink={0}>
                          <Text bold={column.isPrimary} color={column.isPrimary ? 'warning' : undefined} wrap="truncate-end">
                            {column.name}
                          </Text>
                        </Box>
                        <Box width={isNarrow ? undefined : typeWidth} flexShrink={0} paddingLeft={isNarrow ? 1 : 0}>
                          <Text color="suggestion" wrap="truncate-end">
                            {column.type}
                          </Text>
                        </Box>
                      </Box>
                      <Box flexDirection="row" gap={1} flexShrink={1} paddingLeft={isNarrow ? 2 : 0}>
                        {column.isPrimary && <Text color="warning">PK</Text>}
                        {!column.isNullable && !column.isPrimary && <Text dimColor>not null</Text>}
                        {column.isUnique && <Text dimColor>unique</Text>}
                        {column.references !== null && <Text color="claude">→ {column.references}</Text>}
                        {column.defaultValue !== '' && (
                          <Text dimColor wrap="truncate-end">
                            = {column.defaultValue}
                          </Text>
                        )}
                      </Box>
                    </Box>
                  ))}
                {isOpen &&
                  table.indexes.map(index => (
                    <Box key={`index:${table.name}:${index}`} paddingLeft={2}>
                      <Text dimColor wrap="truncate-end">
                        {index}
                      </Text>
                    </Box>
                  ))}
              </Box>
            )
          })}
          {tables.length > drawn.length && <Text dimColor>{`… ${tables.length - drawn.length} more: type a filter to narrow the list.`}</Text>}
        </Box>
      </Box>
    )
  })
}
