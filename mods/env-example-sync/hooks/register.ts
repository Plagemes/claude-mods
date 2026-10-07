import type { EngineInterface, Register } from 'claude-code'

import { addedReads, BUILT_IN_IGNORED, isExampleName, listedNames, withNames } from './env'

const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const SOURCE_FILE = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|astro|py|rb|php|go|rs|java|kt|cs)$/i
const SKIPPED_PATH =
  /(^|[\\/])(node_modules|vendor|dist|build|\.git|tests?|__tests__|specs?)[\\/]|\.(?:test|spec)\.|_test\.go$|(^|[\\/])test_[^\\/]*\.py$|_spec\.rb$/
const DEFAULT_FILES = ['.env.example', '.env.sample']
const MAX_LEVELS = 12
const MAX_SHOWN = 6

type Input = Readonly<Record<string, unknown>>
type Settings = { files: readonly string[]; ignored: ReadonlySet<string> }

const dirname = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
const basename = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

/** Every piece of text a write-type call puts in the file, and the text it replaces. */
function textsOf(input: Input): { added: string; replaced: string } {
  const edits: readonly unknown[] = Array.isArray(input.edits) ? input.edits : [input]
  const pick = (field: string) =>
    edits.map(edit => (edit as Record<string, unknown>)[field]).filter((value): value is string => typeof value === 'string').join('\n')
  return typeof input.content === 'string' ? { added: input.content, replaced: '' } : { added: pick('new_string'), replaced: pick('old_string') }
}

/** The example file nearest to the edited file, looking in its folder and each folder above up to the project root. */
async function findExample($: EngineInterface, file: string, files: readonly string[]): Promise<string | undefined> {
  const root = await $.session.root().catch(() => undefined)
  let folder = dirname(file)
  for (let level = 0; level < MAX_LEVELS && folder !== ''; level += 1) {
    for (const name of files) {
      const candidate = `${folder}/${name}`
      if (await $.fs.exists(candidate).catch(() => false)) return candidate
    }
    if (folder === root) break
    folder = dirname(folder)
  }
  return undefined
}

/** Appends the variables missing from the example file; resolves to the ones it added. */
async function syncExample($: EngineInterface, file: string, names: readonly string[], settings: Settings): Promise<{ example: string; added: string[] } | undefined> {
  const example = await findExample($, file, settings.files)
  if (example === undefined) return undefined
  const text = await $.fs.read(example).catch(() => undefined)
  if (text === undefined) return undefined
  const listed = listedNames(text)
  const added = names.filter(name => !listed.has(name))
  if (added.length === 0) return undefined
  await $.fs.write(example, withNames(text, added))
  return { example, added }
}

export const register: Register = (on, options) => {
  const configured = String(options.file ?? '').trim()
  const settings: Settings = {
    files: configured !== '' && isExampleName(basename(configured)) ? [configured] : DEFAULT_FILES,
    ignored: new Set([
      ...BUILT_IN_IGNORED,
      ...String(options.ignore ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(name => name !== ''),
    ]),
  }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Input = e
    const file = input.file_path
    if (typeof file !== 'string' || !SOURCE_FILE.test(file) || SKIPPED_PATH.test(file) || input._host !== undefined) return next(e)

    const { added, replaced } = textsOf(input)
    const before = input.content === undefined ? replaced : await $.fs.read(file).catch(() => '')
    const names = addedReads(before, added, settings.ignored)
    const ran = await next(e)
    if (names.length === 0 || ran.deny !== undefined || ran.isError === true) return ran

    const synced = await syncExample($, file, names, settings).catch(() => undefined)
    if (synced === undefined) return ran
    const shown = synced.added.slice(0, MAX_SHOWN).join(', ') + (synced.added.length > MAX_SHOWN ? ` (+${synced.added.length - MAX_SHOWN})` : '')
    $.ui.toast(`${basename(synced.example)}: added ${shown}`)
    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `env-example-sync: added ${shown} to ${synced.example} with empty values. Give them example values or a comment there if that helps; .env itself was not touched.`,
      ],
    }
  })
}
