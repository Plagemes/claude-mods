import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FixtureFactoryDraft as Draft } from '../types'
import { FILE_GLOBS, SKIPPED_DIRS, extractBlock, grepPatterns, parseHits, relatedBlocks, relatedNames } from './find'
import type { Hit } from './find'
import { DEFAULT_COUNT, SYSTEM_PROMPT, fieldCount, fileNameFor, parseArgs, parseRecords, previewOf, tokenBudget, unevenFields, userPrompt } from './generate'

const PANE = 'fixtures'
const GREP_TIMEOUT_MS = 15_000
const MODEL_TIMEOUT_MS = 240_000
const PREVIEW_CHARS = 6000
const INSERT_LIMIT_CHARS = 60_000
const DEFAULT_MODEL = 'sonnet'
const FIXTURE_DIRS = ['tests/fixtures', 'test/fixtures', '__fixtures__', 'spec/fixtures', 'fixtures']

const draft = atom({ plugin: 'fixture-factory', key: 'draft' } as const, null)
const isDefinitionShown = atom({ plugin: 'fixture-factory', key: 'isDefinitionShown' } as const, false)

type Settings = { model: string; count: number; outputDir: string }

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

async function projectRoot($: EngineInterface): Promise<string> {
  return (await $.session.cwd()).replace(/[\\/]+$/, '')
}

/** Definitions named like `name`: git grep in a repository (untracked files too), grep -r elsewhere. */
async function search($: EngineInterface, root: string, name: string): Promise<Hit[]> {
  const patterns = grepPatterns(name).flatMap(pattern => ['-e', pattern])
  try {
    const run = await $.process.run(['git', 'grep', '-n', '-I', '-i', '-E', '--untracked', ...patterns, '--', ...FILE_GLOBS], { cwd: root, timeoutMs: GREP_TIMEOUT_MS })
    if (run.exitCode === 0) return parseHits(run.stdout, name)
    if (run.exitCode === 1) return []
  } catch {
    // Not a repository, or no git: plain grep below.
  }
  try {
    const run = await $.process.run(
      ['grep', '-r', '-n', '-I', '-i', '-E', ...FILE_GLOBS.map(glob => `--include=${glob}`), ...SKIPPED_DIRS.map(dir => `--exclude-dir=${dir}`), ...patterns, '.'],
      { cwd: root, timeoutMs: GREP_TIMEOUT_MS },
    )
    return run.exitCode === 0 ? parseHits(run.stdout, name) : []
  } catch {
    return []
  }
}

/** Where fixtures go: the configured folder, else the first fixtures folder the project has, else `fixtures/`. */
async function fixtureFolder($: EngineInterface, root: string, settings: Settings): Promise<string> {
  if (settings.outputDir !== '') return settings.outputDir
  for (const dir of FIXTURE_DIRS) {
    if (await $.fs.exists(`${root}/${dir}`).catch(() => false)) return dir
  }
  return 'fixtures'
}

const isSameDraft = (latest: Draft | null, current: Draft): latest is Draft =>
  latest !== null && latest.name === current.name && latest.source === current.source && latest.phase === 'generating'

async function fail($: EngineInterface, current: Draft, error: string): Promise<void> {
  await update($, draft, (latest: Draft | null) => (isSameDraft(latest, current) ? { ...latest, phase: 'error' as const, error } : latest))
}

/** Asks the model for the records, once more if the first answer is not a JSON array, and shows them. */
async function generate($: EngineInterface, settings: Settings, current: Draft): Promise<void> {
  const prompt = userPrompt({ name: current.name, count: current.count, kind: current.kind, path: current.source, definition: current.definition, related: current.related })
  const maxTokens = tokenBudget(current.count, fieldCount(current.definition))
  const ask = (text: string) => $.model.complete({ model: settings.model, system: SYSTEM_PROMPT, prompt: text, maxTokens, timeoutMs: MODEL_TIMEOUT_MS })

  let reply = await ask(prompt)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!reply.isAnswered) {
      const why = reply.reason === 'api-error' ? `the API answered ${reply.status ?? 'nothing'} (${reply.error})` : reply.reason
      return fail($, current, `No records: ${why}.`)
    }
    if (reply.usage.output_tokens >= maxTokens) return fail($, current, `The records did not fit in one reply (${maxTokens} tokens): ask for fewer.`)
    const parsed = parseRecords(reply.text)
    if (parsed.ok) {
      const records = parsed.records.slice(0, current.count)
      const uneven = unevenFields(records)
      const warning =
        records.length < current.count
          ? `Only ${records.length} of ${current.count} records came back.`
          : uneven.length > 0
            ? `Not every record has: ${uneven.slice(0, 5).join(', ')}.`
            : null
      const json = JSON.stringify(records, null, 2)
      const ready = { phase: 'ready' as const, json, preview: previewOf(records, PREVIEW_CHARS), recordCount: records.length, warning, error: null }
      await update($, draft, (latest: Draft | null) => (isSameDraft(latest, current) ? { ...latest, ...ready } : latest))
      $.ui.toast(`${records.length} ${current.name} records ready`)
      return
    }
    if (attempt === 1) return fail($, current, `The model's answer was not usable: ${parsed.error}.`)
    reply = await ask(`${prompt}\n\nYour previous answer could not be used: ${parsed.error}. Answer with the JSON array only.`)
  }
}

/** Finds the definition, opens the pane and starts generating. */
async function start($: EngineInterface, args: string, settings: Settings): Promise<string> {
  const wanted = parseArgs(args, settings.count)
  if (wanted === undefined) return 'Usage: /fixtures <Model|Type|table> [count], for example /fixtures User 20'
  const root = await projectRoot($)
  const hits = await search($, root, wanted.name)
  const best = hits[0]
  if (best === undefined) {
    return `No definition of ${wanted.name} found. Looked for Prisma models, TypeScript interfaces, types and zod schemas, Python classes, SQL CREATE TABLE, Go and Rust structs.`
  }
  const text = await readText($, `${root}/${best.path}`)
  if (text === undefined) return `Could not read ${best.path}.`

  const lines = text.split('\n')
  const definition = extractBlock(lines, best.line - 1, best.kind)
  const related = relatedBlocks(lines, relatedNames(definition, wanted.name), best.kind, best.line - 1)
  const source = `${best.path}:${best.line}`
  const target = `${await fixtureFolder($, root, settings)}/${fileNameFor(wanted.name)}`
  const fresh: Draft = {
    phase: 'generating',
    name: wanted.name,
    count: wanted.count,
    kind: best.kind,
    source,
    definition,
    related,
    alternatives: hits.slice(1, 4).map(hit => `${hit.path}:${hit.line}`),
    json: '',
    preview: '',
    recordCount: 0,
    warning: null,
    error: null,
    target,
    savedTo: null,
    isReplacing: false,
  }
  await update($, draft, () => fresh)
  await $.ui.open({ id: PANE, title: 'Fixtures' })
  $.clock.after(0, () => void generate($, settings, fresh).catch(error => fail($, fresh, String(error))))
  return `Generating ${wanted.count} ${wanted.name} records from ${source} with ${settings.model}…`
}

async function regenerate($: EngineInterface, settings: Settings): Promise<void> {
  const current = await read($, draft)
  if (current === null || current.phase === 'generating') return
  const fresh: Draft = { ...current, phase: 'generating', json: '', preview: '', recordCount: 0, warning: null, error: null, savedTo: null, isReplacing: false }
  await update($, draft, () => fresh)
  await generate($, settings, fresh).catch(error => fail($, fresh, String(error)))
}

/** Writes the records; a file already there is replaced only on a second press. */
async function save($: EngineInterface): Promise<void> {
  const current = await read($, draft)
  if (current === null || current.phase !== 'ready') return
  const path = `${await projectRoot($)}/${current.target}`
  const isTaken = current.savedTo !== current.target && (await $.fs.exists(path).catch(() => false))
  if (isTaken && !current.isReplacing) {
    await update($, draft, (latest: Draft | null) => (latest === null ? latest : { ...latest, isReplacing: true }))
    return
  }
  await $.fs.write(path, `${current.json}\n`)
  await update($, draft, (latest: Draft | null) => (latest === null ? latest : { ...latest, savedTo: current.target, isReplacing: false }))
  $.ui.toast(`Saved ${current.recordCount} records to ${current.target}`)
}

async function insert($: EngineInterface): Promise<void> {
  const current = await read($, draft)
  if (current === null || current.phase !== 'ready') return
  const text =
    current.savedTo !== null
      ? `Use the ${current.recordCount} ${current.name} test fixtures in @${current.savedTo} `
      : `Here are ${current.recordCount} test records for ${current.name}:\n\`\`\`json\n${current.json.slice(0, INSERT_LIMIT_CHARS)}\n\`\`\`\n`
  const filled = await $.prompt.fill({ text, mode: 'insert' })
  $.ui.toast(filled.isFilled ? 'Fixtures added to your prompt' : 'The prompt box is not available right now')
}

export const register: Register = (on, options) => {
  const count = Number(options.count)
  const settings: Settings = {
    model: typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : DEFAULT_MODEL,
    count: Number.isInteger(count) && count > 0 ? count : DEFAULT_COUNT,
    outputDir: typeof options.outputDir === 'string' ? options.outputDir.trim().replace(/^\.\/|\/+$/g, '') : '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fixtures',
      description: 'Generate realistic test records that match a model, type or table of this project',
      argumentHint: '<Model|Type|table> [count]',
    })
    return next(e)
  })

  on('command.run', { command: 'fixtures' }, async ($, e) => ({ text: await start($, e.args, settings) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const current = await read($, draft)
    if (current === null) return <Text dimColor>Run /fixtures &lt;Model&gt; [count] to generate test records here.</Text>
    const isShown = await read($, isDefinitionShown)
    const title = current.phase === 'ready' ? `${current.recordCount} ${current.name} records` : `${current.count} ${current.name} records`

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="title" flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text bold>Fixtures · {title}</Text>
            {current.phase !== 'generating' && (
              <Button key="regenerate" label="Regenerate" hotkey="g" plain dimColor onPress={() => void regenerate($, settings)} />
            )}
          </Box>
          <Text dimColor wrap="truncate-end">
            from {current.source} ({current.kind}){current.alternatives.length > 0 ? ` · also: ${current.alternatives.join(', ')}` : ''}
          </Text>
        </Box>
        <Box key="definition" flexDirection="column">
          <Button
            key="toggle-definition"
            label={`${isShown ? '▾' : '▸'} Definition`}
            plain
            onPress={() => void update($, isDefinitionShown, (value: boolean) => !value)}
          />
          {isShown && <Code source={current.definition} path={current.source.replace(/:\d+$/, '')} />}
        </Box>
        {current.phase === 'generating' && (
          <Box key="generating">
            <Text color="suggestion">Generating with {settings.model}…</Text>
          </Box>
        )}
        {current.error !== null && (
          <Box key="error">
            <Text color="error">{current.error}</Text>
          </Box>
        )}
        {current.phase === 'ready' && (
          <Box key="preview">
            <Code language="json" source={current.preview} />
          </Box>
        )}
        {current.warning !== null && (
          <Box key="warning">
            <Text color="warning">⚠ {current.warning}</Text>
          </Box>
        )}
        {current.phase === 'ready' && (
          <Box key="actions" flexDirection="row" gap={2} flexWrap="wrap">
            <Button
              key="save"
              label={current.isReplacing ? `Replace ${current.target}` : current.savedTo === null ? `Save to ${current.target}` : 'Saved ✓'}
              hotkey="s"
              variant="primary"
              onPress={() => void save($)}
            />
            <Button key="insert" label="Insert into prompt" hotkey="i" onPress={() => void insert($)} />
            <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
          </Box>
        )}
        {current.isReplacing && (
          <Box key="replace-note">
            <Text color="warning">{current.target} exists: press again to replace it.</Text>
          </Box>
        )}
      </Box>
    )
  })
}
