import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { catalogSection, factOf, levenshtein, parseComponents, similarComponents } from '../hooks/catalog'
import { fakeHub } from './hub'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const ROOT = '/work/shop'
const BUTTON = [
  "import React from 'react'",
  '',
  'export interface ButtonProps {',
  '  /** Visual style */',
  "  variant?: 'primary' | 'ghost'",
  '  onClick?: () => void',
  '  children: React.ReactNode',
  '}',
  '',
  '/** Primary action button. Use it in forms and dialogs. */',
  "export function Button({ variant = 'primary', onClick, children }: ButtonProps) {",
  '  return <button className={variant} onClick={onClick}>{children}</button>',
  '}',
].join('\n')
const USER_CARD = [
  '// Shows a user with avatar and name.',
  'export const UserCard = ({ user, compact }: { user: User; compact?: boolean }) => <div>{user.name}</div>',
].join('\n')
const AVATAR_VUE = [
  '<!-- Round avatar with initials fallback -->',
  '<template><img :src="src" /></template>',
  '<script setup lang="ts">',
  'defineProps<{ src?: string; size: number }>()',
  '</script>',
].join('\n')
const FILES: Record<string, string> = {
  'src/components/Button.tsx': BUTTON,
  'src/components/Button.test.tsx': 'export function ButtonTest() { return <div /> }',
  'src/components/users/UserCard.tsx': USER_CARD,
  'src/components/Avatar.vue': AVATAR_VUE,
  'src/lib/format.ts': 'export function Format() { return 1 }',
}
const COMPOSE = { model: 'claude', promptModel: 'claude', surfaces: ['terminal'] as const, tools: [], outputStyle: null, traits: [] }
const PANE = {
  plugin: 'component-catalog',
  component: 'Pane',
  requestId: 'components',
  props: { title: 'Components', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const components = (args = '') =>
  ({ command: 'components', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

type World = { files: Map<string, string>; toasts: string[]; filled: string[] }

/** A project on a virtual disk; Write and Edit change it as the tools would. */
const world = (on: On): World => {
  const state: World = { files: new Map(Object.entries(FILES).map(([path, text]) => [`${ROOT}/${path}`, text])), toasts: [], filled: [] }
  const isDir = (path: string) => [...state.files.keys()].some(file => file.startsWith(`${path}/`))
  startClock = mock.clock(on, { now: 1_000_000 })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) => {
    if (isDir(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    const text = state.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', ($, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const file of state.files.keys()) {
      if (!file.startsWith(`${e.path}/`)) continue
      const [name = '', ...rest] = file.slice(e.path.length + 1).split('/')
      names.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? 100 : 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    const text = state.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: state.files.has(e.path) || isDir(e.path) }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Write') state.files.set(e.file_path, e.content)
    if (e.tool === 'Edit') state.files.set(e.file_path, (state.files.get(e.file_path) ?? '').replace(e.old_string, e.new_string))
    return { result: { type: 'create' } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.fill', ($, e) => {
    state.filled.push(e.text)
    return { isFilled: true }
  })
  return state
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(components('rescan'))
}

test('parses React, Vue and Svelte components with props and purpose; names near-misses', () => {
  const [button] = parseComponents('src/components/Button.tsx', BUTTON)
  expect(button?.name).toBe('Button')
  expect(button?.purpose).toBe('Primary action button.')
  expect(button?.props).toEqual([
    { name: 'variant', type: "'primary' | 'ghost'", isOptional: true },
    { name: 'onClick', type: '() => void', isOptional: true },
    { name: 'children', type: 'React.ReactNode' },
  ])
  expect(parseComponents('src/components/users/UserCard.tsx', USER_CARD)[0]?.purpose).toBe('Shows a user with avatar and name.')
  const avatar = parseComponents('src/components/Avatar.vue', AVATAR_VUE)[0]
  expect(avatar?.props.map(prop => prop.name)).toEqual(['src', 'size'])
  expect(avatar?.purpose).toBe('Round avatar with initials fallback')
  const toggle = parseComponents('src/lib/components/toggle-switch.svelte', '<script>export let checked = false\nexport let label</script>')[0]
  expect(toggle?.name).toBe('ToggleSwitch')
  expect(toggle?.props).toEqual([{ name: 'checked', isOptional: true }, { name: 'label' }])
  const forward = 'interface InputProps { value: string }\nexport const Input = React.forwardRef<HTMLInputElement, InputProps>((props, ref) => <input ref={ref} />)'
  expect(parseComponents('ui/Input.tsx', forward)[0]?.props).toEqual([{ name: 'value', type: 'string' }])
  expect(parseComponents('ui/hooks.ts', 'export const useCart = () => 1\nexport function Format() { return 1 }')).toEqual([])

  expect(levenshtein('UserCards', 'usercard')).toBe(1)
  const catalog = parseComponents('src/components/users/UserCard.tsx', USER_CARD)
  expect(similarComponents('UserCards', 'src/components/UserCards.tsx', catalog).map(c => c.name)).toEqual(['UserCard'])
  expect(similarComponents('UserList', 'src/components/UserList.tsx', catalog)).toEqual([])
  expect(similarComponents('UserCard', 'src/components/users/UserCard.tsx', catalog)).toEqual([])

  const many = Array.from({ length: 60 }, (_, i) => ({ ...catalog[0]!, name: `Widget${i}`, path: `ui/Widget${i}.tsx` }))
  const section = catalogSection(many, ['ui'], 1200) ?? ''
  expect(section.length).toBeLessThanOrEqual(1200)
  expect(section).toContain('# Existing UI components')
  expect(section).toMatch(/…and \d+ more \(run \/components to see all\)\.$/)
})

test('scans the component folders at session start and tells Claude about them', async ($, on) => {
  world(on)
  await start($)
  const composed = await $.prompt.compose(COMPOSE)
  const section = composed.sections.find(one => one.id === 'component-catalog:components')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('- Button (src/components/Button.tsx): Primary action button. · props: variant?, onClick?, children')
  expect(section?.text).toContain('- UserCard (src/components/users/UserCard.tsx)')
  expect(section?.text).toContain('- Avatar (src/components/Avatar.vue)')
  expect(section?.text).not.toContain('ButtonTest')
  expect(section?.text).not.toContain('Format')
  expect(composed.sections[0]?.id).toBe('intro')
})

test('the prompt section can be turned off', { options: { promptChars: 0 } }, async ($, on) => {
  world(on)
  await start($)
  const composed = await $.prompt.compose(COMPOSE)
  expect(composed.sections.map(one => one.id)).toEqual(['intro'])
})

test('writing a near-duplicate component warns Claude and you; a distinct one does not', async ($, on) => {
  const state = world(on)
  await start($)
  const duplicate = await $.tool.call({
    tool: 'Write',
    file_path: `${ROOT}/src/components/UserCards.tsx`,
    content: 'export function UserCards({ user }: { user: User }) { return <div /> }',
  })
  expect(duplicate.context?.[0]).toContain('UserCards (src/components/UserCards.tsx) ≈ UserCard (src/components/users/UserCard.tsx)')
  expect(duplicate.context?.[0]).toContain('reuse or extend the existing component')
  expect(state.toasts[0]).toBe('UserCards looks like the existing UserCard (src/components/users/UserCard.tsx)')

  const distinct = await $.tool.call({
    tool: 'Write',
    file_path: `${ROOT}/src/components/PriceTag.tsx`,
    content: 'export const PriceTag = ({ amount }: { amount: number }) => <span>{amount}</span>',
  })
  expect(distinct.context).toBeUndefined()

  // Both new files join the catalog, and Claude sees them from the next turn on.
  await $.turn.start({ text: 'next', turnId: 't2' })
  const section = (await $.prompt.compose(COMPOSE)).sections.find(one => one.id === 'component-catalog:components')
  expect(section?.text).toContain('- PriceTag (src/components/PriceTag.tsx) · props: amount')
  expect(section?.text).toContain('- UserCards (src/components/UserCards.tsx)')
})

test('similarity warnings can be turned off', { options: { warnSimilar: false } }, async ($, on) => {
  const state = world(on)
  await start($)
  const written = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/components/Buttons.tsx`, content: 'export function Buttons() { return <div /> }' })
  expect(written.context).toBeUndefined()
  expect(state.toasts).toEqual([])
})

test('/components opens a searchable pane on terminal and desktop; mention puts a component in the prompt', async ($, on) => {
  const state = world(on)
  await start($)
  const opened = await $.command.run(components())
  expect(opened.text).toBe('3 components in src/components.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Button' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: "props: variant?: 'primary' | 'ghost', onClick?: () => void, children: React.ReactNode" })).toBeDefined()
    await ui.input({ key: 'search', text: 'size' })
    expect(await ui.find({ type: 'Text', text: '1 of 3 match "size"' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Button' })).toBeUndefined()
    await ui.press({ key: 'mention:src/components/Avatar.vue#Avatar' })
    await ui.input({ key: 'search', text: '' })
    await ui.unmount()
  }
  expect(state.filled).toEqual([
    'the existing Avatar component (src/components/Avatar.vue) ',
    'the existing Avatar component (src/components/Avatar.vue) ',
  ])
  const searched = await $.command.run(components('user'))
  expect(searched.text).toContain('1 match "user"')
})

test('with mods-hub: says hello and shares the catalog as the fact component-catalog.components, kept current as components are written', async ($, on) => {
  const hub = fakeHub(on)
  world(on)
  await start($)
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])
  expect(hub.facts.get('components')).toEqual({
    count: 3,
    dirs: ['src/components'],
    isCut: false,
    components: [
      { name: 'Avatar', path: 'src/components/Avatar.vue', props: 2 },
      { name: 'Button', path: 'src/components/Button.tsx', props: 3 },
      { name: 'UserCard', path: 'src/components/users/UserCard.tsx', props: 2 },
    ],
  })

  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/components/Badge.tsx`, content: 'export const Badge = ({ label }: { label: string }) => <span>{label}</span>' })
  expect((hub.facts.get('components') as { count: number }).count).toBe(4)
})

test('the shared fact is cut to the hub\'s size limit', () => {
  const many = Array.from({ length: 500 }, (_, index) => ({ name: `Component${index}`, path: `src/components/Component${index}.tsx`, purpose: '', props: [], framework: 'react' as const }))
  const fact = factOf({ components: many, dirs: ['src/components'], isCut: false }, 2_000)
  expect(fact.count).toBe(500)
  expect(fact.isCut).toBe(true)
  expect(fact.components.length).toBeLessThan(500)
  expect(JSON.stringify(fact).length).toBeLessThanOrEqual(2_000)
})
