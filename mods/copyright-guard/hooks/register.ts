import type { EngineInterface, Register } from 'claude-code'

import { changesOf, describeProject, isForeign, isNoticeHome, mergeProject, noticesIn, parseLicenseText, parsePackageJson } from './notices'
import type { Notice, Project } from './notices'

const WRITE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING', 'COPYING.md']
const PROJECT_CACHE_MS = 60_000
const MAX_REPORTED = 3
const TOAST_NOTICE_LENGTH = 60

type ProjectCache = { project: Project | undefined; at: number }

const readText = ($: EngineInterface, path: string): Promise<string | undefined> => $.fs.read(path).catch(() => undefined)

/** The license and holders LICENSE and package.json give the project, read again at most once a minute. */
const projectOf = async ($: EngineInterface, cache: ProjectCache, allow: readonly string[]): Promise<Project> => {
  const now = await $.clock.now()
  if (cache.project !== undefined && now - cache.at < PROJECT_CACHE_MS) return cache.project

  const root = await $.session.root()
  const licenseTexts = await Promise.all(LICENSE_FILES.map(name => readText($, `${root}/${name}`)))
  const license = licenseTexts.find(text => text !== undefined)
  const manifest = await readText($, `${root}/package.json`)

  cache.project = mergeProject(
    [...(license === undefined ? [] : [parseLicenseText(license)]), ...(manifest === undefined ? [] : [parsePackageJson(manifest)])],
    allow,
  )
  cache.at = now
  return cache.project
}

const message = (path: string, project: Project, found: readonly Notice[]): string =>
  [
    `copyright-guard: ${path} now holds a license or copyright notice that does not match this project (${describeProject(project)}):`,
    ...found.slice(0, MAX_REPORTED).map(notice => `- ${notice.text}`),
    ...(found.length > MAX_REPORTED ? [`- (+${found.length - MAX_REPORTED} more)`] : []),
    'If this text was copied from another project, check that its license lets you use it here, keep its notice, and tell the user where it came from.',
    "If you wrote the notice yourself, remove it or make it match the project's.",
  ].join('\n')

export const register: Register = (on, options) => {
  const allow = String(options.allow ?? '')
    .split(',')
    .map(term => term.trim())
    .filter(term => term !== '')
  const cache: ProjectCache = { project: undefined, at: 0 }

  on('tool.call', { tool: WRITE_TOOLS }, async ($, e, next) => {
    const input: Readonly<Record<string, unknown>> = e
    const path = String(input.file_path ?? input.notebook_path ?? '')
    if (path === '' || isNoticeHome(path)) return next(e)

    // A Write replaces the whole file, so what was there is read first: its own notices are not news.
    const existing = typeof input.content === 'string' ? ((await readText($, path)) ?? '') : ''
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const added = changesOf(input, existing).flatMap(noticesIn)
    if (added.length === 0) return ran
    const project = await projectOf($, cache, allow)
    const foreign = added.filter(notice => isForeign(notice, project))
    if (foreign.length === 0) return ran

    const first = foreign[0]?.text ?? ''
    const shown = first.length > TOAST_NOTICE_LENGTH ? `${first.slice(0, TOAST_NOTICE_LENGTH - 1)}…` : first
    $.ui.toast(`other license in ${path.split(/[\\/]/).at(-1)}: ${shown}`)
    return { ...ran, context: [...(ran.context ?? []), message(path, project, foreign)] }
  })
}
