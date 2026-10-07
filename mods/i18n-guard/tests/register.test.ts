import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findHardCoded } from '../hooks/scan'

const BUTTON = '/repo/src/Button.tsx'

// Stands for the engine: files that already exist (read by path), and every tool call that reaches it.
const engine = (on: On, files: Record<string, string> = {}) => {
  const ran: string[] = []
  const toasts: string[] = []
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('tool.call', (_$, e) => {
    ran.push(e.tool)
    return { result: 'ok', text: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { ran, toasts }
}

test('warn mode lets the edit through and tells Claude what to fix', async ($, on) => {
  const { ran, toasts } = engine(on)

  const result = await $.tool.call({
    tool: 'Edit',
    file_path: BUTTON,
    old_string: '  return <button onClick={save}>{t("save")}</button>',
    new_string: '  return <button title="Save the form" onClick={save}>Save changes</button>',
  })

  expect(ran).toEqual(['Edit'])
  expect(toasts).toEqual(['2 hard-coded strings in Button.tsx'])
  expect(result.context?.[0]).toContain('title="Save the form", "Save changes"')
})

test('block mode refuses the edit and says how to fix it', { options: { mode: 'block', attributes: 'title,placeholder,aria-label,alt' } }, async ($, on) => {
  const { ran } = engine(on)

  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/Search.tsx',
    content: 'export const Search = () => <input placeholder="Search products" aria-label={t("search")} />\n',
  })

  expect(ran).toHaveLength(0)
  expect(result.deny).toContain('i18n-guard: hard-coded user-facing strings in Search.tsx: placeholder="Search products"')
  expect(result.deny).toContain("t('key')")
})

test('translated strings, expressions and code literals are fine', async ($, on) => {
  const { ran, toasts } = engine(on)

  await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/Card.tsx',
    content: [
      "import { t } from './i18n'",
      'const kind: Array<string> = ["a", "b"]',
      'export const Card = ({ name, count }: Props) => (',
      '  <section className="card" title={t("card.title")} alt="">',
      '    <h1>{t("card.heading")}</h1>',
      '    <p>{name}</p>',
      '    <span>{count > 1 && "·"}</span>',
      '    <img alt={t("card.logo")} src="/logo.png" />',
      '    &nbsp;|&nbsp; 42',
      '  </section>',
      ')',
      'const first = <T,>(items: T[]) => items[0]',
      'if (count < 2 && name > "a") console.log("done")',
    ].join('\n'),
  })

  expect(ran).toEqual(['Write'])
  expect(toasts).toHaveLength(0)
})

test('finds text next to expressions, nested elements and literal expression children', async ($, on) => {
  const { toasts } = engine(on)

  const result = await $.tool.call({
    tool: 'Write',
    file_path: BUTTON,
    content: [
      'export const Row = ({ n, ok }: Props) => (',
      '  <li>',
      '    Hello {n}, welcome back',
      "    {ok && <b>Don't panic</b>}",
      '    {"Plain literal"}',
      '    <Field label="Name" title="Your name" />',
      '  </li>',
      ')',
    ].join('\n'),
  })

  expect(toasts).toEqual(['5 hard-coded strings in Button.tsx'])
  expect(result.context?.[0]).toContain('"Hello", "welcome back", "Don\'t panic", "Plain literal", title="Your name"')
})

test('only strings an edit adds are reported, not the ones already there', async ($, on) => {
  const { toasts } = engine(on)

  await $.tool.call({
    tool: 'Edit',
    file_path: BUTTON,
    old_string: '<h1 className="a">Welcome</h1>',
    new_string: '<h1 className="b">Welcome</h1>',
  })
  expect(toasts).toHaveLength(0)

  await $.tool.call({
    tool: 'Edit',
    file_path: BUTTON,
    old_string: '<h1>Welcome</h1>',
    new_string: '<h1>Welcome back</h1>',
  })
  expect(toasts).toHaveLength(1)
})

test('a Write over an existing file only counts what is new', async ($, on) => {
  const { toasts } = engine(on, { [BUTTON]: 'export const A = () => <p>Old text</p>\n' })

  await $.tool.call({ tool: 'Write', file_path: BUTTON, content: 'export const A = () => <p>Old text</p>\n' })
  expect(toasts).toHaveLength(0)

  await $.tool.call({ tool: 'Write', file_path: BUTTON, content: 'export const A = () => <p>Old text</p>\nexport const B = () => <p>New text</p>\n' })
  expect(toasts).toHaveLength(1)
})

test('reads Vue templates and Svelte markup, and skips their script blocks', async ($, on) => {
  const { toasts } = engine(on)

  const vue = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/Login.vue',
    content: [
      '<template>',
      '  <form>',
      '    <label>Email</label>',
      '    <input placeholder="you@example.com" :aria-label="$t(\'login.email\')" :title="\'Enter your email\'" />',
      '    <button>{{ $t("login.go") }}</button>',
      '  </form>',
      '</template>',
      '<script setup>',
      'const greeting = "Hello there"',
      '</script>',
    ].join('\n'),
  })
  expect(vue.context?.[0]).toContain('"Email", placeholder="you@example.com", title="Enter your email"')
  expect(vue.context?.[0]).not.toContain('Hello there')

  const svelte = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/Hero.svelte',
    content: ['<script>', '  let name = "world"', '</script>', '<h1 title={t("hero")}>Hello {name}</h1>', '<img alt="Team photo" src="/t.png">'].join('\n'),
  })
  expect(svelte.context?.[0]).toContain('"Hello", alt="Team photo"')
  expect(toasts).toHaveLength(2)
})

test('ignores other file types, test files and unrelated attributes', async ($, on) => {
  const { toasts } = engine(on)

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/util.ts', content: 'export const label = "Hello world"\n' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/Button.test.tsx', content: 'render(<button>Save</button>)\n' })
  await $.tool.call({ tool: 'Write', file_path: BUTTON, content: 'export const A = () => <div className="Big card" data-testid="main" />\n' })

  expect(toasts).toHaveLength(0)
})

test('the attributes to check can be changed', { options: { mode: 'warn', attributes: 'tooltip, label' } }, async ($, on) => {
  const { toasts } = engine(on)

  await $.tool.call({ tool: 'Write', file_path: BUTTON, content: 'export const A = () => <Icon tooltip="Delete" title="Ignored now" />\n' })

  expect(toasts).toEqual(['1 hard-coded string in Button.tsx'])
})

test('a large file full of generics and comparisons scans in linear time', async () => {
  const line = 'const m: Map<string, Array<number>> = new Map<string, Array<number>>(); if (a < b) return <p title="Hi">x</p>\n'
  const source = line.repeat(2000)
  const startedAt = performance.now()
  const found = findHardCoded(source, 'jsx', new Set(['title']), true)
  expect(performance.now() - startedAt).toBeLessThan(500)
  expect(found).toHaveLength(4000)
})
