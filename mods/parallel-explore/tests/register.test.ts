import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On } from 'claude-code'

import { FIXED_ANGLES, mergePrompt, parseAngles } from '../hooks/explore'
import { whyNotReadOnly } from '../hooks/readonly'
import { routesOf } from '../hooks/routes'
import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const USAGE = { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const QUESTION = 'How does the session token get refreshed?'
const ANGLES = [
  { title: 'Refresh logic', focus: 'Find where tokens are refreshed and how expiry is detected.' },
  { title: 'Callers & tests', focus: 'Find who triggers a refresh and which tests cover it.' },
  { title: 'Config', focus: 'Find token lifetimes, env vars and auth settings.' },
]
const ANSWER = 'Tokens are refreshed by `refreshSession` in src/auth/session.ts:42 when a request gets a 401.'
const PANE = {
  plugin: 'parallel-explore',
  component: 'Pane',
  requestId: 'explore',
  props: { title: 'Explore', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const explore = (args: string) => ({ command: 'explore', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const
const complete = (agentId: string, answer: string, reason: 'answer' | 'error' = 'answer') =>
  ({ answer, durationMs: 30_000, isAborted: false, turnId: `t-${agentId}`, agentId, reason }) as const

type Spawn = { subagentType: string; prompt: string; description: string }
type Asked = { model: string; system: string; prompt: string }
type World = { spawns: Spawn[]; asked: Asked[]; prompts: string[]; copied: string[]; toasts: string[]; registered: { name: string; tools?: readonly string[] }[]; ran: string[] }

const world = (on: On, options: { exploreMissing?: boolean; plan?: () => ModelCompleteResult; merge?: () => ModelCompleteResult } = {}) => {
  const state: World = { spawns: [], asked: [], prompts: [], copied: [], toasts: [], registered: [], ran: [] }
  const clock = (startClock = mock.clock(on, { now: 100_000 }))
  let nextId = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.list', () => ({ value: ['Read', 'Bash', 'Edit'].map(name => ({ name, description: name, isReadOnly: false })) }) as never)
  on('agent.register', ($, e) => {
    state.registered.push({ name: e.name, ...(e.tools === undefined ? {} : { tools: e.tools }) })
    return { value: { agent: `parallel-explore:${e.name}` } }
  })
  on('agent.spawn', ($, e) => {
    // The test kit hands a plugin's spawn on in the Agent tool's spelling (subagent_type).
    const subagentType = e.subagentType ?? String((e as unknown as Record<string, unknown>).subagent_type)
    state.spawns.push({ subagentType, prompt: e.prompt, description: e.description })
    if (options.exploreMissing === true && subagentType === 'Explore') return { deny: 'Agent type "Explore" not found' }
    nextId += 1
    return { model: 'claude', agentId: `agent-${nextId}` }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.complete', ($, e) => {
    state.asked.push({ model: e.model, system: e.system ?? '', prompt: e.prompt })
    if (e.model === 'haiku') return { value: options.plan?.() ?? { isAnswered: true, text: JSON.stringify(ANGLES), usage: USAGE } }
    return { value: options.merge?.() ?? { isAnswered: true, text: ANSWER, usage: USAGE } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', ($, e) => {
    state.ran.push(String(e.tool) === 'Bash' && 'command' in e ? String(e.command) : String(e.tool))
    return { result: 'ok' }
  })
  on('prompt.submit', ($, e) => {
    state.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    state.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.log', () => ({ value: undefined }))
  return { state, clock }
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
}

test('plans angles from JSON and writes the merge prompt', () => {
  expect(parseAngles(`Sure:\n\`\`\`json\n${JSON.stringify(ANGLES)}\n\`\`\``)).toEqual(ANGLES)
  expect(parseAngles('[{"title":"only one","focus":"x"}]')).toBeUndefined()
  const prompt = mergePrompt(QUESTION, [
    { ...ANGLES[0]!, status: 'done', report: 'src/auth/session.ts:42 refreshes.' },
    { ...ANGLES[1]!, status: 'failed', error: 'no report within 10 min' },
  ])
  expect(prompt).toContain('## Explorer 1: Refresh logic')
  expect(prompt).toContain('(no report: no report within 10 min)')
  expect(prompt).toContain('Never invent a path or a line number.')
})

// Every way found to write or run something through a program the explorers may use.
const BYPASSES = [
  // awk: system(), pipes to and from commands, output redirection, gawk's @ directives, program files
  `awk 'BEGIN{system("touch pwned")}'`,
  `awk 'awk::system("id")'`,
  `awk '{print > "out.txt"}' f`,
  `awk '{printf "%s", $0 > "out.txt"}' f`,
  `awk '{print(x) > "out.txt"}' f`,
  `awk '{ if ($1 > 0) print $1 > "out.txt" }' f`,
  `awk '{print >> "out.txt"}' f`,
  `awk '{print $1 | "sh"}' f`,
  `awk '{ "date" | getline d; print d }' f`,
  `awk '{ print |& "cat" }' f`,
  `awk 'BEGIN { f = "sys" "tem"; @f("id") }'`,
  `awk '@load "filefuncs"'`,
  `awk 'BEGIN { if (x) /"/; print > "f"; if (x) /"/ }'`,
  'awk -f prog.awk f',
  "awk -e 'BEGIN{}' f",
  'awk --exec=prog.awk f',
  "awk -o out.awk '1' f",
  "awk -p '1' f",
  'awk -W exec prog.awk',
  // sed: w/W and e commands, the s///w and s///e flags, in-place editing, script files
  "sed -n 'w out.txt' f",
  "sed -n '/x/w out.txt' f",
  "sed 'W out.txt' f",
  "sed 's/a/b/w out.txt' f",
  "sed 's/a/b/gw out.txt' f",
  "sed '1e touch pwned' f",
  "sed 's/.*/id/e' f",
  "sed -e p -e 'w out.txt' f",
  "sed --expression='w out.txt' f",
  "sed -n 'bx;w out.txt' f",
  "sed 's/[/]/x/w out.txt' f",
  "sed -i 's/a/b/' f",
  "sed -i.bak 's/a/b/' f",
  "sed -Ei 's/a/b/' f",
  "sed --in-place 's/a/b/' f",
  "sed -I '' 's/a/b/' f",
  "sed 's/a/b/' -i f",
  'sed -f script.sed f',
  // sort -o, uniq's output operand, tree -o
  'sort -o out.txt f',
  'sort -uo out.txt f',
  'sort --output=out.txt f',
  'sort --out=out.txt f',
  'sort --compress-program=sh f',
  'uniq in.txt out.txt',
  'uniq -c -f 1 in.txt out.txt',
  'uniq in.txt -- out.txt',
  'tree -o out.txt',
  'tree -aLo 2 out.txt',
  'tree -R -H .',
  // rg's preprocessors
  'rg --pre sh foo',
  'rg --pre=./x.sh foo',
  "rg --pre-glob '*.pdf' --pre cat foo",
  'rg --hostname-bin=sh foo',
  // git: output files, pagers, external diff and textconv drivers, config and repository overrides, ref writes
  'git log --output=out.txt',
  'git log --output out.txt',
  'git diff --output=out.txt',
  'git show --output=out.txt',
  'git grep -O x',
  'git grep -nO x',
  'git grep --open-files-in-pager=vi x',
  'git log -p --ext-diff',
  'git diff --ext-diff',
  'git show --textconv HEAD',
  'git cat-file --filters HEAD:x',
  'git log --help',
  'git -c core.pager=sh log',
  'git -c diff.external=sh diff',
  'git --config-env=core.pager=X log',
  'git --exec-path=. log',
  'git --git-dir=evil log',
  'git -p log',
  'git branch new-branch',
  'git branch -D main',
  'git branch -l new-branch',
  'git tag v9',
  'git tag -d v1',
  'git remote add x https://example.com/x.git',
  'git remote prune origin',
  'git checkout main',
  // find and fd actions
  'find . -exec rm {} +',
  'find . -execdir sh \\;',
  'find . -ok rm {} \\;',
  'find . -delete',
  "find . '-delete'",
  'find . -dele\\te',
  'find . -fprint out.txt',
  "find . -fprintf out.txt '%p'",
  'find . -fls out.txt',
  'fd -x rm',
  'fd -HIx rm',
  'fd --exec rm',
  'fd -X rm',
  // programs that are not read commands at all
  'xargs rm',
  'ls | xargs rm',
  'env sh',
  'env -i rm x',
  'tee out.txt',
  'ls | tee out.txt',
  'less f',
  'more f',
  'xxd in.bin out.bin',
  'ack --pager=sh x',
  'ag --pager=sh x',
  "yq -i '.a = 1' f.yaml",
  'file -C -m magic',
  'printf -v PATH x',
  'npm install',
  'cat x\nrm y',
  // the shell itself: redirection, substitution, variables, braces, globs, paths, assignments
  'cat x > out.txt',
  'cat x >> out.txt',
  'cat x >| out.txt',
  'cat x &> out.txt',
  'cat x >&out.txt',
  'cat x >&1x',
  'cat x 1>/dev/nullx',
  'cat <> out.txt',
  'cat <(touch pwned)',
  'echo $(touch pwned)',
  'echo `touch pwned`',
  'echo "$(touch pwned)"',
  'git log $IFS--output=x',
  'OPT=--output=x; git log "$OPT"',
  "cat $'\\x2d'",
  'git log {--output=x,}',
  'git log @{x},--output=y}',
  'git log --out\\put=x',
  "git log '--output=x'",
  'rg foo *',
  'sort *',
  'sed -e x* f',
  'PATH=. cat x',
  'GIT_EXTERNAL_DIFF=sh git diff',
  './cat x',
  '/bin/rm x',
  'r\\m -rf x',
  '(rm -rf x)',
  'f() { rm x; }; f',
  'cat <<EOF',
]

// Everyday reading that must keep working.
const READS = [
  'rg -n foo src',
  'git log --oneline -5',
  'git grep -n x',
  'sed -n 1,40p f',
  "awk '{print $1}' f",
  'sort f | uniq -c',
  "find . -name '*.ts'",
  'tree -L 2',
  'rg -n "refresh|renew" src | head -50',
  'cd src && git log --oneline -5 -- auth 2>/dev/null',
  "grep -rn 'TODO' --include='*.ts' src",
  'wc -l src/*.ts',
  'du -sh *',
  'git show HEAD~1 --stat',
  'git diff main...HEAD -- src',
  'git blame -L 10,20 src/a.ts',
  'git -C src log -1',
  'git log @{u}..HEAD',
  'git branch -a --contains abc123',
  "git tag -l 'v*'",
  'git remote -v',
  'git status --short',
  'GIT_PAGER=cat git log -3',
  'LC_ALL=C sort -u f',
  "grep -o 'x' f | sort | uniq -c | sort -rn | head",
  'ls 2>&1 | head',
  "jq '.scripts' package.json",
  "sed -n '/^export/p' src/a.ts",
  "sed 's/[[:space:]]*$//' f",
  "sed ':a;N;$!ba;s/\\n/ /g' f",
  "awk -F: '$3 > 100 {print $1}' /etc/passwd",
  "awk '/a|b/ {n++} END {print n}' f",
  "awk '{ s += $2 } END { print s / NR }' f",
  "fd -e ts src",
  "rg -l foo -g '*.ts' --hidden",
  '[ -f package.json ] && cat package.json',
]

test('explorer shell guard refuses every known write or run through an allowed program', () => {
  expect(BYPASSES.filter(command => whyNotReadOnly(command) === undefined)).toEqual([])
  expect(whyNotReadOnly(`awk 'BEGIN{system("touch pwned")}'`)).toBe('awk system() runs commands')
  expect(whyNotReadOnly("sed 's/a/b/w out.txt' f")).toBe('sed s///w writes files')
  expect(whyNotReadOnly('sort -o out.txt f')).toBe('sort -o writes or runs something')
  expect(whyNotReadOnly('uniq in.txt out.txt')).toBe('uniq with a second file writes it')
  expect(whyNotReadOnly('rg --pre sh foo')).toBe('rg --pre writes or runs something')
  expect(whyNotReadOnly('git grep -O x')).toBe('git grep -O writes or runs something')
  expect(whyNotReadOnly('find . -name "*.ts" -exec rm {} +')).toBe('find -exec writes or runs commands')
  expect(whyNotReadOnly('cat a > b')).toBe('no output redirection')
  expect(whyNotReadOnly('git checkout main')).toBe('git checkout is not a read command')
  expect(whyNotReadOnly('sed -i s/a/b/ x.ts')).toBe('no sed -i')
})

test('explorer shell guard lets everyday read commands through', () => {
  expect(READS.map(command => [command, whyNotReadOnly(command)]).filter(([, why]) => why !== undefined)).toEqual([])
})

test('/explore sends three Explore agents, shows progress, merges their reports and hands them to Claude', async ($, on) => {
  const { state, clock } = world(on)
  await start($)
  const started = await $.command.run(explore(QUESTION))
  expect(started.text).toBe('Exploring with 3 agents in parallel: Refresh logic · Callers & tests · Config. The merged findings land in the Explore pane.')
  await clock.settle()
  expect(state.asked[0]?.model).toBe('haiku')
  expect(state.spawns.map(spawn => spawn.subagentType)).toEqual(['Explore', 'Explore', 'Explore'])
  expect(state.registered).toEqual([]) // the scout is registered only when the built-in agent can't start
  expect(state.spawns[1]?.description).toBe('Explore: Callers & tests')
  expect(state.spawns[1]?.prompt).toContain('Your angle: Callers & tests. Find who triggers a refresh')
  expect(state.spawns[1]?.prompt).toContain(`The question: ${QUESTION}`)

  const busy = await $.command.run(explore('something else'))
  expect(busy.text).toContain('An exploration is still running')

  await clock.advance(5_000)
  await $.turn.complete(complete('agent-1', 'Findings: src/auth/session.ts:42 refreshSession() renews on 401.'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Exploring · 1 of 3 reported · 0:05' })).toBeDefined()
    expect((await ui.find({ key: 'angles' }))?.text).toContain('✓Refresh logic0:05')
    expect(await ui.find({ key: 'send' })).toBeUndefined()
    await ui.unmount()
  }

  await $.turn.complete(complete('agent-2', 'Called from src/api/client.ts:88; tested in tests/auth.test.ts:12.'))
  await $.turn.complete(complete('agent-3', 'TOKEN_TTL in .env.example:3.'))
  await clock.settle()
  const merge = state.asked[1]
  expect(merge?.model).toBe('claude-opus-5-5')
  expect(merge?.prompt).toContain('## Explorer 2: Callers & tests')
  expect(merge?.prompt).toContain('TOKEN_TTL in .env.example:3.')
  expect(state.toasts.at(-1)).toBe('Explore: findings merged')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Done in 0:05' })).toBeDefined()
    expect((await ui.find({ key: 'answer' }))?.text).toContain('refreshSession')
    await ui.press({ key: 'reports' })
    expect((await ui.find({ key: 'reports' }))?.text).toContain('TOKEN_TTL in .env.example:3.')
    await ui.press({ key: 'reports' })
    await ui.press({ key: 'copy' })
    await ui.unmount()
  }
  expect(state.copied[0]).toBe(ANSWER)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'send' })
  expect(state.prompts[0]).toContain(`I had three agents explore the codebase in parallel for: ${QUESTION}`)
  expect(state.prompts[0]).toContain(ANSWER)
})

test('explorers are read-only; other agents and the main loop are untouched; their notices do not wake Claude', async ($, on) => {
  const { state, clock } = world(on)
  await start($)
  await $.command.run(explore(QUESTION))
  await clock.settle()
  const asExplorer = (input: Record<string, unknown>) => $.tool.call({ ...input, agentId: 'agent-2' } as never)
  const denied = await asExplorer({ tool: 'Bash', command: 'rm -rf src' })
  expect(String(denied.deny ?? denied.text)).toContain('explorers are read-only (rm is not a read command)')
  const edit = await asExplorer({ tool: 'Edit', file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' })
  expect(String(edit.deny ?? edit.text)).toContain('explorers are read-only (Edit refused)')
  const monitor = await asExplorer({ tool: 'Monitor', command: 'touch pwned', description: 'watch', timeout_ms: 1_000 })
  expect(String(monitor.deny ?? monitor.text)).toContain('explorers are read-only (Monitor refused)')
  const mcp = await asExplorer({ tool: 'mcp__github__create_or_update_file', path: 'a.ts' })
  expect(String(mcp.deny ?? mcp.text)).toContain('explorers are read-only (mcp__github__create_or_update_file refused)')
  const sorted = await asExplorer({ tool: 'Bash', command: 'sort -o out.txt names.txt' })
  expect(String(sorted.deny ?? sorted.text)).toContain('explorers are read-only (sort -o writes or runs something)')
  await asExplorer({ tool: 'Read', file_path: '/work/app/a.ts' })
  await asExplorer({ tool: 'Bash', command: 'rg -n refreshSession src' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'someone-else' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(state.ran).toEqual(['Read', 'rg -n refreshSession src', 'npm test', 'npm run build'])

  const notice = await $.prompt.submit({ text: '<task-notification><task-id>agent-1</task-id><status>completed</status></task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(notice.drop).toContain('its findings are in the Explore pane')
  const other = await $.prompt.submit({ text: '<task-notification><task-id>bash-7</task-id></task-notification>', wait: false, origin: { kind: 'task-notification' } })
  expect(other.drop).toBeUndefined()
})

test('without the built-in Explore agent the read-only scout steps in', async ($, on) => {
  const { state, clock } = world(on, { exploreMissing: true })
  await start($)
  expect(state.registered).toEqual([])
  await $.command.run(explore(QUESTION))
  await clock.settle()
  expect(state.registered).toEqual([{ name: 'scout', tools: ['Read', 'Bash'] }])
  expect(state.spawns.filter(spawn => spawn.subagentType === 'Explore')).toHaveLength(3)
  expect(state.spawns.filter(spawn => spawn.subagentType === 'parallel-explore:scout')).toHaveLength(3)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '(scout)' })).toBeDefined()
})

test('fixed angles when planning is off; a failed explorer and the deadline still lead to an answer', { options: { planAngles: false, timeoutMinutes: 2 } }, async ($, on) => {
  const { state, clock } = world(on, { merge: () => ({ isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE }) })
  await start($)
  await $.command.run(explore(QUESTION))
  await clock.settle()
  expect(state.asked).toHaveLength(0)
  expect(state.spawns[2]?.description).toBe(`Explore: ${FIXED_ANGLES[2]?.title}`)

  await $.turn.complete(complete('agent-1', 'Implementation lives in src/auth/session.ts:42.'))
  await $.turn.complete(complete('agent-2', '', 'error'))
  await clock.settle()
  expect(state.asked).toHaveLength(0)
  await clock.advance(120_000)
  expect(state.toasts.at(-1)).toBe('Explore: merging failed, the reports are shown side by side')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Done in 2:00 · reports not merged' })).toBeDefined()
  const answer = (await ui.find({ key: 'answer' }))?.text ?? ''
  expect(answer).toContain('Implementation lives in src/auth/session.ts:42.')
  expect(answer).toContain('No report: it stopped (error) without a report.')
  expect(answer).toContain('No report: no report within 2 min.')
})

test('with mods-hub: says hello, publishes agent.finished per explorer, shows the model smart-router routed each to, and announces the merge through the hub', async ($, on) => {
  const { state, clock } = world(on)
  const hub = fakeHub(on, {}, clock)
  on('fs.read', () => ({ value: '{"version":"1.0.0"}' }))
  const feed = [
    { id: 'e1', topic: 'agent.routed', data: { agentType: 'Explore', tier: 'light', model: 'haiku', reason: 'read-only', agentId: 'agent-1' }, source: 'smart-router', at: 1, session: 's', scope: 'session' },
    { id: 'e2', topic: 'cost.update', data: {}, source: 'mods-hub', at: 2, session: 's', scope: 'session' },
  ]
  on('state.get', { plugin: 'mods-hub', key: 'feed' }, () => ({ value: { value: feed, version: 1 } }))
  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: '1.0.0', publishes: ['agent.finished'], consumes: ['agent.routed'] }])

  await $.command.run(explore(QUESTION))
  await clock.settle()
  await clock.advance(5_000)
  await $.turn.complete(complete('agent-1', 'Findings: src/auth/session.ts:42.'))
  await $.turn.complete(complete('agent-2', '', 'error'))
  await $.turn.complete(complete('agent-3', 'TOKEN_TTL in .env.example:3.'))
  await clock.settle()
  expect(hub.published).toEqual([
    { topic: 'agent.finished', data: { agentType: 'Explore', outcome: 'ok', durationMs: 5000, agentId: 'agent-1' } },
    { topic: 'agent.finished', data: { agentType: 'Explore', outcome: 'failed', durationMs: 5000, agentId: 'agent-2' } },
    { topic: 'agent.finished', data: { agentType: 'Explore', outcome: 'ok', durationMs: 5000, agentId: 'agent-3' } },
  ])
  expect(hub.notified).toEqual([{ level: 'success', title: 'Explore: findings merged' }])
  expect(state.toasts).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'angles' }))?.text).toContain('✓Refresh logic0:05haiku · light')
    await ui.unmount()
  }
})

test('without mods-hub the merge is announced by toast and no routing is shown', async ($, on) => {
  const { state, clock } = world(on)
  await start($)
  await $.command.run(explore(QUESTION))
  await clock.settle()
  for (const id of ['agent-1', 'agent-2', 'agent-3']) await $.turn.complete(complete(id, `report ${id}`))
  await clock.settle()
  expect(state.toasts.at(-1)).toBe('Explore: findings merged')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'angles' }))?.text).not.toContain('·')
  await ui.unmount()
})

test('routesOf maps agent ids to model and tier from the hub feed', () => {
  expect(routesOf([{ topic: 'agent.routed', data: { agentId: 'a', model: 'haiku', tier: 'light' } }, { topic: 'agent.routed', data: { agentId: 'b', model: 'opus' } }, { topic: 'agent.routed', data: { model: 'x' } }, { topic: 'other', data: null }])).toEqual(
    new Map([['a', 'haiku · light'], ['b', 'opus']]),
  )
})
