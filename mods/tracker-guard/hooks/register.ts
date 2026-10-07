import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import { INSTALLER_HINT, LOOKS_LIKE_TRACKING, isWatchedFile, trackersAdded, trackersInstalledBy } from './detect'
import { isApproved } from './trackers'
import type { Tracker } from './trackers'

const DEFAULT_ALLOW_WORD = 'TRACKER-OK'
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

type Settings = { approved: ReadonlySet<string>; allowWord: string; blockErrorTracking: boolean }

/** The trackers among `found` that this call may not add. */
const forbidden = (found: readonly Tracker[], settings: Settings): Tracker[] =>
  found.filter(tracker => (settings.blockErrorTracking || tracker.category !== 'error-tracking') && !isApproved(tracker, settings.approved))

const denial = (what: string, trackers: readonly Tracker[], settings: Settings): string => {
  const names = trackers.map(tracker => `${tracker.name} (${tracker.category})`).join(', ')
  const first = trackers[0]?.id ?? ''
  const word = settings.allowWord === '' ? '' : ` or by writing ${settings.allowWord} in their next message`
  return (
    `tracker-guard: blocked. ${what} adds ${names}, which is not on the approved list. ` +
    'Do not add analytics or tracking without the user\'s say-so: ask whether they want it. ' +
    `They can approve it by adding "${first}" to this mod's approved list${word}. Otherwise leave it out.`
  )
}

type Change = { path: string; before: string; after: string }

const editsOf = (edits: unknown, field: 'old_string' | 'new_string'): string =>
  (Array.isArray(edits) ? edits : []).map(edit => (typeof edit?.[field] === 'string' ? edit[field] : '')).join('\n')

/** What a file-changing tool call replaces and puts in its place; undefined for files that cannot add a tracker. */
async function changeOf($: EngineInterface, input: Readonly<Record<string, unknown>>): Promise<Change | undefined> {
  const path = input.file_path ?? input.notebook_path
  if (typeof path !== 'string' || !isWatchedFile(path)) return undefined
  const tool = String(input.tool)
  if (tool === 'Edit') return { path, before: String(input.old_string ?? ''), after: String(input.new_string ?? '') }
  if (tool === 'MultiEdit') return { path, before: editsOf(input.edits, 'old_string'), after: editsOf(input.edits, 'new_string') }
  if (tool === 'NotebookEdit') return { path, before: '', after: String(input.new_source ?? '') }
  if (tool !== 'Write') return undefined
  let before = ''
  if (input._host === undefined) {
    try {
      before = String(await $.fs.read(path))
    } catch {
      // A new file: nothing was there before.
    }
  }
  return { path, before, after: String(input.content ?? '') }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    approved: new Set(String(options.approved ?? '').split(',').map(word => word.trim().toLowerCase()).filter(word => word !== '')),
    allowWord: typeof options.allowWord === 'string' ? options.allowWord.trim() : DEFAULT_ALLOW_WORD,
    blockErrorTracking: options.blockErrorTracking === true,
  }
  let isAllowed = false

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) isAllowed = settings.allowWord !== '' && e.text.includes(settings.allowWord)
    // A turn nobody typed (a notification, a schedule, a peer) starts without the approval of an earlier prompt.
    else if (e.turnId === undefined) isAllowed = false
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (isAllowed) return next(e)
    const found = forbidden(trackersInstalledBy(e.command), settings)
    return found.length === 0 ? next(e) : { deny: denial('This install command', found, settings) }
  }).catch(($, e, next) =>
    next.called || !('command' in e) || !INSTALLER_HINT.test(e.command) ? next(e) : { deny: 'tracker-guard: its check failed, so this install was blocked.' },
  )

  on('tool.call', { tool: /^(?:Edit|MultiEdit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    if (isAllowed) return next(e)
    const change = await changeOf($, e)
    if (change === undefined) return next(e)
    const found = forbidden(trackersAdded(change.path, change.before, change.after), settings)
    return found.length === 0 ? next(e) : { deny: denial(`This edit to ${change.path}`, found, settings) }
  }).catch(($, e, next) => (next.called || !LOOKS_LIKE_TRACKING.test(JSON.stringify(e)) ? next(e) : { deny: 'tracker-guard: its check failed, so this edit was blocked.' }))
}
