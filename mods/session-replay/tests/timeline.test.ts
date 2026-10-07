import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { applyFilter, buildTimeline, clip, diffOf, duration, entryOf, exportMarkdown, metaOf, scrubber } from '../hooks/timeline'

const ROOT = '/repo'
const AT = new Date(2026, 9, 7, 14, 3, 21).getTime()

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'Fix the failing cart test\nIt broke yesterday.', toolUses: [] },
  {
    role: 'assistant',
    text: 'Let me run the tests first.',
    toolUses: [
      { tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test -- cart' }, text: 'FAIL src/cart.test.ts\n  ✕ applies discounts', isError: true },
      { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/repo/src/cart.ts', offset: 10 }, text: '10 export const total = …' },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b1', text: 'FAIL', isError: true, result: undefined }] },
  { role: 'user', text: '<system-reminder>The date changed.</system-reminder>', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      { tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/repo/src/cart.ts', old_string: 'price * rate', new_string: 'price * (1 - rate)' }, text: 'ok' },
      { tool_use_id: 't1', tool: 'TodoWrite', input: { todos: [{ content: 'Fix discount', status: 'completed' }, { content: 'Run tests', status: 'in_progress' }] }, text: 'ok' },
      { tool_use_id: 'a1', tool: 'Agent', input: { description: 'Review the fix', prompt: 'Check **cart.ts**' }, text: 'Looks right.', durationMs: 42_000 },
      { tool_use_id: 'm1', tool: 'mcp__linear__create_issue', input: { title: 'Cart' }, text: 'created' },
    ],
  },
  { role: 'assistant', text: 'Fixed: the discount was applied twice.', toolUses: [] },
]

const RECORDS = {
  prompts: [{ text: 'Fix the failing cart test\nIt broke yesterday.', at: AT }],
  tools: { b1: { at: AT + 5_000, durationMs: 2_300, isError: true }, e1: { at: AT + 9_000, durationMs: 12, isError: false } },
}

test('builds one step per prompt, answer and tool call, with recorded times', () => {
  const steps = buildTimeline(MESSAGES, RECORDS, ROOT)
  expect(steps.map(step => `${step.kind}: ${step.title}`)).toEqual([
    'prompt: Fix the failing cart test',
    'answer: Let me run the tests first.',
    'command: $ npm test -- cart',
    'read: Read src/cart.ts from line 10',
    'edit: Edit src/cart.ts',
    'todo: Todos: 1/2 done',
    'agent: Subagent: Review the fix',
    'tool: mcp__linear__create_issue',
    'answer: Fixed: the discount was applied twice.',
  ])
  const [prompt, , command, , edit, todo, agent, mcp] = steps
  expect(prompt?.at).toBe(AT)
  expect(command).toMatchObject({ at: AT + 5_000, durationMs: 2_300, isError: true, language: 'bash', output: 'FAIL src/cart.test.ts\n  ✕ applies discounts' })
  expect(metaOf(command ?? steps[0]!)).toBe('Command · 14:03:26 · 2.3 s · ✗ failed')
  expect(edit).toMatchObject({ format: 'diff', path: '/repo/src/cart.ts', body: '@@ -1,1 +1,1 @@\n-price * rate\n+price * (1 - rate)' })
  expect(todo?.body).toBe('- [x] Fix discount\n- [ ] Run tests *(in progress)*')
  expect(agent).toMatchObject({ format: 'markdown', body: 'Check **cart.ts**', durationMs: 42_000 })
  expect(mcp).toMatchObject({ language: 'json', body: '{\n  "title": "Cart"\n}' })
  expect(entryOf(command ?? steps[0]!)).toEqual({ id: 'b1', kind: 'command', title: '$ npm test -- cart', at: AT + 5_000, isError: true })
})

test('filters keep the steps they name, in order', () => {
  const steps = buildTimeline(MESSAGES, RECORDS, ROOT)
  expect(applyFilter(steps, 'prompts').map(step => step.id)).toEqual(['prompt:0'])
  expect(applyFilter(steps, 'answers')).toHaveLength(2)
  expect(applyFilter(steps, 'tools')).toHaveLength(6)
  expect(applyFilter(steps, 'commands').map(step => step.id)).toEqual(['b1'])
  expect(applyFilter(steps, 'edits').map(step => step.id)).toEqual(['e1'])
  expect(applyFilter(steps, 'errors').map(step => step.id)).toEqual(['b1'])
  expect(applyFilter(steps, 'unknown')).toHaveLength(9)
})

test('diffs, clipping, durations and the scrubber', () => {
  expect(diffOf('', 'a\nb')).toBe('@@ -1,0 +1,2 @@\n+a\n+b')
  expect(clip('x'.repeat(100), 40)).toBe(`${'x'.repeat(24)}\n… 62 characters left out …\n${'x'.repeat(14)}`)
  expect([duration(850), duration(2_340), duration(245_000)]).toEqual(['850 ms', '2.3 s', '4 min 05 s'])
  expect(scrubber(0, 5, 9)).toEqual({ played: '', head: '●', rest: '────────' })
  expect(scrubber(4, 5, 9)).toEqual({ played: '━━━━━━━━', head: '●', rest: '' })
  expect(scrubber(2, 5, 9)).toEqual({ played: '━━━━', head: '●', rest: '────' })
})

test('the export is Markdown with a section per step and safe code fences', () => {
  const markdown = exportMarkdown(buildTimeline(MESSAGES, RECORDS, ROOT), 'Session replay')
  expect(markdown).toStartWith('# Session replay\n\n9 steps · 1 prompts · 6 tool calls · 1 edits\n\n## 1. 💬 Fix the failing cart test\n\n*Prompt · 14:03:21*\n\nFix the failing cart test\nIt broke yesterday.')
  expect(markdown).toContain('## 3. $ $ npm test -- cart\n\n*Command · 14:03:26 · 2.3 s · ✗ failed*\n\n```bash\nnpm test -- cart\n```\n\nError:\n\n```\nFAIL src/cart.test.ts')
  expect(markdown).toContain('```diff\n@@ -1,1 +1,1 @@')
  const fenced = exportMarkdown([{ id: 'x', kind: 'command', title: 'echo', body: 'echo ```', format: 'code', language: 'bash' }], 'T')
  expect(fenced).toContain('````bash\necho ```\n````')
})
