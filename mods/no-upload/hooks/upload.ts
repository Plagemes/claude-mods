import { simpleCommands } from './commands'
import type { Simple } from './commands'

/** Something a command sends to a host. */
export type Upload = { tool: string; host: string; how: string }

/** Paste bins and file-sharing sites: sending them anything (a file, a text, a pipe) is an upload. */
export const PASTE_HOSTS: readonly string[] = [
  'pastebin.com', 'paste.ee', 'paste.rs', 'dpaste.com', 'dpaste.org', 'hastebin.com', 'hasteb.in', 'ix.io', 'sprunge.us', 'termbin.com',
  'transfer.sh', '0x0.st', 'file.io', 'tmpfiles.org', 'catbox.moe', 'litterbox.catbox.moe', 'anonfiles.com', 'gofile.io', 'bashupload.com',
  'temp.sh', 'oshi.at', 'uguu.se', 'bpa.st', 'rentry.co', 'controlc.com', 'paste.debian.net', 'ghostbin.com', '0bin.net', 'clbin.com',
  'filebin.net', 'fars.ee',
]

/** `host` is `suffix` or a subdomain of it. */
const isUnder = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`)

export const isPasteHost = (host: string): boolean => PASTE_HOSTS.some(known => isUnder(host, known))

const PRIVATE_V4 = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/

/** Loopback, private networks and local-only names: not an outside service. */
export const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === 'host.docker.internal' || host.endsWith('.localhost') || host.endsWith('.local') || PRIVATE_V4.test(host)

/** Is `host` one of the allowed hosts? `example.com` allows it and its subdomains, `*.example.com` its subdomains only. */
export const isAllowedHost = (host: string, allowed: ReadonlySet<string>): boolean =>
  isLocalHost(host) || [...allowed].some(entry => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : isUnder(host, entry)))

/** A cheap test before parsing: does the line contain anything that can send data out? */
export const UPLOAD_HINT = /\b(?:curl|wget|scp|rsync|nc|ncat|netcat|ssh|http|https|xh|xhs|gh)\b|\/dev\/(?:tcp|udp)\//

const FILE_EXTENSIONS = /\.(?:txt|json|png|jpe?g|gif|log|tar|gz|tgz|zip|md|csv|sh|py|js|ts|html?|pdf|xml|ya?ml|bin|dat|out|tmp|bak|key|pem|crt|sql|db|env|cfg|conf|ini|toml|lock|rb|go|rs|c|h|cc|java|kt|php)$/i

/** The host of a URL or a bare `host/path` operand, lower case; undefined for words that are not a place on the network. */
export const hostOf = (word: string): string | undefined => {
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)/.exec(word)
  if (withScheme !== null) return (withScheme[1] as string).replace(/^\[|\]$/g, '').toLowerCase()
  const bare = /^(?:[\w-]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|localhost)(?::\d+)?(?:[/?#]|$)/.exec(word)
  const host = bare?.[1]?.toLowerCase()
  return host === undefined || (!/[/?#]/.test(word) && FILE_EXTENSIONS.test(host) && !isPasteHost(host)) ? undefined : host
}

type Parsed = { operands: string[]; options: Map<string, string[]> }

/** Splits arguments into operands and options (with their values); `valued` lists the options that take one. */
const parseArguments = (args: readonly string[], valued: ReadonlySet<string>, shortValued: ReadonlySet<string>): Parsed => {
  const operands: string[] = []
  const options = new Map<string, string[]>()
  const add = (name: string, value: string): void => {
    options.set(name, [...(options.get(name) ?? []), value])
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const equals = arg.indexOf('=')
      const name = equals === -1 ? arg : arg.slice(0, equals)
      if (equals !== -1) add(name, arg.slice(equals + 1))
      else if (valued.has(name)) add(name, args[++i] ?? '')
      else add(name, '')
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = `-${arg[at] as string}`
        if (shortValued.has(letter)) {
          const rest = arg.slice(at + 1)
          add(letter, rest === '' ? (args[++i] ?? '') : rest)
          break
        }
        add(letter, '')
      }
    } else {
      operands.push(arg)
    }
  }
  return { operands, options }
}

const valuesOf = (parsed: Parsed, ...names: string[]): string[] => names.flatMap(name => parsed.options.get(name) ?? [])
const has = (parsed: Parsed, ...names: string[]): boolean => names.some(name => parsed.options.has(name))

const CURL_LONG = new Set([
  '--request', '--header', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--json', '--user', '--form', '--form-string',
  '--user-agent', '--referer', '--cookie', '--cookie-jar', '--max-time', '--connect-timeout', '--upload-file', '--output', '--write-out', '--proxy',
  '--proxy-user', '--retry', '--retry-delay', '--retry-max-time', '--cert', '--cacert', '--capath', '--key', '--dump-header', '--range', '--config',
  '--time-cond', '--speed-time', '--speed-limit', '--resolve', '--connect-to', '--interface', '--limit-rate', '--max-redirs', '--proto', '--noproxy',
  '--url', '--url-query', '--oauth2-bearer', '--continue-at', '--quote', '--output-dir', '--unix-socket', '--aws-sigv4', '--tls-max', '--ciphers',
])
const CURL_SHORT = new Set(['-X', '-H', '-d', '-u', '-F', '-A', '-e', '-b', '-c', '-m', '-T', '-o', '-w', '-x', '-U', '-E', '-D', '-r', '-K', '-z', '-y', '-Y', '-C', '-Q'])
const WGET_LONG = new Set([
  '--output-document', '--output-file', '--append-output', '--directory-prefix', '--user-agent', '--header', '--user', '--password', '--method',
  '--execute', '--tries', '--timeout', '--wait', '--quota', '--post-data', '--post-file', '--body-data', '--body-file', '--load-cookies',
  '--save-cookies', '--referer', '--ca-certificate', '--certificate', '--private-key', '--bind-address', '--limit-rate', '--input-file',
])
const WGET_SHORT = new Set(['-O', '-o', '-a', '-P', '-U', '-e', '-t', '-T', '-w', '-Q', '-i', '-B'])

/** A curl option value that sends a file: `@file`, `@-` (stdin) or `name@file` (`--data-urlencode`); `--data-raw` never reads one. */
const readsFile = (value: string): boolean => value.startsWith('@') || /^[^=@]+@/.test(value)

const curlUploads = (words: readonly string[]): Upload[] => {
  const parsed = parseArguments(words.slice(1), CURL_LONG, CURL_SHORT)
  const dataFiles = valuesOf(parsed, '-d', '--data', '--data-ascii', '--data-binary', '--json').filter(value => value.startsWith('@'))
  const urlencoded = valuesOf(parsed, '--data-urlencode').filter(readsFile)
  const formFiles = valuesOf(parsed, '-F', '--form').filter(value => /=\s*[@<]/.test(value))
  const isFile = has(parsed, '-T', '--upload-file') || dataFiles.length > 0 || urlencoded.length > 0 || formFiles.length > 0
  const hasBody = isFile || has(parsed, '-d', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--json', '-F', '--form', '--form-string')
  const hosts = [...parsed.operands, ...valuesOf(parsed, '--url')].flatMap(operand => hostOf(operand) ?? [])
  const how = has(parsed, '-T', '--upload-file') ? 'a file upload (-T)' : isFile ? 'a file sent with curl' : 'text posted to a paste or sharing service'
  return hosts.filter(host => isFile || (hasBody && isPasteHost(host))).map(host => ({ tool: 'curl', host, how }))
}

const wgetUploads = (words: readonly string[]): Upload[] => {
  const parsed = parseArguments(words.slice(1), WGET_LONG, WGET_SHORT)
  const isFile = has(parsed, '--post-file', '--body-file')
  const hasBody = isFile || has(parsed, '--post-data', '--body-data')
  const hosts = parsed.operands.flatMap(operand => hostOf(operand) ?? [])
  return hosts.filter(host => isFile || (hasBody && isPasteHost(host))).map(host => ({ tool: 'wget', host, how: isFile ? 'a file posted with wget' : 'text posted to a paste or sharing service' }))
}

const SCP_SHORT = new Set(['-P', '-i', '-o', '-F', '-c', '-l', '-S', '-J', '-D'])
const RSYNC_LONG = new Set([
  '--rsh', '--exclude', '--include', '--exclude-from', '--include-from', '--filter', '--port', '--rsync-path', '--log-file', '--partial-dir',
  '--bwlimit', '--timeout', '--block-size', '--backup-dir', '--suffix', '--files-from', '--max-size', '--min-size', '--chmod', '--chown',
  '--usermap', '--groupmap', '--temp-dir', '--compare-dest', '--copy-dest', '--link-dest', '--address', '--sockopts', '--out-format',
  '--info', '--debug', '--password-file', '--read-batch', '--write-batch',
])
const RSYNC_SHORT = new Set(['-e', '-f', '-B', '-T'])

/** The host of `[user@]host:path`, `host::module` or `scp://host/path`; undefined for a local path or a Windows drive. */
const remoteHostOf = (operand: string): string | undefined => {
  const url = /^(?:scp|sftp|ssh|rsync):\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/:]+)/i.exec(operand)
  if (url !== null) return (url[1] as string).replace(/^\[|\]$/g, '').toLowerCase()
  if (/^[./~]/.test(operand) || /^[A-Za-z]:[\\/]/.test(operand)) return undefined
  const spec = /^(?:[^@/\s:]+@)?(\[[^\]]+\]|[A-Za-z0-9][A-Za-z0-9._-]*):/.exec(operand)
  return spec === null ? undefined : (spec[1] as string).replace(/^\[|\]$/g, '').toLowerCase()
}

const copyUploads = (tool: string, words: readonly string[]): Upload[] => {
  const parsed = tool === 'scp' ? parseArguments(words.slice(1), new Set(), SCP_SHORT) : parseArguments(words.slice(1), RSYNC_LONG, RSYNC_SHORT)
  const destination = parsed.operands.at(-1)
  const host = destination === undefined || parsed.operands.length < 2 ? undefined : remoteHostOf(destination)
  return host === undefined ? [] : [{ tool, host, how: `files copied with ${tool}` }]
}

const NC_SHORT = new Set(['-p', '-s', '-w', '-W', '-x', '-X', '-i', '-q', '-I', '-O', '-T', '-V', '-P'])

const netcatUploads = (command: Simple): Upload[] => {
  const parsed = parseArguments(command.words.slice(1), new Set(), NC_SHORT)
  if (has(parsed, '-l', '-z', '--listen')) return []
  const host = parsed.operands.find(operand => !/^\d+$/.test(operand))?.toLowerCase()
  if (host === undefined || !(command.isPiped || command.hasInput || isPasteHost(host))) return []
  return [{ tool: command.words[0] as string, host, how: 'data sent over a raw connection' }]
}

const HTTPIE_SHORT = new Set(['-a', '-A', '-b', '-j', '-s', '-p', '-o', '-d'])

const httpieUploads = (command: Simple): Upload[] => {
  const parsed = parseArguments(command.words.slice(1), new Set(['--auth', '--auth-type', '--session', '--verify', '--cert', '--proxy', '--timeout', '--output']), HTTPIE_SHORT)
  const [first, ...rest] = parsed.operands
  const operands = /^[A-Z]+$/.test(first ?? '') ? rest : parsed.operands
  const host = hostOf(operands[0] ?? '') ?? (/^:\d*\//.test(operands[0] ?? '') ? 'localhost' : undefined)
  const sendsFile = command.hasInput || operands.slice(1).some(item => /^[^=@:]+=?@/.test(item))
  return host !== undefined && sendsFile ? [{ tool: command.words[0] as string, host, how: 'a file sent with HTTPie' }] : []
}

/** Everything one simple command sends out to the network: files, pipes and pastes. */
const uploadsOf = (command: Simple): Upload[] => {
  const [first = '', ...rest] = command.words
  const tool = first.replace(/^.*\//, '')
  const found: Upload[] = []
  const devTcp = [...command.words, ...command.redirects].flatMap(word => [...word.matchAll(/\/dev\/(?:tcp|udp)\/([^/\s]+)\/\d+/g)].map(match => (match[1] as string).toLowerCase()))
  found.push(...devTcp.map(host => ({ tool: 'bash', host, how: 'a /dev/tcp redirect' })))
  if (tool === 'curl') found.push(...curlUploads(command.words))
  else if (tool === 'wget') found.push(...wgetUploads(command.words))
  else if (tool === 'scp' || tool === 'rsync') found.push(...copyUploads(tool, command.words))
  else if (tool === 'nc' || tool === 'ncat' || tool === 'netcat') found.push(...netcatUploads(command))
  else if (tool === 'http' || tool === 'https' || tool === 'xh' || tool === 'xhs') found.push(...httpieUploads(command))
  else if (tool === 'ssh' && command.isPiped) {
    const host = parseArguments(rest, new Set(), new Set(['-i', '-p', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-S', '-W'])).operands[0]
    if (host !== undefined) found.push({ tool, host: host.replace(/^.*@/, '').toLowerCase(), how: 'data piped into ssh' })
  } else if (tool === 'gh' && rest[0] === 'gist' && (rest[1] === 'create' || rest[1] === 'new')) {
    found.push({ tool, host: 'gist.github.com', how: 'a GitHub gist' })
  }
  return found
}

/** What the command line sends to a host that is not local or allowed; each destination once. */
export const blockedUploads = (command: string, allowed: ReadonlySet<string>): Upload[] => {
  if (!UPLOAD_HINT.test(command)) return []
  const seen = new Set<string>()
  return simpleCommands(command)
    .flatMap(uploadsOf)
    .filter(upload => {
      if (isAllowedHost(upload.host, allowed) || seen.has(upload.host)) return false
      seen.add(upload.host)
      return true
    })
}
