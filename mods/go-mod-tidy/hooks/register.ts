import type { EngineInterface, Register, Timer } from 'claude-code'

import { changedImports, describeChange, isOwnPackage, modulePathOf } from './imports'

const GO_FILE = /\.go$/
const SKIPPED_PATH = /(^|[\\/])(vendor|node_modules|\.git)[\\/]/
const WRITE_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const DEBOUNCE_MS = 2000
const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_TIMEOUT_SECONDS = 600
const MAX_LEVELS = 24
const MAX_STDERR_LINES = 4

type Input = Readonly<Record<string, unknown>>

type State = {
  /** Go files whose imports changed since the last run, with the changed import paths, waiting for the edits to settle. */
  pending: Map<string, string[]>
  timer: Timer | undefined
  isBusy: boolean
  isGoMissing: boolean
  /** Notes for the model, given with the next tool result. */
  notes: string[]
  timeoutMs: number
}

const dirname = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))

/** The folder of the nearest go.mod at or above the file. */
async function findModuleRoot($: EngineInterface, file: string): Promise<string | undefined> {
  let folder = dirname(file)
  for (let level = 0; level < MAX_LEVELS && folder !== ''; level += 1) {
    if (await $.fs.exists(`${folder}/go.mod`).catch(() => false)) return folder
    folder = dirname(folder)
  }
  return undefined
}

const readOrEmpty = ($: EngineInterface, path: string): Promise<string> => $.fs.read(path).catch(() => '')

/** `go mod tidy` in one module, then a toast and (for the model) a note about what happened. */
async function tidyModule($: EngineInterface, root: string, state: State): Promise<void> {
  const goModBefore = await readOrEmpty($, `${root}/go.mod`)
  const goSumBefore = await readOrEmpty($, `${root}/go.sum`)
  let run
  try {
    run = await $.process.run(['go', 'mod', 'tidy'], { cwd: root, timeoutMs: state.timeoutMs })
  } catch (error) {
    if (String(error).includes('ENOENT')) {
      state.isGoMissing = true
      $.ui.toast('go is not installed, so go.mod was not tidied')
    } else {
      $.ui.toast(`go mod tidy stopped after ${state.timeoutMs / 1000}s`)
      state.notes.push(`go-mod-tidy: go mod tidy in ${root} did not finish within ${state.timeoutMs / 1000}s (a module download may be slow); run it yourself when needed.`)
    }
    return
  }

  if (run.exitCode !== 0) {
    const lines = run.stderr.split('\n').map(line => line.trim()).filter(line => line !== '')
    const reason = lines.slice(0, MAX_STDERR_LINES).join(' | ')
    $.ui.toast(`go mod tidy failed: ${lines[0] ?? `exit ${run.exitCode}`}`)
    state.notes.push(`go-mod-tidy: go mod tidy failed in ${root}: ${reason === '' ? `exit code ${run.exitCode}` : reason}. Fix the import or add the module (go get), then run go mod tidy again.`)
    return
  }

  const goModAfter = await readOrEmpty($, `${root}/go.mod`)
  const goSumAfter = await readOrEmpty($, `${root}/go.sum`)
  if (goModAfter === goModBefore && goSumAfter === goSumBefore) {
    $.ui.toast('go mod tidy: already tidy')
    return
  }
  const change = describeChange(goModBefore, goModAfter)
  $.ui.toast(`go mod tidy: go.mod updated${change === '' ? '' : ` (${change})`}`)
  state.notes.push(`go-mod-tidy: ran go mod tidy in ${root}; go.mod/go.sum changed${change === '' ? '' : `: ${change}`}. Re-read go.mod before editing it.`)
}

/** Runs `go mod tidy` for the modules of the files whose imports changed; runs again when more edits came meanwhile. */
async function tidyPending($: EngineInterface, state: State): Promise<void> {
  const files = [...state.pending]
  state.pending.clear()
  state.timer = undefined
  state.isBusy = true
  try {
    const imports = new Map<string, string[]>()
    for (const [file, paths] of files) {
      const root = await findModuleRoot($, file)
      if (root !== undefined) imports.set(root, [...(imports.get(root) ?? []), ...paths])
    }
    for (const [root, paths] of imports) {
      const modulePath = modulePathOf(await readOrEmpty($, `${root}/go.mod`))
      if (paths.some(path => !isOwnPackage(path, modulePath))) await tidyModule($, root, state)
    }
  } catch (error) {
    $.ui.log(`go-mod-tidy: ${String(error)}`, { to: 'debug' })
  } finally {
    state.isBusy = false
    if (state.pending.size > 0 && !state.isGoMissing) schedule($, state)
  }
}

function schedule($: EngineInterface, state: State): void {
  state.timer?.cancel()
  if (state.isBusy) return
  state.timer = $.clock.after(DEBOUNCE_MS, () => void tidyPending($, state))
}

/** The text an edit removes and the text it puts there; for a Write, the file as it is and as it will be. */
async function importTexts($: EngineInterface, input: Input): Promise<{ before: string; after: string }> {
  if (typeof input.content === 'string') return { before: await readOrEmpty($, String(input.file_path)), after: input.content }
  const edits: readonly unknown[] = Array.isArray(input.edits) ? input.edits : [input]
  const pick = (field: string) =>
    edits.map(edit => (edit as Record<string, unknown>)[field]).filter((value): value is string => typeof value === 'string').join('\n')
  return { before: pick('old_string'), after: pick('new_string') }
}

export const register: Register = (on, options) => {
  const seconds = Number(options.timeoutSeconds) > 0 ? Number(options.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS
  const state: State = {
    pending: new Map(),
    timer: undefined,
    isBusy: false,
    isGoMissing: false,
    notes: [],
    timeoutMs: Math.min(seconds, MAX_TIMEOUT_SECONDS) * 1000,
  }

  on('tool.call', async ($, e, next) => {
    const input: Input = e
    const file = input.file_path
    const isGoEdit = WRITE_TOOLS.test(String(e.tool)) && typeof file === 'string' && GO_FILE.test(file) && !SKIPPED_PATH.test(file) && input._host === undefined
    const texts = isGoEdit ? await importTexts($, input) : undefined

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    const changed = texts === undefined || ran.isError === true || state.isGoMissing ? [] : changedImports(texts.before, texts.after)
    if (changed.length > 0) {
      state.pending.set(String(file), [...(state.pending.get(String(file)) ?? []), ...changed])
      schedule($, state)
    }
    if (state.notes.length === 0) return ran
    const notes = state.notes.splice(0)
    return { ...ran, context: [...(ran.context ?? []), ...notes] }
  })
}
