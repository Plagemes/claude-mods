/**
 * Starting OpenWA for the user, and the words around it. Pure: no `$`.
 *
 * OpenWA (github.com/rmyndharis/OpenWA) is published as a Docker image only: its package is private, with no npm
 * release and no CLI, so `npx` cannot start it. (`@open-wa/wa-automate` is another project with another API.)
 * The managed start therefore runs the official image, bound to 127.0.0.1, with a named volume for the link.
 */

/** The image, pinned to the minor line OpenWA patches (SECURITY.md: only the latest minor gets fixes). */
export const IMAGE = 'ghcr.io/rmyndharis/openwa:0.24'
export const CONTAINER = 'claude-openwa'
export const VOLUME = 'claude-openwa-data'
/** The WhatsApp session the setup creates in OpenWA (names: 3-50 of letters, digits and dashes). */
export const SESSION_NAME = 'claude'
/** OpenWA's own port inside the container. */
const INNER_PORT = 2785

/** server.json: who is starting or running the managed OpenWA. Written by that session alone. */
export type ServerLock = { owner: string; phase: 'pulling' | 'starting' | 'running'; heartbeatAt: number; startedAt: number }

/** A lock not renewed for this long belongs to a session that is gone. */
export const LOCK_STALE_MS = 45_000

export const parseLock = (value: unknown): ServerLock | null => {
  if (typeof value !== 'object' || value === null) return null
  const lock = value as Partial<ServerLock>
  if (typeof lock.owner !== 'string' || lock.owner === '' || typeof lock.heartbeatAt !== 'number') return null
  const phase = lock.phase === 'pulling' || lock.phase === 'starting' || lock.phase === 'running' ? lock.phase : 'running'
  return { owner: lock.owner, phase, heartbeatAt: lock.heartbeatAt, startedAt: typeof lock.startedAt === 'number' ? lock.startedAt : lock.heartbeatAt }
}

/** Whether this session may start the server: `free` (no fresh lock), `mine`, or `held` by another live session. */
export const lockState = (lock: ServerLock | null, me: string, now: number): 'free' | 'mine' | 'held' => {
  if (lock === null || now - lock.heartbeatAt > LOCK_STALE_MS) return 'free'
  return lock.owner === me ? 'mine' : 'held'
}

/** The host and port of an OpenWA base URL; the managed start is offered only for this machine. */
export const endpointOf = (baseUrl: string): { host: string; port: number; isLocal: boolean } => {
  const match = /^https?:\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/i.exec(baseUrl.trim())
  const host = (match?.[1] ?? '').toLowerCase()
  const port = Number(match?.[2] ?? (baseUrl.startsWith('https') ? 443 : 80))
  return { host, port, isLocal: ['127.0.0.1', 'localhost', '[::1]'].includes(host) }
}

/** `http://host:port` of a base URL (`…/api` cut), for the dashboard link. */
export const dashboardOf = (baseUrl: string): string => baseUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '') + '/'

/** A base URL as typed (`127.0.0.1:2785`, `http://box:2785/`) → `http://…/api`; '' when it is no URL. */
export const normalizeBaseUrl = (input: string): string => {
  const text = input.trim().replace(/\/+$/, '')
  if (text === '') return ''
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(withScheme)) return ''
  return /\/api$/i.test(withScheme) ? withScheme : `${withScheme}/api`
}

export const pullArgv = (): string[] => ['docker', 'pull', IMAGE]

/**
 * `docker run` for the managed server: detached, so it outlives a reload of the mod and keeps the link while other
 * sessions use it; removed when stopped (`--rm`, the link lives in the volume); no restart policy, so nothing starts
 * it again without the user; published on 127.0.0.1 only. Baileys can create the per-project groups.
 */
export const runArgv = (port: number, engine: 'baileys' | 'whatsapp-web.js'): string[] => [
  'docker',
  'run',
  '-d',
  '--rm',
  '--name',
  CONTAINER,
  '-p',
  `127.0.0.1:${port}:${INNER_PORT}`,
  '-v',
  `${VOLUME}:/app/data`,
  '--shm-size',
  '1g',
  '-e',
  'AUTO_START_SESSIONS=true',
  '-e',
  `ENGINE_TYPE=${engine}`,
  IMAGE,
]

/** The admin key OpenWA wrote on its first boot, read once to mint the scoped key; never stored by the mod. */
export const adminKeyArgv = (): string[] => ['docker', 'exec', CONTAINER, 'cat', '/app/data/.api-key']
export const stopArgv = (): string[] => ['docker', 'stop', CONTAINER]
export const removeArgv = (): string[] => ['docker', 'rm', '-f', CONTAINER]
/** `running`, `exited`, `created`, ... or '' when there is no such container. */
export const stateArgv = (): string[] => ['docker', 'inspect', '-f', '{{.State.Status}}', CONTAINER]
export const versionArgv = (): string[] => ['docker', 'version', '--format', '{{.Server.Version}}']

/** What `docker version` says about the prerequisite. */
export type DockerCheck = { state: 'ok' | 'missing' | 'stopped' | 'error'; version: string; note: string }

export const dockerCheckOf = (outcome: { exitCode: number; stdout: string; stderr: string } | { error: string }): DockerCheck => {
  if ('error' in outcome) {
    return /ENOENT|not found|failed to start/i.test(outcome.error)
      ? { state: 'missing', version: '', note: 'Docker is not installed (or not on PATH).' }
      : { state: 'error', version: '', note: `Docker did not answer: ${outcome.error}` }
  }
  const version = outcome.stdout.trim()
  if (outcome.exitCode === 0 && version !== '') return { state: 'ok', version, note: `Docker ${version}` }
  const text = `${outcome.stderr} ${outcome.stdout}`
  if (/cannot connect|is the docker daemon running|error during connect|docker_engine|dockerDesktopLinuxEngine|pipe.*(not find|cannot find)|connection refused/i.test(text)) {
    return { state: 'stopped', version: '', note: 'Docker is installed but not running: start Docker Desktop (or the docker service).' }
  }
  return { state: 'error', version: '', note: `Docker: ${firstLine(text) || `exit ${outcome.exitCode}`}` }
}

/** Why `docker run` failed, in words the user can act on. */
export const runFailureOf = (stderr: string, port: number): string => {
  if (/port is already allocated|address already in use|bind.*(failed|forbidden)|ports are not available/i.test(stderr)) {
    return `Port ${port} is already in use by another program. Stop it, or choose "I run it myself" and point the mod at your OpenWA.`
  }
  if (/already in use by container/i.test(stderr)) return `A container named ${CONTAINER} already exists: press Start again to replace it.`
  if (/pull access denied|manifest unknown|not found: manifest/i.test(stderr)) return `Docker could not fetch ${IMAGE}. Check your network, then try again.`
  if (/no space left/i.test(stderr)) return 'Docker has no disk space left.'
  return firstLine(stderr) || 'docker run failed'
}

/** One line of what `docker pull` printed last, for the progress row. */
export const pullProgressOf = (text: string): string => {
  const lines = text.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean)
  return lines.at(-1) ?? ''
}

const firstLine = (text: string): string => text.split(/[\r\n]+/).map(line => line.trim()).find(Boolean) ?? ''

/** A transport failure in plain words, and the raw text kept for the dim detail line. */
export const unreachableText = (raw: string): string => {
  if (/ECONNREFUSED|connection refused|actively refused/i.test(raw)) return "OpenWA isn't running"
  if (/ETIMEDOUT|timed out|timeout/i.test(raw)) return "OpenWA didn't answer in time"
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return "OpenWA's address can't be found"
  return "Can't reach OpenWA"
}

/** How long to wait before the next health check after `failures` failed ones: 5 s doubling, at most 60 s. */
export const HEALTH_MAX_MS = 60_000
export const healthDelay = (failures: number): number => (failures <= 0 ? 0 : Math.min(HEALTH_MAX_MS, 5_000 * 2 ** (failures - 1)))
