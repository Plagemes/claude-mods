import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { adviceFor, heavyKind, limitsFrom } from '../hooks/assets'
import { additionsOf, simpleCommands } from '../hooks/commands'

const NOW = 1_800_000_000_000
const KB = 1024
const MB = 1024 * KB
const FRESH = NOW + 500
const OLD = NOW - 86_400_000

type Disk = Record<string, { size: number; mtimeMs?: number }>

/** The project beneath the plugin: a disk (what the command "did" is already on it), git, a clock and the toasts. */
const project = (on: On, disk: Disk, staged: string[] = [], run = { fails: false }) => {
  mock.clock(on, { now: NOW })
  const seen = { toasts: [] as string[], git: [] as string[][] }
  on('session.cwd', () => ({ value: '/app' }))
  on('session.repo', () => ({ value: { root: '/app', remote: null, internal: false, name: null } }))
  on('fs.stat', (_$, e) => {
    const file = disk[e.path]
    if (file !== undefined) return { value: { kind: 'file' as const, size: file.size, mtimeMs: file.mtimeMs ?? FRESH, isLink: false } }
    const isFolder = Object.keys(disk).some(path => path.startsWith(`${e.path}/`))
    return isFolder ? { value: { kind: 'dir' as const, size: 0, mtimeMs: FRESH, isLink: false } } : { deny: 'ENOENT' }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path.replace(/\/+$/, '')}/`
    const entries = Object.entries(disk).filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return entries.length === 0 ? { deny: 'ENOENT' } : { value: entries.map(([path, file]) => ({ name: path.slice(prefix.length), kind: 'file' as const, size: file.size, mtimeMs: file.mtimeMs ?? FRESH, isLink: false })) }
  })
  on('process.run', (_$, e) => {
    seen.git.push([...e.argv])
    return { value: { exitCode: 0, stdout: staged.map(name => `${name}\0`).join(''), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => (run.fails ? { isError: true as const, result: 'failed', text: 'cp: cannot stat' } : { result: 'ok' }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const noteOf = (result: { context?: readonly string[] }): string => result.context?.[0] ?? ''

test('a heavy image copied into public/ is reported with the toast and a note with the fix', async ($, on) => {
  const seen = project(on, { '/app/public/img/hero.png': { size: 1.8 * MB } })

  const result = await bash($, 'cp ~/Downloads/hero.png public/img/hero.png')

  expect(seen.toasts).toEqual(['public/img/hero.png is 1.8 MB, over the 300 KB image limit'])
  const note = noteOf(result)
  expect(note).toContain('heavy-asset-warn: a heavy asset was added to the project.')
  expect(note).toContain('- public/img/hero.png is 1.8 MB (images over 300 KB slow page loads): convert it to WebP or AVIF')
  expect(note).toContain('srcset')
})

test('moving into a folder, curl -o and -O, wget -P and redirects are all seen', async ($, on) => {
  const seen = project(on, {
    '/app/public/videos/intro.mp4': { size: 12 * MB },
    '/app/public/photo.jpg': { size: 700 * KB },
    '/app/static/fonts/Inter.ttf': { size: 310 * KB },
    '/app/assets/banner.gif': { size: 2 * MB },
    '/app/assets/shot.png': { size: 500 * KB, mtimeMs: OLD },
  })

  expect(noteOf(await bash($, 'mv /tmp/intro.mp4 public/videos/'))).toContain('- public/videos/intro.mp4 is 12.0 MB (videos over 2.0 MB')
  expect(noteOf(await bash($, 'curl -sSL -o public/photo.jpg https://cdn.example.com/p.jpg'))).toContain('- public/photo.jpg is 700 KB')
  expect(noteOf(await bash($, 'cd static/fonts && curl -O "https://cdn.example.com/f/Inter.ttf?v=3"'))).toContain('- static/fonts/Inter.ttf is 310 KB (fonts over 200 KB delay text rendering): convert it to WOFF2')
  expect(noteOf(await bash($, 'wget -q -P assets https://cdn.example.com/banner.gif'))).toContain('- assets/banner.gif is 2.0 MB (images over 300 KB slow page loads): replace an animated GIF')
  expect(noteOf(await bash($, 'curl -s https://cdn.example.com/shot.png > assets/shot.png'))).toContain('- assets/shot.png is 500 KB')
  expect(seen.toasts).toHaveLength(5)
})

test('a glob copy is found by the files it just wrote; older files in the folder are not blamed', async ($, on) => {
  const seen = project(on, {
    '/app/public/new-a.png': { size: 400 * KB, mtimeMs: FRESH },
    '/app/public/new-b.png': { size: 900 * KB, mtimeMs: FRESH },
    '/app/public/old.png': { size: 5 * MB, mtimeMs: OLD },
  })

  const note = noteOf(await bash($, 'cp ~/shots/*.png public/'))

  expect(note).toContain('2 heavy assets were added')
  expect(note).toContain('public/new-a.png')
  expect(note).toContain('public/new-b.png')
  expect(note).not.toContain('old.png')
  expect(seen.toasts).toEqual(['2 heavy assets added: public/new-a.png 400 KB, public/new-b.png 900 KB'])
})

test('git add checks what is staged, anywhere in the repo, and warns about a file once', async ($, on) => {
  const seen = project(on, { '/app/docs/diagram.png': { size: 600 * KB }, '/app/docs/small.png': { size: 20 * KB } }, ['docs/diagram.png', 'docs/small.png', 'src/app.ts'])

  const first = await bash($, 'git add -A')
  const second = await bash($, 'git add docs && git status')

  expect(noteOf(first)).toContain('- docs/diagram.png is 600 KB')
  expect(second.context).toBeUndefined()
  expect(seen.git[0]).toEqual(['git', 'diff', '--cached', '--name-only', '--diff-filter=AM', '-z'])
  expect(seen.toasts).toHaveLength(1)
})

test('Write is checked wherever the file goes; small files, other types and failed commands are not', async ($, on) => {
  const disk: Disk = { '/app/anywhere/logo.svg': { size: 350 * KB }, '/app/public/ok.png': { size: 120 * KB }, '/app/src/big.ts': { size: 9 * MB }, '/tmp/elsewhere/huge.png': { size: 9 * MB }, '/app/docs/huge.png': { size: 9 * MB } }
  const run = { fails: false }
  const seen = project(on, disk, [], run)

  expect(noteOf(await $.tool.call({ tool: 'Write', file_path: '/app/anywhere/logo.svg', content: '<svg/>' }))).toContain('- anywhere/logo.svg is 350 KB (images over 300 KB slow page loads): optimize it with svgo')
  expect((await bash($, 'cp a.png public/ok.png')).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/app/src/big.ts', content: 'x' })).context).toBeUndefined()
  expect((await bash($, 'cp huge.png /tmp/elsewhere/huge.png')).context).toBeUndefined()
  expect((await bash($, 'cp huge.png docs/huge.png')).context).toBeUndefined()
  run.fails = true
  expect((await bash($, 'cp huge.png public/ok.png')).context).toBeUndefined()
  expect(seen.toasts).toHaveLength(1)
})

test('limits and folders are configurable', { options: { imageKb: 100, directories: 'docs' } }, async ($, on) => {
  project(on, { '/app/docs/huge.png': { size: 150 * KB }, '/app/public/other.png': { size: 150 * KB } })

  expect(noteOf(await bash($, 'cp huge.png docs/huge.png'))).toContain('(images over 100 KB')
  expect((await bash($, 'cp other.png public/other.png')).context).toBeUndefined()
})

test('video and font limits are configurable too', { options: { videoKb: 500, fontKb: 50 } }, async ($, on) => {
  project(on, { '/app/public/a.mp4': { size: 600 * KB }, '/app/public/b.woff2': { size: 60 * KB } })

  expect(noteOf(await bash($, 'cp a.mp4 public/a.mp4'))).toContain('videos over 500 KB')
  expect(noteOf(await bash($, 'cp b.woff2 public/b.woff2'))).toContain('subset it to the characters you use')
})

test('commands are read the way the shell reads them', () => {
  expect(simpleCommands(`cp "my file.png" 'a b/' && ls | wc -l`)).toEqual([{ words: ['cp', 'my file.png', 'a b/'], redirects: [] }, { words: ['ls'], redirects: [] }, { words: ['wc', '-l'], redirects: [] }])
  expect(simpleCommands('curl -s url 2>&1 > out.png; echo done >> log.txt')).toEqual([{ words: ['curl', '-s', 'url'], redirects: ['out.png'] }, { words: ['echo', 'done'], redirects: ['log.txt'] }])
  expect(additionsOf('cp -r a.png b/c.png', '/app')).toEqual({ files: ['/app/b/c.png', '/app/b/c.png/a.png'], folders: [], isGitAdd: false })
  expect(additionsOf('cp -t public a.png b.png', '/app').files).toEqual(['/app/public', '/app/public/a.png', '/app/public/b.png'])
  expect(additionsOf('cp *.png public/', '/app')).toEqual({ files: ['/app/public'], folders: ['/app/public'], isGitAdd: false })
  expect(additionsOf('cd web && wget -O logo.png https://x/y', '/app').files).toEqual(['/app/web/logo.png'])
  expect(additionsOf('curl -O https://x/a/b.png', '/app').files).toEqual(['/app/b.png'])
  expect(additionsOf('curl -o - https://x/a.png | cat', '/app').files).toEqual([])
  expect(additionsOf('cp $SRC public/x.png', '/app').files).toEqual(['/app/public/x.png'])
  expect(additionsOf('git -C repo add .', '/app').isGitAdd).toBe(true)
  expect(additionsOf('git status', '/app').isGitAdd).toBe(false)
  expect(additionsOf('echo hi', '/app')).toEqual({ files: [], folders: [], isGitAdd: false })
})

test('limits and advice depend on the kind and format of the asset', () => {
  const limits = limitsFrom({})
  expect(heavyKind('a.PNG', 301 * KB, limits)).toBe('image')
  expect(heavyKind('a.png', 300 * KB, limits)).toBeUndefined()
  expect(heavyKind('a.mp4', 2 * MB + 1, limits)).toBe('video')
  expect(heavyKind('a.woff2', 201 * KB, limits)).toBe('font')
  expect(heavyKind('a.ts', 9 * MB, limits)).toBeUndefined()
  expect(adviceFor('a.avif', 'image')).toContain('already a modern format')
  expect(adviceFor('a.otf', 'font')).toContain('WOFF2')
  expect(limitsFrom({ imageKb: -1, videoKb: 'x' }).image).toBe(300 * KB)
})
