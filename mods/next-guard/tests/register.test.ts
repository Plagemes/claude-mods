import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

import { checkComponent, clientFeatures, nextProjectDirs } from '../hooks/component'

const NEXT_PACKAGE = JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } })

/** Stands in for the engine: files by path, the files read, and the toasts. */
function project(on: On, files: Record<string, string>) {
  const seen = { toasts: [] as string[], reads: [] as string[] }
  on('tool.call', () => ({ result: 'ok' }))
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const COUNTER = [
  'import { useState } from "react"',
  'export default function Counter() {',
  '  const [n, setN] = useState(0)',
  '  return <button onClick={() => setN(n + 1)}>{n}</button>',
  '}',
].join('\n')

test('tells Claude when a component uses hooks or handlers but has no "use client"', async ($, on) => {
  const seen = project(on, { '/repo/package.json': NEXT_PACKAGE, '/repo/app/counter.tsx': COUNTER })
  const result = await $.tool.call({ tool: 'Write', file_path: '/repo/app/counter.tsx', content: COUNTER })
  const note = result.context?.[0] ?? ''
  expect(note).toContain('next-guard: 1 note on /repo/app/counter.tsx:')
  expect(note).toContain("warn: uses useState, onClick but has no 'use client'")
  expect(seen.toasts).toEqual(["1 'use client' note for counter.tsx"])
})

test('tells Claude when a "use client" file imports server-only modules, with the line', async ($, on) => {
  const source = [
    "'use client'",
    "import fs from 'node:fs'",
    "import { cookies } from 'next/headers'",
    "import { db } from '@/lib/db'",
    "import { prisma } from '../server/prisma'",
    "import { useState } from 'react'",
    "import type { Pool } from 'pg'",
    'export default function C() { const [a] = useState(0); return <p>{a}</p> }',
  ].join('\n')
  project(on, { '/repo/package.json': NEXT_PACKAGE, '/repo/src/app/c.tsx': source })
  const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app/c.tsx', old_string: 'a', new_string: 'b' })
  const note = result.context?.[0] ?? ''
  expect(note).toContain('(line 2): a \'use client\' file imports node:fs')
  expect(note).toContain('(line 3): a \'use client\' file imports next/headers')
  expect(note).toContain('(line 4): a \'use client\' file imports @/lib/db')
  expect(note).toContain('(line 5): a \'use client\' file imports ../server/prisma')
  expect(note).not.toContain('imports react')
  expect(note).not.toContain('imports pg')
})

test('hints at a needless "use client", unless hintUnneeded is off', async ($, on) => {
  const source = "'use client'\nexport default function Title({ text }: { text: string }) {\n  return <h1>{text}</h1>\n}\n"
  project(on, { '/repo/package.json': NEXT_PACKAGE, '/repo/app/title.tsx': source })
  const result = await $.tool.call({ tool: 'Write', file_path: '/repo/app/title.tsx', content: source })
  expect(result.context?.[0]).toContain("hint: marked 'use client' but no hooks, event handlers or browser APIs were found")
})

test('no hint when hintUnneeded is off', { options: { hintUnneeded: false } }, async ($, on) => {
  const source = "'use client'\nexport default function Title() {\n  return <h1>hi</h1>\n}\n"
  project(on, { '/repo/package.json': NEXT_PACKAGE, '/repo/app/title.tsx': source })
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/app/title.tsx', content: source })).context).toBeUndefined()
})

test('stays silent outside Next.js projects, outside app/, and for non-code files', async ($, on) => {
  const seen = project(on, {
    '/repo/package.json': JSON.stringify({ dependencies: { react: '19' } }),
    '/next/package.json': NEXT_PACKAGE,
    '/repo/app/counter.tsx': COUNTER,
    '/next/lib/counter.tsx': COUNTER,
    '/next/app/README.md': COUNTER,
  })
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/app/counter.tsx', content: COUNTER })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/next/lib/counter.tsx', content: COUNTER })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/next/app/README.md', content: COUNTER })).context).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('finds the package.json of a monorepo app, and reads it once', async ($, on) => {
  const seen = project(on, { '/repo/apps/web/package.json': NEXT_PACKAGE, '/repo/apps/web/app/a.tsx': COUNTER, '/repo/apps/web/app/b.tsx': COUNTER })
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/apps/web/app/a.tsx', content: COUNTER })).context?.[0]).toContain('useState')
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/apps/web/app/b.tsx', content: COUNTER })).context?.[0]).toContain('useState')
  expect(seen.reads.filter(path => path.endsWith('package.json'))).toEqual(['/repo/apps/web/package.json'])
})

test('what counts as a client feature, and what does not', () => {
  const features = (source: string) => clientFeatures(source)
  expect(features('const [a] = useState(0)')).toEqual(['useState'])
  expect(features('useEffect(() => {}, []); const r = useRouter()')).toEqual(['useEffect', 'useRouter'])
  expect(features('const c = useCart()')).toEqual(['useCart'])
  expect(features('<input onChange={f} onFocus={g} />')).toEqual(['onChange', 'onFocus'])
  expect(features('window.scrollTo(0, 0); localStorage.getItem("a")')).toEqual(['window', 'localStorage'])
  expect(features('const ctx = createContext(null)')).toEqual(['createContext'])
  expect(features('dynamic(() => import("x"), { ssr: false })')).toEqual(['ssr: false'])

  expect(features('const v = useMemo(() => 1, []); const f = useCallback(() => 2, []); const id = useId()')).toEqual([])
  expect(features('const t = useTranslations("home")')).toEqual([])
  expect(features('if (typeof window !== "undefined") {}')).toEqual([])
  expect(features('const s = "onClick={}" + "window.x" // useState(0)')).toEqual([])
  expect(features('const x = use(promise)')).toEqual([])
})

test('error.tsx must be a client component, "use server" files and route handlers are skipped', () => {
  const options = { hintUnneeded: true }
  expect(checkComponent('export default function E() { return <p>x</p> }', '/app/error.tsx', options).map(f => f.kind)).toEqual(['error-boundary'])
  expect(checkComponent("'use client'\nexport default function E() { return <p>x</p> }", '/app/error.tsx', options)).toEqual([])
  expect(checkComponent("'use server'\nimport fs from 'fs'\nexport async function a() {}", '/app/actions.ts', options)).toEqual([])
  expect(checkComponent("import { useState } from 'react'\nexport function GET() { useState(0) }", '/app/api/route.ts', options)).toEqual([])
  expect(checkComponent("export function useCart() { const [a] = useState(0); return a }", '/app/hooks.ts', options)).toEqual([])
})

test('a "use client" file that exports metadata, and a foreign import that may need the client', () => {
  const options = { hintUnneeded: true }
  const withMetadata = "'use client'\nexport const metadata = { title: 'x' }\nexport default function P() { const [a] = useState(0); return <p>{a}</p> }"
  expect(checkComponent(withMetadata, '/app/page.tsx', options).map(f => f.kind)).toEqual(['metadata'])
  const animated = "'use client'\nimport { motion } from 'framer-motion'\nexport default function A() { return <motion.div /> }"
  expect(checkComponent(animated, '/app/a.tsx', options)).toEqual([])
})

test('nextProjectDirs tells app/ and src/app/ from other folders', () => {
  expect(nextProjectDirs('/repo/app/page.tsx')).toEqual(['/repo'])
  expect(nextProjectDirs('/repo/src/app/page.tsx')).toEqual(['/repo'])
  expect(nextProjectDirs('/repo/apps/web/app/x/page.tsx')).toEqual(['/repo/apps/web'])
  expect(nextProjectDirs('/repo/src/components/a.tsx')).toEqual([])
  expect(nextProjectDirs('/repo/myapp/page.tsx')).toEqual([])
  expect(nextProjectDirs('/app/app/page.tsx')).toEqual(['/app', ''])
})

test('a project in a folder named app (a Docker WORKDIR /app) is still found', async ($, on) => {
  project(on, { '/app/package.json': NEXT_PACKAGE, '/app/app/page.tsx': COUNTER })
  expect((await $.tool.call({ tool: 'Write', file_path: '/app/app/page.tsx', content: COUNTER })).context?.[0]).toContain('useState')
})

test('regression: a 300 KB client file of imports is checked in well under a second', () => {
  let source = "'use client'\n"
  for (let i = 0; source.length < 300_000; i += 1) source += `import { thing${i} } from './lib/module-${i}'\n`
  source += "import fs from 'fs'\n"
  const started = performance.now()
  const findings = checkComponent(source, '/app/page.tsx', { hintUnneeded: false })
  expect(performance.now() - started).toBeLessThan(500)
  expect(findings.find(finding => finding.kind === 'server-import')?.line).toBe(source.split('\n').length - 1)
})
