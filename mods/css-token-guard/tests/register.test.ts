import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { addedLiterals, findColorLiterals, findSizeLiterals } from '../hooks/literals'
import { colorDistance, parseColor, parseObjectTokens, parseStyleTokens } from '../hooks/tokens'

const ROOT = '/app'
const TOKENS_CSS = [
  ':root {',
  '  --color-primary: #3366ff;',
  '  --color-text: #111827;',
  '  --color-surface: #f9fafb;',
  '  --color-alias: var(--color-primary);',
  '  --space-4: 16px;',
  '  --space-2: 0.5rem;',
  '}',
  '',
].join('\n')

/** A project on a virtual disk, with a clock, the toasts, and a tool that reaches the engine. */
const project = (on: On, files: Record<string, string>) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const reached: string[] = []
  const toasts: string[] = []
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.list', (_$, e) => {
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files).filter(path => path.startsWith(prefix))) {
      const [name, ...deeper] = path.slice(prefix.length).split('/')
      if (name !== undefined) names.set(name, deeper.length > 0 ? 'dir' : 'file')
    }
    if (names.size === 0) return { deny: 'ENOENT' }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: files[`${prefix}${name}`]?.length ?? 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] ?? '' }))
  on('fs.stat', (_$, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: files[e.path]?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('tool.call', (_$, e) => {
    reached.push('file_path' in e ? String(e.file_path) : String(e.tool))
    return { result: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, reached, toasts }
}

const edit = ($: Engine, file_path: string, new_string: string, old_string = '') => $.tool.call({ tool: 'Edit', file_path, old_string, new_string })
const write = ($: Engine, file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content })
const noteOf = (result: { context?: readonly string[] }): string => result.context?.[0] ?? ''

test('a hard-coded color that is a token is reported with the token to use', async ($, on) => {
  const { toasts, reached } = project(on, { [`${ROOT}/src/styles/tokens.css`]: TOKENS_CSS })

  const result = await edit($, `${ROOT}/src/Button.tsx`, "const style = { color: '#3366FF', background: 'rgb(17, 24, 39)' }")

  expect(reached).toEqual([`${ROOT}/src/Button.tsx`])
  const note = noteOf(result)
  expect(note).toContain("css-token-guard: this edit to /app/src/Button.tsx hard-codes values that the project's design tokens cover:")
  expect(note).toContain('- #3366FF (line 1) -> var(--color-primary) (the same color)')
  expect(note).toContain('- rgb(17, 24, 39) (line 1) -> var(--color-text) (the same color)')
  expect(note).toContain('"token-ok"')
  expect(toasts).toEqual(['2 hard-coded values in Button.tsx, tokens exist'])
})

test('near misses name the closest token; colors nothing resembles say so', async ($, on) => {
  project(on, { [`${ROOT}/src/styles/tokens.css`]: TOKENS_CSS })

  const result = await write($, `${ROOT}/src/card.css`, '.a { color: #3468fd }\n.b { background: #f8fafb }\n.c { border-color: #ff00aa }\n')

  const note = noteOf(result)
  expect(note).toContain('- #3468fd (line 1) -> var(--color-primary) (very close)')
  expect(note).toContain('- #f8fafb (line 2) -> var(--color-surface) (visually identical)')
  expect(note).toContain('- #ff00aa (line 3) -> no token is close (nearest is')
})

test('white and black may stay, the allow list is configurable', { options: { allow: '#fff, rgb(0, 0, 0), #3366ff' } }, async ($, on) => {
  project(on, { [`${ROOT}/src/styles/tokens.css`]: TOKENS_CSS })

  const result = await write($, `${ROOT}/src/a.css`, '.a { color: #FFFFFF; background: #000; border-color: #3366ff; outline-color: #111827 }\n')

  expect(noteOf(result)).toContain('- #111827 (line 1)')
  expect(noteOf(result)).not.toContain('#FFFFFF')
  expect(noteOf(result)).not.toContain('#3366ff')
})

test('without design tokens in the project, and in the token files themselves, it says nothing', async ($, on) => {
  const bare = project(on, { [`${ROOT}/src/app.css`]: 'a { color: red }' })
  expect((await write($, `${ROOT}/src/a.css`, 'a { color: #123456 }')).context).toBeUndefined()
  expect(bare.toasts).toHaveLength(0)
})

test('editing the token file itself is how tokens get defined', async ($, on) => {
  project(on, { [`${ROOT}/src/styles/tokens.css`]: TOKENS_CSS, [`${ROOT}/tailwind.config.ts`]: "export default { theme: { extend: { colors: { brand: '#ff0000', ink: '#101010' } } } }" })

  expect((await edit($, `${ROOT}/src/styles/tokens.css`, '--color-new: #123456;')).context).toBeUndefined()
  expect((await edit($, `${ROOT}/tailwind.config.ts`, "colors: { x: '#123456' }")).context).toBeUndefined()
  expect((await edit($, `${ROOT}/src/theme.css`, '--x: #123456;')).context).toBeUndefined()
})

test('only added literals count; variables, comments, links, fallbacks and token-ok lines are not literals to fix', async ($, on) => {
  project(on, { [`${ROOT}/src/styles/tokens.css`]: TOKENS_CSS, [`${ROOT}/src/old.css`]: '.a { color: #3366ff }\n' })

  expect((await write($, `${ROOT}/src/old.css`, '.a { color: #3366ff }\n.b { margin: 0 }\n')).context).toBeUndefined()

  const clean = [
    '.a { --local: #3366ff; }',
    '/* the brand is #3366ff */',
    '.b { color: var(--color-primary, #3366ff); }',
    '.c { background: url(#3366ff) } <a href="#abc">x</a>',
    '.d { color: #3366ff; } /* token-ok */',
    '#fed { margin: 0 }',
    '&#123; &#x27;',
  ].join('\n')
  expect((await write($, `${ROOT}/src/clean.css`, clean)).context).toBeUndefined()
})

test('Tailwind and theme files are read for tokens too', async ($, on) => {
  project(on, {
    [`${ROOT}/tailwind.config.ts`]: "export default { theme: { extend: { colors: { primary: '#3366ff', brand: { 500: '#ff0000', DEFAULT: '#cc0000' } } } } }",
  })

  const note = noteOf(await edit($, `${ROOT}/src/Hero.tsx`, '<div className="bg-[#3366ff] text-[#ff0000]" style={{ color: "#cc0000" }} />'))

  expect(note).toContain('- #3366ff (line 1) -> Tailwind color primary (the same color)')
  expect(note).toContain('- #ff0000 (line 1) -> Tailwind color brand-500 (the same color)')
  expect(note).toContain('- #cc0000 (line 1) -> Tailwind color brand (the same color)')
})

test('a theme.ts object and Sass variables are tokens', async ($, on) => {
  project(on, {
    [`${ROOT}/src/theme.ts`]: "export const theme = { colors: { primary: '#3366ff', text: '#111827' }, spacing: { md: '16px' } } as const\n",
    [`${ROOT}/src/styles/_variables.scss`]: '$danger: #cc0000;\n$muted: hsl(220, 10%, 50%);\n',
  })

  const note = noteOf(await edit($, `${ROOT}/src/Alert.vue`, '<style>.a { color: #cc0000; background: #3366ff }</style>'))

  expect(note).toContain('- #cc0000 (line 1) -> $danger (the same color)')
  expect(note).toContain('- #3366ff (line 1) -> colors.primary (the same color)')
})

test('pixel values are checked only when asked, and only when a size token has that value', { options: { checkSpacing: true } }, async ($, on) => {
  project(on, { [`${ROOT}/src/styles/tokens.css`]: TOKENS_CSS })

  const note = noteOf(await write($, `${ROOT}/src/box.css`, '.a { padding: 16px 8px; margin: 13px; border: 1px solid; gap: 2px; width: calc(100% - 16px); color: #3366ff }\n'))

  expect(note).toContain('- 16px (line 1) -> var(--space-4)')
  expect(note).toContain('- 8px (line 1) -> var(--space-2)')
  expect(note).not.toContain('13px')
  expect(note).not.toContain('2px')
  expect(note).toContain('#3366ff')
})

test('pixel values are left alone by default', async ($, on) => {
  project(on, { [`${ROOT}/src/styles/tokens.css`]: TOKENS_CSS })
  expect((await write($, `${ROOT}/src/box.css`, '.a { padding: 16px }\n')).context).toBeUndefined()
})

test('tokens are looked up again after a minute, and extra token files can be named', { options: { tokenFiles: 'config/brand.json' } }, async ($, on) => {
  const files: Record<string, string> = { [`${ROOT}/config/brand.json`]: '{ "color": { "accent": { "$value": "#ff8800" } }, "other": { "pink": "#ff00aa" } }' }
  const { clock } = project(on, files)

  expect(noteOf(await write($, `${ROOT}/src/a.css`, '.a { color: #ff8800 }'))).toContain('-> color.accent (the same color)')

  files[`${ROOT}/config/brand.json`] = '{ "color": { "accent": "#00ff88", "ink": "#001122" } }'
  expect(noteOf(await write($, `${ROOT}/src/b.css`, '.a { color: #00ff88 }'))).toContain('no token is close')
  await clock.advance(61_000)
  expect(noteOf(await write($, `${ROOT}/src/c.css`, '.a { color: #00ff88 }'))).toContain('-> color.accent (the same color)')
})

test('colors in every notation are understood and compared by how they look', () => {
  expect(parseColor('#36f')).toEqual([51, 102, 255])
  expect(parseColor('#3366ff80')).toEqual([51, 102, 255])
  expect(parseColor('rgb(51 102 255 / 50%)')).toEqual([51, 102, 255])
  expect(parseColor('rgba(51, 102, 255, 0.5)')).toEqual([51, 102, 255])
  expect(parseColor('hsl(0, 100%, 50%)')).toEqual([255, 0, 0])
  expect(parseColor('hsl(120 100% 25%)')).toEqual([0, 128, 0])
  expect(parseColor('var(--x)')).toBeUndefined()
  expect(parseColor('rgb(var(--r), 0, 0)')).toBeUndefined()
  expect(parseColor('#12345')).toBeUndefined()
  expect(colorDistance([255, 255, 255], [255, 255, 255])).toBe(0)
  expect(colorDistance([51, 102, 255], [52, 104, 253])).toBeLessThan(3)
  expect(colorDistance([255, 255, 255], [0, 0, 0])).toBeGreaterThan(90)
})

test('token files: custom properties, Sass, Less and object literals', () => {
  const css = parseStyleTokens(':root{\n --a: #fff;\n --b: var(--a);\n --c: 12px;\n --d: 2rem !important;\n}\n$e: #000 !default;\n@f: rgb(1,2,3);\n')
  expect(css.colors.map(token => token.use)).toEqual(['var(--a)', '$e', '@f'])
  expect(css.sizes).toEqual([{ use: 'var(--c)', px: 12 }, { use: 'var(--d)', px: 32 }])

  const objects = parseObjectTokens("module.exports = { theme: { extend: { colors: { gray: { 100: '#f3f4f6', DEFAULT: '#888' }, white: lighten('#fff', 3) }, spacing: { 4: '1rem' } } } }", 'tailwind.config.js')
  expect(objects.colors.map(token => token.use)).toEqual(['Tailwind color gray-100', 'Tailwind color gray'])
  expect(objects.sizes).toEqual([{ use: 'Tailwind spacing.4', px: 16 }])
})

test('literal finders skip what is not a color and report line numbers', () => {
  expect(findColorLiterals('a\n.b { color: #abc; x: rgba(0, 0, 0, .5) }\n').map(literal => `${literal.text}@${literal.line}`)).toEqual(['#abc@2', 'rgba(0, 0, 0, .5)@2'])
  expect(findColorLiterals('<a href="#add">x</a> color: #bad;').map(literal => literal.text)).toEqual(['#bad'])
  expect(findSizeLiterals("a { paddingTop: '24px', margin: 0 auto; border: 1px solid }").map(literal => literal.text)).toEqual(['24px'])
  expect(addedLiterals([{ text: '#FFF' }], [{ text: '#fff' }, { text: '#fff' }])).toHaveLength(1)
})
