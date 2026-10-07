import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

const ADA = 'Ada Lovelace <ada@example.com>'
const BOT = 'Pair Bot <bot@example.com>'
const ADA_TRAILER = "--trailer 'Co-authored-by: Ada Lovelace <ada@example.com>'"
const BOT_TRAILER = "--trailer 'Co-authored-by: Pair Bot <bot@example.com>'"

/** Stands in for the engine: records the Bash commands that would run and answers `git --version`. */
function engine(on: On, gitVersion = 'git version 2.43.0') {
  const ran: string[] = []
  const gitCalls: string[][] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: 'ok' }
  })
  on('process.run', (_$, e) => {
    gitCalls.push([...e.argv])
    return { value: { exitCode: 0, stdout: `${gitVersion}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('attribution.text', (_$, e) => ({ text: e.text }))
  return { ran, gitCalls }
}

const bash = (command: string) => ({ tool: 'Bash', command }) as const

test('adds a --trailer for each missing co-author to git commit -m', { options: { coAuthors: `${ADA}, ${BOT}` } }, async ($, on) => {
  const { ran } = engine(on)
  await $.tool.call(bash('git commit -m "fix: handle empty input"'))
  expect(ran).toEqual([`git commit ${ADA_TRAILER} ${BOT_TRAILER} -m "fix: handle empty input"`])
})

test('finds the commit inside compound commands and heredocs, and quotes safely', { options: { coAuthors: "Zoë O'Neil <zoe@example.com>" } }, async ($, on) => {
  const { ran } = engine(on)
  await $.tool.call(bash('cd app && git add -A && git commit -am "wip" && git push'))
  await $.tool.call(bash("git commit -m \"$(cat <<'EOF'\nfeat: x\n\nBody line\nEOF\n)\""))
  const trailer = "--trailer 'Co-authored-by: Zoë O'\\''Neil <zoe@example.com>'"
  expect(ran).toEqual([
    `cd app && git add -A && git commit ${trailer} -am "wip" && git push`,
    `git commit ${trailer} -m "$(cat <<'EOF'\nfeat: x\n\nBody line\nEOF\n)"`,
  ])
})

test('leaves commands alone that already carry the co-author, or are not message commits', { options: { coAuthors: ADA } }, async ($, on) => {
  const { ran, gitCalls } = engine(on)
  const untouched = [
    'git commit -m "x\n\nCo-authored-by: Ada Lovelace <ADA@example.com>"',
    'git commit --amend --no-edit',
    'git commit',
    'git status && git log -m',
    'echo "git commit -m x" > notes.txt',
    'npm test',
  ]
  for (const command of untouched) await $.tool.call(bash(command))
  expect(ran).toEqual(untouched)
  expect(gitCalls).toHaveLength(0)
})

test('does not rewrite when git is older than 2.32 (no commit --trailer)', { options: { coAuthors: ADA } }, async ($, on) => {
  const { ran } = engine(on, 'git version 2.25.1')
  await $.tool.call(bash('git commit -m "x"'))
  expect(ran).toEqual(['git commit -m "x"'])
})

test('asks for the trailers in the commit attribution text, once each', { options: { coAuthors: `${ADA}, ${BOT}` } }, async ($, on) => {
  engine(on)
  const added = await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: Claude <noreply@anthropic.com>' })
  expect(added.text).toBe(
    'Co-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: Ada Lovelace <ada@example.com>\nCo-authored-by: Pair Bot <bot@example.com>',
  )
  const dedup = await $.attribution.text({ kind: 'commit', text: 'Co-authored-by: Ada Lovelace <ada@example.com>' })
  expect(dedup.text).toBe('Co-authored-by: Ada Lovelace <ada@example.com>\nCo-authored-by: Pair Bot <bot@example.com>')
  const pr = await $.attribution.text({ kind: 'pr', text: 'Generated with Claude Code' })
  expect(pr.text).toBe('Generated with Claude Code')
})

test('does nothing until coAuthors is set', async ($, on) => {
  const { ran, gitCalls } = engine(on)
  await $.tool.call(bash('git commit -m "x"'))
  const text = await $.attribution.text({ kind: 'commit', text: 'T' })
  expect(ran).toEqual(['git commit -m "x"'])
  expect(gitCalls).toHaveLength(0)
  expect(text.text).toBe('T')
})
