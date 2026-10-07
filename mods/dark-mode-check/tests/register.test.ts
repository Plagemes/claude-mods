import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseColor } from '../hooks/color'
import { baseSelector, findStyleFindings, parseRules } from '../hooks/stylesheet'
import { findClassFindings } from '../hooks/tailwind'

const ROOT = '/app'
const DARK_TAILWIND = { [`${ROOT}/tailwind.config.ts`]: "export default { darkMode: 'class', content: ['./src/**/*.tsx'] }" }

/** A project on a virtual disk, with a clock, the toasts and a tool that reaches the engine. */
const project = (on: On, files: Record<string, string>) => {
  mock.clock(on, { now: 1_000_000 })
  const toasts: string[] = []
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.list', (_$, e) => {
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const names = Object.keys(files).filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return names.length === 0 ? { deny: 'ENOENT' } : { value: names.map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: files[path]?.length ?? 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] ?? '' }))
  on('fs.stat', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: files[e.path]?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

const write = ($: Engine, file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content })
const edit = ($: Engine, file_path: string, old_string: string, new_string: string) => $.tool.call({ tool: 'Edit', file_path, old_string, new_string })
const noteOf = (result: { context?: readonly string[] }): string => result.context?.[0] ?? ''
const texts = (source: string): string[] => findClassFindings(source).map(finding => finding.text)

test('light Tailwind colors without a dark variant are reported with the dark classes to add', async ($, on) => {
  const toasts = project(on, DARK_TAILWIND)

  const result = await write($, `${ROOT}/src/Card.tsx`, 'export const Card = () => (\n  <div className="bg-white text-gray-900 border border-gray-200 p-4 text-sm">\n    hi\n  </div>\n)\n')

  const note = noteOf(result)
  expect(note).toContain('dark-mode-check: this project supports dark mode, but this edit to /app/src/Card.tsx adds colors with no dark variant:')
  expect(note).toContain('- line 2: bg-white, text-gray-900, border-gray-200 -> dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700')
  expect(note).toContain('"dark-ok"')
  expect(toasts).toEqual(['3 colors without a dark variant in Card.tsx'])
})

test('a dark counterpart in the same class list, even in another argument of cn(), is enough', async ($, on) => {
  project(on, DARK_TAILWIND)

  const result = await write($, `${ROOT}/src/Panel.tsx`, '<div className={cn("bg-white text-gray-900", isOn && "dark:bg-gray-900", "dark:text-gray-100")} />\n<p className="bg-gray-50 dark:bg-slate-950">x</p>\n')

  expect(result.context).toBeUndefined()
})

test('hover and other states need their own dark counterpart', () => {
  expect(findClassFindings('<a className="hover:bg-gray-100 bg-white dark:bg-gray-900">x</a>').map(finding => finding.advice)).toEqual(['dark:hover:bg-gray-800'])
  expect(findClassFindings('<a className="hover:bg-gray-100 dark:hover:bg-gray-800 dark:bg-black">x</a>')).toEqual([])
})

test('colors that work in both themes are not flagged', () => {
  expect(texts('<div className="bg-blue-600 text-white border-red-500 bg-gray-500 text-gray-400 bg-black bg-gray-900 text-gray-100" />')).toEqual([])
  expect(texts('<div className="text-lg font-bold p-2 rounded bg-[#fff] text-[rgb(0,0,0)]" />')).toEqual([])
  expect(texts('<p>bg-white text-gray-900 in prose</p>')).toEqual([])
})

test('other ways of writing a class list: Vue, Svelte, HTML, plain strings and helper calls', () => {
  expect(texts('<div :class="{ \'bg-white\': isOn }" />')).toEqual(['bg-white'])
  expect(texts('<div class="text-black bg-slate-100"></div>')).toEqual(['text-black, bg-slate-100'])
  expect(texts("const card = 'bg-neutral-50 text-neutral-800'")).toEqual(['bg-neutral-50, text-neutral-800'])
  expect(texts('const x = clsx("bg-white", { "border-gray-100": big })')).toEqual(['bg-white, border-gray-100'])
  expect(texts("<div className={`bg-white ${open ? 'text-gray-900' : ''}`} />")).toEqual(['bg-white, text-gray-900'])
  expect(texts('<div className="divide-y divide-gray-200 ring-1 ring-gray-300 placeholder-gray-700" />')).toEqual(['divide-gray-200, ring-gray-300, placeholder-gray-700'])
})

test('a project that does not support dark mode is not nagged', async ($, on) => {
  const toasts = project(on, { [`${ROOT}/tailwind.config.ts`]: 'export default { content: [] }', [`${ROOT}/src/index.css`]: 'body { margin: 0 }' })

  expect((await write($, `${ROOT}/src/Card.tsx`, '<div className="bg-white" />')).context).toBeUndefined()
  expect(toasts).toHaveLength(0)
})

test('dark mode is found in global styles, in next-themes, or in the edited file itself', async ($, on) => {
  project(on, { [`${ROOT}/src/globals.css`]: ':root { --bg: #fff }\n@media (prefers-color-scheme: dark) { :root { --bg: #000 } }' })
  expect(noteOf(await write($, `${ROOT}/src/A.tsx`, '<div className="bg-white" />'))).toContain('bg-white')
})

test('next-themes in package.json counts', async ($, on) => {
  project(on, { [`${ROOT}/package.json`]: '{ "dependencies": { "next-themes": "^0.3.0" } }' })
  expect(noteOf(await write($, `${ROOT}/src/A.tsx`, '<div className="text-gray-900" />'))).toContain('text-gray-900')
})

test('a dark: class elsewhere in the same file shows the file is themed', async ($, on) => {
  project(on, {})
  const note = noteOf(await write($, `${ROOT}/src/A.tsx`, '<><b className="bg-white dark:bg-black" /><i className="text-black" /></>'))
  expect(note).toContain('text-black -> dark:text-white')
})

test('only what the edit adds is reported, and dark-ok lines are skipped', async ($, on) => {
  project(on, { ...DARK_TAILWIND, [`${ROOT}/src/Old.tsx`]: '<div className="bg-white" />\n<p>hello</p>\n' })

  expect((await edit($, `${ROOT}/src/Old.tsx`, 'hello', 'hello there')).context).toBeUndefined()
  expect(noteOf(await edit($, `${ROOT}/src/Old.tsx`, '<p>hello</p>', '<p className="text-gray-900">hello</p>'))).toContain('- line 2: text-gray-900')
  expect((await write($, `${ROOT}/src/Email.tsx`, '<td className="bg-white"> {/* dark-ok: emails are light only */}</td>')).context).toBeUndefined()
})

test('CSS colors need an override in a dark block for the same selector and kind of property', async ($, on) => {
  project(on, DARK_TAILWIND)
  const css = [
    '.card { background: #fff; color: #111827; border: 1px solid #e5e7eb; }',
    '.badge { background: #3366ff; color: white; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card { background-color: #111827; border-color: #374151 }',
    '}',
    '',
  ].join('\n')

  const note = noteOf(await write($, `${ROOT}/src/card.css`, css))

  expect(note).toContain('- line 1: .card { color: #111827 } -> no override in a dark block')
  expect(note).not.toContain('background')
  expect(note).not.toContain('.badge')
  expect(note).not.toContain('border')
})

test('SCSS nesting, class and attribute dark selectors, and light-only blocks are understood', () => {
  const scss = [
    '.nav {',
    '  background: white;',
    '  &:hover { background: #f5f5f5; color: #222 }',
    '  .link { color: #333 }',
    '}',
    '.dark .nav { background: #000 }',
    'html[data-theme="dark"] .nav:hover { background: #111; color: #eee }',
    '[data-theme=dark] .nav .link { color: #ddd }',
    '@media (prefers-color-scheme: light) { .promo { background: #fff } }',
    '.light .banner { background: #fff }',
  ].join('\n')

  expect(findStyleFindings(scss)).toEqual([])
  expect(findStyleFindings('.x { color: #333 }\n.y { background: rgb(250, 250, 250) }').map(finding => `${finding.line}: ${finding.text}`)).toEqual([
    '1: .x { color: #333 }',
    '2: .y { background: rgb(250, 250, 250) }',
  ])
})

test('Vue and Svelte style blocks are read, markup around them is not CSS', async ($, on) => {
  project(on, DARK_TAILWIND)

  const note = noteOf(await write($, `${ROOT}/src/Box.vue`, '<template>\n  <div class="box">a { b: c }</div>\n</template>\n<style scoped>\n.box {\n  background: #ffffff;\n}\n</style>\n'))

  expect(note).toContain('- line 6: .box { background: #ffffff } -> no override')
})

test('selectors and colors are normalised', () => {
  expect(baseSelector('.dark .card')).toBe('.card')
  expect(baseSelector('html[data-theme="dark"] .card>.title')).toBe('.card > .title')
  expect(baseSelector(':root.dark body .x')).toBe('body .x')
  expect(baseSelector('.card.dark')).toBe('.card')
  expect(parseRules('.a, .b { color: red; /* c */ }\n@keyframes k { from { color: #fff } }').map(rule => rule.selector)).toEqual(['.a, .b'])
  expect(parseColor('WHITE')).toEqual([255, 255, 255])
  expect(parseColor('hsl(0 0% 100%)')).toEqual([255, 255, 255])
})

test('a class map before the markup is read too, and a big style sheet is analysed in time', () => {
  const source = "const styles = { card: 'bg-white text-gray-900' }\nexport const Card = () => <div className=\"p-4\" />\n"
  expect(texts(source)).toEqual(['bg-white, text-gray-900'])
  expect(findClassFindings(source)[0]?.line).toBe(1)

  const css = Array.from({ length: 8000 }, (_, i) => `.c${i} {\n  color: #333;\n  background: #fff;\n}\n`).join('')
  const started = performance.now()
  const findings = findStyleFindings(css)
  expect(findings).toHaveLength(16000)
  expect(findings.at(-1)?.line).toBe(8000 * 4 - 1)
  expect(performance.now() - started).toBeLessThan(2000)
})
