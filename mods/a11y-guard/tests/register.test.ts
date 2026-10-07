import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findIssues, newIssues } from '../hooks/markup'

const rulesIn = (source: string): string[] => findIssues(source).map(issue => issue.rule)

/** The engine beneath the plugin: files on disk, the tool that applies the edit, and the toasts. */
const world = (on: On, files: Record<string, string> = {}) => {
  const reached: string[] = []
  const toasts: string[] = []
  on('fs.stat', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('tool.call', (_$, e) => {
    reached.push('file_path' in e ? String(e.file_path) : String(e.tool))
    return { result: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { reached, toasts }
}

const write = ($: Engine, file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content })
const edit = ($: Engine, file_path: string, old_string: string, new_string: string) => $.tool.call({ tool: 'Edit', file_path, old_string, new_string })

const GALLERY = [
  'export function Gallery({ photos }) {',
  '  return (',
  '    <div>',
  '      <img src={photos[0]} />',
  '      <button onClick={zoom}><ZoomIcon /></button>',
  '      <div onClick={close}>x</div>',
  '    </div>',
  '  )',
  '}',
  '',
].join('\n')

test('in warn mode the edit goes through, the model gets a numbered list and the user a toast', async ($, on) => {
  const { reached, toasts } = world(on)

  const result = await write($, '/app/src/Gallery.tsx', GALLERY)

  expect(reached).toEqual(['/app/src/Gallery.tsx'])
  const note = result.context?.[0] ?? ''
  expect(note).toContain('a11y-guard: this edit to /app/src/Gallery.tsx adds 3 accessibility issues:')
  expect(note).toContain('- line 4: <img> has no alt attribute: add alt text, or alt="" when the image is decorative')
  expect(note).toContain('- line 5: <button> has no text or aria-label (icon-only?)')
  expect(note).toContain('- line 6: <div> has a click handler but is missing role, tabIndex and a key handler: use a <button> instead')
  expect(toasts).toEqual(['3 accessibility issues in Gallery.tsx'])
})

test('in block mode the edit is refused and nothing is written', { options: { mode: 'block' } }, async ($, on) => {
  const { reached, toasts } = world(on)

  const result = await write($, '/app/src/Gallery.tsx', GALLERY)

  expect(result.deny).toContain('a11y-guard: blocked, this edit to Gallery.tsx adds 3 accessibility issues:')
  expect(result.deny).toContain('- line 4: <img> has no alt attribute')
  expect(reached).toHaveLength(0)
  expect(toasts).toHaveLength(0)
})

test('only what the edit adds is reported: problems that were already in the file are left alone', async ($, on) => {
  const existing = '<div>\n  <img src="a.png" />\n  <p>Hello</p>\n</div>\n'
  world(on, { '/app/Card.vue': existing })

  const unrelated = await edit($, '/app/Card.vue', 'Hello', 'Hello there')
  expect(unrelated.context).toBeUndefined()

  const added = await edit($, '/app/Card.vue', '<p>Hello</p>', '<p>Hello</p>\n  <img src="b.png" />')
  expect(added.context?.[0]).toContain('adds 1 accessibility issue:')
  expect(added.context?.[0]).toContain('- line 4: <img> has no alt attribute')
})

test('an edit that fixes a problem, or touches other kinds of files, says nothing', async ($, on) => {
  world(on, { '/app/Card.tsx': '<img src="a.png" />\n' })

  expect((await edit($, '/app/Card.tsx', '<img src="a.png" />', '<img src="a.png" alt="A card" />')).context).toBeUndefined()
  expect((await write($, '/app/util.ts', 'const html = "<img src=x>"')).context).toBeUndefined()
  expect((await write($, '/app/README.md', '<img src="x.png">')).context).toBeUndefined()
})

test('an Edit that cannot be replayed on the file is judged on its own snippet', async ($, on) => {
  world(on, { '/app/List.svelte': '<ul></ul>\n' })

  const result = await edit($, '/app/List.svelte', '<li>old</li>', '<li on:click={pick}>new</li>')

  expect(result.context?.[0]).toContain('<li> has a click handler but is missing role, tabIndex and a key handler')
})

test('images', () => {
  expect(rulesIn('<img src="a.png" />')).toEqual(['img-alt'])
  expect(rulesIn('<img src="a.png" alt="" />')).toEqual([])
  expect(rulesIn('<img src="a.png" alt={title} />')).toEqual([])
  expect(rulesIn('<img :src="a" :alt="b">')).toEqual([])
  expect(rulesIn('<img {...props} />')).toEqual([])
  expect(rulesIn('<Image src="a.png" />')).toEqual([])
})

test('buttons and links need a name', () => {
  expect(rulesIn('<button onClick={go}><CloseIcon /></button>')).toEqual(['button-name'])
  expect(rulesIn('<button><svg><path d="M0 0" /></svg></button>')).toEqual(['button-name'])
  expect(rulesIn('<button></button>')).toEqual(['button-name'])
  expect(rulesIn('<button onClick={() => a > b}>Go</button>')).toEqual([])
  expect(rulesIn('<button aria-label="Close"><X /></button>')).toEqual([])
  expect(rulesIn('<button aria-label=""><X /></button>')).toEqual(['button-name'])
  expect(rulesIn('<button title="Close"><X /></button>')).toEqual([])
  expect(rulesIn('<button><svg><title>Close</title></svg></button>')).toEqual([])
  expect(rulesIn('<button>{label}</button>')).toEqual([])
  expect(rulesIn('<button><Icon aria-label="Close" /></button>')).toEqual([])
  expect(rulesIn('<button><img src="m.png" alt="Menu" /></button>')).toEqual([])
  expect(rulesIn('<button><span className="sr-only">Close</span><X /></button>')).toEqual([])
  expect(rulesIn('<button {...rest}><X /></button>')).toEqual([])
  expect(rulesIn('<button v-text="label"></button>')).toEqual([])
  expect(rulesIn('<a href="/docs"><Icon /></a>')).toEqual(['link-name'])
  expect(rulesIn('<a href="/docs">Docs</a>')).toEqual([])
  expect(rulesIn('<a href="/docs"><i class="fa fa-home"></i> Home</a>')).toEqual([])
  expect(rulesIn('<a name="top"></a>')).toEqual([])
  expect(rulesIn('<button>{/* TODO */}<X /></button>')).toEqual(['button-name'])
})

test('clickable divs and spans need role, tabIndex and a key handler', () => {
  expect(rulesIn('<div onClick={go}>x</div>')).toEqual(['click-handler'])
  expect(rulesIn('<span @click="go">x</span>')).toEqual(['click-handler'])
  expect(rulesIn('<li on:click={go}>x</li>')).toEqual(['click-handler'])
  expect(rulesIn('<div onclick="go()">x</div>')).toEqual(['click-handler'])
  expect(rulesIn('<div onClick={go} role="button" tabIndex={0}>x</div>')[0]).toBe('click-handler')
  expect(findIssues('<div onClick={go} role="button" tabIndex={0}>x</div>')[0]?.message).toContain('missing a key handler')
  expect(rulesIn('<div onClick={go} role="button" tabIndex={0} onKeyDown={go}>x</div>')).toEqual([])
  expect(rulesIn('<div onClick={close} role="presentation" />')).toEqual([])
  expect(rulesIn('<div onClick={close} aria-hidden="true" />')).toEqual([])
  expect(rulesIn('<button onClick={go}>Go</button>')).toEqual([])
})

test('inputs need a label: wrapping, htmlFor, aria-label', () => {
  expect(rulesIn('<input type="text" />')).toEqual(['input-label'])
  expect(rulesIn('<textarea rows={3} />')).toEqual(['input-label'])
  expect(rulesIn('<select><option>a</option></select>')).toEqual(['input-label'])
  expect(rulesIn('<input type="hidden" name="csrf" />')).toEqual([])
  expect(rulesIn('<input type="submit" value="Go" />')).toEqual([])
  expect(rulesIn('<input aria-label="Search" />')).toEqual([])
  expect(rulesIn('<input aria-labelledby="t" />')).toEqual([])
  expect(rulesIn('<label>Name <input type="text" /></label>')).toEqual([])
  expect(rulesIn('<label htmlFor="email">Email</label>\n<input id="email" />')).toEqual([])
  expect(rulesIn('<label for="email">Email</label><input id="email">')).toEqual([])
  expect(rulesIn('<input id="email" />')).toEqual(['input-label'])
  expect(rulesIn('<label htmlFor="a">A</label><input id="b" />')).toEqual(['input-label'])
  expect(rulesIn('<input id={id} />')).toEqual([])
  expect(rulesIn('<Input placeholder="x" />')).toEqual([])
})

test('positive tabindex and autofocus', () => {
  expect(rulesIn('<div tabIndex={3} />')).toEqual(['positive-tabindex'])
  expect(rulesIn('<div tabindex="2"></div>')).toEqual(['positive-tabindex'])
  expect(rulesIn('<div tabIndex={0} />')).toEqual([])
  expect(rulesIn('<div tabIndex={-1} />')).toEqual([])
  expect(rulesIn('<input autoFocus aria-label="x" />')).toEqual(['autofocus'])
  expect(rulesIn('<input autoFocus={false} aria-label="x" />')).toEqual([])
  expect(rulesIn('<Modal><input autoFocus aria-label="x" /></Modal>')).toEqual([])
  expect(rulesIn('<dialog open><input autofocus aria-label="x"></dialog>')).toEqual([])
})

test('TypeScript generics and comparisons do not confuse the scanner', () => {
  const source = 'const [x, setX] = useState<string | null>(null)\nconst ok = a < b && c > d\nreturn <img src={x ?? "a"} />\n'
  expect(findIssues(source).map(issue => `${issue.rule}@${issue.line}`)).toEqual(['img-alt@3'])
  expect(rulesIn('<!-- <img src="x"> -->\n<p>fine</p>')).toEqual([])
})

test('the same element is the same issue wherever it moves, and a second copy counts', () => {
  const a = '<img src="a.png" />\n<p>x</p>'
  const moved = '<p>x</p>\n\n<img src="a.png" />'
  expect(newIssues(a, moved)).toHaveLength(0)
  expect(newIssues(a, `${a}\n<img src="a.png" />`)).toHaveLength(1)
})

test('regression: Angular [attr.aria-label] names an element, and aria-hidden={true} or bare aria-hidden is decorative', () => {
  expect(rulesIn('<button [attr.aria-label]="label" (click)="close()"><svg></svg></button>')).toEqual([])
  expect(rulesIn('<a [attr.aria-label]="label" href="/"><svg></svg></a>')).toEqual([])
  expect(rulesIn('<input [attr.aria-label]="label" />')).toEqual([])
  expect(rulesIn('<span onClick={close} aria-hidden={true}>x</span>')).toEqual([])
  expect(rulesIn('<span onClick={close} aria-hidden>x</span>')).toEqual([])
  expect(rulesIn('<span onClick={close} aria-hidden={false}>x</span>')).toEqual(['click-handler'])
})

test('regression: big or bracket-heavy sources scan in linear time, line numbers stay right', () => {
  const images = '<img src="x">\n'.repeat(15_000)
  const started = Date.now()
  const issues = findIssues(images)
  expect(issues).toHaveLength(15_000)
  expect(issues.at(-1)?.line).toBe(15_000)
  expect(findIssues('<a '.repeat(70_000))).toHaveLength(0)
  expect(Date.now() - started).toBeLessThan(3_000)
})

test('regression: a Write too big to scan goes through untouched', async ($, on) => {
  const { reached } = world(on)
  const result = await write($, '/app/huge.html', '<img src="x">\n'.repeat(40_000))
  expect(reached).toEqual(['/app/huge.html'])
  expect(result.context).toBeUndefined()
})
