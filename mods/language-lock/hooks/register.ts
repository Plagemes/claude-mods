import type { Register } from 'claude-code'

const DEFAULT_LANGUAGE = 'English'
const MAX_LANGUAGE_LENGTH = 60

/** A language name from the config row, kept to one short line so it cannot smuggle in instructions. */
const cleanLanguage = (value: unknown): string => {
  const language = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_LANGUAGE_LENGTH) : ''
  return language === '' ? DEFAULT_LANGUAGE : language
}

export const register: Register = (on, options) => {
  const language = cleanLanguage(options.language)
  const text =
    `Language: always write your replies to the user in ${language}, whatever language they write in, ` +
    `unless they ask for another one. Keep code, identifiers, code comments, file names, commit messages ` +
    `and pull request titles in English unless the user asks otherwise.`

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare')) return composed

    return { sections: [...composed.sections, { id: 'language-lock:language', text, scope: 'session' }] }
  })
}
