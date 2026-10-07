import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { DiffPaneFile as File, DiffPaneView as View } from '../types'
import { EMPTY_TREE, barCells, cutDiff, parseTracked, parseUntracked, shortPath, untrackedEntry } from './parse'

type Git = { ok: boolean; out: string; err: string }

const PLUGIN = 'diff-pane'
const PANE = 'changes'
const REFRESH_DELAY_MS = 400
const GIT_TIMEOUT_MS = 20_000
const UNTRACKED_LIMIT = 100
const UNTRACKED_COUNTED = 40
const UNTRACKED_MAX_BYTES = 256 * 1024
const MAX_BAR = 20
const NARROW_COLUMNS = 56
const EDITING_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|Bash)$/
const STATUS_COLOR: Record<File['status'], string> = { M: 'warning', A: 'success', '?': 'success', D: 'error', T: 'suggestion' }
const EMPTY_VIEW: View = { repo: null, files: [], selected: null, diff: null, updatedAt: 0, error: null }

const view = atom({ plugin: 'diff-pane', key: 'view' } as const, EMPTY_VIEW)

const git = async ($: EngineInterface, cwd: string | undefined, args: readonly string[]): Promise<Git> => {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
    return { ok: run.exitCode === 0, out: run.stdout, err: run.stderr.trim() }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

/** HEAD, or the empty tree on a branch with no commit yet. */
const baseOf = async ($: EngineInterface, root: string): Promise<string> =>
  (await git($, root, ['rev-parse', '--verify', '-q', 'HEAD'])).ok ? 'HEAD' : EMPTY_TREE

const readUntracked = async ($: EngineInterface, root: string, path: string): Promise<File> => {
  const stat = await $.fs.stat(`${root}/${path}`).catch(() => undefined)
  if (stat?.kind !== 'file' || stat.size > UNTRACKED_MAX_BYTES) return untrackedEntry(path, undefined)
  const text = await $.fs.read(`${root}/${path}`).catch(() => undefined)
  return untrackedEntry(path, typeof text === 'string' ? text : undefined)
}

/** Every file that differs from HEAD, untracked ones included, with line counts. */
const scan = async ($: EngineInterface, root: string): Promise<{ files: File[]; error: string | null }> => {
  const base = await baseOf($, root)
  const [numstat, nameStatus, others] = await Promise.all([
    git($, root, ['diff', base, '--numstat', '-z', '--no-renames']),
    git($, root, ['diff', base, '--name-status', '-z', '--no-renames']),
    git($, root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  if (!numstat.ok) return { files: [], error: `git diff failed: ${numstat.err}` }
  // Line counts for the first few untracked files only: each one is a read.
  const untracked = await Promise.all(
    parseUntracked(others.out)
      .slice(0, UNTRACKED_LIMIT)
      .map((path, index) => (index < UNTRACKED_COUNTED ? readUntracked($, root, path) : untrackedEntry(path, undefined))),
  )
  const files = [...parseTracked(numstat.out, nameStatus.out), ...untracked].sort((a, b) => a.path.localeCompare(b.path))
  return { files, error: null }
}

/** The unified diff of one file against HEAD, from its first hunk on. */
const diffOf = async ($: EngineInterface, root: string, file: File): Promise<string> => {
  const run =
    file.status === '?'
      ? await git($, root, ['diff', '--no-index', '--no-color', '--', '/dev/null', file.path])
      : await git($, root, ['diff', await baseOf($, root), '--no-color', '--no-ext-diff', '--', file.path])
  const firstHunk = run.out.indexOf('@@')
  return firstHunk === -1 ? '' : cutDiff(run.out.slice(firstHunk)).text
}

const showDiff = async ($: EngineInterface, path: string | null): Promise<void> => {
  const current = await read($, view)
  const file = current.files.find(entry => entry.path === path)
  if (current.repo === null || file === undefined) {
    await update($, view, (latest: View) => ({ ...latest, selected: null, diff: null }))
    return
  }
  await update($, view, (latest: View) => ({ ...latest, selected: file.path, diff: null }))
  const diff = file.isBinary ? '' : await diffOf($, current.repo, file)
  await update($, view, (latest: View) => (latest.selected === file.path ? { ...latest, diff } : latest))
}

/** Rescans the repository the session is in, keeping the open diff if its file still changed. */
const refresh = async ($: EngineInterface): Promise<void> => {
  const top = await git($, undefined, ['rev-parse', '--show-toplevel'])
  if (!top.ok) {
    await update($, view, () => EMPTY_VIEW)
    return
  }
  const root = top.out.trim()
  const { files, error } = await scan($, root)
  const updatedAt = await $.clock.now()
  const { selected } = await update($, view, (latest: View) => {
    const isKept = latest.repo === root && files.some(file => file.path === latest.selected)
    return { repo: root, files, error, updatedAt, selected: isKept ? latest.selected : null, diff: isKept ? latest.diff : null }
  })
  if (selected !== null) await showDiff($, selected)
}

const refreshIfOpen = async ($: EngineInterface): Promise<void> => {
  try {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) await refresh($)
  } catch (error) {
    $.ui.log(`${PLUGIN}: refresh failed: ${String(error)}`, { to: 'debug' })
  }
}

const copyPath = async ($: EngineInterface, path: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) => {
  const copied = await $.ui.copy({ text: path, surface })
  $.ui.toast(copied.isCopied ? `Copied ${path}` : `${PLUGIN}: could not copy (${copied.reason})`)
}

export const register: Register = on => {
  let pending: Timer | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'changes', description: 'diff-pane: live list of changed files with +/- counts' })
    return next(e)
  })

  on('command.run', { command: 'changes' }, async $ => {
    await refresh($)
    const { repo } = await read($, view)
    if (repo === null) return { text: `${PLUGIN}: not in a git repository.` }
    await $.ui.open({ id: PANE, title: 'Changes' })
    return { text: 'Changes pane opened.' }
  })

  on('tool.call', { tool: EDITING_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    // Several edits in a row refresh once, shortly after the last.
    pending?.cancel()
    pending = $.clock.after(REFRESH_DELAY_MS, () => {
      pending = undefined
      void refreshIfOpen($)
    })
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const current = await read($, view)
    if (current.repo === null) return <Text dimColor>Not in a git repository.</Text>

    const columns = e.props.bodyColumns
    const isNarrow = columns < NARROW_COLUMNS
    const barWidth = isNarrow ? 0 : Math.min(MAX_BAR, Math.floor(columns / 6))
    const countsWidth = 13
    const pathWidth = Math.max(10, columns - 2 - countsWidth - (barWidth > 0 ? barWidth + 1 : 0) - 14)
    const largest = Math.max(0, ...current.files.map(file => file.adds + file.dels))
    const adds = current.files.reduce((sum, file) => sum + file.adds, 0)
    const dels = current.files.reduce((sum, file) => sum + file.dels, 0)
    const repoName = current.repo.split(/[\\/]/).pop() ?? current.repo

    const bar = (plusCount: number, minusCount: number, cells: number) => {
      const { plus, minus } = barCells(plusCount, minusCount, largest, cells)
      return (
        <Text>
          <Text color="success">{'+'.repeat(plus)}</Text>
          <Text color="error">{'-'.repeat(minus)}</Text>
          {' '.repeat(Math.max(0, cells - plus - minus))}
        </Text>
      )
    }
    const counts = (file: File) =>
      file.isBinary ? 'binary' : file.status === '?' && file.adds === 0 ? 'new' : `+${file.adds} −${file.dels}`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>{repoName}</Text>
          <Text dimColor>vs HEAD · updates after each edit</Text>
          <Button key="refresh" label="Refresh" plain dimColor onPress={() => refresh($)} />
        </Box>
        {current.error !== null && (
          <Box key="error">
            <Text color="error">{current.error}</Text>
          </Box>
        )}
        {current.files.length === 0 && current.error === null && (
          <Box key="clean">
            <Text color="success">✓ Nothing changed since HEAD</Text>
          </Box>
        )}
        {current.files.map(file => {
          const isSelected = file.path === current.selected
          return (
            <Box key={`row:${file.path}`} flexDirection="row" gap={1}>
              <Text color={STATUS_COLOR[file.status]} bold>
                {file.status}
              </Text>
              <Box flexGrow={1}>
                <Text bold={isSelected} wrap="truncate-start">
                  {shortPath(file.path, pathWidth)}
                </Text>
              </Box>
              <Text dimColor>{counts(file).padStart(countsWidth - 2)}</Text>
              {barWidth > 0 && bar(file.adds, file.dels, barWidth)}
              <Button key={`copy:${file.path}`} label="Copy" plain dimColor onPress={press => copyPath($, file.path, press.surface)} />
              <Button
                key={`diff:${file.path}`}
                label={isSelected ? 'Hide' : 'Diff'}
                plain
                dimColor={!isSelected}
                onPress={() => showDiff($, isSelected ? null : file.path)}
              />
            </Box>
          )
        })}
        {current.files.length > 0 && (
          <Box key="totals" flexDirection="row" gap={1}>
            <Text bold>
              {current.files.length} file{current.files.length === 1 ? '' : 's'} changed
            </Text>
            <Text>
              <Text color="success">+{adds}</Text> <Text color="error">−{dels}</Text>
            </Text>
          </Box>
        )}
        {current.selected !== null && (
          <Box key="diff" flexDirection="column" marginTop={1}>
            <Text bold>{current.selected}</Text>
            {current.diff === null ? (
              <Text dimColor>Loading the diff…</Text>
            ) : current.diff === '' ? (
              <Text dimColor>No text changes to show (binary file or mode change).</Text>
            ) : (
              <Code format="diff" source={current.diff} path={current.selected} />
            )}
          </Box>
        )}
      </Box>
    )
  })
}
