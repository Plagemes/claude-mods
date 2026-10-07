import type { EngineInterface, Register } from 'claude-code'

type Source = 'you' | 'Claude'
type Link = { url: string; sources: Source[] }
type Reply = { text: string }

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g
const TRAILING_PUNCTUATION = /[.,;:!?*\]}]+$/
// Rows the engine injects into the conversation (reminders, command output) are not what anyone wrote.
const INJECTED_ROW = /^\s*<(?:system-reminder|local-command|command-|task-notification)/
const MAX_ROWS = 200

const countOf = (text: string, char: string): number => text.split(char).length - 1

// Drops the punctuation that follows a link in prose, but keeps the ")" of a URL like .../Foo_(bar).
const cleanUrl = (raw: string): string => {
  let url = raw
  for (;;) {
    const trimmed = url.replace(TRAILING_PUNCTUATION, '')
    const isUnbalanced = trimmed.endsWith(')') && countOf(trimmed, '(') < countOf(trimmed, ')')
    const next = isUnbalanced ? trimmed.slice(0, -1) : trimmed
    if (next === url) return url
    url = next
  }
}

const urlsIn = (text: string): string[] => (text.match(URL_PATTERN) ?? []).map(cleanUrl).filter(url => URL.canParse(url))

const collectLinks = async ($: EngineInterface): Promise<Link[]> => {
  const byKey = new Map<string, Link>()
  for (const { role, text } of await $.session.messages()) {
    if (role === 'user' && INJECTED_ROW.test(text)) continue
    const source: Source = role === 'user' ? 'you' : 'Claude'
    for (const url of urlsIn(text)) {
      const key = url.replace(/\/$/, '')
      const link = byKey.get(key) ?? { url, sources: [] }
      if (!link.sources.includes(source)) link.sources.push(source)
      byKey.set(key, link)
    }
  }
  return [...byKey.values()]
}

const select = (links: Link[], filter: string): Link[] => {
  const needle = filter.trim().toLowerCase()
  return needle === '' ? links : links.filter(link => link.url.toLowerCase().includes(needle))
}

const noLinks = (filter: string): Reply => ({
  text: filter.trim() === '' ? 'link-vault: no links in this conversation yet.' : `link-vault: no links matching "${filter.trim()}".`,
})

const listLinks = async ($: EngineInterface, filter: string): Promise<Reply> => {
  const links = select(await collectLinks($), filter)
  if (links.length === 0) return noLinks(filter)

  const rows = links.slice(0, MAX_ROWS).map((link, index) => `${index + 1}. ${link.url} — ${link.sources.join(' + ')}`)
  const hidden = links.length - rows.length
  return {
    text: [
      `🔗 Links in this conversation (${links.length})`,
      ...rows,
      ...(hidden > 0 ? [`…and ${hidden} more`] : []),
      'Copy them all with /links-copy.',
    ].join('\n'),
  }
}

const copyLinks = async ($: EngineInterface, filter: string): Promise<Reply> => {
  const links = select(await collectLinks($), filter)
  if (links.length === 0) return noLinks(filter)

  const list = links.map(link => link.url).join('\n')
  const copied = await $.ui.copy({ text: list })
  return {
    text: copied.isCopied
      ? `🔗 Copied ${links.length} link${links.length === 1 ? '' : 's'} to the clipboard.`
      : `link-vault: no clipboard here (${copied.reason}). The links:\n${list}`,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'links', description: 'List every URL from this conversation', argumentHint: '[filter]' })
    await $.command.register({ name: 'links-copy', description: 'Copy every URL from this conversation', argumentHint: '[filter]' })
    return next(e)
  })

  on('command.run', { command: 'links' }, ($, e) => listLinks($, e.args))
  on('command.run', { command: 'links-copy' }, ($, e) => copyLinks($, e.args))
}
