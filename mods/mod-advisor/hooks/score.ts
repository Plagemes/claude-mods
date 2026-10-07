/**
 * The advisor's judgement, pure: what a project is made of, which mods fit it,
 * and which fit what the person is asking. Nothing here knows a mod by name:
 * a mod is judged by its catalog entry (its `signals` when it has them, else
 * the words of its name, description and keywords), so a mod added to the
 * catalog tomorrow is judged the same way.
 */
import type { AdvisorMod } from '../types'

// ── Text ─────────────────────────────────────────────────────────────────────

const DIACRITICS = /[̀-ͯ]/g
const ESCAPE = /[.*+?^${}()|[\]\\]/g
const MAX_PROMPT_TOKENS = 80

/** Lower case, accents dropped: `Perché` → `perche`. */
export const normalize = (text: string): string => text.normalize('NFD').replace(DIACRITICS, '').toLowerCase()

const escapeRegExp = (text: string): string => text.replace(ESCAPE, '\\$&')

/** Words that say nothing about what a mod is for (English and Italian). */
const STOPWORDS = new Set(
  (
    'a about after again all also am an and any are as at be been before being but by can could did do does doing done for from ' +
    'get got had has have having how i if in into is it its just let lets like make me more most my need no not now of on once ' +
    'only or our out over please so some such than that the their them then there these they this those through to too up us use ' +
    'used using very via want was we were what when where which while who why will with would you your yours claude code mod mods ' +
    'thing things something way ok okay hey hi thanks thank else nothing anything everything here someone ' +
    // Italian
    'il lo la i gli le un uno una di da con su per tra fra e ed o che chi cui non come dove quando perche quale quali questo questa ' +
    'questi queste quello quella sono sei siamo ho hai ha abbiamo avete hanno mi ti ci vi si del dello della dei degli delle al allo ' +
    'alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle col coi mio mia ' +
    'miei mie tuo tua suo sua nostro vostro loro piu anche ma se poi gia ancora fai fare faccio fammi puoi puo posso voglio vorrei ' +
    'devo serve bisogna cosi cosa tutto tutti tutte molto qui qua ecco ciao grazie sto stai sta stiamo essere avere'
  ).split(/\s+/),
)

/** Verbs and fillers every request has: they would match mods named after them (`*-check`, `quick-*`). */
const PROMPT_NOISE = new Set(
  (
    'check run add create make show find fix help look see tell give put try set new old good better best really quick quickly ' +
    'simple small big bit lot work works working file files function functions class method line lines thing stuff issue problem ' +
    'aggiungi crea mostra trova sistema aiuta guarda dimmi dammi prova metti nuovo vecchio bene meglio'
  ).split(/\s+/),
)

/**
 * Prompt words that stand for the words mod descriptions use: Italian, and
 * the shorthand people type. Applied to prompts only.
 */
const LEXICON: readonly (readonly [RegExp, readonly string[]])[] = [
  // English shorthand and synonyms
  [/^(ship|shipping|release|releasing|publish|publishing|deployment)$/, ['deploy']],
  [/^prod$/, ['production']],
  [/^(k8s|kube)$/, ['kubernetes', 'kubectl']],
  [/^prs?$/, ['pull', 'request']],
  [/^(db|dbs|postgres|postgresql|mysql|sqlite|mongo|mongodb)$/, ['database']],
  [/^tf$/, ['terraform']],
  [/^perf$/, ['performance']],
  [/^a11y$/, ['accessibility']],
  [/^deps?$/, ['dependency']],
  [/^(vulns?|cves?)$/, ['vulnerability']],
  [/^(spending|spent|price|pricing|money|bill|billing|expensive|cheap|cheaper)$/, ['cost', 'spend']],
  [/^(notify|notified|ping|alert)$/, ['notification']],
  [/^(credentials?|apikeys?|passwords?)$/, ['secret']],
  // Italian
  [/^(rilasci|distribu|pubblic)/, ['deploy', 'release', 'publish']],
  [/^produzion/, ['production']],
  [/^messagg/, ['message']],
  [/^ram[oi]$/, ['branch']],
  [/^conflitt/, ['conflict']],
  [/^(unir|unisc|fusion)/, ['merge']],
  [/^segret/, ['secret']],
  [/^chiav/, ['key', 'secret']],
  [/^(cost[oiae]|spes[ae]|spend)/, ['cost', 'spend']],
  [/^(lent[oiae]|lentezz|rallent)/, ['slow']],
  [/^(prestazion|veloc|ottimizz)/, ['performance', 'fast']],
  [/^(error[ei]|sbagli)$/, ['error', 'mistake']],
  [/^dipendenz/, ['dependency', 'package']],
  [/^aggiorn/, ['update', 'upgrade', 'outdated']],
  [/^vulnerabil/, ['vulnerability', 'audit']],
  [/^licenz/, ['license']],
  [/^(traduz|tradur|traduc|lingu)/, ['language', 'translation', 'i18n']],
  [/^accessibil/, ['accessibility']],
  [/^color[ei]$/, ['color']],
  [/^contrast/, ['contrast']],
  [/^immagin/, ['image']],
  [/^componen/, ['component']],
  [/^document/, ['docs', 'readme', 'documentation']],
  [/^(riassun|sintes|riepilog)/, ['summary']],
  [/^spieg/, ['explain']],
  [/^(revision|rived|recension)/, ['review']],
  [/^(ricord|memori)/, ['remember', 'memory']],
  [/^appunt/, ['notes']],
  [/^contest/, ['context']],
  [/^modell/, ['model']],
  [/^(notific|avvis)/, ['notification', 'alert']],
  [/^suon/, ['sound', 'chime']],
  [/^migr/, ['migration', 'migrate']],
  [/^tabell/, ['table']],
  [/^contenitor/, ['container', 'docker']],
  [/^(elimin|cancell|rimuov)/, ['delete', 'remove']],
  [/^cartell/, ['folder', 'directory']],
  [/^pagin/, ['page']],
  [/^(pulsant|bottone)/, ['button']],
  [/^sicurezz/, ['security', 'secret']],
  [/^schermat/, ['screenshot']],
  [/^(cronolog|storic)/, ['history']],
  [/^richiest/, ['request']],
  [/^difett/, ['bug', 'error']],
  [/^segnalaz/, ['issue', 'report']],
  [/^obiettiv/, ['goal']],
  [/^paus/, ['break']],
  [/^formatt/, ['format', 'formatter']],
  [/^tip(i|izz)/, ['types', 'typecheck']],
  [/^(scriv|scritt)/, ['write']],
  [/^gener/, ['generate']],
  [/^dati$/, ['data']],
  [/^tracc/, ['tracking', 'analytics']],
  [/^caric/, ['upload']],
  [/^rete$/, ['network']],
  [/^disco$/, ['disk']],
  [/^(sottoagent|agent[ei])/, ['subagent', 'agent']],
  [/^parallel/, ['parallel']],
  [/^coda$/, ['queue']],
  [/^(nott|notturn)/, ['overnight', 'night']],
  [/^(impar|insegn|studi)/, ['learn', 'learning']],
  [/^scorciatoi/, ['shortcut']],
  [/^(esegu|lanci|avvi)/, ['run', 'start']],
  [/^(controll|verific)/, ['check']],
  [/^collaud/, ['test']],
  [/^registr/, ['log', 'record']],
  [/^(vecchi|obsolet)/, ['outdated']],
  [/^(ripristin|annull)/, ['rollback', 'undo', 'checkpoint']],
  [/^salvatagg/, ['backup', 'checkpoint']],
  [/^perdit/, ['leak']],
  [/^stile$/, ['style']],
  [/^regol/, ['rule']],
  [/^(squadr|collegh)/, ['team', 'teammate', 'handoff']],
  [/^consegn/, ['handoff']],
  [/^ieri$/, ['yesterday']],
  [/^(cambiament|modific)/, ['change', 'edit', 'diff']],
  [/^differenz/, ['diff']],
  [/^(rischi|pericol)/, ['dangerous', 'risk']],
  [/^interrog/, ['query']],
  [/^profil/, ['profile', 'profiler']],
  [/^domand/, ['question', 'quiz']],
  [/^(capir|comprend)/, ['understand', 'explain']],
]

/** A path (`/tmp/x`, `./src`, `~/a`, `src/app/page.tsx`): it names a place, not a need. */
const PATH_WORD = /(?:^|\s)(?:[~.]{0,2}\/\S*|\S*\/\S*\/\S*)/g
/** Extensions that say what a file is made of, not what it is about (`config.yaml` → `config`). */
const PLAIN_EXTENSION = /\b([\w-]+)\.(?:json|ya?ml|[cm]?[jt]sx?|md|txt|lock|html?|cfg|ini|xml|log)\b/g

/** A prompt without its paths and plain file extensions. */
const cleanPrompt = (text: string): string => text.replace(PATH_WORD, ' ').replace(PLAIN_EXTENSION, '$1')

/** A light English stemmer: both sides go through it, so it only has to be consistent. */
export function stem(word: string): string {
  let out = word
  if (out.length > 4 && out.endsWith('ies')) {
    return `${out.slice(0, -3)}y`
  }
  if (out.length > 5 && out.endsWith('ing')) {
    out = out.slice(0, -3)
  } else if (out.length > 4 && out.endsWith('ed')) {
    out = out.slice(0, -2)
  } else if (/(?:ss|x|z|ch|sh)es$/.test(out) && out.length > 4) {
    out = out.slice(0, -2)
  } else if (out.length > 3 && out.endsWith('s') && !out.endsWith('ss')) {
    out = out.slice(0, -1)
  }
  if (out.length > 4 && out.endsWith('e')) {
    out = out.slice(0, -1)
  }

  return out
}

/** One word of a text: its stem, and the word as written (for the reason shown). */
export type Token = { stem: string; surface: string }

/**
 * The distinct words of a text, stemmed, stopwords dropped; with `isPrompt`,
 * also the words the lexicon reads into it (Italian, shorthand).
 */
export function tokensOf(text: string, isPrompt = false): Token[] {
  const tokens: Token[] = []
  const seen = new Set<string>()
  const add = (term: string, surface: string): void => {
    const stemmed = stem(term)
    if (!seen.has(stemmed) && !STOPWORDS.has(term)) {
      seen.add(stemmed)
      tokens.push({ stem: stemmed, surface })
    }
  }
  for (const word of normalize(isPrompt ? cleanPrompt(text) : text).split(/[^a-z0-9]+/)) {
    if (word.length < 2 || STOPWORDS.has(word) || /^\d+$/.test(word) || (isPrompt && PROMPT_NOISE.has(word))) {
      continue
    }
    add(word, word)
    if (isPrompt) {
      for (const [pattern, words] of LEXICON) {
        if (pattern.test(word)) {
          words.forEach(term => add(term, word))
        }
      }
    }
    if (isPrompt && tokens.length >= MAX_PROMPT_TOKENS) {
      break
    }
  }

  return tokens
}

const phraseCache = new Map<string, RegExp>()

/** Whether a normalized text holds `phrase` as whole words (`next.js`, `.env`, `go.mod`, `use client`). */
export function mentions(normalizedText: string, phrase: string): boolean {
  const needle = normalize(phrase).trim()
  if (needle === '') {
    return false
  }
  let pattern = phraseCache.get(needle)
  if (pattern === undefined) {
    pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`)
    phraseCache.set(needle, pattern)
  }

  return pattern.test(normalizedText)
}

// ── Globs and dependencies ───────────────────────────────────────────────────

/** A compiled glob: its pattern, whether it names directories only, whether it matches a base name at any depth. */
export type Glob = { pattern: RegExp; isDirOnly: boolean; isBaseName: boolean }

const globCache = new Map<string, Glob>()

/**
 * Compiles a glob over project-relative paths: `*` and `?` within a name, `**`
 * across folders, `{a,b}` alternatives. A glob with no `/` matches a name at
 * any depth (`*.tf`, `Dockerfile`), one with a `/` the whole path
 * (`prisma/schema.prisma`, `.github/workflows/*.yml`); a trailing `/` names a folder.
 */
export function compileGlob(glob: string): Glob {
  const known = globCache.get(glob)
  if (known !== undefined) {
    return known
  }
  const isDirOnly = glob.endsWith('/')
  const body = glob.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  const isBaseName = !body.includes('/')
  let source = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? ''
    if (char === '*' && body[index + 1] === '*') {
      index += 1
      if (body[index + 1] === '/') {
        index += 1
        source += '(?:.*/)?'
      } else {
        source += '.*'
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '{' && body.indexOf('}', index) > index) {
      const end = body.indexOf('}', index)
      source += `(?:${body.slice(index + 1, end).split(',').map(escapeRegExp).join('|')})`
      index = end
    } else {
      source += escapeRegExp(char)
    }
  }
  const compiled = { pattern: new RegExp(`^${source}$`, 'i'), isDirOnly, isBaseName }
  globCache.set(glob, compiled)

  return compiled
}

/** What the project holds, as far as the advisor looked: paths relative to its root, and dependency names. */
export type ProjectFacts = {
  files: readonly string[]
  dirs: readonly string[]
  deps: readonly string[]
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The first path of the project the glob matches, or undefined. */
export function matchGlob(facts: ProjectFacts, glob: string): string | undefined {
  const { pattern, isDirOnly, isBaseName } = compileGlob(glob)
  const test = (path: string): boolean => pattern.test(isBaseName ? baseName(path) : path)
  return (isDirOnly ? undefined : facts.files.find(test)) ?? facts.dirs.find(test)
}

/** A dependency name as the ecosystems compare them: lower case, `_` and `.` as `-` for Python. */
export const normalizeDep = (name: string): string => name.trim().toLowerCase().replace(/_/g, '-')

/** The first dependency of the project `wanted` names (a trailing `*` matches a prefix), or undefined. */
export function matchDep(facts: ProjectFacts, wanted: string): string | undefined {
  const target = normalizeDep(wanted)
  if (target === '') {
    return undefined
  }
  return target.endsWith('*')
    ? facts.deps.find(dep => dep.startsWith(target.slice(0, -1)))
    : facts.deps.find(dep => dep === target)
}

// ── Stacks ───────────────────────────────────────────────────────────────────

/**
 * A technology the advisor can recognise in a project, and the words a mod's
 * description uses when it is about it. Strong words name it; related words
 * are what such projects need (a Prisma project has migrations). `weight` is
 * how specific it is: a framework says more about a project than a language,
 * a language more than a habit.
 */
export type Tech = {
  id: string
  label: string
  files: readonly string[]
  deps: readonly string[]
  strong: readonly string[]
  related: readonly string[]
  weight: number
  /** Shown in the band's "(Next.js, Prisma, Docker)": a stack, not a habit like tests or a changelog. */
  isStack: boolean
}

const FRAMEWORK = 4
const LANGUAGE = 3
const HABIT = 2

const UI_WORDS = ['component', 'components', 'ui', 'storybook', 'accessibility', 'css', 'bundle']
const DB_WORDS = ['database', 'databases', 'migration', 'migrations', 'schema', 'query', 'queries', 'seed', 'database_url', 'tables']

const tech = (
  id: string,
  label: string,
  weight: number,
  sources: { files?: readonly string[]; deps?: readonly string[] },
  strong: readonly string[],
  related: readonly string[] = [],
): Tech => ({ id, label, weight, files: sources.files ?? [], deps: sources.deps ?? [], strong, related, isStack: weight > HABIT })

export const TECHS: readonly Tech[] = [
  tech('next', 'Next.js', FRAMEWORK, { files: ['next.config.*'], deps: ['next'] }, ['next.js', 'nextjs', 'use client'], ['server-only', ...UI_WORDS]),
  tech('react', 'React', FRAMEWORK, { deps: ['react', 'react-dom', 'react-native'] }, ['react', 'jsx'], UI_WORDS),
  tech('vue', 'Vue', FRAMEWORK, { files: ['*.vue', 'nuxt.config.*'], deps: ['vue', 'nuxt'] }, ['vue', 'nuxt'], UI_WORDS),
  tech('svelte', 'Svelte', FRAMEWORK, { files: ['*.svelte', 'svelte.config.*'], deps: ['svelte', '@sveltejs/kit'] }, ['svelte'], UI_WORDS),
  tech('angular', 'Angular', FRAMEWORK, { files: ['angular.json'], deps: ['@angular/core'] }, ['angular'], UI_WORDS),
  tech('django', 'Django', FRAMEWORK, { files: ['manage.py'], deps: ['django'] }, ['django'], ['models', ...DB_WORDS]),
  tech('flask', 'Flask', FRAMEWORK, { deps: ['flask'] }, ['flask'], ['api routes']),
  tech('fastapi', 'FastAPI', FRAMEWORK, { deps: ['fastapi'] }, ['fastapi'], ['openapi', 'api routes']),
  tech('laravel', 'Laravel', FRAMEWORK, { deps: ['laravel/framework'] }, ['laravel'], DB_WORDS),
  tech('rails', 'Rails', FRAMEWORK, { deps: ['rails'] }, ['rails'], DB_WORDS),
  tech('prisma', 'Prisma', FRAMEWORK, { files: ['schema.prisma'], deps: ['prisma', '@prisma/client'] }, ['prisma'], DB_WORDS),
  tech('drizzle', 'Drizzle', FRAMEWORK, { files: ['drizzle.config.*'], deps: ['drizzle-orm', 'drizzle-kit'] }, ['drizzle'], DB_WORDS),
  tech('docker', 'Docker', FRAMEWORK, { files: ['Dockerfile', 'Dockerfile.*', '*.dockerfile', 'docker-compose*.y*ml', 'compose.y*ml', '.dockerignore'] },
    ['docker', 'dockerfile', 'dockerfiles', 'container', 'containers']),
  tech('kubernetes', 'Kubernetes', FRAMEWORK, { files: ['k8s/', 'kubernetes/', 'helm/', 'charts/', 'Chart.yaml', 'kustomization.y*ml', 'skaffold.y*ml'] },
    ['kubernetes', 'kubectl', 'k8s', 'helm']),
  tech('terraform', 'Terraform', FRAMEWORK, { files: ['*.tf', '.terraform.lock.hcl'] }, ['terraform', 'infrastructure', 'cloud resources'], ['cloud']),
  tech('graphql', 'GraphQL', FRAMEWORK, { files: ['*.graphql', '*.gql'], deps: ['graphql', '@apollo/server', '@apollo/client', 'graphql-yoga'] }, ['graphql']),
  tech('storybook', 'Storybook', FRAMEWORK, { files: ['.storybook/'], deps: ['storybook', '@storybook/*'] }, ['storybook', 'story']),
  tech('playwright', 'Playwright', FRAMEWORK, { files: ['playwright.config.*'], deps: ['@playwright/test', 'playwright'] }, ['playwright', 'screenshot']),
  tech('typescript', 'TypeScript', LANGUAGE, { files: ['tsconfig.json', '*.ts', '*.tsx'], deps: ['typescript'] },
    ['typescript', 'ts-ignore', 'type-check', 'type-checks', 'typecheck', 'any types'], ['eslint-disable']),
  tech('python', 'Python', LANGUAGE, { files: ['pyproject.toml', 'requirements*.txt', 'setup.py', 'Pipfile', '*.py'] },
    ['python', 'pip', 'virtualenv', 'venv', 'pip-audit', 'pypi', '__future__']),
  tech('go', 'Go', LANGUAGE, { files: ['go.mod', '*.go'] }, ['go.mod', 'go.sum', 'golang', 'go mod', 'go imports']),
  tech('rust', 'Rust', LANGUAGE, { files: ['Cargo.toml', '*.rs'] }, ['rust', 'cargo', 'dbg!']),
  tech('php', 'PHP', LANGUAGE, { files: ['composer.json', '*.php'] }, ['php', 'composer', 'strict_types']),
  tech('ruby', 'Ruby', LANGUAGE, { files: ['Gemfile', '*.rb'] }, ['ruby', 'gem', 'bundler']),
  tech('java', 'Java', LANGUAGE, { files: ['pom.xml', 'build.gradle', 'build.gradle.kts'] }, ['java', 'maven', 'gradle', 'spring']),
  tech('sql', 'SQL', LANGUAGE, {
    files: ['*.sql', 'migrations/', 'alembic.ini'],
    deps: ['pg', 'postgres', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'psycopg', 'psycopg2', 'psycopg2-binary', 'sqlalchemy',
      'typeorm', 'sequelize', 'knex', 'mongoose', 'gorm.io/gorm', 'diesel', 'sqlx', 'activerecord'],
  }, ['sql', 'psql', 'mysql', 'sqlite', 'postgres'], DB_WORDS),
  tech('node', 'Node.js', HABIT, { files: ['package.json'] }, ['node', 'npm', 'nvmrc', 'package.json'], ['javascript', 'lockfiles', 'console.log']),
  tech('css', 'CSS', HABIT, { files: ['*.css', '*.scss', '*.sass', '*.less', 'tailwind.config.*'], deps: ['tailwindcss', 'sass', 'styled-components', '@emotion/react'] },
    ['css', 'design tokens', 'contrast', 'dark-mode', 'dark theme', 'hex colors'], ['colors', 'accessibility', 'wcag']),
  tech('monorepo', 'monorepo', HABIT, { files: ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'] }, ['monorepo']),
  tech('openapi', 'OpenAPI', HABIT, { files: ['openapi.{yaml,yml,json}', 'swagger.{yaml,yml,json}'] }, ['openapi'], ['api routes', 'api server']),
  tech('actions', 'GitHub Actions', HABIT, { files: ['.github/workflows/*.yml', '.github/workflows/*.yaml'] }, ['github actions', 'workflows']),
  tech('tests', 'tests', HABIT, {
    files: ['*.test.*', '*.spec.*', '__tests__/', 'pytest.ini', 'conftest.py', '*_test.go'],
    deps: ['jest', 'vitest', 'mocha', 'pytest', '@testing-library/*'],
  }, [], ['tests', 'flaky', 'tdd']),
  tech('env', '.env', HABIT, { files: ['.env', '.env.*'] }, ['.env', 'env.example', 'environment variables']),
  tech('i18n', 'i18n', HABIT, { files: ['locales/', 'i18n/'], deps: ['i18next', 'react-i18next', 'react-intl', 'vue-i18n', 'next-intl'] },
    ['i18n', 'user-facing strings']),
  tech('deploy', 'deploy config', HABIT, { files: ['vercel.json', 'netlify.toml', 'fly.toml', 'firebase.json', 'app.yaml', 'Procfile'], deps: ['vercel', 'netlify-cli', 'firebase-tools'] },
    ['deploy', 'deploying', 'pre-deploy'], ['production']),
  tech('changelog', 'changelog', HABIT, { files: ['CHANGELOG.md'] }, ['changelog']),
  tech('codeowners', 'CODEOWNERS', HABIT, { files: ['CODEOWNERS'] }, ['codeowners']),
  tech('csv', 'CSV data', HABIT, { files: ['*.csv', '*.jsonl'] }, ['csv', 'jsonl']),
]

/** A technology found in the project, and the path or dependency that gave it away. */
export type Detected = { tech: Tech; cause: Cause }
export type Cause = { kind: 'file' | 'dep'; detail: string }

/** The technologies the project shows, in the table's order. */
export function detectStack(facts: ProjectFacts, techs: readonly Tech[] = TECHS): Detected[] {
  const found: Detected[] = []
  for (const one of techs) {
    const dep = one.deps.map(wanted => matchDep(facts, wanted)).find(match => match !== undefined)
    const file = dep === undefined ? one.files.map(glob => matchGlob(facts, glob)).find(match => match !== undefined) : undefined
    if (dep !== undefined) {
      found.push({ tech: one, cause: { kind: 'dep', detail: dep } })
    } else if (file !== undefined) {
      found.push({ tech: one, cause: { kind: 'file', detail: file } })
    }
  }

  return found
}

/** The stack's labels for the band: frameworks and platforms, most specific first, at most `limit`. */
export function stackLabels(stack: readonly Detected[], limit = 3): string[] {
  const shown = stack.filter(one => one.tech.isStack)
  // A framework says more than the language under it: Next.js before React, TypeScript and Node.js.
  const generic = new Set(['react', 'typescript', 'node', 'python', 'php', 'ruby'])
  const ordered = [...shown.filter(one => !generic.has(one.tech.id)), ...shown.filter(one => generic.has(one.tech.id))]
  return ordered.slice(0, limit).map(one => one.tech.label)
}

// ── Scores ───────────────────────────────────────────────────────────────────

/** One reason a mod scored. */
export type Evidence =
  | { kind: 'file'; detail: string; glob: string }
  | { kind: 'dep'; detail: string }
  | { kind: 'stack'; detail: string; word: string; cause: Cause; isStrong: boolean }
  | { kind: 'essential'; detail: string }
  | { kind: 'intent'; detail: string; word: string }

export type Scored = { name: string; score: number; evidence: Evidence[] }

const FILE_WEIGHT = 4
const DEP_WEIGHT = 5
const SIGNAL_MATCHES_COUNTED = 2
const RELATED_WORD = 1.5
const RELATED_WORDS_COUNTED = 2
const NAME_BONUS = 1
/** A project pick needs this much: one signal, one strong word, or three related ones. */
export const PROJECT_MIN = 3
export const PROJECT_LIMIT = 8
export const ESSENTIALS_LIMIT = 3

/** The text a mod is judged by when it has no signals: its name, description and keywords. */
export const modText = (mod: AdvisorMod): string =>
  normalize([mod.name.replace(/-/g, ' '), mod.description, ...(mod.keywords ?? [])].join(' \n '))

/**
 * The part of a description that says what the mod is about: up to its first
 * comma, colon, semicolon, dash or full stop outside parentheses. "Warns when
 * the disk is nearly full before builds, installs and docker pulls" is about
 * disks, not Docker; a technology named later is only mentioned in passing.
 */
export function headOf(description: string): string {
  let depth = 0
  for (let index = 0; index < description.length; index += 1) {
    const char = description[index]
    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (char === ',' || char === ':' || char === ';' || char === '\u2014' || (char === '.' && /\s/.test(description[index + 1] ?? ' ')))) {
      return description.slice(0, index)
    }
  }

  return description
}

/** The name and the head of the description: where a technology must be named to count fully. */
const modHead = (mod: AdvisorMod): string =>
  normalize([mod.name.replace(/-/g, ' '), headOf(mod.description), ...(mod.keywords ?? [])].join(' \n '))

/** How well a mod's words fit the technologies found: its name and description against the stack. */
function wordScore(mod: AdvisorMod, stack: readonly Detected[]): Scored {
  const evidence: Evidence[] = []
  let score = 0
  const text = modText(mod)
  const head = modHead(mod)
  const nameWords = new Set(mod.name.toLowerCase().split('-'))
  const strongWords = new Set<string>()
  const related: Evidence[] = []
  for (const found of stack) {
    const strong = found.tech.strong.find(word => mentions(head, word))
    if (strong !== undefined) {
      strongWords.add(stem(normalize(strong)))
      score += found.tech.weight + (nameWords.has(found.tech.id) ? NAME_BONUS : 0)
      evidence.push({ kind: 'stack', detail: found.tech.label, word: strong, cause: found.cause, isStrong: true })
      continue
    }
    // A technology named only in passing counts as a related word.
    for (const word of [...found.tech.strong, ...found.tech.related].filter(one => mentions(text, one))) {
      related.push({ kind: 'stack', detail: found.tech.label, word, cause: found.cause, isStrong: false })
    }
  }
  // A mod about another stack (Prisma, in a Django project) is not made to fit by the words they share.
  const isOtherStack = strongWords.size === 0 &&
    TECHS.some(other => other.weight > HABIT && !stack.some(found => found.tech.id === other.id) && other.strong.some(word => mentions(head, word)))
  if (isOtherStack) {
    return { name: mod.name, score: 0, evidence: [] }
  }
  // Related words count once each, however many technologies share them, and only up to a point.
  const counted = new Set(strongWords)
  for (const one of related) {
    const key = one.kind === 'stack' ? stem(normalize(one.word)) : ''
    if (!counted.has(key) && counted.size - strongWords.size < RELATED_WORDS_COUNTED) {
      counted.add(key)
      score += RELATED_WORD
      evidence.push(one)
    }
  }

  return { name: mod.name, score, evidence }
}

/**
 * How well one mod fits the project. A mod with `signals` is judged by them
 * alone (files and dependencies found, `always`; one whose signals name
 * neither is not about projects); one without, by the words of its catalog
 * entry against the technologies found. `affinity`, the words' score either
 * way, orders mods the signals score alike: `go-mod-tidy` before a mod that
 * merely lists `go.mod` among many manifests.
 */
export function projectScore(mod: AdvisorMod, facts: ProjectFacts, stack: readonly Detected[]): Scored & { affinity: number } {
  const words = wordScore(mod, stack)
  if (mod.signals === undefined) {
    return { ...words, affinity: words.score }
  }
  const files = (mod.signals.files ?? [])
    .map(glob => ({ glob, path: matchGlob(facts, glob) }))
    .filter((match, index, all): match is { glob: string; path: string } =>
      match.path !== undefined && all.findIndex(other => other.path === match.path) === index)
    .slice(0, SIGNAL_MATCHES_COUNTED)
  const deps = [...new Set((mod.signals.deps ?? []).map(wanted => matchDep(facts, wanted)).filter((dep): dep is string => dep !== undefined))]
    .slice(0, SIGNAL_MATCHES_COUNTED)
  const evidence: Evidence[] = [
    ...deps.map((dep): Evidence => ({ kind: 'dep', detail: dep })),
    ...files.map((match): Evidence => ({ kind: 'file', detail: match.path, glob: match.glob })),
    ...(mod.signals.always === true ? [{ kind: 'essential', detail: 'every project' } as const] : []),
  ]

  return { name: mod.name, score: deps.length * DEP_WEIGHT + files.length * FILE_WEIGHT, evidence, affinity: words.score }
}

const strongCount = (scored: Scored): number =>
  scored.evidence.filter(one => one.kind === 'dep' || one.kind === 'file' || (one.kind === 'stack' && one.isStrong)).length

const isEssential = (scored: Scored): boolean => scored.evidence.some(one => one.kind === 'essential')

/**
 * The mods that fit the project, best first: those scoring at least
 * PROJECT_MIN (at most `limit`), then the essentials. `exclude` names the
 * mods not to offer (installed, dismissed).
 */
export function rankProject(
  mods: readonly AdvisorMod[],
  facts: ProjectFacts,
  exclude: ReadonlySet<string> = new Set(),
  limit = PROJECT_LIMIT,
): { picks: Scored[]; stack: Detected[] } {
  const stack = detectStack(facts)
  const scored = mods
    .filter(mod => !exclude.has(mod.name))
    .map((mod, index) => ({ scored: projectScore(mod, facts, stack), index }))
  const fits = scored
    .filter(({ scored: one }) => one.score >= PROJECT_MIN)
    .sort((a, b) =>
      b.scored.score - a.scored.score || b.scored.affinity - a.scored.affinity || strongCount(b.scored) - strongCount(a.scored) || a.index - b.index)
    .slice(0, limit)
    .map(({ scored: one }) => one)
  const essentials = scored
    .map(({ scored: one }) => one)
    .filter(one => isEssential(one) && !fits.some(fit => fit.name === one.name))
    .slice(0, ESSENTIALS_LIMIT)

  return { picks: [...fits, ...essentials], stack }
}

// ── Intents ──────────────────────────────────────────────────────────────────

const NAME_FIELD = 3
const COMMAND_FIELD = 3
const INTENT_FIELD = 3
const KEYWORD_FIELD = 2
const DESCRIPTION_FIELD = 1
const PHRASE_BONUS = 8
/** A description word this rare (in at most ~1 in 12 mods) is telling. */
const RARE_IDF = 2.5
/** A description word this rare (in at most three mods) is enough on its own. */
const VERY_RARE_IDF = 4.1
const MIN_STRONG_WORD = 4
/** How much of a prompt is read for intents. */
export const PROMPT_CHARS = 2_000
/** The most a common word counts, whatever field it sits in. */
const COMMON_FIELD = 1.5

/** Each mod's words with the weight of the field they came from, and how rare each word is across the catalog. */
export type IntentIndex = {
  docs: ReadonlyMap<string, ReadonlyMap<string, number>>
  phrases: ReadonlyMap<string, readonly string[]>
  idf: ReadonlyMap<string, number>
}

const commandWords = (command: string): string => command.replace(/^\//, '').replace(/[-_:]/g, ' ')

/** Indexes the catalog once per version; every prompt is scored against it. */
export function buildIndex(mods: readonly AdvisorMod[]): IntentIndex {
  const docs = new Map<string, Map<string, number>>()
  const phrases = new Map<string, string[]>()
  const counts = new Map<string, number>()
  for (const mod of mods) {
    const doc = new Map<string, number>()
    const put = (text: string, weight: number): void => {
      for (const token of tokensOf(text)) {
        doc.set(token.stem, Math.max(doc.get(token.stem) ?? 0, weight))
      }
    }
    put(mod.description, DESCRIPTION_FIELD)
    put((mod.keywords ?? []).join(' '), KEYWORD_FIELD)
    put(mod.name.replace(/-/g, ' '), NAME_FIELD)
    put((mod.commands ?? []).map(commandWords).join(' '), COMMAND_FIELD)
    // A one-word intent tells on its own; the words of a phrase only as description words (the whole phrase scores
    // as a phrase): "pip --user" must not make every prompt about a "user" a venv-guard prompt.
    const intents = mod.signals?.intents ?? []
    const isPhrase = (intent: string): boolean => tokensOf(intent).length > 1
    put(intents.filter(intent => !isPhrase(intent)).join(' '), INTENT_FIELD)
    put(intents.filter(isPhrase).join(' '), DESCRIPTION_FIELD)
    phrases.set(mod.name, intents.filter(intent => /\s/.test(intent.trim())))
    docs.set(mod.name, doc)
    for (const token of doc.keys()) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  const size = Math.max(1, mods.length)
  const idf = new Map([...counts].map(([token, count]) => [token, Math.log(1 + size / count)]))

  return { docs, phrases, idf }
}

/**
 * A mod's score for a prompt: `matches` counts its telling words, `isStrong`
 * says one of them names the mod (or is very rare), `hits` counts the prompts
 * it matched (when rolled).
 */
export type IntentScored = Scored & { matches: number; isStrong: boolean; hits: number }

/**
 * How well each mod fits one prompt, best first: the rarer the shared word and
 * the more telling the field it sits in (name, command, intent over
 * description), the more it counts. A mod is scored only on one strong match
 * (a word of its name, commands, intents or keywords, an intent phrase, a very
 * rare word of its description) or two telling ones.
 */
export function rankIntent(index: IntentIndex, prompt: string): IntentScored[] {
  // The request is at the top; a pasted log or file below it would only add noise (and time, on every prompt).
  const head = prompt.slice(0, PROMPT_CHARS)
  const tokens = tokensOf(head, true)
  const text = normalize(head)
  const results: IntentScored[] = []
  for (const [name, doc] of index.docs) {
    let score = 0
    let isStrong = false
    const telling = new Set<string>()
    const found: { word: string; points: number }[] = []
    for (const token of tokens) {
      const weight = doc.get(token.stem)
      if (weight === undefined) {
        continue
      }
      const idf = index.idf.get(token.stem) ?? 0
      // A word many mods share (`command`, `test`) tells little, even in a name.
      const isCommon = idf < RARE_IDF
      const points = (isCommon ? Math.min(weight, COMMON_FIELD) : weight) * idf
      score += points
      found.push({ word: token.surface, points })
      if (!isCommon) {
        telling.add(token.surface)
      }
      // A very rare description word is enough on its own, unless it is a scrap like the `ts` of `auth.ts`.
      isStrong ||= (weight > DESCRIPTION_FIELD && !isCommon) || (idf >= VERY_RARE_IDF && token.surface.length >= MIN_STRONG_WORD)
    }
    for (const phrase of index.phrases.get(name) ?? []) {
      if (mentions(text, phrase)) {
        score += PHRASE_BONUS
        telling.add(phrase)
        isStrong = true
        found.push({ word: phrase, points: PHRASE_BONUS * 2 })
      }
    }
    const matches = telling.size
    if (score <= 0 || !(isStrong || matches >= 2)) {
      continue
    }
    const evidence: Evidence[] = []
    for (const match of found.sort((a, b) => b.points - a.points)) {
      if (!evidence.some(one => one.kind === 'intent' && one.word === match.word)) {
        evidence.push({ kind: 'intent', detail: match.word, word: match.word })
      }
    }
    results.push({ name, score: Math.round(score * 10) / 10, evidence, matches, isStrong, hits: 1 })
  }

  return results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/** How much each of the last prompts counts, newest first. */
export const DECAY: readonly number[] = [1, 0.6, 0.4, 0.25, 0.15]
/** A prompt score this high makes an installed mod's command worth a tip. */
export const TIP_MIN = 8
/** A rolling score this high puts a mod under "For what you're doing now". */
export const NOW_MIN = 6
/** A rolling score this high, with two telling words or two prompts behind it, makes a mod worth recommending. */
export const NEW_MIN = 10

/** The scores of the last prompts (newest first) folded into one, each weighed by DECAY. */
export function rollIntent(prompts: readonly (readonly IntentScored[])[]): IntentScored[] {
  const merged = new Map<string, IntentScored>()
  prompts.slice(0, DECAY.length).forEach((scores, age) => {
    const weight = DECAY[age] ?? 0
    for (const one of scores) {
      const known = merged.get(one.name) ?? { name: one.name, score: 0, evidence: [], matches: 0, isStrong: false, hits: 0 }
      known.score += one.score * weight
      known.matches = Math.max(known.matches, one.matches)
      known.isStrong ||= one.isStrong
      known.hits += 1
      for (const evidence of one.evidence) {
        if (!known.evidence.some(seen => seen.detail === evidence.detail)) {
          known.evidence.push(evidence)
        }
      }
      merged.set(one.name, known)
    }
  })

  return [...merged.values()]
    .map(one => ({ ...one, score: Math.round(one.score * 10) / 10 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

/** A recommendation must reach this share of the best rolled score: the clear winners, not the long tail. */
const NEW_SHARE_OF_BEST = 0.4

/** Whether a rolled score is worth recommending a mod that is not installed: strong, and said twice or in two telling words. */
export const isWorthRecommending = (scored: IntentScored): boolean =>
  scored.score >= NEW_MIN && scored.isStrong && (scored.matches >= 2 || scored.hits >= 2)

/** The rolled scores worth recommending, best first. */
export function recommendable(rolled: readonly IntentScored[]): IntentScored[] {
  const best = rolled[0]?.score ?? 0
  return rolled.filter(one => isWorthRecommending(one) && one.score >= best * NEW_SHARE_OF_BEST)
}

// ── Reasons ──────────────────────────────────────────────────────────────────

const causeText = (cause: Cause, isNew: boolean): string =>
  cause.kind === 'file'
    ? isNew ? `you added ${cause.detail}` : cause.detail
    : isNew ? `${cause.detail} was installed` : `uses ${cause.detail}`

/** One evidence as a short line: what the pane shows under a mod. `isNew` phrases it as a change. */
export function describeEvidence(evidence: Evidence, isNew = false): string {
  switch (evidence.kind) {
    case 'file':
      return isNew ? `you added ${evidence.detail}` : `${evidence.detail} found`
    case 'dep':
      return isNew ? `${evidence.detail} was installed` : `uses ${evidence.detail}`
    case 'stack':
      return isNew ? causeText(evidence.cause, true) : `${evidence.detail} · ${causeText(evidence.cause, false)}`
    case 'essential':
      return 'an essential for every project'
    case 'intent':
      return `you're asking about "${evidence.word}"`
  }
}

/** Why a scored mod was picked, in one short line. */
export const reasonOf = (scored: Scored, isNew = false): string =>
  scored.evidence[0] === undefined ? '' : describeEvidence(scored.evidence[0], isNew)
