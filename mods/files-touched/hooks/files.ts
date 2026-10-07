import type { ToolCallInput, ToolCallResult } from 'claude-code'

import type { FilesTouchedEntry } from '../types'

type TouchKind = 'read' | 'edit' | 'create'

/** The directory's files, as the pane lists them under one heading. */
type DirectoryGroup = { dir: string; files: FilesTouchedEntry[] }

/** What a finished tool call did to a file; undefined for a call that touched none or failed. */
export const touchOf = (e: ToolCallInput, ran: ToolCallResult): { path: string; kind: TouchKind } | undefined => {
  if (ran.deny !== undefined || ran.isError === true) return undefined
  const input: Readonly<Record<string, unknown>> = e
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
  if (path === '') return undefined

  switch (String(e.tool)) {
    case 'Read':
      return { path, kind: 'read' }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { path, kind: 'edit' }
    case 'Write': {
      const result: unknown = ran.result
      const isCreated = typeof result === 'object' && result !== null && 'type' in result && result.type === 'create'
      return { path, kind: isCreated ? 'create' : 'edit' }
    }
    default:
      return undefined
  }
}

/** The entry with one more touch of `kind` at `at`; a new entry when there was none. */
export const withTouch = (entry: FilesTouchedEntry | undefined, path: string, kind: TouchKind, at: number): FilesTouchedEntry => {
  const base = entry ?? { path, reads: 0, edits: 0, creates: 0, lastAt: at }
  return {
    ...base,
    reads: base.reads + (kind === 'read' ? 1 : 0),
    edits: base.edits + (kind === 'edit' ? 1 : 0),
    creates: base.creates + (kind === 'create' ? 1 : 0),
    lastAt: at,
  }
}

export const isChanged = (entry: FilesTouchedEntry): boolean => entry.edits + entry.creates > 0

/** `path` relative to `root` when it lies inside it; else the absolute path. */
export const shown = (path: string, root: string): string =>
  root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

/** What the prompt box takes to mention the file: `@src/app.ts`, quoted when it holds a space. */
export const mentionOf = (path: string, root: string): string => {
  const relative = shown(path, root)
  return /\s/.test(relative) ? `@"${relative}"` : `@${relative}`
}

/** The files by directory (relative to `root`; `./` for the root itself), directories and files sorted by name. */
export const groupByDirectory = (files: readonly FilesTouchedEntry[], root: string): DirectoryGroup[] => {
  const groups = new Map<string, FilesTouchedEntry[]>()
  for (const file of files) {
    const relative = shown(file.path, root)
    const cut = relative.lastIndexOf('/')
    const dir = cut < 0 ? './' : `${relative.slice(0, cut + 1)}`
    groups.set(dir, [...(groups.get(dir) ?? []), file])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === './' ? -1 : b === './' ? 1 : a.localeCompare(b)))
    .map(([dir, entries]) => ({ dir, files: [...entries].sort((a, b) => a.path.localeCompare(b.path)) }))
}

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
