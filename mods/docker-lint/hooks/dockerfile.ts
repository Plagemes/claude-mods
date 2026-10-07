export type Rule = 'latest-tag' | 'root-user' | 'apt-recommends' | 'apt-cleanup' | 'apt-update-alone' | 'add-local' | 'curl-pipe' | 'secret-name'

export type Finding = {
  rule: Rule
  /** Line of the instruction, counting from 1. */
  line: number
  message: string
}

type Instruction = { keyword: string; args: string; line: number }
type Stage = { image: string; line: number; alias: string | undefined; users: string[] }

const SECRET_NAME = /(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL)/i
const SECRET_REFERENCE = /(?:_FILE|_PATH|_URL)$/i
const ARCHIVE = /\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar\.zst)$/i
const REMOTE_SOURCE = /^(?:https?:\/\/|ftp:\/\/|git@|git:\/\/)/i
const CURL_PIPE = /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b|\b(?:ba|z|da)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b|<\(\s*(?:curl|wget)\b/
const APT_INSTALL = /\b(?:apt-get|apt|aptitude)\s+(?:-\S+\s+)*install\b/
const APT_UPDATE = /\b(?:apt-get|apt)\s+(?:-\S+\s+)*update\b/

/** The file's instructions, with continuation lines joined and comments dropped. */
export function instructionsOf(text: string): Instruction[] {
  const instructions: Instruction[] = []
  let pending: { parts: string[]; line: number } | undefined
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const trimmed = raw.trim()
    if (pending === undefined && (trimmed === '' || trimmed.startsWith('#'))) continue
    if (pending !== undefined && (trimmed === '' || trimmed.startsWith('#'))) continue
    const isContinued = /\\\s*$/.test(raw)
    const part = raw.replace(/\\\s*$/, '').trim()
    if (pending === undefined) pending = { parts: [part], line: index + 1 }
    else pending.parts.push(part)
    if (!isContinued) {
      const joined = pending.parts.join(' ').trim()
      const match = /^(\w+)\s*(.*)$/s.exec(joined)
      if (match !== null) instructions.push({ keyword: (match[1] as string).toUpperCase(), args: match[2] as string, line: pending.line })
      pending = undefined
    }
  }
  return instructions
}

/** `FROM --platform=linux/amd64 node:22 AS build` -> the image and the stage's alias. */
function parseFrom(args: string): { image: string; alias: string | undefined } {
  const words = args.split(/\s+/).filter(word => !word.startsWith('--'))
  const alias = words[1]?.toLowerCase() === 'as' ? words[2] : undefined
  return { image: words[0] ?? '', alias }
}

function stagesOf(instructions: readonly Instruction[]): Stage[] {
  const stages: Stage[] = []
  for (const { keyword, args, line } of instructions) {
    if (keyword === 'FROM') stages.push({ ...parseFrom(args), line, users: [] })
    else if (keyword === 'USER') stages.at(-1)?.users.push((args.split(/\s+/)[0] ?? '').split(':')[0] ?? '')
  }
  return stages
}

function tagProblem(stage: Stage, earlier: readonly Stage[]): string | undefined {
  const { image } = stage
  if (image === '' || image.toLowerCase() === 'scratch' || /[${]/.test(image) || image.includes('@')) return undefined
  if (earlier.some(previous => previous.alias?.toLowerCase() === image.toLowerCase())) return undefined
  const tag = /:([^/:]+)$/.exec(image)?.[1]
  if (tag === undefined) return `${image} has no tag, which means :latest; pin a version (for example ${image}:1.2) so builds repeat`
  return tag.toLowerCase() === 'latest' ? `${image} uses the :latest tag, which changes under you; pin a version` : undefined
}

function envNames(keyword: string, args: string): string[] {
  const names: string[] = []
  const tokens = args.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? []
  if (keyword === 'ARG' || tokens[0]?.includes('=') === true) {
    for (const token of tokens) names.push(token.split('=')[0] ?? '')
  } else if (tokens[0] !== undefined) {
    names.push(tokens[0])
  }
  return names.filter(name => name !== '')
}

function addSources(args: string): string[] {
  const words = args.startsWith('[') ? (args.match(/"([^"]*)"/g) ?? []).map(word => word.slice(1, -1)) : args.split(/\s+/)
  return words.filter(word => !word.startsWith('--')).slice(0, -1)
}

/** Dockerfile smells that are worth a second look, found by reading the text. */
export function lintDockerfile(text: string): Finding[] {
  const instructions = instructionsOf(text)
  const stages = stagesOf(instructions)
  const findings: Finding[] = []
  const add = (rule: Rule, line: number, message: string) => findings.push({ rule, line, message })

  for (const [index, stage] of stages.entries()) {
    const problem = tagProblem(stage, stages.slice(0, index))
    if (problem !== undefined) add('latest-tag', stage.line, problem)
  }

  const last = stages.at(-1)
  if (last !== undefined) {
    const user = last.users.at(-1)
    if (user === undefined) add('root-user', last.line, 'no USER instruction in the final stage, so the container runs as root; create a user and switch to it')
    else if (user === 'root' || user === '0') add('root-user', last.line, 'the final stage ends with USER root; switch to a non-root user')
  }

  for (const { keyword, args, line } of instructions) {
    if (keyword === 'RUN') {
      const isCacheMounted = /--mount=type=cache[^ ]*\/var\/(?:lib\/apt|cache\/apt)/.test(args)
      if (APT_INSTALL.test(args)) {
        if (!/--no-install-recommends|Install-Recommends=(?:false|0)/i.test(args)) add('apt-recommends', line, 'apt-get install without --no-install-recommends pulls in packages you did not ask for')
        if (!isCacheMounted && !/rm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:\S+\s+)*\/var\/lib\/apt\/lists/.test(args)) {
          add('apt-cleanup', line, 'apt-get install without rm -rf /var/lib/apt/lists/* in the same RUN leaves the package index in the layer')
        }
      } else if (APT_UPDATE.test(args)) {
        add('apt-update-alone', line, 'apt-get update in its own RUN gets cached and goes stale; run it in the same RUN as apt-get install')
      }
      if (CURL_PIPE.test(args)) add('curl-pipe', line, 'piping curl or wget into a shell runs unverified code at build time; download, check a checksum, then run')
    } else if (keyword === 'ADD') {
      const local = addSources(args).filter(source => !REMOTE_SOURCE.test(source) && !ARCHIVE.test(source))
      if (local.length > 0) add('add-local', line, `ADD ${local[0]} copies a local path; use COPY (ADD is for URLs and archives it unpacks)`)
    } else if (keyword === 'ENV' || keyword === 'ARG') {
      const secret = envNames(keyword, args).find(name => SECRET_NAME.test(name) && !SECRET_REFERENCE.test(name))
      if (secret !== undefined) add('secret-name', line, `${keyword} ${secret} looks like a secret kept in the image history; use RUN --mount=type=secret or pass it when the container runs`)
    }
  }
  return findings.sort((a, b) => a.line - b.line)
}

/** Rules that hadolint also checks (by its codes); the others stay with the built-in rules when it runs. */
export const COVERED_BY_HADOLINT: readonly Rule[] = ['latest-tag', 'apt-recommends', 'apt-cleanup', 'add-local']
