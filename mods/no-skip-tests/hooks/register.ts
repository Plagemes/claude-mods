import type { EngineInterface, Register } from 'claude-code'

type Rule = { label: string; marker: RegExp; files: RegExp }

/** What silences or narrows a test run, per language. Counted, so markers already in the file are not new. */
const RULES: readonly Rule[] = [
  {
    label: '.skip / .only',
    marker: /\b(?:it|test|describe|context|suite|bench)(?:\.[A-Za-z]+)*\.(?:skip|only)\b/g,
    files: /\.[cm]?[jt]sx?$/,
  },
  {
    label: 'fit / xit / xdescribe',
    marker: /(?:^|[^\w.$])(?:fit|fdescribe|xit|xdescribe|xtest|xcontext|xspecify)\s*\(/gm,
    files: /\.(?:[cm]?[jt]sx?|rb)$/,
  },
  {
    label: '@pytest.mark.skip / @unittest.skip',
    marker: /\b(?:pytest\.mark\.skip|unittest\.skip)\b/g,
    files: /\.py$/,
  },
  { label: 't.Skip', marker: /\b[tb]\.Skip(?:f|Now)?\(/g, files: /_test\.go$/ },
  { label: '#[ignore]', marker: /#\[\s*ignore\b/g, files: /\.rs$/ },
  { label: '@Disabled / @Ignore', marker: /@(?:Disabled|Ignore)\b/g, files: /\.(?:java|kt)$/ },
]

const TEST_FILE_NAMES: readonly RegExp[] = [
  /\.(?:test|spec)\.[A-Za-z]+$/,
  /_(?:test|spec)\.[A-Za-z]+$/,
  /(?:^|\/)test_[^/]*\.py$/,
  /(?:Test|Tests|IT)\.(?:java|kt)$/,
  /(?:^|\/)(?:__tests__|tests?|specs?|e2e)\//,
]
/** Rust keeps its tests inside the source files, so every .rs file is checked. */
const ALWAYS_CHECKED = /\.rs$/

const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const DEFAULT_ALLOW_WORD = 'SKIP-OK'

/** Windows paths are matched with forward slashes, so `tests\\` folders count too. */
const isTestFile = (path: string): boolean => {
  const slashed = path.replace(/\\/g, '/')
  return ALWAYS_CHECKED.test(slashed) || TEST_FILE_NAMES.some(pattern => pattern.test(slashed))
}

const countMarkers = (marker: RegExp, text: string): number => (text.match(marker) ?? []).length

/** Labels of the markers that `after` has more of than `before`, for a file of this name. */
const addedMarkers = (path: string, before: string, after: string): string[] =>
  RULES.filter(
    ({ files, marker }) => files.test(path) && countMarkers(marker, after) > countMarkers(marker, before),
  ).map(({ label }) => label)

/** The file's current text: '' when there is no file yet, null when it exists but cannot be read. */
const currentText = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    if (!(await $.fs.exists(path))) {
      return ''
    }
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

const editPairs = (edits: unknown): { before: string; after: string } => {
  const list = Array.isArray(edits) ? edits : []
  const field = (name: string): string =>
    list.map(edit => (typeof edit?.[name] === 'string' ? edit[name] : '')).join('\n')

  return { before: field('old_string'), after: field('new_string') }
}

/** The text a file-changing tool call replaces and the text it puts there; null when it cannot be judged. */
const changeOf = async (
  $: EngineInterface,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Promise<{ path: string; before: string; after: string } | null> => {
  const path = input.file_path

  if (typeof path !== 'string') {
    return null
  }

  if (tool === 'Edit') {
    return { path, before: String(input.old_string ?? ''), after: String(input.new_string ?? '') }
  }

  if (tool === 'MultiEdit') {
    return { path, ...editPairs(input.edits) }
  }

  const before = await currentText($, path)

  return before === null ? null : { path, before, after: String(input.content ?? '') }
}

export const register: Register = (on, options) => {
  const allowWord = typeof options.allowWord === 'string' ? options.allowWord.trim() : DEFAULT_ALLOW_WORD
  let isAllowed = false

  on('prompt.submit', (_$, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) {
      isAllowed = allowWord !== '' && e.text.includes(allowWord)
    }

    return next(e)
  })

  on('tool.call', { tool: /^(?:Edit|Write|MultiEdit)$/ }, async ($, e, next) => {
    if (isAllowed) {
      return next(e)
    }

    const change = await changeOf($, String(e.tool), e)

    if (change === null || !isTestFile(change.path)) {
      return next(e)
    }

    const added = addedMarkers(change.path, change.before, change.after)

    if (added.length === 0) {
      return next(e)
    }

    const escape =
      allowWord === '' ? '' : ` If the user really wants it, ask them to put ${allowWord} in their next message.`

    return {
      deny: `no-skip-tests: this change adds ${added.join(', ')} to ${change.path}. Fix the test or the code instead of silencing the test.${escape}`,
    }
  })
}
