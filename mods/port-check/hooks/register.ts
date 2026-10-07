import type { EngineInterface, Register } from 'claude-code'

import { parseLsof, parseSs, unique } from './ports'
import type { Listener } from './ports'
import { analyze } from './servers'
import type { Server } from './servers'

const PROBE_TIMEOUT_MS = 3000
const MAX_SCRIPT_DEPTH = 3
const MAX_PORTS = 3
const MAX_COMMAND_LENGTH = 60
const SERVER_WORDS = /\b(?:npm|pnpm|yarn|bun|vite|next|nuxt|nuxi|astro|remix|webpack|ng|vue-cli-service|react-scripts|svelte-kit|gatsby|storybook|serve|http-server|live-server|rails|rackup|flask|uvicorn|hypercorn|gunicorn|daphne|fastapi|streamlit|jupyter|mkdocs|waitress-serve|symfony|hugo|jekyll|php|django-admin|manage\.py|runserver|http\.server|--port|node|nodemon|tsx|ts-node|deno|python3?|ruby)\b/

type Taken = { server: Server; listeners: Listener[] }

const joinPath = (base: string, relative: string): string => {
  if (relative === '') return base
  if (relative.startsWith('/') || relative.startsWith('~')) return relative
  const parts = base.replace(/\/+$/, '').split('/')
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

/** The scripts of the package.json in a folder; none when there is no readable one. */
async function packageScripts($: EngineInterface, folder: string): Promise<Record<string, string>> {
  try {
    const pkg: unknown = JSON.parse(await $.fs.read(`${folder}/package.json`))
    const scripts = typeof pkg === 'object' && pkg !== null ? (pkg as Record<string, unknown>).scripts : undefined
    return typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** The servers a command line starts, following package scripts (`npm run dev` -> `vite --port 4000`) a few levels deep. */
async function serversOf($: EngineInterface, text: string, cwd: string): Promise<Server[]> {
  const found: Server[] = []
  const queue = [{ text, env: {} as Record<string, string>, extra: [] as string[], folder: cwd, depth: 0 }]
  for (const job of queue) {
    const analysis = analyze(job.text, job.env, job.extra)
    found.push(...analysis.servers)
    if (job.depth >= MAX_SCRIPT_DEPTH) continue
    for (const ref of analysis.scripts) {
      const folder = joinPath(job.folder, ref.directory)
      const body = (await packageScripts($, folder))[ref.name]
      if (typeof body === 'string') queue.push({ text: body, env: ref.env, extra: ref.args, folder, depth: job.depth + 1 })
    }
  }
  return [...new Map(found.map(server => [server.port, server])).values()].slice(0, MAX_PORTS)
}

/** Runs a probe command; undefined when it cannot run (not installed, timed out). */
async function probe($: EngineInterface, argv: readonly string[]): Promise<{ exitCode: number; stdout: string } | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: PROBE_TIMEOUT_MS })
    return { exitCode, stdout }
  } catch {
    return undefined
  }
}

/** The processes listening on a TCP port: lsof first, ss where lsof is not installed. */
async function listenersOn($: EngineInterface, port: number): Promise<Listener[]> {
  const lsof = await probe($, ['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])
  if (lsof !== undefined) return unique(parseLsof(lsof.stdout))
  const ss = await probe($, ['ss', '-ltnpH', 'sport', '=', `:${port}`])
  return ss === undefined ? [] : unique(parseSs(ss.stdout))
}

/** `node /app/server.js` for a pid, when ps can say. */
async function commandLine($: EngineInterface, pid: number): Promise<string | undefined> {
  const ps = await probe($, ['ps', '-p', String(pid), '-o', 'args='])
  const line = ps?.exitCode === 0 ? ps.stdout.trim() : ''
  return line === '' ? undefined : line.length > MAX_COMMAND_LENGTH ? `${line.slice(0, MAX_COMMAND_LENGTH)}...` : line
}

async function takenPorts($: EngineInterface, servers: readonly Server[]): Promise<Taken[]> {
  const taken: Taken[] = []
  for (const server of servers) {
    const listeners = await listenersOn($, server.port)
    if (listeners.length > 0) taken.push({ server, listeners })
  }
  return taken
}

async function describe($: EngineInterface, { server, listeners }: Taken): Promise<{ short: string; long: string }> {
  const named = listeners.slice(0, 2)
  const short = named.map(({ name, pid }) => `${name} (pid ${pid})`).join(', ')
  const details = await Promise.all(named.map(async ({ name, pid }) => `${name}, pid ${pid}${await commandLine($, pid).then(line => (line === undefined ? '' : `: ${line}`))}`))
  return {
    short: `port ${server.port} is already in use by ${short}`,
    long:
      `port-check: port ${server.port} (${server.tool}'s port for this command) is already listening: ${details.join('; ')}. ` +
      `The server may fail with EADDRINUSE or move to another port. Stop that process (kill ${named[0]?.pid ?? '<pid>'}) or pick another port with --port.`,
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!SERVER_WORDS.test(e.command)) return next(e)

    const notes: string[] = []
    try {
      const servers = await serversOf($, e.command, await $.session.cwd())
      for (const taken of await takenPorts($, servers)) {
        const { short, long } = await describe($, taken)
        $.ui.toast(short)
        notes.push(long)
      }
    } catch {
      return next(e)
    }

    const ran = await next(e)
    return notes.length === 0 || ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
  })
}
