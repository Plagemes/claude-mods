import { simpleCommands } from './shared/shell'

/** What `df -Pk .` says about the disk the working directory is on. */
export type DiskUsage = {
  totalKb: number
  availableKb: number
  usedPercent: number
  mount: string
}

const KB_PER_GB = 1024 * 1024

/** Commands that write a lot to disk: dependency installs, builds, image pulls and clones. */
const HEAVY_WRITERS: readonly RegExp[] = [
  /\b(?:npm|yarn|pnpm|bun)\s+(?:install|i|ci|add|update|upgrade|(?:run\s+)?build)\b/,
  /^\s*(?:yarn|bun\s+install)\s*(?:$|[&|;])/,
  /\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\buv\s+(?:sync|add|pip\s+install)\b|\bpoetry\s+(?:install|add|update)\b|\bpipenv\s+install\b|\bconda\s+(?:install|create|update)\b/,
  /\bcargo(?:\s+\+\S+)?\s+(?:build|install|fetch|check|test|doc|bench|vendor)\b/,
  /\bgo\s+(?:build|install|get|mod\s+download)\b/,
  /\b(?:gem|bundle)\s+install\b|\bcomposer\s+(?:install|update|require)\b/,
  /\bdotnet\s+(?:build|restore|publish)\b|\bmvn\s+[\w:. -]*\b(?:package|install|verify)\b|\bgradlew?\s+(?:[\w:-]+\s+)*(?:build|assemble|install)\b/,
  /\bdocker(?:-compose)?\s+(?:(?:compose|image|buildx)\s+)?(?:build|pull)\b|\bdocker\s+compose\s+up\b[^|;&]*--build\b/,
  /\bgit\s+(?:-C\s+\S+\s+)?(?:clone|lfs\s+pull|submodule\s+update)\b/,
  /\b(?:apt-get|apt|dnf|yum|apk|brew)\s+(?:install|upgrade)\b/,
]

/** Why a command failed when the disk was full: what the shell, Node, Docker and pip all say. */
export const NO_SPACE = /No space left on device|\bENOSPC\b|Disk quota exceeded|not enough space on the disk/i

/** The programs that can be a heavy writer, so `git commit -m "npm install"` or `echo npm install` is not mistaken for one. */
const HEAVY_PROGRAMS: ReadonlySet<string> = new Set([
  'npm', 'yarn', 'pnpm', 'bun', 'pip', 'pip3', 'python', 'python3', 'uv', 'poetry', 'pipenv', 'conda', 'cargo', 'go', 'gem', 'bundle',
  'composer', 'dotnet', 'mvn', 'gradle', 'gradlew', 'docker', 'docker-compose', 'git', 'apt-get', 'apt', 'dnf', 'yum', 'apk', 'brew',
])

/** Whether a shell line runs a command that writes a lot: read command by command (`sudo` and `env` peeled, `bash -c` opened), so a quoted `npm install` in a commit message is not one. */
export const isHeavyWrite = (command: string): boolean =>
  simpleCommands(command).some(({ name, argv }) => {
    if (!HEAVY_PROGRAMS.has(name)) return false
    // The command as its program's name and arguments, matched from the start: what a later argument says (a commit message) is no command.
    const text = [name, ...argv.slice(1)].join(' ')
    return HEAVY_WRITERS.some(pattern => pattern.exec(text)?.index === 0)
  })

/** The numbers on the last line of POSIX `df -Pk` output; undefined when it does not look like that. */
export const parseDf = (stdout: string): DiskUsage | undefined => {
  const lastLine = stdout.trimEnd().split('\n').at(-1) ?? ''
  const match = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(lastLine.trim())
  if (match === null) return undefined
  const [, , total, , available, percent, mount] = match
  return { totalKb: Number(total), availableKb: Number(available), usedPercent: Number(percent), mount: mount ?? '' }
}

export const formatSize = (kb: number): string => {
  const gb = kb / KB_PER_GB
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.max(0, Math.round(kb / 1024))} MB`
}

export const describeDisk = (disk: DiskUsage): string =>
  `only ${formatSize(disk.availableKb)} free of ${formatSize(disk.totalKb)} on ${disk.mount} (${disk.usedPercent}% used)`

/** Why the disk is too full for a heavy command, or undefined when it has room. */
export const shortage = (disk: DiskUsage, minFreeGb: number, maxUsedPercent: number): string | undefined => {
  const isLow = disk.availableKb < minFreeGb * KB_PER_GB
  const isFull = disk.usedPercent > maxUsedPercent
  return isLow || isFull ? describeDisk(disk) : undefined
}

/** Where to look for what is using the space; the commands are for Claude or the person to run, never run by the mod. */
export const SUGGESTIONS = [
  'Find the big folders: du -sh node_modules target .venv build dist ~/.cache ~/.npm ~/.cargo 2>/dev/null | sort -h',
  "Docker's share: docker system df (docker system prune frees the unused part; ask the user before running it)",
]
