import type { EngineInterface, Register } from 'claude-code'

import {
  buildStem,
  defaultConvention,
  describeContent,
  describeShape,
  detectConvention,
  directoryPatterns,
  dominantExtension,
  judgeName,
  limitWords,
  placeMigration,
  splitEntry,
  wordsOf,
} from './naming'
import type { Convention, Entry, Problem } from './naming'

const DEFAULT_DIRECTORIES = 'migrations,db/migrate,db/migration,prisma/migrations,alembic/versions,supabase/migrations'
const PLACEHOLDER = ['<what_it_changes>']
const FALLBACK_EXTENSION = '.sql'
const USAGE = 'Usage: /migration-name <what the migration does> [.ext], e.g. /migration-name add status to orders'

type Settings = { directories: string[]; patterns: RegExp[]; style: 'timestamp' | 'sequence' }

const readSettings = (options: Record<string, unknown>): Settings => {
  const list = typeof options.directories === 'string' && options.directories.trim() !== '' ? options.directories : DEFAULT_DIRECTORIES
  return {
    directories: list.split(',').map(directory => directory.trim().replace(/^\/+|\/+$/g, '')).filter(directory => directory !== ''),
    patterns: directoryPatterns(list),
    style: options.defaultStyle === 'sequence' ? 'sequence' : 'timestamp',
  }
}

async function listEntries($: EngineInterface, directory: string): Promise<Entry[]> {
  try {
    return (await $.fs.list(directory)).map(({ name, kind }) => ({ name, kind }))
  } catch {
    return []
  }
}

const folderName = (directory: string): string => directory.replace(/\/+$/, '').split('/').slice(-2).join('/')

const reasonFor = (name: string, problems: readonly Problem[]): string => {
  if (problems.length === 2) return `"${name}" is too generic and has no timestamp or number in front`
  return problems[0] === 'generic'
    ? `"${name}" is too generic to say what the migration does`
    : `"${name}" has no timestamp or sequence number, so the order of migrations is unclear`
}

const conventionNote = (directory: string, convention: Convention): string =>
  convention.example === undefined
    ? `New migrations should be named ${describeShape(convention)}.`
    : `Migrations in ${folderName(directory)} follow ${describeShape(convention)}, like ${convention.example}.`

/** The path a new migration should take: a file, or a folder holding migration.sql in the nested (Prisma) layout. */
const suggestedPath = (directory: string, stem: string, ext: string, innerFile: string | undefined, isNested: boolean): string =>
  innerFile !== undefined || isNested ? `${directory}${stem}/${innerFile ?? `migration${ext === '' ? FALLBACK_EXTENSION : ext}`}` : `${directory}${stem}${ext}`

async function refuseUnlessWellNamed($: EngineInterface, path: string, content: string, settings: Settings): Promise<string | undefined> {
  const placement = placeMigration(path, settings.patterns)
  if (placement === undefined) return undefined
  const isNestedFile = placement.innerFile !== undefined
  const { stem, ext } = splitEntry(placement.entry, isNestedFile)
  const problems = judgeName(stem)
  // Only a migration that does not exist yet is named here; rewriting an existing one is not this mod's business.
  if (problems.length === 0 || (await $.fs.exists(path))) return undefined

  const siblings = (await listEntries($, placement.directory)).filter(entry => entry.name !== placement.entry)
  const convention = detectConvention(siblings) ?? defaultConvention(settings.style)
  const words = describeContent(content) ?? PLACEHOLDER
  const suggestion = suggestedPath(placement.directory, buildStem(convention, words, await $.clock.now()), ext, placement.innerFile, convention.isNested)
  const hint = words === PLACEHOLDER ? ' Replace <what_it_changes> with a few words about the change.' : ''

  return (
    `migration-namer: ${reasonFor(placement.entry, problems)}. ${conventionNote(placement.directory, convention)} ` +
    `Write it as ${suggestion} instead.${hint}`
  )
}

async function suggestName($: EngineInterface, description: string, settings: Settings): Promise<string> {
  const tokens = description.trim().split(/\s+/).filter(token => token !== '')
  const typedExtension = /^\.[a-z0-9]{1,5}$/i.test(tokens.at(-1) ?? '') ? tokens.pop() : undefined
  const words = limitWords(wordsOf(tokens.join(' ')))
  if (words.length === 0) return USAGE

  const root = (await $.session.root()).replace(/[\\/]+$/, '')
  let directory: string | undefined
  for (const candidate of settings.directories) {
    if (await $.fs.exists(`${root}/${candidate}`)) {
      directory = candidate
      break
    }
  }
  const entries = directory === undefined ? [] : await listEntries($, `${root}/${directory}`)
  const convention = detectConvention(entries) ?? defaultConvention(settings.style)
  const ext = typedExtension ?? dominantExtension(entries) ?? FALLBACK_EXTENSION
  const stem = buildStem(convention, words, await $.clock.now())
  const name = convention.isNested ? `${stem}/migration${ext}` : `${stem}${ext}`
  const origin = directory === undefined ? 'no migrations folder found here' : `from ${directory}`

  return [name, `Convention: ${describeShape(convention)} (${origin})`].join('\n')
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'migration-name',
      description: "Suggest a migration file name that follows the folder's convention",
      argumentHint: '<what the migration does> [.ext]',
    })
    return next(e)
  })

  on('command.run', { command: 'migration-name' }, async ($, e) => {
    try {
      return { text: await suggestName($, e.args, settings) }
    } catch {
      return { text: 'Could not look at the project, so no name was suggested.' }
    }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (e._host !== undefined) return next(e)
    const reason = await refuseUnlessWellNamed($, e.file_path, e.content, settings)
    return reason === undefined ? next(e) : { deny: reason }
  }).catch(($, e, next) => next(e)) // a naming helper must never stop a write by failing
}
