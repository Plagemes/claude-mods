import { conninfo, mysqlConnection, passwordEnv } from './db'
import type { DbTarget } from './db'

/** Field and row separators no column value holds. */
export const UNIT = '\u001f'
export const RECORD = '\u001e'

/** A command line for the database's own client, with what it needs in its environment and on stdin. */
export type Invocation = { argv: string[]; env: Record<string, string>; stdin?: string }

/**
 * Runs `statements` in one read-only session of the database's CLI, each row
 * printed as fields joined by UNIT. Nothing goes through a shell.
 */
export const readOnlyQuery = (target: DbTarget, statements: readonly string[]): Invocation => {
  if (target.kind === 'sqlite') {
    return {
      argv: ['sqlite3', '-readonly', '-batch', '-noheader', '-separator', UNIT, '-newline', RECORD, target.path],
      env: {},
      stdin: statements.map(statement => `${statement}\n;\n`).join(''),
    }
  }
  if (target.kind === 'postgres') {
    return {
      argv: [
        'psql', '-X', '-w', '-q', '-A', '-t', '-F', UNIT, '-R', RECORD, '-v', 'ON_ERROR_STOP=1', '-d', conninfo(target),
        '-c', 'SET default_transaction_read_only = on',
        ...statements.flatMap(statement => ['-c', statement]),
      ],
      env: passwordEnv(target),
    }
  }
  return {
    argv: [
      'mysql', ...mysqlConnection(target), '--connect-timeout=5', `--database=${target.database}`, '--batch', '--skip-column-names',
      '-e', ['SET SESSION TRANSACTION READ ONLY', ...statements].join(';\n'),
    ],
    env: passwordEnv(target),
  }
}

const MYSQL_ESCAPES: Record<string, string> = { n: '\n', t: '\t', '0': '\0', '\\': '\\' }

/**
 * Splits a client's output into rows of fields. Every row the queries print
 * starts with a one-letter tag, which is how psql's per-command line breaks
 * are told from a break inside a value.
 */
export const parseRows = (kind: DbTarget['kind'], stdout: string): string[][] => {
  if (kind === 'mysql') {
    return stdout
      .split('\n')
      .filter(line => line !== '')
      .map(line => line.split('\t').map(field => field.replace(/\\([nt0\\])/g, (_, code: string) => MYSQL_ESCAPES[code] ?? code)))
  }
  return stdout
    .split(RECORD)
    .flatMap(chunk => chunk.split(new RegExp(`\\n(?=[A-Z]${UNIT})`)))
    .map(row => row.replace(/\n$/, ''))
    .filter(row => row !== '')
    .map(row => row.split(UNIT))
}

/** The first lines of a client's error output, without its noise. */
export const errorSummary = (stderr: string, exitCode: number): string => {
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^(?:LINE \d+:|\^|HINT:)/.test(line))
  return lines.slice(0, 2).join(' ') || `the client exited with code ${exitCode}`
}
