import type { EngineInterface, Register } from 'claude-code'

import { findDestructive, moveTo, remoteEnvironment } from './commands'
import type { Hit } from './commands'
import { hostPatterns, parseDotenv, targetOf } from './database'

const DOTENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', 'prisma/.env']
const RISKY_WORDS = /\b(?:seed|reset|drop|fresh|refresh|flush|wipe|dropdb|loaddata)\b|migrate:(?:fresh|refresh|reset)|--force-reset|schema:(?:drop|load)|ecto\.(?:reset|drop)/i

type Settings = { allowed: readonly RegExp[]; isStrict: boolean }

/** A URL found for one variable, and where it came from. */
type Source = { name: string; url: string; origin: string }

/** The folders whose `.env` files can matter: where the command runs, and the project root. */
async function foldersOf($: EngineInterface, hit: Hit): Promise<string[]> {
  const cwd = await $.session.cwd()
  const root = await $.session.root().catch(() => cwd)
  return [...new Set([moveTo(cwd, hit.directory), moveTo(root, hit.directory), cwd, root])]
}

async function dotenvValues($: EngineInterface, folders: readonly string[], name: string): Promise<Source[]> {
  const found: Source[] = []
  for (const folder of folders) {
    for (const file of DOTENV_FILES) {
      const text = await $.fs.read(moveTo(folder, file)).catch(() => undefined)
      const url = text === undefined ? undefined : parseDotenv(text).get(name)
      if (url !== undefined && url !== '') found.push({ name, url, origin: moveTo(folder, file) })
    }
  }
  return found
}

/** What the command would connect to: the command's own words, then the process environment, then dotenv files (the order tools read them in). */
async function sourcesOf($: EngineInterface, hit: Hit): Promise<Source[]> {
  const processValues: Record<string, string | undefined> = {
    DATABASE_URL: await $.env.get('DATABASE_URL'),
    DIRECT_URL: await $.env.get('DIRECT_URL'),
  }
  const sources: Source[] = []
  for (const name of Object.keys(processValues)) {
    const own = hit.assignments[name]
    const inherited = processValues[name]
    if (own !== undefined) sources.push({ name, url: own, origin: 'the command' })
    else if (inherited !== undefined && inherited !== '') sources.push({ name, url: inherited, origin: 'the environment' })
    else sources.push(...(await dotenvValues($, await foldersOf($, hit), name)))
  }
  return sources
}

/** Why the command may not run, or undefined when it targets the own machine (or nothing can be told and that is allowed). */
async function objection($: EngineInterface, hit: Hit, settings: Settings): Promise<string | undefined> {
  const named = remoteEnvironment(hit.assignments)
  if (named !== undefined) return `"${hit.label}" runs with ${named}, which is not your own machine.`

  const sources = await sourcesOf($, hit)
  for (const { name, url, origin } of sources) {
    const target = targetOf(url, settings.allowed)
    if (target.kind === 'remote') return `"${hit.label}" would run against ${name} host "${target.host}" (from ${origin}).`
  }
  if (settings.isStrict && !sources.some(source => targetOf(source.url, settings.allowed).kind === 'local')) {
    return `"${hit.label}" can run against a database that cannot be identified (no usable DATABASE_URL in the command, the environment or .env).`
  }
  return undefined
}

export const register: Register = (on, options) => {
  const settings: Settings = { allowed: hostPatterns(String(options.allowHosts ?? '')), isStrict: options.denyUnknown === true }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    for (const hit of findDestructive(e.command)) {
      const reason = await objection($, hit, settings)
      if (reason !== undefined) {
        return {
          deny:
            `seed-guard: ${reason} Seeding, resetting and dropping is only allowed on your own machine (localhost, 127.0.0.1, ::1, a sqlite file, or a host in allowHosts). ` +
            `Point DATABASE_URL at a local database for this command, or ask the user to run it themselves.`,
        }
      }
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called || !RISKY_WORDS.test(e.command) ? next(e) : { deny: 'seed-guard: its check failed, so the command was blocked.' },
  )
}
