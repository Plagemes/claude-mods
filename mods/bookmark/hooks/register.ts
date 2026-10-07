import type { EngineInterface, Register } from 'claude-code'

type Bookmark = { id: number; label: string; text: string; savedAt: number }
type Book = { nextId: number; items: Bookmark[] }
type Reply = { text: string }

const TEXT_LIMIT = 2000
const LABEL_LIMIT = 40
const PREVIEW_LIMIT = 70
const MAX_BOOKMARKS = 50

const isBook = (value: unknown): value is Book =>
  typeof value === 'object' && value !== null && Array.isArray((value as Book).items) && typeof (value as Book).nextId === 'number'

const clip = (text: string, max: number): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

const formatTime = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

// One book per project, keyed by the project root.
const bookKey = async ($: EngineInterface): Promise<string> => `bookmarks:${await $.session.root()}`

const loadBook = async ($: EngineInterface, key: string): Promise<Book> => {
  const stored = await $.store.get(key)
  return isBook(stored) ? stored : { nextId: 1, items: [] }
}

const lastAnswer = async ($: EngineInterface): Promise<string | undefined> => {
  const messages = await $.session.messages()
  return [...messages].reverse().find(message => message.role === 'assistant' && message.text.trim() !== '')?.text
}

const saveBookmark = async ($: EngineInterface, label: string): Promise<Reply> => {
  const answer = await lastAnswer($)
  if (answer === undefined) return { text: 'bookmark: nothing to save yet, Claude has not answered.' }
  try {
    const key = await bookKey($)
    const book = await loadBook($, key)
    const text = answer.slice(0, TEXT_LIMIT)
    const bookmark: Bookmark = {
      id: book.nextId,
      label: clip(label === '' ? text : label, LABEL_LIMIT),
      text,
      savedAt: await $.clock.now(),
    }
    await $.store.set(key, { nextId: book.nextId + 1, items: [...book.items, bookmark].slice(-MAX_BOOKMARKS) })
    return { text: `📌 bookmark #${bookmark.id} saved: ${bookmark.label}` }
  } catch (error) {
    return { text: `bookmark: could not save (${error instanceof Error ? error.message : String(error)}).` }
  }
}

const listBookmarks = async ($: EngineInterface): Promise<Reply> => {
  const { items } = await loadBook($, await bookKey($))
  if (items.length === 0) {
    return { text: 'No bookmarks in this project yet. Run /bookmark [label] after an answer you want to keep.' }
  }
  const rows = [...items].reverse().map(({ id, label, text, savedAt }) => {
    const hasOwnLabel = label !== clip(text, LABEL_LIMIT)
    return `#${id} · ${formatTime(savedAt)} · ${label}${hasOwnLabel ? ` — ${clip(text, PREVIEW_LIMIT)}` : ''}`
  })
  return { text: ['📌 Bookmarks (newest first)', ...rows, 'Reuse one with /bookmark-insert <n>, remove it with /bookmark-delete <n>.'].join('\n') }
}

const parseId = (args: string): number => Number(args.trim().replace(/^#/, ''))

const insertBookmark = async ($: EngineInterface, args: string): Promise<Reply> => {
  const id = parseId(args)
  if (args.trim() === '' || !Number.isInteger(id)) return { text: 'usage: /bookmark-insert <n>' }
  const found = (await loadBook($, await bookKey($))).items.find(item => item.id === id)
  if (found === undefined) return { text: `bookmark: no bookmark #${id} in this project. /bookmarks lists them.` }

  const { isFilled } = await $.prompt.fill({ text: found.text, mode: 'insert' })
  return { text: isFilled ? `📌 bookmark #${id} is in your prompt.` : 'bookmark: the prompt box cannot take text right now.' }
}

const deleteBookmark = async ($: EngineInterface, args: string): Promise<Reply> => {
  const id = parseId(args)
  if (args.trim() === '' || !Number.isInteger(id)) return { text: 'usage: /bookmark-delete <n>' }
  const key = await bookKey($)
  const book = await loadBook($, key)
  if (!book.items.some(item => item.id === id)) return { text: `bookmark: no bookmark #${id} in this project.` }

  await $.store.set(key, { ...book, items: book.items.filter(item => item.id !== id) })
  return { text: `📌 bookmark #${id} deleted.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'bookmark', description: "Save Claude's last answer as a bookmark", argumentHint: '[label]' })
    await $.command.register({ name: 'bookmarks', description: "List this project's bookmarks" })
    await $.command.register({ name: 'bookmark-insert', description: 'Put a bookmark into the prompt', argumentHint: '<n>' })
    await $.command.register({ name: 'bookmark-delete', description: 'Delete a bookmark', argumentHint: '<n>' })
    return next(e)
  })

  on('command.run', { command: 'bookmark' }, ($, e) => saveBookmark($, e.args.trim()))
  on('command.run', { command: 'bookmarks' }, $ => listBookmarks($))
  on('command.run', { command: 'bookmark-insert' }, ($, e) => insertBookmark($, e.args))
  on('command.run', { command: 'bookmark-delete' }, ($, e) => deleteBookmark($, e.args))
}
