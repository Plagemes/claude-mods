import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import { groupByDirectory, isChanged, mentionOf, nameOf, shown, touchOf, withTouch } from './files'

const PANE = 'files'
const COMMAND = 'files'
const COUNT_WIDTH = 7

const files = atom({ plugin: 'files-touched', key: 'files' } as const, [])
const isChangedOnly = atom({ plugin: 'files-touched', key: 'isChangedOnly' } as const, false)

let root = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    root = e.cwd
    await $.command.register({ name: COMMAND, description: 'Show every file read, edited or created this session' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, files, () => [])
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'Files' })
    return {}
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const touch = touchOf(e, ran)
    if (touch === undefined) return ran

    if (root === '') root = await $.session.cwd().catch(() => '')
    const at = await $.clock.now()
    await update($, files, list => {
      const existing = list.find(entry => entry.path === touch.path)
      const touched = withTouch(existing, touch.path, touch.kind, at)
      return existing === undefined ? [...list, touched] : list.map(entry => (entry === existing ? touched : entry))
    })
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, files)
    const changedOnly = await read($, isChangedOnly)
    const listed = changedOnly ? all.filter(isChanged) : all
    const count = (pick: (entry: (typeof all)[number]) => number) => all.filter(entry => pick(entry) > 0).length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1} gap={1}>
          <Box flexDirection="row" gap={2}>
            <Text bold>
              {all.length} {all.length === 1 ? 'file' : 'files'}
            </Text>
            <Text dimColor>{count(entry => entry.reads)} read</Text>
            <Text color="warning">{count(entry => entry.edits)} edited</Text>
            <Text color="success">{count(entry => entry.creates)} created</Text>
          </Box>
          <Button
            key="filter"
            label={changedOnly ? 'Show all' : 'Changed only'}
            hotkey="e"
            onPress={() => void update($, isChangedOnly, value => !value)}
          />
        </Box>
        {listed.length === 0 && <Text dimColor>{changedOnly ? 'No files changed yet.' : 'No files touched yet.'}</Text>}
        {groupByDirectory(listed, root).map(group => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color="suggestion">
              {group.dir}
            </Text>
            {group.files.map(file => (
              <Box flexDirection="row" gap={1}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-middle">
                    {'  '}
                    {nameOf(file.path)}
                  </Text>
                </Box>
                <Text color="success">{(file.creates > 0 ? 'new' : '').padStart(COUNT_WIDTH)}</Text>
                <Text color="warning">{(file.edits > 0 ? `${file.edits} edit` : '').padStart(COUNT_WIDTH)}</Text>
                <Text dimColor>{(file.reads > 0 ? `${file.reads} read` : '').padStart(COUNT_WIDTH)}</Text>
                <Button key={`copy:${file.path}`} label="copy" plain dimColor onPress={press => void copyPath($, file.path, press.surface)} />
                <Button key={`mention:${file.path}`} label="@" plain dimColor onPress={() => void mention($, file.path)} />
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}

/** Puts the file's absolute path on the clipboard of the surface the press came from. */
const copyPath = async ($: EngineInterface, path: string, surface: RenderSurface): Promise<void> => {
  const copied = await $.ui.copy({ text: path, surface }).catch(() => undefined)
  if (copied?.isCopied === true) $.ui.toast(`files-touched: copied ${shown(path, root)}`)
  else $.ui.toast(`files-touched: could not copy the path${copied === undefined ? '' : ` (${copied.reason})`}`)
}

/** Inserts `@path` at the cursor in the prompt box. */
const mention = async ($: EngineInterface, path: string): Promise<void> => {
  const filled = await $.prompt.fill({ text: `${mentionOf(path, root)} `, mode: 'insert' }).catch(() => undefined)
  if (filled?.isFilled !== true) $.ui.toast('files-touched: the prompt box is not available right now')
}
