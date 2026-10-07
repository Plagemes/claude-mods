import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StorybookNudgeState } from '../types'
import { basename, dirname, hasStoryIn, isComponentPath, stemOf, storyExtension, storyFor } from './paths'

const DEFAULT_FOLDERS = 'components'
const STORY_FOLDERS = ['stories', '__stories__']
const MAX_LEVELS_UP = 12
const TOAST_MS = 8_000
const MAX_LISTED = 3

const EMPTY: StorybookNudgeState = { watching: [], missing: [] }
const state = atom({ plugin: 'storybook-nudge', key: 'state' } as const, EMPTY)

const addAll = (list: readonly string[], more: readonly string[]): string[] => [...new Set([...list, ...more])]

/** True when a `.storybook` folder sits in the file's folder or above it, up to the project root. */
async function hasStorybook($: EngineInterface, file: string, root: string): Promise<boolean> {
  if (!file.startsWith(`${root}/`)) return false
  let folder = dirname(file)
  for (let level = 0; level < MAX_LEVELS_UP && folder.length >= root.length; level += 1) {
    if (await $.fs.exists(`${folder}/.storybook`)) return true
    folder = dirname(folder)
  }
  return false
}

async function namesIn($: EngineInterface, folder: string): Promise<string[]> {
  try {
    return (await $.fs.list(folder)).map(entry => entry.name)
  } catch {
    return []
  }
}

/** A story next to the component, or in a stories/ or __stories__/ folder beside it. */
async function hasStory($: EngineInterface, file: string): Promise<boolean> {
  const folder = dirname(file)
  const stem = stemOf(file)
  for (const where of [folder, ...STORY_FOLDERS.map(name => `${folder}/${name}`)]) {
    if (hasStoryIn(await namesIn($, where), stem)) return true
  }
  return false
}

/** At the end of a main turn: the components made in it are checked for stories, and the ones without are remembered. */
async function settleTurn($: EngineInterface): Promise<void> {
  const { watching } = await read($, state)
  if (watching.length === 0) return
  const missing: string[] = []
  for (const file of watching) if (!(await hasStory($, file))) missing.push(file)
  await update($, state, current => ({ watching: current.watching.filter(file => !watching.includes(file)), missing: addAll(current.missing, missing) }))
  if (missing.length > 0) {
    $.ui.toast(missing.length === 1 ? `${basename(missing[0] ?? '')} has no story yet` : `${missing.length} new components have no story yet`, { timeoutMs: TOAST_MS })
  }
}

const requestFor = (files: readonly string[], root: string): string =>
  [
    'These new components have no Storybook story:',
    ...files.map(file => `- ${file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file} (story file: ${stemOf(file)}.stories.${storyExtension(file)})`),
    '',
    'Add a story next to each one, following the stories this project already has (format, title and args conventions). Cover the main variants and states. Do not change the components.',
  ].join('\n')

const summarize = (files: readonly string[]): string => {
  const names = files.slice(0, MAX_LISTED).map(basename).join(', ')
  return files.length === 1 ? `${names} has no story` : `${names}${files.length > MAX_LISTED ? ` and ${files.length - MAX_LISTED} more` : ''} have no story`
}

export const register: Register = (on, options) => {
  const folders = new Set(String(options.directories ?? DEFAULT_FOLDERS).split(',').map(name => name.trim()).filter(name => name !== ''))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const story = storyFor(e.file_path)
    const isCandidate = isComponentPath(e.file_path, folders)
    if (e._host !== undefined || (story === undefined && !isCandidate)) return next(e)

    const root = ((await $.session.repo())?.root ?? (await $.session.cwd())).replace(/\/+$/, '')
    const isNew = isCandidate && !(await $.fs.exists(e.file_path)) && (await hasStorybook($, e.file_path, root))
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    if (isNew) await update($, state, current => ({ ...current, watching: addAll(current.watching, [e.file_path]) }))
    // A story written for a component the band is waiting on settles it.
    if (story !== undefined) {
      const isOf = (file: string): boolean => stemOf(file) === story
      await update($, state, current => ({ watching: current.watching.filter(file => !isOf(file)), missing: current.missing.filter(file => !isOf(file)) }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted) await settleTurn($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const { missing } = await read($, state)
    if (missing.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const root = ((await $.session.repo())?.root ?? (await $.session.cwd())).replace(/\/+$/, '')
    // Other plugins' bands draw beneath this one rather than being replaced by it.
    const below = await next(e)
    const askClaude = async (): Promise<void> => {
      await update($, state, current => ({ ...current, missing: [] }))
      await $.prompt.submit({ text: requestFor(missing, root), asUser: true })
    }

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color="warning" bold>Storybook</Text>
          <Text wrap="truncate-end">{summarize(missing)}</Text>
        </Box>
        <Box gap={1}>
          <Button key="ask" label="Ask Claude to add stories" hotkey="s" variant="primary" onPress={() => void askClaude()} />
          <Button key="dismiss" label="Dismiss" hotkey="d" role="dismiss" onPress={() => void update($, state, current => ({ ...current, missing: [] }))} />
        </Box>
        {below}
      </Box>
    )
  })
}
