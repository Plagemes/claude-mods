import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { answer, sectionsOf } from '../hooks/cheat'
import { SHEETS, findSheet } from '../hooks/sheets'

const cheat = async ($: Engine, args = ''): Promise<string> =>
  (
    await $.command.run({
      command: 'cheat',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
  ).text ?? ''

test('registers /cheat when the session starts', async ($, on) => {
  const registered: string[] = []
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['cheat'])
})

test('/cheat lists the ten topics with a line about each', async ($) => {
  const text = await cheat($)

  expect(text).toContain('# Cheat sheets')
  for (const topic of ['git', 'docker', 'regex', 'tmux', 'vim', 'bash', 'sql', 'curl', 'kubectl', 'npm']) {
    expect(text, topic).toMatch(new RegExp(`^ {4}${topic} {2,}\\S`, 'm'))
  }
  expect(text).toContain('/cheat git stash')
})

test('/cheat <topic> prints the whole sheet', async ($) => {
  const text = await cheat($, 'git')

  expect(text.startsWith('# Git cheat sheet\n\n## Status and history\n')).toBe(true)
  expect(text).toContain('git stash pop')
  expect(text).toContain('git push --force-with-lease')
  expect(text).toContain('## Undo')
})

test('/cheat <topic> <words> keeps only the lines that contain every word, under their headings', async ($) => {
  const text = await cheat($, 'git stash pop')

  expect(text).toContain('# Git: "stash pop"')
  expect(text).toContain('## Stash')
  expect(text).toContain('git stash pop')
  expect(text).not.toContain('git stash list')
  expect(text).not.toContain('git reflog')
})

test('a word can match the title of a section, so /cheat docker compose shows the Compose section', async ($) => {
  const text = await cheat($, 'docker compose')

  expect(text).toContain('docker compose up -d')
  expect(text).toContain('docker compose down')
  expect(text).not.toContain('## Images')
})

test('topics have aliases and are not case sensitive', async ($) => {
  expect(await cheat($, 'K8S rollout undo')).toContain('kubectl rollout undo deploy/<name>')
  expect(await cheat($, 'Regexp lookbehind')).toContain('(?<=x)')
  expect(await cheat($, 'SHELL pipefail')).toContain('set -euo pipefail')
  expect(findSheet('nvim')?.topic).toBe('vim')
  expect(findSheet('postgres')?.topic).toBe('sql')
})

test('words that are not a topic search every sheet, grouped by sheet', async ($) => {
  const text = await cheat($, 'prune')

  expect(text).toContain('# Cheat sheets: "prune"')
  expect(text).toContain('## Docker')
  expect(text).toContain('docker system prune')
  expect(text).toContain('## Git')
  expect(text).toContain('git fetch --prune')
  expect(text).toContain('## npm')
  expect(text).toContain('npm prune')
})

test('says so when nothing matches, and points at what to try', async ($) => {
  expect(await cheat($, 'git frobnicate')).toBe('No line in the Git sheet matches "frobnicate". /cheat git shows the whole sheet.')
  const none = await cheat($, 'frobnicate')
  expect(none).toContain('Nothing matches "frobnicate" in any cheat sheet.')
  expect(none).toContain('Topics: git, docker, regex, tmux, vim, bash, sql, curl, kubectl, npm.')
})

test('a broad search is capped and says how much it left out', () => {
  const text = answer('s')

  expect(text.split('\n').filter(line => line.startsWith('    ')).length).toBe(50)
  expect(text).toMatch(/…and \d+ more lines\. Add a topic or another word/)
})

test('every sheet is well formed: sections, aligned two-column lines, no stray whitespace', () => {
  expect(SHEETS.map(sheet => sheet.topic)).toEqual(['git', 'docker', 'regex', 'tmux', 'vim', 'bash', 'sql', 'curl', 'kubectl', 'npm'])
  for (const sheet of SHEETS) {
    expect(sectionsOf(sheet).length, sheet.topic).toBeGreaterThanOrEqual(5)
    expect(sectionsOf(sheet).flatMap(section => section.lines).length, sheet.topic).toBeGreaterThanOrEqual(30)
    for (const line of sheet.markdown.split('\n')) {
      if (line === '') continue
      expect(line.startsWith('## ') || /^ {4}\S.*\S {2,}\S/.test(line) || /^ {4}\S.*\S$/.test(line), `${sheet.topic}: ${line}`).toBe(true)
      expect(line, `${sheet.topic}: trailing space`).not.toMatch(/\s$/)
      expect(line, `${sheet.topic}: tab`).not.toContain('\t')
    }
  }
})
