import { expect, test } from 'claude-code/testing'

import { batchTiny, buildPlan, forecastOf, parseSubtasks, planText, runPrompt, stagesOf, workflowPrompt, writesOverlap } from '../hooks/plan'
import type { PlanOptions } from '../hooks/plan'
import type { SmartRouterSubtask } from '../types'

const MODELS = { light: 'haiku', standard: 'sonnet', deep: 'opus' }
const OPTIONS: PlanOptions = { workflowThreshold: 6, maxParallel: 5, models: MODELS, mainModel: 'claude-opus-5-5', isFallback: false, now: 0 }
const task = (title: string, tier: SmartRouterSubtask['tier'], dependsOn: number[] = [], writes: string[] = [], prompt = `${title}, as described.`): SmartRouterSubtask => ({ title, tier, prompt, dependsOn, writes })

test('a tiny edit runs inline; a broad search goes to one light agent', () => {
  const edit = buildPlan('Fix the typo in the footer', [task('Fix footer typo', 'light', [], ['src/Footer.tsx'], 'Fix the typo "Recieve" in src/Footer.tsx.')], OPTIONS)
  expect(edit.mode).toBe('inline')
  expect(edit.isWorkflowEligible).toBe(false)
  expect(runPrompt(edit, MODELS)).toBe('Fix the typo in the footer')

  const search = buildPlan('Where is auth handled?', [task('Map auth code', 'light', [], [], 'Find every place the codebase checks authentication and list the files with a one-line summary each.')], OPTIONS)
  expect(search.mode).toBe('single')
  expect(runPrompt(search, MODELS)).toContain('one subagent with model: haiku')
})

test('four independent modules run as parallel subagents in one message', () => {
  const plan = buildPlan('Add input validation to four forms', ['Signup', 'Login', 'Profile', 'Billing'].map(name => task(`Validate ${name} form`, 'standard', [], [`src/forms/${name}.tsx`])), OPTIONS)
  expect(plan.mode).toBe('parallel')
  expect(plan.stages).toEqual([[0, 1, 2, 3]])
  expect(plan.reason).toBe('4 independent subtasks: launch them as parallel subagents in one message.')
  const prompt = runPrompt(plan, MODELS)
  expect(prompt).toContain('Stage 1 — 4 in parallel:')
  expect(prompt).toContain('model: sonnet')
  expect(prompt).toContain('send all their Agent calls in ONE message')
  expect(prompt).toContain('same shared context block')
})

test('an 8-step pipeline with dependencies is offered as a workflow, never started on its own', () => {
  const subtasks = [
    task('Map the API', 'light'),
    task('Map the UI', 'light'),
    task('Design the schema', 'deep', [0, 1]),
    task('Migrate the server', 'standard', [2], ['server/']),
    task('Migrate the client', 'standard', [2], ['client/']),
    task('Update the tests', 'standard', [3, 4], ['tests/']),
    task('Run the suite', 'light', [5]),
    task('Merge the results', 'deep', [6]),
  ]
  const plan = buildPlan('Move the app to the new schema', subtasks, OPTIONS)
  expect(plan.mode).toBe('workflow')
  expect(plan.isWorkflowEligible).toBe(true)
  expect(plan.stages).toEqual([[0, 1], [2], [3, 4], [5], [6], [7]])
  expect(plan.reason).toContain('8 subtasks (3 haiku · 3 sonnet · 2 opus)')
  expect(plan.reason).toContain('explicit OK')
  expect(workflowPrompt(plan, MODELS)).toMatch(/^I explicitly opt in: run this plan as a workflow with the Workflow tool/)
  expect(runPrompt(plan, MODELS)).not.toContain('Workflow tool')
})

test('a short pipeline with a fan-out is workflow-eligible; a plain chain runs in order', () => {
  const fanOut = buildPlan('t', [task('A', 'light'), task('B', 'standard', [0]), task('C', 'standard', [0]), task('D', 'deep', [1, 2])], OPTIONS)
  expect(fanOut.isWorkflowEligible).toBe(true)
  const chain = buildPlan('t', [task('A', 'standard'), task('B', 'standard', [0]), task('C', 'standard', [1])], OPTIONS)
  expect(chain.mode).toBe('sequential')
  expect(chain.isWorkflowEligible).toBe(false)
})

test('overlapping writes are serialized; big stages are batched by maxParallel', () => {
  const plan = buildPlan('t', [task('Add route', 'standard', [], ['src/routes.ts']), task('Add other route', 'standard', [], ['src/routes.ts']), task('Docs', 'standard', [], ['docs/'])], OPTIONS)
  expect(plan.stages).toEqual([[0, 2], [1]])
  expect(plan.notes[0]).toContain('change the same files: run in order (or give them isolation: "worktree")')
  expect(writesOverlap(['src/'], ['src/a.ts'])).toBe(true)
  expect(writesOverlap(['src/a.ts'], ['src/ab.ts'])).toBe(false)
  const wide = stagesOf(Array.from({ length: 7 }, (_, at) => task(`Module ${at}`, 'standard', [], [`m${at}/`])), 3)
  expect(wide.stages).toEqual([[0, 1, 2], [3, 4, 5], [6]])
  expect(wide.batched).toEqual([0])
})

test('many tiny light chores of one kind become one batched agent', () => {
  const renames = Array.from({ length: 5 }, (_, at) => task(`Rename var ${at}`, 'light', [], [`src/f${at}.ts`], `Rename the variable tmp${at} to buffer${at} in src/f${at}.ts.`))
  const { subtasks, merged } = batchTiny([...renames, task('Write tests', 'standard', [], ['tests/'])])
  expect(merged).toBe(5)
  expect(subtasks).toHaveLength(2)
  expect(subtasks[0]?.prompt).toContain('Do these 5 small tasks one after another')
  expect(subtasks[0]?.writes).toHaveLength(5)
  const plan = buildPlan('Rename and test', [...renames, task('Write tests', 'standard', [], ['tests/'])], OPTIONS)
  expect(plan.notes).toContain('5 tiny light chores of one kind are batched into one agent.')
})

test('forecasts inline, subagents and workflow by tier prices', () => {
  const forecast = forecastOf([task('A', 'light'), task('B', 'light'), task('C', 'standard')], MODELS, 'claude-opus-5-5')
  expect(forecast.parallel.usd).toBeLessThan(forecast.inline.usd)
  expect(forecast.workflow.usd).toBeGreaterThan(forecast.parallel.usd)
  expect(forecast.parallel.tokens).toBeGreaterThan(0)
  const onMain = forecastOf([task('A', 'deep')], { ...MODELS, deep: 'inherit' }, 'claude-opus-5-5')
  expect(onMain.parallel.usd).toBeGreaterThan(0)
})

test('reads the planner JSON, fenced or bare; dependencies by number or title; tiers by word or alias', () => {
  const reply = 'Here:\n```json\n[{"title":"Scan","tier":"haiku","prompt":"List the endpoints.","dependsOn":[],"writes":[]},{"title":"Fix","tier":"weird","prompt":"Fix the 404 bug in routes.ts","dependsOn":["Scan", 9, 2],"writes":["src/routes.ts"]}]\n```'
  const subtasks = parseSubtasks(reply, (title, prompt, proposed) => proposed ?? 'standard')
  expect(subtasks).toEqual([
    { title: 'Scan', tier: 'light', prompt: 'List the endpoints.', dependsOn: [], writes: [] },
    { title: 'Fix', tier: 'standard', prompt: 'Fix the 404 bug in routes.ts', dependsOn: [0], writes: ['src/routes.ts'] },
  ])
  expect(parseSubtasks('{"subtasks":[{"prompt":"Do it"}]}', () => 'light')?.[0]?.title).toBe('Do it')
  expect(parseSubtasks('I cannot help with that.', () => 'light')).toBeUndefined()
  const cyclic = stagesOf([task('A', 'light', [1]), task('B', 'light', [0])], 5)
  expect(cyclic.stages.flat().sort()).toEqual([0, 1])
  expect(planText(buildPlan('t', [task('Only', 'deep')], OPTIONS), MODELS)).toContain('1. Only — deep, model: opus')
})
