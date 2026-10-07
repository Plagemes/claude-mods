import type { PromptOrigin, Register } from 'claude-code'

import { UPLOAD_HINT, blockedUploads } from './upload'
import type { Upload } from './upload'

const DEFAULT_ALLOW_WORD = 'UPLOAD-OK'
const MAX_SHOWN = 100
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'slack-ping'])

const isPerson = (origin: PromptOrigin): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

const shorten = (command: string): string => {
  const line = command.trim().replace(/\s+/g, ' ')
  return line.length > MAX_SHOWN ? `${line.slice(0, MAX_SHOWN - 1)}…` : line
}

const denial = (command: string, uploads: readonly Upload[], allowWord: string): string => {
  const targets = uploads.map(upload => `${upload.host} (${upload.how})`).join(', ')
  const first = uploads[0]?.host ?? ''
  const word = allowWord === '' ? '' : `by writing ${allowWord} in their next message, or `
  return (
    `no-upload: blocked \`${shorten(command)}\`. It would send data to ${targets}, which is not on the allowed list. ` +
    "Do not upload files or text to outside services without the user's explicit OK: tell them what you wanted to send and where, and ask. " +
    `They can approve it ${word}by adding "${first}" to the allowed hosts in this mod's settings.`
  )
}

export const register: Register = (on, options) => {
  const allowed = new Set(String(options.allowHosts ?? '').split(',').map(host => host.trim().toLowerCase()).filter(host => host !== ''))
  const allowWord = typeof options.allowWord === 'string' ? options.allowWord.trim() : DEFAULT_ALLOW_WORD
  let isAllowed = false

  on('prompt.submit', ($, e, next) => {
    if (isPerson(e.origin)) isAllowed = allowWord !== '' && e.text.includes(allowWord)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (isAllowed) return next(e)
    const uploads = blockedUploads(e.command, allowed)
    return uploads.length === 0 ? next(e) : { deny: denial(e.command, uploads, allowWord) }
  }).catch(($, e, next) =>
    next.called || !('command' in e) || !UPLOAD_HINT.test(e.command) ? next(e) : { deny: 'no-upload: its check failed, so this command was blocked.' },
  )
}
