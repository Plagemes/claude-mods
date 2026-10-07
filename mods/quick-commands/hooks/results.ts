// What a check's output says, for the bus events quick-commands publishes. Pure: no `$`, unit-tested directly.

import { stripAnsi } from './shared/test-runners'

export type CheckCounts = { errors: number; warnings: number }

const sumOf = (text: string, pattern: RegExp): number | undefined => {
  const found = [...text.matchAll(pattern)]
  return found.length === 0 ? undefined : found.reduce((sum, match) => sum + Number(match[1]), 0)
}

const linesMatching = (text: string, pattern: RegExp): number => text.split('\n').filter(line => pattern.test(line)).length

/** The tool a command runs, as a bus event names it: `npm run lint` → npm, `cargo clippy` → cargo, `./lint.sh` → lint.sh. */
export function toolOf(command: string): string {
  const words = command.trim().split(/\s+/).filter(word => !/^\w+=/.test(word))
  const first = words[0] ?? ''
  return first.slice(first.lastIndexOf('/') + 1) || 'unknown'
}

/**
 * Errors and warnings a linter or type checker reported: eslint/biome summaries (`✖ 5 problems (3 errors, 2 warnings)`),
 * ruff/mypy/pyright counts (`Found 3 errors`, `2 errors, 1 warning`), tsc's `error TS2322` lines, rustc/clippy and go vet
 * diagnostics. A failed run that names no count is one error.
 */
export function checkCountsOf(output: string, hasFailed: boolean): CheckCounts {
  const text = stripAnsi(output)
  const summary = /(\d+) errors?(?:,| and) (\d+) warnings?/i.exec(text)
  if (summary !== null) return { errors: Number(summary[1]), warnings: Number(summary[2]) }
  const tsc = linesMatching(text, /\berror TS\d+:/)
  const rust = { errors: linesMatching(text, /^error(?:\[\w+\])?:/), warnings: linesMatching(text, /^warning(?:\[\w+\])?:/) }
  const found = sumOf(text, /\bFound (\d+) errors?\b/gi) ?? sumOf(text, /^(\d+) errors?\b/gim)
  const warnings = sumOf(text, /\b(\d+) warnings?\b/gi) ?? rust.warnings
  // rustc ends with `error: could not compile …`, which is no diagnostic of its own.
  const errors = found ?? (tsc > 0 ? tsc : Math.max(0, rust.errors - linesMatching(text, /^error: (?:could not compile|aborting due to)/)))
  return { errors: errors === 0 && hasFailed ? 1 : errors, warnings }
}
