import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { insertEntry, parseCommit, TEMPLATE, unreleasedOf } from '../hooks/changelog'

const ROOT = '/work/shop'
const PATH = `${ROOT}/CHANGELOG.md`
const NOW = Date.UTC(2026, 9, 7, 12)
const PARSE = { untyped: 'changed', includeChores: false } as const
const EXISTING = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Fixed',
  '',
  '- Handle empty carts',
  '',
  '## [1.0.0] - 2026-09-01',
  '',
  '### Added',
  '',
  '- First release',
  '',
].join('\n')
const PANE_PROPS = {
  title: 'Unreleased',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}
const BASH_OK = { stdout: '', stderr: '', interrupted: false }

type Repo = { files: Map<string, string>; runs: string[][]; toasts: string[]; copies: string[] }

/** A repository whose HEAD is the given commit, and the nouns the mod calls. */
const repo = (on: On, subject: string, options: { file?: string; committedAt?: number; body?: string } = {}): Repo => {
  const state: Repo = { files: new Map(), runs: [], toasts: [], copies: [] }
  if (options.file !== undefined) state.files.set(PATH, options.file)
  mock.clock(on, { now: NOW })
  on('process.run', ($, e) => {
    state.runs.push([...e.argv])
    const args = e.argv.slice(1).join(' ')
    const stdout = args.startsWith('rev-parse --show-toplevel')
      ? `${ROOT}\n`
      : `a1b2c3d\0${Math.floor((options.committedAt ?? NOW) / 1000)}\0${subject}\0${options.body ?? ''}\n`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', ($, e) => {
    state.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', ($, e) => {
    state.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  return state
}

test('commit subjects map to Keep a Changelog sections', async () => {
  expect(parseCommit('feat(api): add pagination to /orders', '', PARSE)).toEqual({ section: 'Added', text: '**api:** Add pagination to /orders' })
  expect(parseCommit('fix!: drop the legacy token format.', '', PARSE)).toEqual({ section: 'Fixed', text: '**Breaking:** Drop the legacy token format' })
  expect(parseCommit('fix(security): escape names in emails', '', PARSE)?.section).toBe('Security')
  expect(parseCommit('refactor: split the cart store', 'BREAKING CHANGE: store API renamed', PARSE)?.text).toBe('**Breaking:** Split the cart store')
  expect(parseCommit('chore: bump deps', '', PARSE)).toBeUndefined()
  expect(parseCommit('docs: fix typo', '', { untyped: 'changed', includeChores: true })?.section).toBe('Changed')
  expect(parseCommit('Merge branch main into feature', '', PARSE)).toBeUndefined()
  expect(parseCommit('Speed up checkout', '', PARSE)).toEqual({ section: 'Changed', text: 'Speed up checkout' })
  expect(parseCommit('Speed up checkout', '', { untyped: 'skip', includeChores: false })).toBeUndefined()
})

test('entries land under Unreleased in canonical order, once', async () => {
  const added = insertEntry(EXISTING, { section: 'Added', text: 'Gift cards' })
  expect(unreleasedOf(added.markdown)).toBe('### Added\n\n- Gift cards\n\n### Fixed\n\n- Handle empty carts')
  const fixed = insertEntry(added.markdown, { section: 'Fixed', text: 'Rounding of totals' }, ' (a1b2c3d)')
  expect(unreleasedOf(fixed.markdown)).toContain('- Handle empty carts\n- Rounding of totals (a1b2c3d)')
  expect(fixed.markdown).toContain('## [1.0.0] - 2026-09-01\n\n### Added\n\n- First release')
  expect(insertEntry(fixed.markdown, { section: 'Fixed', text: 'Rounding of totals' }).isChanged).toBe(false)

  const fresh = insertEntry(TEMPLATE, { section: 'Security', text: 'Rotate keys' })
  expect(fresh.markdown.endsWith('## [Unreleased]\n\n### Security\n\n- Rotate keys\n')).toBe(true)
  const noHeading = insertEntry('# Changelog\n\n## [0.1.0]\n\n- Init\n', { section: 'Added', text: 'X' })
  expect(noHeading.markdown).toContain('# Changelog\n\n## [Unreleased]\n\n### Added\n\n- X\n\n## [0.1.0]')
})

test('a successful git commit adds its entry, creating CHANGELOG.md, and tells Claude', async ($, on) => {
  const state = repo(on, 'feat(api): add pagination to /orders')
  on('tool.call', () => ({ result: { ...BASH_OK, gitOperation: { commit: { sha: 'a1b2c3d', kind: 'committed' } } } }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "feat(api): add pagination to /orders"' })
  const written = state.files.get(PATH) ?? ''
  expect(written.startsWith('# Changelog\n')).toBe(true)
  expect(unreleasedOf(written)).toBe('### Added\n\n- **api:** Add pagination to /orders')
  expect(ran.context?.[0]).toContain('under ## [Unreleased] › ### Added in CHANGELOG.md (new file)')
  expect(state.toasts[0]).toContain('Added · **api:** Add pagination to /orders')
})

test('amends, failures, chores and other commands leave the changelog alone', async ($, on) => {
  const state = repo(on, 'chore: tidy', { file: EXISTING })
  let answer: unknown = { result: { ...BASH_OK, gitOperation: { commit: { sha: 'a1b2c3d', kind: 'amended' } } } }
  on('tool.call', () => answer as { result: unknown })

  await $.tool.call({ tool: 'Bash', command: 'git commit --amend --no-edit' })
  answer = { result: 'nothing to commit', isError: true, text: 'nothing to commit' }
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x"' })
  answer = { result: { ...BASH_OK, gitOperation: { commit: { sha: 'a1b2c3d', kind: 'committed' } } } }
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "chore: tidy"' })
  const runsBefore = state.runs.length
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  expect(state.files.get(PATH)).toBe(EXISTING)
  expect(state.runs.length).toBe(runsBefore)
})

test('without the git record only a commit made during the call counts', async ($, on) => {
  const state = repo(on, 'fix: stale HEAD', { file: EXISTING, committedAt: NOW - 60_000 })
  on('tool.call', () => ({ result: BASH_OK }))
  await $.tool.call({ tool: 'Bash', command: 'git -C . commit -m "fix: stale HEAD"' })
  expect(state.files.get(PATH)).toBe(EXISTING)
})

test('/changelog shows the Unreleased section in a pane with Copy', async ($, on) => {
  const state = repo(on, 'x', { file: EXISTING })
  const ran = await $.command.run({
    command: 'changelog',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(ran.text).toContain('1 unreleased entry in CHANGELOG.md')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'changelog-keeper', surface, component: 'Pane', requestId: 'changelog', props: PANE_PROPS })
    expect((await ui.find({ key: 'unreleased' }))?.text).toContain('- Handle empty carts')
    expect(await ui.find({ type: 'Text', text: 'Unreleased · 1 entry' })).toBeDefined()
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(state.copies).toEqual(['### Fixed\n\n- Handle empty carts', '### Fixed\n\n- Handle empty carts'])
})

test('regression: an amend is skipped even without the engine git record', async ($, on) => {
  const state = repo(on, 'feat: reworded subject', { file: EXISTING })
  on('tool.call', () => ({ result: BASH_OK }))

  await $.tool.call({ tool: 'Bash', command: 'git commit --amend -m "feat: reworded subject"' })
  expect(state.files.get(PATH)).toBe(EXISTING)

  await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: reworded subject"' })
  expect(unreleasedOf(state.files.get(PATH) ?? '')).toContain('- Reworded subject')
})

test('regression: a CRLF changelog keeps its line endings', () => {
  const crlf = EXISTING.replace(/\n/g, '\r\n')
  const { markdown } = insertEntry(crlf, { section: 'Added', text: 'Dark mode' })
  expect(markdown.replace(/\r\n/g, '')).not.toContain('\n')
  expect(markdown).toContain('### Added\r\n\r\n- Dark mode\r\n')
})
