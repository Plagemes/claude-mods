import type { Sheet } from './sheet'
import { bash } from './sheets/bash'
import { curl } from './sheets/curl'
import { docker } from './sheets/docker'
import { git } from './sheets/git'
import { kubectl } from './sheets/kubectl'
import { npm } from './sheets/npm'
import { regex } from './sheets/regex'
import { sql } from './sheets/sql'
import { tmux } from './sheets/tmux'
import { vim } from './sheets/vim'

export const SHEETS: readonly Sheet[] = [git, docker, regex, tmux, vim, bash, sql, curl, kubectl, npm]

/** The sheet a word names, by topic or alias, ignoring case. */
export const findSheet = (word: string): Sheet | undefined => {
  const wanted = word.toLowerCase()
  return SHEETS.find(sheet => sheet.topic === wanted || sheet.aliases.includes(wanted))
}
