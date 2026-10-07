import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { analyze, judge } from '../hooks/analyze'
import { adjustToPass, contrast, parseColor, ratioText } from '../hooks/color'
import { classColors, tailwindColor } from '../hooks/tailwind'

const THEME_CSS = `:root {
  --text: #1f2937;
  --muted: #9ca3af;
  --surface: #ffffff;
}
[data-theme="dark"] {
  --surface: #0f172a;
  --muted: #475569;
}
.card { color: var(--text); background: var(--surface); }
.card__meta { color: var(--muted); background-color: var(--surface); }
`

type World = { files: Map<string, string>; toasts: string[] }

/** Files as they are after the edit, and an engine whose file tools always succeed. */
const world = (on: On, files: Record<string, string>): World => {
  const state: World = { files: new Map(Object.entries(files)), toasts: [] }
  on('fs.read', ($, e) => (state.files.has(e.path) ? { value: state.files.get(e.path) as string } : { deny: 'ENOENT' }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', ($, e) => (String(e.tool) === 'Edit' && 'old_string' in e && e.old_string === 'DENY' ? { deny: 'no' } : { result: 'ok' }))
  return state
}

const edit = ($: Engine, file_path: string, new_string: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'x', new_string })
const write = ($: Engine, file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content })

test('computes WCAG ratios and suggests the nearest passing color', () => {
  const white = parseColor('#fff')
  const gray = parseColor('rgb(118 118 118)')
  if (white === undefined || gray === undefined) throw new Error('colors should parse')
  expect(ratioText(contrast(gray, white))).toBe('4.54:1')
  expect(ratioText(contrast(parseColor('black') ?? white, white))).toBe('21.00:1')
  expect(parseColor('hsl(210deg 40% 50% / 0.5)')?.a).toBe(0.5)
  expect(parseColor('rgba(0, 0, 0, .4)')).toEqual({ r: 0, g: 0, b: 0, a: 0.4 })
  expect(Math.round((parseColor('#abcd')?.a ?? 0) * 100)).toBe(87)
  expect(parseColor('currentColor')).toBeUndefined()

  const fix = adjustToPass(parseColor('#999') ?? white, white, 4.5)
  expect(fix !== undefined && contrast(fix, white) >= 4.5).toBe(true)
  expect(judge('#777', '#fff', false, 'AA')?.ratio).toBeLessThan(4.5)
  expect(judge('#777', '#fff', true, 'AA')).toBeUndefined()
  expect(judge('#000', 'transparent', false, 'AA')).toBeUndefined()

  expect(tailwindColor('gray-400')).toBe('#9ca3af')
  expect(tailwindColor('black/50')).toBe('rgba(0, 0, 0, 0.5)')
  expect(tailwindColor('[#777]')).toBe('#777')
  expect(classColors('text-3xl text-slate-400 bg-white hover:text-black').isLarge).toBe(true)
  expect(classColors('text-lg font-bold text-slate-400').isLarge).toBe(false)
})

test('an Edit that writes a failing pair gets a note with the ratio and a fix', async ($, on) => {
  const css = '.btn-secondary {\n  color: #999999;\n  background-color: #ffffff;\n}\n.ok { color: #111; background: #fff }\n'
  const state = world(on, { '/app/src/button.css': css })
  const result = await edit($, '/app/src/button.css', '  color: #999999;')
  const note = result.context?.[0] ?? ''
  expect(note).toContain('contrast-checker: /app/src/button.css has 1 text/background pair below WCAG AA:')
  expect(note).toContain('- .btn-secondary (line 1): #999999 on #ffffff is 2.84:1, needs 4.5:1 for normal text. Try color #767676 (4.54:1).')
  expect(note).not.toContain('.ok')
  expect(state.toasts).toEqual(['⚠ 1 contrast issue in button.css (lowest 2.84:1, WCAG AA)'])
})

test('a changed variable is checked wherever it is used, in light and dark themes', async ($, on) => {
  world(on, { '/app/theme.css': THEME_CSS })
  const result = await edit($, '/app/theme.css', '  --muted: #9ca3af;')
  const note = result.context?.[0] ?? ''
  expect(note).toContain('- .card__meta (line 11): var(--muted) (#9ca3af) on var(--surface) (#ffffff) is 2.53:1')
  expect(note).toContain('- .card__meta (line 11, dark theme): var(--muted) (#475569) on var(--surface) (#0f172a) is 2.35:1')
  expect(note).not.toContain('.card (')
})

test('passing colors, other files and failed edits stay silent', async ($, on) => {
  const state = world(on, {
    '/app/ok.css': '.a { color: #222; background: #fff; }\n.b:disabled { color: #ccc; background: #fff; }\n',
    '/app/README.md': 'color: #ccc; background: #fff',
  })
  expect((await write($, '/app/ok.css', 'x')).context).toBeUndefined()
  expect((await write($, '/app/README.md', 'x')).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Edit', file_path: '/app/ok.css', old_string: 'DENY', new_string: '.a{}' })).deny).toBe('no')
  expect(state.toasts).toHaveLength(0)
})

test('checks Tailwind classes, styled-components and inline styles in components', async ($, on) => {
  const tsx = [
    'const Pill = styled.span`',
    '  color: #aaaaaa;',
    '  background: #ffffff;',
    '`',
    'export const Tag = () => <span className="px-2 text-gray-400 bg-white dark:bg-gray-900 dark:text-gray-600">new</span>',
    "export const Note = () => <p style={{ color: '#888', backgroundColor: '#fff' }}>hi</p>",
  ].join('\n')
  world(on, { '/app/Tag.tsx': tsx })
  const note = (await write($, '/app/Tag.tsx', tsx)).context?.[0] ?? ''
  expect(note).toContain('- styled.span (line 1): #aaaaaa on #ffffff is 2.32:1')
  expect(note).toContain('(line 5): #9ca3af on #ffffff is 2.53:1')
  expect(note).toContain('(line 5, dark theme): #4b5563 on #111827 is 2.34:1')
  expect(note).toContain('- inline style (line 6): #888 on #fff is 3.54:1')
})

test('AAA asks for 7:1', { options: { level: 'AAA' } }, async ($, on) => {
  world(on, { '/app/a.scss': '$ink: #666666;\n.text { color: $ink; background: white; }\n' })
  const note = (await write($, '/app/a.scss', 'x')).context?.[0] ?? ''
  expect(note).toContain('below WCAG AAA')
  expect(note).toContain('- .text (line 2): $ink (#666666) on white is 5.74:1, needs 7:1 for normal text.')
})

test('nested SCSS rules inherit the background of their parent', () => {
  const scss = '$brand: #7dd3fc;\n.nav {\n  background: $brand;\n  a { color: #fff; }\n}\n'
  const [issue] = analyze('nav.scss', scss, 'all', 'AA')
  expect(issue?.where).toBe('.nav a')
  expect(issue?.bg).toBe('$brand (#7dd3fc)')
  expect(ratioText(issue?.ratio ?? 0)).toBe('1.66:1')
})
