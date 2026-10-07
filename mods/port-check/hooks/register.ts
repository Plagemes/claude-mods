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

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await greetHub($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!SERVER_WORDS.test(e.command)) return next(e)

    const notes: string[] = []
    try {
      const servers = await serversOf($, e.command, await $.session.cwd())
      for (const taken of await takenPorts($, servers)) {
        const { short, long } = await describe($, taken)
        await hubNotify($, { level: 'warning', title: short })
        notes.push(long)
      }
    } catch {
      return next(e)
    }

    const ran = await next(e)
    return notes.length === 0 || ran.deny !== undefined ? ran : { ...ran, context: [...(ran.context ?? []), ...notes] }
  })
}

// #region @vendored shared/hub-client.ts sha256:0acb840d81b7: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
// #endregion @vendored shared/hub-client.ts
