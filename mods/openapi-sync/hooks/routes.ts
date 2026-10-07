// Pure parts of openapi-sync: finding route definitions in code, reading an OpenAPI/Swagger spec's
// paths, and comparing the two. No `$` here.

import type { OpenapiSyncIssue } from '../types'

export type Issue = OpenapiSyncIssue
export type Route = { method: string; path: string }
export type RouteChange = Route & { file: string; change: 'added' | 'removed' }
export type SpecRoutes = { paths: Map<string, Set<string>>; bases: string[] }

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const
const ANY = 'ANY'
const ROUTE_FILE = /\.(?:[cm]?[jt]sx?|py|php|go|rb|java|kt)$/i
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\/|\.(?:test|spec)\.[a-z]+$|_test\.go$|(?:^|\/)test_[^/]*\.py$/i
const JS_SERVER = /\b(?:express|fastify|koa|hono|restify|polka|elysia|itty-router)\b|@nestjs\/|\bRouter\s*\(|\bnew\s+Hono\b/
const CLIENT_RECEIVER = /^(?:axios|http|https|fetch|client|apiClient|request|superagent|ky|got|agent|cy|page|this)$/

export const isRouteFile = (path: string): boolean => ROUTE_FILE.test(path) && !TEST_FILE.test(path)
export const isSpecFile = (path: string): boolean => /(?:^|\/)(?:openapi|swagger)(?:[.-][\w-]+)?\.(?:ya?ml|json)$/i.test(path)

/** `/users/:id/` → `/users/{id}`; `<int:pk>`, `[slug]`, `[...rest]` and `(?P<name>…)` become `{name}`. */
export const normalizePath = (raw: string): string => {
  let path = raw.trim().replace(/^\^/, '').replace(/\$$/, '')
  path = path
    .replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}')
    .replace(/<(?:\w+:)?(\w+)>/g, '{$1}')
    .replace(/\[\[?\.\.\.(\w+)\]?\]/g, '{$1}')
    .replace(/\[(\w+)\]/g, '{$1}')
    .replace(/:(\w+)\??/g, '{$1}')
    .replace(/\{(\w+):[^}]*\}/g, '{$1}')
  path = `/${path}`.replace(/\/{2,}/g, '/')
  return path.length > 1 ? path.replace(/\/$/, '') : path
}

/** Two paths are the same route when they match with their parameter names ignored. */
const shapeOf = (path: string): string => normalizePath(path).replace(/\{[^}]*\}/g, '{}').toLowerCase()

const isWildcard = (path: string): boolean => /\*/.test(path)

const add = (routes: Route[], method: string, path: string): void => {
  const normalized = normalizePath(path)
  const verb = method.toUpperCase() === 'ALL' ? ANY : method.toUpperCase()
  // Wildcards and a catch-all root (Go's "/") are fallbacks, not API operations.
  if (isWildcard(normalized) || (verb === ANY && normalized === '/')) return
  routes.push({ method: verb, path: normalized })
}

const joinPath = (prefix: string, path: string): string => `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`

const jsRoutes = (text: string): Route[] => {
  const routes: Route[] = []
  if (!JS_SERVER.test(text)) return routes
  const call = /\b([\w$]+)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(['"`])(\/[^'"`]*)\3\s*,/g
  for (const match of text.matchAll(call)) {
    if (CLIENT_RECEIVER.test(match[1] as string)) continue
    add(routes, match[2] as string, match[4] as string)
  }
  for (const match of text.matchAll(/\.route\s*\(\s*\{([\s\S]{0,400}?)\}\s*\)/g)) {
    const body = match[1] ?? ''
    const url = /\b(?:url|path)\s*:\s*['"`]([^'"`]+)['"`]/.exec(body)?.[1]
    const methods = /\bmethod\s*:\s*(\[[^\]]*\]|['"`]\w+['"`])/.exec(body)?.[1]
    if (url === undefined || methods === undefined) continue
    for (const method of methods.match(/\w+/g) ?? []) add(routes, method, url)
  }
  // NestJS: @Controller('users') with @Get(':id') handlers.
  const controller = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/.exec(text)
  if (controller !== null) {
    for (const match of text.matchAll(/@(Get|Post|Put|Patch|Delete|Options|Head|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) {
      add(routes, match[1] as string, joinPath(controller[1] ?? '', match[2] ?? ''))
    }
  }
  return routes
}

const METHOD_EXPORT = /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|\bexport\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|\bexport\s*\{([^}]*)\}/g

const nextRoutes = (file: string, text: string): Route[] | undefined => {
  const appRoute = /(?:^|\/)app\/(.*?)\/?route\.[cm]?[jt]sx?$/.exec(file)
  if (appRoute !== null) {
    const segments = (appRoute[1] ?? '').split('/').filter(segment => segment !== '' && !/^\(.*\)$/.test(segment) && !segment.startsWith('@'))
    const path = `/${segments.join('/')}`
    const methods = new Set<string>()
    for (const match of text.matchAll(METHOD_EXPORT)) {
      if (match[1] ?? match[2]) methods.add((match[1] ?? match[2]) as string)
      for (const name of (match[3] ?? '').match(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g) ?? []) methods.add(name)
    }
    const routes: Route[] = []
    for (const method of methods) add(routes, method, path)
    return routes
  }
  const pagesApi = /(?:^|\/)pages\/(api\/.*)\.[cm]?[jt]sx?$/.exec(file)
  if (pagesApi !== null) {
    const routes: Route[] = []
    add(routes, ANY, `/${(pagesApi[1] ?? '').replace(/\/index$/, '')}`)
    return routes
  }
  return undefined
}

const pythonRoutes = (file: string, text: string): Route[] => {
  const routes: Route[] = []
  if (/(?:^|\/)urls\.py$/.test(file)) {
    for (const match of text.matchAll(/\b(re_)?path\(\s*r?(['"])([^'"]*)\2\s*,\s*(include\()?/g)) {
      if (match[4] !== undefined) continue
      add(routes, ANY, match[3] as string)
    }
    return routes
  }
  const prefixes = new Map<string, string>()
  for (const match of text.matchAll(/\b(\w+)\s*=\s*(?:APIRouter|Blueprint)\(([^)]*)\)/g)) {
    const prefix = /\b(?:url_)?prefix\s*=\s*['"]([^'"]*)['"]/.exec(match[2] ?? '')?.[1]
    if (prefix !== undefined) prefixes.set(match[1] as string, prefix)
  }
  for (const match of text.matchAll(/@(\w+)\.(get|post|put|patch|delete|options|head)\(\s*(['"])([^'"]*)\3/g)) {
    add(routes, match[2] as string, joinPath(prefixes.get(match[1] as string) ?? '', match[4] as string))
  }
  for (const match of text.matchAll(/@(\w+)\.(?:route|api_route)\(\s*(['"])([^'"]*)\2([^)]*)\)/g)) {
    const methods = /methods\s*=\s*[[(]([^\])]*)[\])]/.exec(match[4] ?? '')?.[1]?.match(/\w+/g) ?? ['GET']
    for (const method of methods) add(routes, method, joinPath(prefixes.get(match[1] as string) ?? '', match[3] as string))
  }
  return routes
}

const singular = (word: string): string => word.replace(/ies$/, 'y').replace(/s$/, '')

/** The routes `resource`/`apiResource` (Laravel) and `resources` (Rails) stand for, without the HTML form pages. */
const resourceRoutes = (routes: Route[], name: string): void => {
  const base = `/${name.replace(/\./g, '/')}`
  const id = `{${singular(name.split(/[./]/).pop() ?? 'id')}}`
  add(routes, 'GET', base)
  add(routes, 'POST', base)
  add(routes, 'GET', `${base}/${id}`)
  add(routes, 'PUT', `${base}/${id}`)
  add(routes, 'PATCH', `${base}/${id}`)
  add(routes, 'DELETE', `${base}/${id}`)
}

const phpRoutes = (file: string, text: string): Route[] => {
  const routes: Route[] = []
  if (!/(?:^|\/)routes\/[^/]+\.php$/.test(file)) return routes
  const prefix = /(?:^|\/)routes\/api\.php$/.test(file) ? '/api' : ''
  for (const match of text.matchAll(/Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]*)['"]/gi)) {
    add(routes, match[1] as string, joinPath(prefix, match[2] as string))
  }
  for (const match of text.matchAll(/Route::match\(\s*\[([^\]]*)\]\s*,\s*['"]([^'"]*)['"]/gi)) {
    for (const method of (match[1] ?? '').match(/\w+/g) ?? []) add(routes, method, joinPath(prefix, match[2] as string))
  }
  const scoped: Route[] = []
  for (const match of text.matchAll(/Route::(?:api)?[Rr]esource\(\s*['"]([^'"]+)['"]/g)) resourceRoutes(scoped, match[1] as string)
  routes.push(...scoped.map(route => ({ ...route, path: normalizePath(joinPath(prefix, route.path)) })))
  return routes
}

const goRoutes = (text: string): Route[] => {
  const routes: Route[] = []
  for (const line of text.split('\n')) {
    const handle = /\bHandle(?:Func)?\(\s*"([^"]+)"/.exec(line)
    if (handle !== null) {
      const pattern = (handle[1] as string).trim()
      const spaced = /^([A-Z]+)\s+(\/\S*)$/.exec(pattern)
      const methods = /\.Methods\(([^)]*)\)/.exec(line)?.[1]?.match(/[A-Z]+/g)
      if (spaced !== null) add(routes, spaced[1] as string, spaced[2] as string)
      else for (const method of methods ?? [ANY]) add(routes, method, pattern)
      continue
    }
    for (const match of line.matchAll(/\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Options|Head)\(\s*"(\/[^"]*)"/g)) {
      add(routes, match[1] as string, match[2] as string)
    }
  }
  return routes
}

const rubyRoutes = (file: string, text: string): Route[] => {
  const routes: Route[] = []
  if (!/(?:^|\/)config\/routes\.rb$/.test(file)) return routes
  for (const match of text.matchAll(/^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm)) add(routes, match[1] as string, match[2] as string)
  for (const match of text.matchAll(/^\s*resources?\s+:(\w+)/gm)) resourceRoutes(routes, match[1] as string)
  return routes
}

const springRoutes = (text: string): Route[] => {
  const routes: Route[] = []
  const prefix = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:class|interface)/.exec(text)?.[1] ?? ''
  for (const match of text.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?(?:\{\s*)?"([^"]*)"[^)]*\))?/g)) {
    add(routes, match[1] as string, joinPath(prefix, match[2] ?? ''))
  }
  return routes
}

/** Every route a source file defines, deduplicated. */
export const routesOf = (file: string, text: string): Route[] => {
  if (!isRouteFile(file)) return []
  const extension = /\.(\w+)$/.exec(file)?.[1]?.toLowerCase() ?? ''
  let routes: Route[]
  if (/^[cm]?[jt]sx?$/.test(extension)) routes = nextRoutes(file, text) ?? jsRoutes(text)
  else if (extension === 'py') routes = pythonRoutes(file, text)
  else if (extension === 'php') routes = phpRoutes(file, text)
  else if (extension === 'go') routes = goRoutes(text)
  else if (extension === 'rb') routes = rubyRoutes(file, text)
  else routes = springRoutes(text)
  const seen = new Set<string>()
  return routes.filter(route => {
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Routes in `after` and not in `before` are added; the reverse are removed. */
export const diffRoutes = (file: string, before: readonly Route[], after: readonly Route[]): RouteChange[] => {
  const keys = (routes: readonly Route[]) => new Set(routes.map(route => `${route.method} ${route.path}`))
  const was = keys(before)
  const now = keys(after)
  return [
    ...after.filter(route => !was.has(`${route.method} ${route.path}`)).map(route => ({ ...route, file, change: 'added' as const })),
    ...before.filter(route => !now.has(`${route.method} ${route.path}`)).map(route => ({ ...route, file, change: 'removed' as const })),
  ]
}

/** Folds a turn's changes: a route removed in one file and added in another (a move) cancels out. */
export const mergeChanges = (earlier: readonly RouteChange[], later: readonly RouteChange[]): RouteChange[] => {
  const merged = new Map<string, RouteChange>()
  for (const change of [...earlier, ...later]) {
    const key = `${change.method} ${change.path}`
    const previous = merged.get(key)
    if (previous !== undefined && previous.change !== change.change) merged.delete(key)
    else merged.set(key, change)
  }
  return [...merged.values()]
}

const pathOfServerUrl = (url: string): string => url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\{[^}]*\}/g, '').replace(/\/$/, '')

/** The paths (and their methods) an OpenAPI 3 or Swagger 2 document declares, in YAML or JSON. */
export const specRoutesOf = (text: string): SpecRoutes => {
  const paths = new Map<string, Set<string>>()
  const bases = new Set<string>()
  if (/^\s*\{/.test(text)) {
    try {
      const doc = JSON.parse(text) as { paths?: Record<string, unknown>; basePath?: unknown; servers?: { url?: unknown }[] }
      for (const [path, item] of Object.entries(doc.paths ?? {})) {
        const keys = item !== null && typeof item === 'object' ? Object.keys(item) : []
        paths.set(path, new Set(keys.filter(key => (HTTP_METHODS as readonly string[]).includes(key.toLowerCase())).map(key => key.toUpperCase())))
      }
      if (typeof doc.basePath === 'string') bases.add(doc.basePath.replace(/\/$/, ''))
      for (const server of Array.isArray(doc.servers) ? doc.servers : []) if (typeof server?.url === 'string') bases.add(pathOfServerUrl(server.url))
    } catch {
      // Unreadable JSON: no paths, so nothing is reported as documented or stale.
    }
    return { paths, bases: [...bases].filter(Boolean) }
  }
  const lines = text.split('\n')
  let section: 'paths' | 'servers' | undefined
  let pathIndent = -1
  let current: Set<string> | undefined
  for (const line of lines) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      section = /^paths\s*:/.test(line) ? 'paths' : /^servers\s*:/.test(line) ? 'servers' : undefined
      const base = /^basePath\s*:\s*['"]?([^'"\s#]+)/.exec(line)?.[1]
      if (base !== undefined) bases.add(base.replace(/\/$/, ''))
      current = undefined
      pathIndent = -1
      continue
    }
    if (section === 'servers') {
      const url = /^\s*-?\s*url\s*:\s*['"]?([^'"\s#]+)/.exec(line)?.[1]
      if (url !== undefined) bases.add(pathOfServerUrl(url))
      continue
    }
    if (section !== 'paths') continue
    const key = /^\s*(['"]?)(\/[^'"]*?)\1\s*:\s*(?:#.*)?$/.exec(line)
    if (key !== null && (pathIndent === -1 || indent === pathIndent)) {
      pathIndent = indent
      current = new Set()
      paths.set(key[2] as string, current)
      continue
    }
    const method = /^\s*(get|post|put|patch|delete|options|head)\s*:/i.exec(line)
    if (method !== null && current !== undefined && indent > pathIndent) current.add((method[1] as string).toUpperCase())
  }
  return { paths, bases: [...bases].filter(Boolean) }
}

/** Whether the spec documents a route (any method when the code or the spec does not say which). */
export const isDocumented = (route: Route, spec: SpecRoutes): boolean => {
  const candidates = [route.path, ...spec.bases.filter(base => route.path.toLowerCase().startsWith(`${base.toLowerCase()}/`)).map(base => route.path.slice(base.length))]
  const shapes = new Set(candidates.map(shapeOf))
  for (const [path, methods] of spec.paths) {
    if (!shapes.has(shapeOf(path))) continue
    if (route.method === ANY || methods.size === 0 || methods.has(route.method)) return true
  }
  return false
}

const issueKey = (issue: Route): string => `${issue.method} ${issue.path}`

/** What is out of sync after a turn: earlier issues and new changes, checked against the spec as it is now. */
export const findIssues = (pending: readonly Issue[], changes: readonly RouteChange[], spec: SpecRoutes): Issue[] => {
  const issues = new Map<string, Issue>()
  for (const issue of pending) issues.set(issueKey(issue), issue)
  for (const change of changes) {
    const key = issueKey(change)
    issues.set(key, { method: change.method, path: change.path, file: change.file, kind: change.change === 'added' ? 'undocumented' : 'stale' })
  }
  return [...issues.values()].filter(issue => (issue.kind === 'undocumented' ? !isDocumented(issue, spec) : isDocumented(issue, spec)))
}

export const describeIssue = (issue: Issue): string =>
  `${issue.kind === 'undocumented' ? '+' : '−'} ${issue.method === ANY ? '' : `${issue.method} `}${issue.path}  (${issue.file}) — ${
    issue.kind === 'undocumented' ? 'not in the spec' : 'removed, still in the spec'
  }`

/** The prompt "Ask Claude to update the spec" submits. */
export const updatePrompt = (issues: readonly Issue[], spec: string): string =>
  [
    `My API routes changed but ${spec} does not match them yet:`,
    ...issues.map(issue =>
      issue.kind === 'undocumented'
        ? `- ${issue.method === ANY ? '' : `${issue.method} `}${issue.path} (defined in ${issue.file}) is not documented`
        : `- ${issue.method === ANY ? '' : `${issue.method} `}${issue.path} was removed from ${issue.file} but is still documented`,
    ),
    '',
    `Please update ${spec} to match the code: add the missing operations (parameters, request body and responses read from the handlers, reusing existing schemas where they fit) and remove the stale ones. Change only the spec.`,
  ].join('\n')
