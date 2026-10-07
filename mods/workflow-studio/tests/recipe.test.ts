import { expect, test } from 'claude-code/testing'

import { BUILTIN_RECIPES } from '../hooks/builtins'
import {
  fill,
  fromAutopilot,
  fromRoute,
  markShadowed,
  parseArgs,
  parsePairs,
  readRecipe,
  recipeText,
  resolveParams,
  runPrompt,
  search,
  slugify,
  stagesOf,
  validateRecipe,
  DEFAULT_MODELS,
} from '../hooks/recipe'
import { parseYaml, stringifyYaml } from '../hooks/yaml'
import type { Recipe, RecipeEntry } from '../types'

const BUILTINS = { project: 'shop', date: '2026-10-07', branch: 'main' }

const RELEASE = `# Our release recipe
name: release
description: Ship {{version}}.
mode: parallel
params:
  - name: version
    required: true
  - name: channel
    default: stable
    options: [stable, beta]
steps:
  - title: Changelog
    tier: standard
    group: prep
    prompt: |
      Write the {{version}} changelog.
      Group it by kind.
  - title: Bump
    tier: light
    group: prep
    prompt: Bump to {{version}} on {{channel}}   # trailing comment
  - Tag v{{version}}
checks:
  - name: Tests
    command: npm test
  - make lint
`

test('reads the YAML people write, and writes YAML it reads back the same', () => {
  const parsed = parseYaml(RELEASE) as Record<string, unknown>
  expect(parsed.name).toBe('release')
  expect((parsed.steps as Record<string, unknown>[])[0]?.prompt).toBe('Write the {{version}} changelog.\nGroup it by kind.\n')
  expect((parsed.steps as Record<string, unknown>[])[1]?.prompt).toBe('Bump to {{version}} on {{channel}}')
  expect((parsed.params as Record<string, unknown>[])[1]?.options).toEqual(['stable', 'beta'])
  expect(parsed.checks).toEqual([{ name: 'Tests', command: 'npm test' }, 'make lint'])

  const compact = parseYaml('steps:\n- a\n- b: 1\n  c: "x: y"\nfolded: >\n  one\n  two\n\n  three\nn: 3\nflag: yes\nempty: ""\n')
  expect(compact).toEqual({ steps: ['a', { b: 1, c: 'x: y' }], folded: 'one two\nthree\n', n: 3, flag: 'yes', empty: '' })

  const tricky = { name: 'x', list: ['- dash', 'a: b', '#hash', 'true', '12', '', 'multi\nline\n', '  indented\nblock'], nested: [{ a: 'b', c: ['d'] }, []], empty: {}, n: 1.5, ok: false, none: null }
  expect(parseYaml(stringifyYaml(tricky))).toEqual(tricky)

  expect(() => parseYaml('name: a\n  bad: indent\n')).toThrow('line 2')
  expect(() => parseYaml('a: 1\na: 2\n')).toThrow('"a" appears twice')
  expect(() => parseYaml('a: &anchor 1\n')).toThrow('anchors')
  expect(() => parseYaml('a:\n\t- tab\n')).toThrow('tabs')
  expect(() => parseYaml('a: "open\n')).toThrow('not closed')
})

test('all six built-in recipes are valid and survive a save', () => {
  expect(Object.keys(BUILTIN_RECIPES)).toEqual(['release', 'dependency-update', 'security-audit', 'flaky-test-hunt', 'onboarding-docs', 'perf-pass'])
  for (const [name, text] of Object.entries(BUILTIN_RECIPES)) {
    const { recipe, errors } = readRecipe(text, `${name}.yaml`)
    expect(errors).toEqual([])
    expect(recipe?.name).toBe(name)
    expect(readRecipe(recipeText(recipe as Recipe), `${name}.yaml`).recipe).toEqual(recipe)
  }
  expect(readRecipe(BUILTIN_RECIPES['security-audit'] ?? '', 'x.yaml').recipe?.mode).toBe('workflow')
})

test('schema errors are friendly: every problem, its field, and a hint', () => {
  const { recipe, errors } = validateRecipe({
    name: 'My Release',
    mode: 'turbo',
    stpes: [],
    params: [{ name: 'version' }, { name: 'version' }, { name: 'kind', default: 'huge', options: ['patch', 'minor'] }],
    steps: [{ title: 'Bump', prompt: 'Bump to {{versoin}}', tier: 'expert' }, { title: 'Empty' }, { prompt: 'a', group: 'g' }, { prompt: 'b' }, { prompt: 'c', group: 'g' }],
    checks: [{ name: 'no command' }],
  })
  expect(recipe).toBeNull()
  expect(errors).toEqual([
    'stpes: unknown field — did you mean "steps"?',
    'name: "My Release" must be 2–40 lowercase letters, digits and dashes (try "my-release")',
    'description: required (one or two sentences: what the recipe does)',
    'mode: "turbo" is not one of inline, parallel, workflow',
    'params[2].name: "version" is declared twice',
    'params[3].default: "huge" is not one of its options (patch, minor)',
    'steps[1].tier: "expert" is not one of light, standard, deep',
    'steps[2].prompt: required (what Claude or the step\'s agent should do)',
    'checks[1].command: required (a shell command that exits 0 when all is well)',
    'steps[1].prompt: {{versoin}} is not a param (params: version, kind)',
    'steps: the steps of group "g" must be next to each other',
  ])
  expect(validateRecipe(['a']).errors[0]).toContain('must be a mapping')
  expect(readRecipe('name: x\n  y: 1', 'x.yaml').errors[0]).toMatch(/^YAML line 2: /)
  expect(readRecipe('{"name": ', 'x.json').errors[0]).toContain('not valid JSON')
  expect(readRecipe('{"name":"ok-json","description":"d","steps":["do it"]}', 'ok-json.json').recipe?.steps).toEqual([{ title: 'do it', prompt: 'do it' }])
})

test('fills params: given, default, required, options; {{builtins}} are always there', () => {
  const recipe = readRecipe(RELEASE, 'release.yaml').recipe as Recipe
  expect(resolveParams(recipe, { version: '2.0.0' }, BUILTINS)).toEqual({ values: { ...BUILTINS, version: '2.0.0', channel: 'stable' }, problems: [] })
  expect(resolveParams(recipe, {}, BUILTINS).problems).toEqual(['version is required: version=…'])
  expect(resolveParams(recipe, { version: '2', channel: 'nightly', colour: 'red' }, BUILTINS).problems).toEqual([
    '"colour" is not a param of release (params: version, channel)',
    'channel must be one of stable, beta (got "nightly")',
  ])
  expect(fill('v{{ version }} on {{date}} {{unknown}}', { version: '2', date: 'today' })).toBe('v2 on today {{unknown}}')
  expect(parsePairs(`version=1.2 notes="big one" tag='x y' loose`)).toEqual({ values: { version: '1.2', notes: 'big one', tag: 'x y' }, rest: ['loose'] })
  expect(parseArgs('run release version=1.2 --personal')).toMatchObject({ kind: 'run', name: 'release', values: { version: '1.2' } })
  expect(parseArgs('release version=1.2')).toMatchObject({ kind: 'run', name: 'release', values: { version: '1.2' } })
  expect(parseArgs('save my-flow --from route --personal')).toEqual({ kind: 'save', name: 'my-flow', from: 'route', isPersonal: true })
  expect(parseArgs('copy release')).toEqual({ kind: 'copy', name: 'release', isPersonal: false })
})

test('builds the run prompt for each mode: inline steps, parallel stages with models, a workflow opt-in', () => {
  const recipe = readRecipe(RELEASE, 'release.yaml').recipe as Recipe
  const values = resolveParams(recipe, { version: '2.0.0' }, BUILTINS).values
  expect(stagesOf(recipe.steps)).toEqual([[0, 1], [2]])

  const parallel = runPrompt(recipe, { values, models: DEFAULT_MODELS, marker: '[workflow-studio run abc]' })
  expect(parallel).toContain('Run the recipe "release" (workflow-studio · release).')
  expect(parallel).toContain('Parameters: version = 2.0.0, channel = stable')
  expect(parallel).toContain('Stage 1 — 2 in parallel:')
  expect(parallel).toContain('  1. Changelog — standard, model: sonnet\n     Write the 2.0.0 changelog.\n     Group it by kind.')
  expect(parallel).toContain('  2. Bump — light, model: haiku')
  expect(parallel).toContain('Stage 2 (after stage 1):\n  3. Tag v2.0.0 — standard, model: sonnet')
  expect(parallel).toContain('send all their Agent calls in ONE message')
  expect(parallel).not.toContain('Workflow tool')
  expect(parallel).toContain('- Tests: `npm test`')
  expect(parallel.endsWith('[workflow-studio run abc]')).toBe(true)

  const inline = runPrompt({ ...recipe, mode: 'inline' }, { values, models: DEFAULT_MODELS, marker: 'm' })
  expect(inline).toContain('Do these steps yourself, in order')
  expect(inline).toContain('  2. Bump (light)')
  expect(inline).not.toContain('Stage 1')

  const workflow = runPrompt({ ...recipe, mode: 'workflow' }, { values, models: { ...DEFAULT_MODELS, deep: 'fable' }, marker: 'm' })
  expect(workflow).toContain('I explicitly opt in: run this recipe as a workflow with the Workflow tool')
  expect(workflow).toContain('parallel() for the steps of one stage')
})

test('turns autopilot and /route plans into recipes; lists, shadows and searches', () => {
  const fromPilot = fromAutopilot({ goal: 'Make the cart total include VAT', steps: ['Find the total', 'Add VAT'], checks: [{ name: 'Tests pass', command: 'npm test' }] }, slugify('Make the cart total include VAT'))
  expect(fromPilot.name).toBe('make-the-cart-total-include-vat')
  expect(validateRecipe(parseYaml(recipeText(fromPilot))).errors).toEqual([])
  expect(fromPilot.checks).toEqual([{ name: 'Tests pass', command: 'npm test' }])

  const routed = fromRoute(
    { task: 'Add dark mode', mode: 'parallel', subtasks: [{ title: 'Find colours', tier: 'light', prompt: 'grep colours' }, { title: 'Theme tokens', tier: 'standard', prompt: 'add tokens' }, { title: 'Verify', tier: 'light', prompt: 'run tests' }], stages: [[0, 1], [2]] },
    'dark-mode',
  )
  expect(routed.mode).toBe('parallel')
  expect(routed.steps.map(step => step.group ?? '-')).toEqual(['stage-1', 'stage-1', '-'])
  expect(validateRecipe(parseYaml(recipeText(routed))).recipe).toEqual(routed)

  const entry = (name: string, source: RecipeEntry['source']): RecipeEntry => ({ name, source, path: `/${source}/${name}.yaml`, recipe: { ...fromPilot, name, description: `${name} job` }, errors: [], isShadowed: false })
  const marked = markShadowed([entry('release', 'builtin'), entry('release', 'project'), entry('audit', 'personal')])
  expect(marked.map(one => `${one.name}:${one.source}:${one.isShadowed}`)).toEqual(['audit:personal:false', 'release:project:false', 'release:builtin:true'])
  expect(search(marked, 'rele job').map(one => one.source)).toEqual(['project', 'builtin'])
})
