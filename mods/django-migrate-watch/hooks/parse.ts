import type { DjangoMigrateApp } from '../types'

const APP_HEADER = /^Migrations for '([^']+)':\s*$/
const OPERATION = /^\s+[-+~*]\s+(.+?)\s*$/
const FILE = /^\s+(\S+\.py)\s*$/

/** Whether a path is a Django models module: `models.py` or a file in a `models/` package. */
export const isModelsFile = (path: string): boolean => /(?:^|\/)models\.py$/.test(path) || /(?:^|\/)models\/[^/]+\.py$/.test(path)

/** Whether a path is a migration file. */
export const isMigrationFile = (path: string): boolean => /(?:^|\/)migrations\/[^/]+\.py$/.test(path)

/** Whether a shell command creates, applies or squashes migrations. */
export const touchesMigrations = (command: string): boolean => /\bmanage\.py\s+(?:makemigrations|migrate|squashmigrations)\b|\bdjango-admin\s+(?:makemigrations|migrate)\b/.test(command)

/**
 * The migrations `makemigrations --dry-run` would write, per app, from its
 * output (`- Add field …` in Django 4, `+ Add field …` / `~ Alter field …` in 5.1+).
 */
export const parsePending = (output: string): DjangoMigrateApp[] => {
  const apps: DjangoMigrateApp[] = []
  for (const line of output.split('\n')) {
    const header = APP_HEADER.exec(line)
    if (header !== null) {
      apps.push({ app: header[1] ?? '', file: null, operations: [] })
      continue
    }
    const current = apps.at(-1)
    if (current === undefined) continue
    const file = FILE.exec(line)
    if (file !== null && current.file === null) {
      current.file = file[1] ?? null
      continue
    }
    const operation = OPERATION.exec(line)
    if (operation !== null) current.operations.push(operation[1] ?? '')
  }
  return apps
}

/** A short form for the status line and the band: `shop (2), accounts (1)`. */
export const appsSummary = (apps: readonly DjangoMigrateApp[]): string =>
  apps.map(app => (app.operations.length > 0 ? `${app.app} (${app.operations.length})` : app.app)).join(', ')

/** What identifies a pending set, so a dismissed band shows again when it changes. */
export const signatureOf = (apps: readonly DjangoMigrateApp[]): string => apps.map(app => `${app.app}:${app.operations.join('|')}`).join('\n')
