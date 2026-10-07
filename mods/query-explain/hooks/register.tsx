import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { QueryExplainRun as Run } from '../types'
import { errorSummary, parseRows, readOnlyQuery } from './client'
import type { Invocation } from './client'
import { ENV_FILES, ENV_VAR, SQLITE_FALLBACKS, describeTarget, environmentRisk, parseEnv, resolveUrl } from './db'
import type { DbTarget } from './db'
import {
  SYSTEM_PROMPT,
  checkStatement,
  contextQueries,
  explainStatements,
  findings,
  modeOf,
  needsFallback,
  planText,
  readContext,
  referencedTables,
  userPrompt,
} from './sql'

const PANE = 'query-plan'
const QUERY_TIMEOUT_MS = 75_000
const MODEL_TIMEOUT_MS = 90_000
const MAX_TOKENS = 1200
const CONTEXT_PLAN_CHARS = 4000
const PROMPT_PLAN_CHARS = 3000
const DEFAULT_MODEL = 'sonnet'

const run = atom({ plugin: 'query-explain', key: 'run' } as const, null)

type Settings = { analyze: boolean; model: string }
type Found = { ok: true; target: DbTarget; source: string } | { ok: false; error: string }
type Ran = { ok: true; stdout: string } | { ok: false; error: string }
type Reply = { text: string; context?: string[] }

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
  if (!resolved.ok) return { ok: false, error: `${ENV_VAR} from ${source} was not used: ${resolved.reason}. Only databases on this machine are queried.` }
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
    const result = await $.process.run(invocation.argv, {
      env: invocation.env,
      timeoutMs: QUERY_TIMEOUT_MS,
      ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
    })
    return result.exitCode === 0 ? { ok: true, stdout: result.stdout } : { ok: false, error: errorSummary(result.stderr, result.exitCode) }
  } catch (error) {
    const text = String(error)
    if (/ENOENT/.test(text)) return { ok: false, error: `${binary} is not installed or not on PATH (it queries ${target.kind} databases).` }
    if (/still running/.test(text)) return { ok: false, error: `${binary} did not finish within ${QUERY_TIMEOUT_MS / 1000}s.` }
    return { ok: false, error: text }
  }
}

/** Asks the model to read the plan, then shows its answer if the pane still holds that query. */
async function explain($: EngineInterface, settings: Settings, current: Run, prompt: string): Promise<void> {
  const isSame = (latest: Run | null): latest is Run => latest !== null && latest.sql === current.sql && latest.plan === current.plan
  let reply: Awaited<ReturnType<EngineInterface['model']['complete']>>
  try {
    reply = await $.model.complete({ model: settings.model, system: SYSTEM_PROMPT, prompt, maxTokens: MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS })
  } catch (error) {
    // Without this the pane would say "explaining" forever.
    const why = error instanceof Error ? error.message : String(error)
    await update($, run, (latest: Run | null) => (isSame(latest) ? { ...latest, phase: 'ready' as const, error: `No explanation: ${why}.` } : latest))
    return
  }
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `the API answered ${reply.status ?? 'nothing'} (${reply.error})` : reply.reason
    await update($, run, (latest: Run | null) => (isSame(latest) ? { ...latest, phase: 'ready' as const, error: `No explanation: ${why}.` } : latest))
    return
  }
  await update($, run, (latest: Run | null) => (isSame(latest) ? { ...latest, phase: 'ready' as const, explanation: reply.text.trim() } : latest))
}

/** Runs EXPLAIN on the local database, shows the plan, and starts the explanation. */
async function explainQuery($: EngineInterface, input: string, settings: Settings): Promise<Reply> {
  const found = await findDatabase($)
  if (!found.ok) return { text: found.error }
  const { target } = found
  const checked = checkStatement(input, target.kind)
  if (!checked.ok) return { text: checked.reason }

  const label = describeTarget(target)
  let mode = modeOf(target.kind, settings.analyze && checked.isRead)
  const start: Run = { phase: 'running', sql: checked.sql, label, mode, plan: '', findings: [], indexes: [], explanation: null, error: null }
  await update($, run, () => start)
  await $.ui.open({ id: PANE, title: 'Query plan' })

  let ran = await runClient($, target, readOnlyQuery(target, explainStatements(target.kind, checked.sql, mode)))
  if (!ran.ok && target.kind === 'mysql' && needsFallback(ran.error)) {
    // MariaDB and MySQL before 8.0.18 have neither EXPLAIN ANALYZE nor the tree format.
    mode = 'EXPLAIN'
    ran = await runClient($, target, readOnlyQuery(target, explainStatements('mysql', checked.sql, mode, true)))
  }
  if (!ran.ok) {
    const error = ran.error
    await update($, run, () => ({ ...start, phase: 'error' as const, error }))
    return { text: error }
  }

  const plan = planText(target.kind, ran.stdout)
  const tables = referencedTables(checked.sql)
  const lookup = tables.length === 0 ? undefined : await runClient($, target, readOnlyQuery(target, contextQueries(target.kind, tables)))
  const context = lookup?.ok === true ? readContext(parseRows(target.kind, lookup.stdout)) : { indexes: [], sizes: {} }
  const ready: Run = { ...start, phase: 'explaining', mode, plan, findings: findings(target.kind, plan, context.sizes), indexes: context.indexes }
  await update($, run, () => ready)
  const prompt = userPrompt({ kind: target.kind, mode, sql: checked.sql, plan, ...context })
  $.clock.after(0, () => void explain($, settings, ready, prompt).catch(() => undefined))

  const flagged = ready.findings.filter(finding => finding.level === 'warn').map(finding => finding.text)
  return {
    text: `${mode} on ${label}: ${flagged.length === 0 ? 'nothing stands out' : flagged.join('; ')}. The explanation is coming in the Query plan pane.`,
    context: [`query-explain ran ${mode} on the local ${target.kind} database (${label}) for:\n${checked.sql}\n\nPlan:\n${plan.slice(0, CONTEXT_PLAN_CHARS)}`],
  }
}

async function askClaude($: EngineInterface): Promise<void> {
  const current = await read($, run)
  if (current === null || current.plan === '') return
  const text =
    `This query is slow on the local ${current.label} database. Make it faster: add the right index as a migration in this ` +
    `project's style, or rewrite the query where it is built in the code.\n\n\`\`\`sql\n${current.sql}\n\`\`\`\n\n${current.mode} plan:\n` +
    `\`\`\`\n${current.plan.slice(0, PROMPT_PLAN_CHARS)}\n\`\`\`\n`
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  $.ui.toast(filled.isFilled ? 'Prompt ready: edit it and press Enter' : 'The prompt box is not available right now')
}

async function copyPlan($: EngineInterface, surface: RenderSurface): Promise<void> {
  const current = await read($, run)
  if (current === null || current.plan === '') return
  const copied = await $.ui.copy({ text: current.plan, surface })
  $.ui.toast(copied.isCopied ? 'Plan copied' : `Could not copy (${copied.reason})`)
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    analyze: options.analyze === true,
    model: typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : DEFAULT_MODEL,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'explain-query',
      description: 'EXPLAIN a SQL query on your local database and explain the plan in plain words',
      argumentHint: '<sql> (or select a query first)',
    })
    return next(e)
  })

  on('command.run', { command: 'explain-query' }, async ($, e) => {
    const typed = e.args.trim()
    const sql = typed !== '' ? typed : ((await $.ui.selection())?.text ?? '').trim()
    if (sql === '') return { text: 'Give a query, /explain-query SELECT …, or select one in the transcript first.' }
    return explainQuery($, sql, settings)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Markdown, Text } = $.ui.resolve(e)
    const current = await read($, run)
    if (current === null) return <Text dimColor>Run /explain-query &lt;sql&gt; to see a plan here.</Text>
    const isBusy = current.phase === 'running' || current.phase === 'explaining'

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="title" flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold wrap="truncate-end">
            {current.mode} · {current.label}
          </Text>
          <Button
            key="rerun"
            label={isBusy ? 'Working…' : 'Re-run'}
            hotkey="r"
            plain
            dimColor
            onPress={() => void (isBusy ? undefined : explainQuery($, current.sql, settings))}
          />
        </Box>
        <Code language="sql" source={current.sql} />
        {current.phase === 'running' && <Text dimColor>Running {current.mode}…</Text>}
        {current.findings.length > 0 && (
          <Box key="findings" flexDirection="column">
            <Text bold>At a glance</Text>
            {current.findings.map((finding, index) => (
              <Box key={`finding:${index}`}>
                <Text color={finding.level === 'warn' ? 'warning' : undefined} dimColor={finding.level === 'info'}>
                  {finding.level === 'warn' ? '⚠' : '·'} {finding.text}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {current.plan !== '' && (
          <Box key="plan" flexDirection="column">
            <Text bold>Plan</Text>
            <Code source={current.plan} wrap="truncate-end" />
          </Box>
        )}
        {current.phase === 'explaining' && (
          <Box key="explaining">
            <Text color="suggestion">Explaining the plan with {settings.model}…</Text>
          </Box>
        )}
        {current.explanation !== null && (
          <Box key="explanation" flexDirection="column">
            <Text bold>Explanation</Text>
            <Markdown text={current.explanation} />
          </Box>
        )}
        {current.error !== null && (
          <Box key="error">
            <Text color="error">{current.error}</Text>
          </Box>
        )}
        <Box key="actions" flexDirection="row" gap={2} flexWrap="wrap">
          {current.plan !== '' && <Button key="ask" label="Ask Claude to optimise" hotkey="a" variant="primary" onPress={() => void askClaude($)} />}
          {current.plan !== '' && <Button key="copy" label="Copy plan" hotkey="c" onPress={press => void copyPlan($, press.surface)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
