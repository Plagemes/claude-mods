/** Why a path is protected; `rule` names the case for mods-hub's risk.blocked. */
export type Protection = { rule: string; reason: string }

const ENV_FILE = /^\.env(?:\.[^/]*|[*?].*)?$/
const ENV_TEMPLATE = /\.(?:example|sample|template|dist)$/
const PRIVATE_KEY_FILE = /\.(?:pem|key|p12|pfx)$/i
const SSH_KEY_FILE = /^id_(?:rsa|dsa|ecdsa|ed25519)/
const KUBECONFIG_FILE = /^kubeconfig(?:\..*)?$|\.kubeconfig$/i
const NPMRC_TOKEN = /_(?:authToken|auth|password)\s*=\s*(?!\$\{|\s|$)\S/m

/** `*` and `?` globs, matched against the end of a path at a directory boundary. */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`(?:^|/)${source}$`)
}

export function parseGlobs(list: string): RegExp[] {
  return list
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
    .map(globToRegExp)
}

export function hasNpmToken(npmrc: string): boolean {
  return NPMRC_TOKEN.test(npmrc)
}

export function isNpmrc(path: string): boolean {
  return baseName(normalize(path)) === '.npmrc'
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** What a path is protected as, by its name alone (`.npmrc` needs its content: see isNpmrc). */
export function protectionOf(rawPath: string): Protection | undefined {
  const path = normalize(rawPath)
  const name = baseName(path)

  if (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)) return { rule: 'env-file', reason: 'an environment file' }
  if (/(?:^|\/)\.ssh(?:\/|$)/.test(path) && !name.endsWith('.pub')) return { rule: 'ssh-dir', reason: 'an SSH directory entry' }
  if (SSH_KEY_FILE.test(name) && !name.endsWith('.pub')) return { rule: 'ssh-key', reason: 'an SSH private key' }
  if (PRIVATE_KEY_FILE.test(name)) return { rule: 'private-key', reason: 'a private key or certificate bundle' }
  if (/(?:^|\/)\.aws\/credentials$/.test(path)) return { rule: 'aws-credentials', reason: 'the AWS credentials file' }
  if (/^[._]netrc$/.test(name)) return { rule: 'netrc', reason: 'a netrc credentials file' }
  if (KUBECONFIG_FILE.test(name) || /(?:^|\/)\.kube\/config$/.test(path)) return { rule: 'kubeconfig', reason: 'a kubeconfig' }
  if (name === '.git-credentials' || name === '.pgpass') return { rule: 'credentials-file', reason: 'a stored credentials file' }
  if (/(?:^|\/)\.gnupg(?:\/|$)/.test(path)) return { rule: 'gnupg', reason: 'the GnuPG key ring' }
  return undefined
}
