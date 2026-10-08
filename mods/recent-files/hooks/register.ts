import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RecentFilesEntry } from '../types'

const files = atom({ plugin: 'recent-files', key: 'files' } as const, [])

const MAX_FILES = 50
const DEFAULT_SHOWN = MAX_FILES

type Touch = { path: string; kind: 'read' | 'edit' }

/** The file a tool call reads or changes, if it is one of the file tools. */
const touchOf = (tool: string, input: Readonly<Record<string, unknown>>): Touch | undefined => {
  const path = tool === 'NotebookEdit' ? input.notebook_path : input.file_path

  if (typeof path !== 'string' || path === '') {
    return undefined
  }

  if (tool === 'Read') {
    return { path, kind: 'read' }
  }

  return tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit'
    ? { path, kind: 'edit' }
    : undefined
}

const remember = (list: RecentFilesEntry[], { path, kind }: Touch): RecentFilesEntry[] => {
  const before = list.find(entry => entry.path === path)
  const entry: RecentFilesEntry = {
    path,
    isRead: kind === 'read' || before?.isRead === true,
    isEdited: kind === 'edit' || before?.isEdited === true,
  }

  return [entry, ...list.filter(other => other.path !== path)].slice(0, MAX_FILES)
}

const relativeTo = (root: string, path: string): string => {
  const prefix = root.endsWith('/') ? root : `${root}/`

  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

const marker = ({ isRead, isEdited }: RecentFilesEntry): string =>
  `${isRead ? 'R' : ' '}${isEdited ? 'E' : ' '}`

const projectRoot = async ($: EngineInterface): Promise<string> => {
  try {
    return await $.session.root()
  } catch {
    return ''
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'recent',
      description: 'List the files read and edited in this session, newest first',
      argumentHint: '[count]',
    })

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const touch = touchOf(String(e.tool), e)

    if (touch !== undefined && ran.deny === undefined && ran.isError !== true) {
      await update($, files, list => remember(list, touch))
    }

    return ran
  })

  on('command.run', { command: 'recent' }, async ($, e) => {
    const list = await read($, files)

    if (list.length === 0) {
      return { text: 'No files read or edited yet in this session.' }
    }

    const asked = Number.parseInt(e.args, 10)
    const shown = list.slice(0, Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_SHOWN)
    const root = await projectRoot($)
    const lines = shown.map(entry => `  ${marker(entry)}  ${relativeTo(root, entry.path)}`)

    return {
      text: [`Recent files, newest first (R = read, E = edited or written), ${shown.length} of ${list.length}:`, ...lines].join('\n'),
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, files, () => [])
    }

    return next(e)
  })
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}
