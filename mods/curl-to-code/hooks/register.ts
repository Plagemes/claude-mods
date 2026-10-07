import type { EngineInterface, Register } from 'claude-code'

import { parseCurl } from './curl'
import { ALIASES, FENCE, LANGUAGES, emit } from './emit'
import type { Language } from './emit'

const USAGE = [
  'Usage: /curl2code [fetch|axios|python|go] <curl command>',
  'Example: /curl2code python curl -X POST https://api.example.com/items -H "Content-Type: application/json" -d \'{"name":"x"}\'',
  'Without a language it uses the one in the mod settings, or the project\'s (go.mod, Python files, axios in package.json), or fetch.',
].join('\n')

const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']

const isLanguage = (word: string): word is Language => LANGUAGES.some(language => language === word)

const exists = async ($: EngineInterface, path: string): Promise<boolean> => {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

/** The language the project in the working directory points at; fetch when it says nothing. */
async function detectLanguage($: EngineInterface): Promise<Language> {
  const cwd = await $.session.cwd()
  if (await exists($, `${cwd}/go.mod`)) return 'go'
  if (await exists($, `${cwd}/package.json`)) {
    try {
      return String(await $.fs.read(`${cwd}/package.json`)).includes('"axios"') ? 'axios' : 'fetch'
    } catch {
      return 'fetch'
    }
  }
  for (const marker of PYTHON_MARKERS) {
    if (await exists($, `${cwd}/${marker}`)) return 'python'
  }
  return 'fetch'
}

/** Splits a leading language word from the rest of the arguments. */
const splitLanguage = (args: string): { language?: Language; curl: string } => {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args)
  const word = match?.[1]?.toLowerCase() ?? ''
  return Object.hasOwn(ALIASES, word) ? { language: ALIASES[word], curl: match?.[2] ?? '' } : { curl: args }
}

async function convert($: EngineInterface, args: string, configured: string): Promise<string> {
  const { language: asked, curl } = splitLanguage(args.trim())
  if (curl.trim() === '') return USAGE

  const parsed = parseCurl(curl)
  if (!parsed.ok) return `Could not read the curl command: ${parsed.error}.\n${USAGE}`

  const language = asked ?? (isLanguage(configured) ? configured : await detectLanguage($))
  const { code, notes } = emit(parsed.request, language)
  const fence = FENCE[language]
  const lines = [`\`\`\`${fence}`, code, '```']
  if (notes.length > 0) lines.push('', 'Not carried over:', ...notes.map(note => `- ${note}`))
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const configured = String(options.defaultLanguage ?? 'auto')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'curl2code',
      description: 'Turn a curl command into fetch, axios, Python requests or Go code',
      argumentHint: '[fetch|axios|python|go] <curl command>',
    })
    return next(e)
  })

  on('command.run', { command: 'curl2code' }, async ($, e) => ({ text: await convert($, e.args, configured) }))
}
