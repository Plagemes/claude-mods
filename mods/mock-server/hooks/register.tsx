import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderSurface } from 'claude-code'

import type { MockServerState } from '../types'
import { BUILTIN_SERVER, parseBuiltinLine, parseMockArgs, parsePrismLine } from './server'
import type { ServerEvent } from './server'
import { mockSpecOf } from './spec'

const PANE = 'mock'
const DEFAULT_PORT = 4010
const HOST = '127.0.0.1'
const MAX_REQUESTS = 60
const MAX_LOG = 30
const ROUTES_SHOWN = 12
const SPEC_DIRS = ['', 'api', 'docs', 'doc', 'spec', 'specs', 'openapi', 'swagger', 'public', 'static', 'src', 'resources', 'config']
const SPEC_NAME = /^(?:openapi|swagger)(?:[.-][\w-]+)?\.(?:ya?ml|json)$/i
const STATUS_COLORS = { starting: 'warning', running: 'success', stopped: 'inactive', failed: 'error' } as const

const serverAtom = atom({ plugin: 'mock-server', key: 'server' } as const, null)

type Engine = 'auto' | 'builtin' | 'prism'
type Settings = { port: number; engine: Engine }
type Stream = HookStream<ProcessSpawnChunk, ProcessSpawnResult>
/** The running child, if any; one per session. */
type Holder = { child?: { id: number; stream: Stream } }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isAbsolute = (path: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(path)
const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 8)
const operations = (count: number): string => `${count} operation${count === 1 ? '' : 's'}`

/** The best openapi/swagger file in the usual folders, relative to the root. */
async function findSpec($: EngineInterface, root: string): Promise<string | undefined> {
  const found: string[] = []
  await Promise.all(
    SPEC_DIRS.map(async dir => {
      let entries: FsEntry[]
      try {
        entries = await $.fs.list(dir === '' ? root : `${root}/${dir}`)
      } catch {
        return
      }
      for (const entry of entries) if (entry.kind === 'file' && SPEC_NAME.test(entry.name)) found.push(dir === '' ? entry.name : `${dir}/${entry.name}`)
    }),
  )
  const rank = (path: string) => (/swagger/i.test(path) ? 10 : 0) + (/\.json$/i.test(path) ? 5 : 0) + path.split('/').length
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]
}

async function patch($: EngineInterface, id: number, change: (server: MockServerState) => MockServerState): Promise<void> {
  await update($, serverAtom, server => (server?.id === id ? change(server) : server))
}

/** Applies one line of server output to the state. */
async function handleLine($: EngineInterface, id: number, engine: MockServerState['engine'], line: string): Promise<void> {
  const event: ServerEvent | undefined = engine === 'builtin' ? parseBuiltinLine(line) : parsePrismLine(line)
  if (event === undefined) return
  const now = await $.clock.now()
  if (event.type === 'ready') {
    const server = await read($, serverAtom)
    if (server?.id !== id) return
    const url = event.url ?? server.url
    await patch($, id, current => ({ ...current, status: 'running', url }))
    $.ui.status(`🧪 mock :${server.port}`)
    $.ui.toast(`Mock ready on ${url}${server.routes.length > 0 ? ` (${operations(server.routes.length)})` : ''}`)
    return
  }
  await patch($, id, server => {
    switch (event.type) {
      case 'request':
        return { ...server, requests: [...server.requests, { at: now, method: event.method, path: event.path, ...(event.status === undefined ? {} : { status: event.status }), ...(event.ms === undefined ? {} : { ms: event.ms }) }].slice(-MAX_REQUESTS) }
      case 'status': {
        const last = server.requests.at(-1)
        if (last === undefined || last.status !== undefined) return server
        return { ...server, requests: [...server.requests.slice(0, -1), { ...last, status: event.status }] }
      }
      case 'route':
        return { ...server, routes: [...server.routes, { method: event.method, path: event.path }] }
      case 'error': {
        const hint = event.code === 'EADDRINUSE' ? `port ${server.port} is already in use; try /mock ${server.spec} ${server.port + 1}` : event.message
        return { ...server, error: hint, log: [...server.log, event.message].slice(-MAX_LOG) }
      }
      default:
        return { ...server, log: [...server.log, event.text].slice(-MAX_LOG) }
    }
  })
}

/** Reads the child's output until it ends, then records how it ended. */
async function pump($: EngineInterface, holder: Holder, id: number, engine: MockServerState['engine'], stream: Stream): Promise<void> {
  let rest = ''
  let ending: Pick<MockServerState, 'status' | 'error'>
  try {
    for await (const chunk of stream) {
      const lines = (rest + chunk.text).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) await handleLine($, id, engine, line)
    }
    if (rest.trim() !== '') await handleLine($, id, engine, rest)
    const ended = await stream.result.catch(() => ({ code: null, signal: 'SIGTERM' }))
    ending = ended.code === 0 || ended.signal !== null ? { status: 'stopped' } : { status: 'failed', error: `exited with code ${ended.code}` }
  } catch (error) {
    const message = errorText(error)
    const missing = engine === 'builtin' ? 'node (Node.js) is not installed or not on PATH; install it, or set engine to prism' : 'npx/prism could not be started; install @stoplight/prism-cli, or set engine to builtin'
    ending = { status: 'failed', error: /ENOENT/.test(message) ? missing : message }
  }
  if (holder.child?.id !== id) return
  holder.child = undefined
  const before = await read($, serverAtom)
  await patch($, id, server => ({ ...server, status: ending.status, ...(server.error === undefined && ending.error !== undefined ? { error: ending.error } : {}) }))
  $.ui.status(undefined)
  if (ending.status === 'failed' && before?.id === id) $.ui.toast(`Mock stopped: ${before.error ?? ending.error ?? 'it failed'}`)
}

/** Ends the running child, if any. */
async function stopServer($: EngineInterface, holder: Holder): Promise<boolean> {
  const child = holder.child
  if (child === undefined) return false
  holder.child = undefined
  void child.stream.return({ code: null, signal: 'SIGTERM' }).catch(() => undefined)
  await patch($, child.id, server => ({ ...server, status: 'stopped' }))
  $.ui.status(undefined)
  return true
}

/** Starts a mock of `specArg` (or the spec found) on `port`; says what it did in one line. */
async function startServer($: EngineInterface, holder: Holder, settings: Settings, args: string): Promise<string> {
  const parsed = parseMockArgs(args)
  if ('error' in parsed) return `Could not read that: ${parsed.error} Usage: /mock [spec] [port] · /mock stop`
  const root = await $.session.root()
  const spec = parsed.spec ?? (await findSpec($, root))
  if (spec === undefined) return 'No OpenAPI spec found (looked for openapi.* and swagger.* in the root, api/, docs/, spec/ …). Try /mock path/to/openapi.yaml'
  const specPath = isAbsolute(spec) ? spec : `${root}/${spec}`
  if (!(await $.fs.exists(specPath).catch(() => false))) return `${spec} does not exist.`
  const port = parsed.port ?? settings.port

  const localPrism = `${root}/node_modules/.bin/prism`
  const hasLocalPrism = settings.engine !== 'builtin' && (await $.fs.exists(localPrism).catch(() => false))
  const engine: MockServerState['engine'] = settings.engine === 'prism' || hasLocalPrism ? 'prism' : 'builtin'
  let argv: string[]
  let input: string | undefined
  let routes: MockServerState['routes'] = []
  if (engine === 'prism') {
    argv = [...(hasLocalPrism ? [localPrism] : ['npx', '--yes', '@stoplight/prism-cli']), 'mock', specPath, '-p', String(port), '-h', HOST]
  } else {
    let mock
    try {
      mock = mockSpecOf(await $.fs.read(specPath))
    } catch (error) {
      return `Could not read ${spec}: ${errorText(error)}`
    }
    if (mock.routes.length === 0) return `${spec} declares no operations to mock.`
    routes = mock.routes.map(route => ({ method: route.method, path: route.path, status: route.status }))
    argv = ['node', '-e', BUILTIN_SERVER]
    input = JSON.stringify({ port, host: HOST, routes: mock.routes })
  }

  await stopServer($, holder)
  const startedAt = await $.clock.now()
  const id = startedAt + Math.random()
  const server: MockServerState = { id, status: 'starting', engine, spec, port, url: `http://localhost:${port}`, routes, requests: [], log: [], startedAt }
  await update($, serverAtom, () => server)
  const stream = $.process.spawn({ argv, cwd: root, ...(input === undefined ? {} : { input }) })
  holder.child = { id, stream }
  // Once the module unloads (which kills the child) the pump's last `$` calls reject: nothing is left to tell.
  void pump($, holder, id, engine, stream).catch(() => undefined)
  $.ui.status(`🧪 mock :${port} (starting)`)
  const how = engine === 'prism' ? (hasLocalPrism ? 'Prism' : 'Prism (via npx; the first run downloads it)') : `the built-in mock (${operations(routes.length)})`
  return `Starting ${how} for ${spec} on http://localhost:${port}…`
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Mock server', rows: 24 }).catch(() => undefined)
  await $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}

async function copyUrl($: EngineInterface, url: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: url, surface })
  $.ui.toast(copied.isCopied ? `Copied ${url}` : `Could not copy (${copied.reason})`)
}

export const register: Register = (on, options) => {
  const engine = String(options.engine ?? 'auto')
  const settings: Settings = {
    port: Math.min(65535, Math.max(1, Math.round(Number(options.port) || DEFAULT_PORT))),
    engine: engine === 'builtin' || engine === 'prism' ? engine : 'auto',
  }
  const holder: Holder = {}

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'mock',
      description: 'Start a mock API server from your OpenAPI spec (/mock stop to end it)',
      argumentHint: '[spec] [port] | stop',
    })
    return next(e)
  })

  on('command.run', { command: 'mock' }, async ($, e) => {
    const args = e.args.trim()
    if (/^(?:stop|off|kill)$/i.test(args)) {
      const server = await read($, serverAtom)
      return { text: (await stopServer($, holder)) ? `Stopped the mock on :${server?.port ?? ''}.` : 'No mock server is running.' }
    }
    const current = await read($, serverAtom)
    if (args === '' && holder.child !== undefined && current !== null) {
      await openPane($)
      return { text: `Mock ${current.status} on ${current.url} (${current.spec}). /mock stop ends it.` }
    }
    const text = await startServer($, holder, settings, args)
    if (holder.child !== undefined) await openPane($)
    return { text }
  })

  // A /clear ends the conversation, not the process: the mock keeps serving through it.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') await stopServer($, holder)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const server = await read($, serverAtom)
    if (server === null) return <Text dimColor>Run /mock [spec] [port] to start a mock API server.</Text>
    const isLive = server.status === 'starting' || server.status === 'running'
    const width = Math.max(...server.routes.map(route => route.method.length), 6)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box gap={1} flexWrap="wrap">
            <Text bold>🧪 Mock server</Text>
            <Text color={STATUS_COLORS[server.status]}>{`● ${server.status}`}</Text>
            <Text bold={isLive} dimColor={!isLive}>{server.url}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {`${server.engine === 'prism' ? 'Prism' : 'built-in'} · ${server.spec}${server.routes.length > 0 ? ` · ${operations(server.routes.length)}` : ''}`}
          </Text>
          {server.error !== undefined && <Text color="error">{server.error}</Text>}
        </Box>
        <Box gap={1} flexWrap="wrap">
          {isLive && <Button key="stop" label="Stop" hotkey="s" onPress={() => void stopServer($, holder)} />}
          <Button
            key="restart"
            label={isLive ? 'Restart' : 'Start again'}
            hotkey="r"
            {...(isLive ? {} : { variant: 'primary' as const })}
            onPress={() => void startServer($, holder, settings, `${server.spec} ${server.port}`).then(text => $.ui.toast(text))}
          />
          <Button key="copy" label="Copy URL" hotkey="c" onPress={press => void copyUrl($, server.url, press.surface)} />
          {server.requests.length > 0 && (
            <Button key="clear" label="Clear requests" onPress={() => void patch($, server.id, current => ({ ...current, requests: [] }))} />
          )}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {server.routes.length > 0 && (
          <Box key="routes" flexDirection="column">
            <Text bold>Operations</Text>
            {server.routes.slice(0, ROUTES_SHOWN).map(route => (
              <Text wrap="truncate-end">
                {`${route.method.padEnd(width)}  ${route.path}${route.status === undefined ? '' : `  → ${route.status}`}`}
              </Text>
            ))}
            {server.routes.length > ROUTES_SHOWN && <Text dimColor>{`… ${server.routes.length - ROUTES_SHOWN} more`}</Text>}
          </Box>
        )}
        {server.log.length > 0 && (
          <Box key="log" flexDirection="column">
            <Text bold>Output</Text>
            {server.log.slice(-6).map(line => (
              <Text dimColor wrap="truncate-end">{line}</Text>
            ))}
          </Box>
        )}
        <Box key="requests" flexDirection="column">
          <Text bold>{`Requests${server.requests.length > 0 ? ` (${server.requests.length})` : ''}`}</Text>
          {server.requests.length === 0 && <Text dimColor>{isLive ? `None yet. Point your frontend at ${server.url}.` : 'None.'}</Text>}
          {server.requests.map(request => (
            <Box gap={1}>
              <Text dimColor>{clock(request.at)}</Text>
              <Text bold>{request.method.padEnd(7)}</Text>
              <Text wrap="truncate-end">{request.path}</Text>
              {request.status !== undefined && (
                <Text color={request.status < 300 ? 'success' : request.status < 400 ? 'suggestion' : request.status < 500 ? 'warning' : 'error'}>
                  {String(request.status)}
                </Text>
              )}
              {request.ms !== undefined && <Text dimColor>{`${request.ms} ms`}</Text>}
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}
