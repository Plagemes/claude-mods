export type Version = { major: number; minor: number; patch: number }

/** A version with missing parts (`20`, `20.11`, `20.x`): undefined stands for "any". */
type Partial3 = { major?: number; minor?: number; patch?: number }

type Primitive = { op: '>=' | '>' | '<' | '<=' | '='; version: Version }

const PARTIAL = /^[=v]*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+][\w.+-]*)?$/
/** Node's long-term-support release names and the major version each one is. */
const LTS_NAMES: Readonly<Record<string, number>> = {
  argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24,
}

const numberOf = (part: string | undefined): number | undefined => (part === undefined || /^[xX*]$/.test(part) ? undefined : Number(part))

function parsePartial(text: string): Partial3 | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '*') return {}
  const match = PARTIAL.exec(trimmed)
  if (match === null) return undefined
  const major = numberOf(match[1])
  const minor = major === undefined ? undefined : numberOf(match[2])
  const patch = minor === undefined ? undefined : numberOf(match[3])
  return { major, minor, patch }
}

/** `v20.11.0`, `20.11.0`, `node-v20.11.0`: a full version; undefined for anything else. */
export function parseVersion(text: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

const compare = (a: Version, b: Version): number => a.major - b.major || a.minor - b.minor || a.patch - b.patch
const filled = ({ major = 0, minor = 0, patch = 0 }: Partial3): Version => ({ major, minor, patch })

/** The version just above everything the partial covers: `1.2` -> 1.3.0, `1` -> 2.0.0. */
function bump(partial: Partial3): Version {
  if (partial.major === undefined) return { major: Number.MAX_SAFE_INTEGER, minor: 0, patch: 0 }
  if (partial.minor === undefined) return { major: partial.major + 1, minor: 0, patch: 0 }
  if (partial.patch === undefined) return { major: partial.major, minor: partial.minor + 1, patch: 0 }
  return { major: partial.major, minor: partial.minor, patch: partial.patch + 1 }
}

/** One comparator (`^1.2.3`, `~1.2`, `>=1`, `1.x`, `=1.2.3`) as the plain comparisons it means. */
function comparator(text: string): Primitive[] | undefined {
  const match = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(text.trim())
  const op = match?.[1] ?? ''
  const partial = parsePartial(match?.[2] ?? '')
  if (partial === undefined) return undefined
  const low = filled(partial)
  const above = bump(partial)
  switch (op) {
    case '^': {
      if (partial.major === undefined) return []
      const upper =
        partial.major > 0 || partial.minor === undefined
          ? { major: partial.major + 1, minor: 0, patch: 0 }
          : partial.minor > 0 || partial.patch === undefined
            ? { major: 0, minor: partial.minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: (partial.patch ?? 0) + 1 }
      return [{ op: '>=', version: low }, { op: '<', version: upper }]
    }
    case '~': case '~>':
      return partial.major === undefined ? [] : [{ op: '>=', version: low }, { op: '<', version: partial.minor === undefined ? above : { major: partial.major, minor: partial.minor + 1, patch: 0 } }]
    case '>=':
      return [{ op: '>=', version: low }]
    case '>':
      return [{ op: '>=', version: above }]
    case '<':
      return [{ op: '<', version: low }]
    case '<=':
      return [{ op: '<', version: above }]
    default:
      return partial.major === undefined ? [] : [{ op: '>=', version: low }, { op: '<', version: above }]
  }
}

function holds({ op, version }: Primitive, actual: Version): boolean {
  const order = compare(actual, version)
  switch (op) {
    case '>=': return order >= 0
    case '>': return order > 0
    case '<': return order < 0
    case '<=': return order <= 0
    default: return order === 0
  }
}

/** `1.2 - 2.3`: from the first (missing parts zero) up to what the second covers. */
function hyphenRange(text: string): Primitive[] | undefined {
  const match = /^(\S+)\s+-\s+(\S+)$/.exec(text.trim())
  if (match === null) return undefined
  const from = parsePartial(match[1] as string)
  const to = parsePartial(match[2] as string)
  if (from === undefined || to === undefined) return undefined
  return [{ op: '>=', version: filled(from) }, { op: '<', version: bump(to) }]
}

/**
 * Whether `version` satisfies an npm-style range: `^`, `~`, `>=`, `>`, `<=`, `<`, `=`, `x`/`*` ranges,
 * `a - b`, comparators joined by spaces (and) and by `||` (or). Undefined when the range is not understood.
 */
export function satisfies(version: Version, range: string): boolean | undefined {
  let isUnderstood = true
  const alternatives = range.split('||').map(alternative => {
    const primitives =
      hyphenRange(alternative) ??
      alternative
        .trim()
        .replace(/([\^~<>=]+)\s+/g, '$1')
        .split(/\s+/)
        .flatMap(part => {
          const found = comparator(part)
          if (found === undefined) isUnderstood = false
          return found ?? []
        })
    return primitives.every(primitive => holds(primitive, version))
  })
  return isUnderstood ? alternatives.some(Boolean) : undefined
}

/**
 * Whether `version` is what a version file pins: `20`, `v20.11`, `20.11.0` (a prefix match, like nvm), a
 * long-term-support name (`lts/iron`), or a range. Undefined for pins that name no fixed version (`lts/*`, `node`, `system`).
 */
export function matchesPin(version: Version, pin: string): boolean | undefined {
  const text = pin.trim().replace(/^node-/i, '')
  const lts = /^lts\/([a-z]+)$/i.exec(text)?.[1]?.toLowerCase()
  if (lts !== undefined) return LTS_NAMES[lts] === undefined ? undefined : version.major === LTS_NAMES[lts]
  const exact = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text)
  if (exact !== null) {
    const [major, minor, patch] = [exact[1], exact[2], exact[3]].map(part => (part === undefined ? undefined : Number(part)))
    return version.major === major && (minor === undefined || version.minor === minor) && (patch === undefined || version.patch === patch)
  }
  return satisfies(version, text)
}
