import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { analyze, boundNames } from '../hooks/analyze'
import { scan } from '../hooks/scan'

const at = (source: string, needle: string): number => source.slice(0, source.indexOf(needle)).split('\n').length
const rules = (source: string) => analyze(source).map(issue => `${issue.line} ${issue.rule}`)

const CONDITIONAL = `import { useState, useEffect, useMemo, useCallback } from 'react'

function Search({ query, items }) {
  if (query) {
    const [page, setPage] = useState(1)
  }
  for (const item of items) {
    useEffect(() => {}, [item])
  }
  const handler = () => useCallback(() => {}, [])
  const value = query ? useMemo(() => 1, []) : 0
  return <div onClick={handler}>{value}</div>
}

export function Gate({ user }) {
  if (!user) return null
  const [open, setOpen] = useState(false)
  return <p>{open ? 'yes' : 'no'}</p>
}
`

const DEPS = `import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export default function Profile({ userId, onLoad }: { userId: string; onLoad: (u: User) => void }) {
  const [user, setUser] = useState<User | null>(null)
  const ref = useRef<User | null>(null)
  const label = \`user \${userId}\`
  useEffect(() => {
    const controller = new AbortController()
    fetchUser(userId, { signal: controller.signal }).then(u => {
      setUser(u)
      onLoad(u)
      ref.current = u
    })
    return () => controller.abort()
  }, [])
  const title = useMemo(() => label.toUpperCase(), [label])
  const save = useCallback(() => api.save({ ...user }), [])
  const total = useMemo(() => user?.items.length)
  return <h1 title={title} onClick={save}>{total}</h1>
}
`

const RENDER = `const List = ({ rows }) => {
  const [count, setCount] = useState(0)
  setCount(count + 1)
  useEffect(async () => { await track(count) }, [count])
  return (
    <ul>
      {rows.map(row => <li>{row.label}</li>)}
      {rows.map((row) => (
        <>
          <dt>{row.term}</dt>
        </>
      ))}
      {rows.map(row => {
        const id = row.id
        return <Row key={id} row={row} />
      })}
      <button onClick={setCount(0)}>Don't reset</button>
      <button onClick={() => setCount(0)}>Reset</button>
    </ul>
  )
}
`

const CLEAN = `'use client'
import React, { forwardRef, memo, useEffect, useReducer, useState } from 'react'

// Remember: useState(1) inside an if is wrong. Docs say "useEffect(() => {}, [])" runs once.
export const useToggle = (initial = false) => {
  const [on, setOn] = useState(initial)
  const toggle = React.useCallback(() => setOn(value => !value), [])
  return [on, toggle] as const
}

export const Card = memo(function Card({ title, items, onPick }: CardProps) {
  const [state, dispatch] = useReducer(reducer, { picked: null })
  const [prevTitle, setPrevTitle] = useState(title)
  if (prevTitle !== title) {
    setPrevTitle(title)
  }
  useEffect(() => {
    document.title = \`\${title} (\${items.length})\`
    dispatch({ type: 'reset' })
  }, [title, items.length])
  return (
    <section>
      <h2>{title}'s picks</h2>
      <p>Don't worry, it's "fine" — 3 < 4 and 5 > 2</p>
      {items.map(item => (
        <Item key={item.id} {...item} onClick={() => onPick(item)} />
      ))}
    </section>
  )
})

export const Input = forwardRef<HTMLInputElement, Props>((props, ref) => {
  const [value, setValue] = useState('')
  return <input ref={ref} value={value} onChange={e => setValue(e.target.value)} {...props} />
})
`

test('finds conditional hooks, hooks in loops and callbacks, and hooks after an early return', () => {
  expect(rules(CONDITIONAL)).toEqual([
    `${at(CONDITIONAL, 'useState(1)')} conditional-hook`,
    `${at(CONDITIONAL, 'useEffect(')} hook-in-loop`,
    `${at(CONDITIONAL, 'useCallback(')} hook-in-callback`,
    `${at(CONDITIONAL, 'useMemo(')} conditional-hook`,
    `${at(CONDITIONAL, 'useState(false)')} hook-after-return`,
  ])
})

test('finds missing dependencies and memo hooks without a dependency array, but not stable values', () => {
  const issues = analyze(DEPS)
  expect(issues.map(issue => issue.message)).toEqual([
    'useEffect in Profile is missing dependencies: userId, onLoad',
    'useCallback in Profile is missing a dependency: user',
    'useMemo has no dependency array, so it recomputes on every render',
  ])
  expect(issues[0]?.line).toBe(at(DEPS, 'useEffect('))
})

test('finds setState during render and .map() elements without keys', () => {
  expect(analyze(RENDER).map(issue => `${issue.line} ${issue.message}`)).toEqual([
    `${at(RENDER, 'setCount(count + 1)')} setCount(…) is called while List renders, which re-renders it again and again; move it into an effect or an event handler`,
    `${at(RENDER, 'useEffect(')} useEffect gets an async function, which returns a promise instead of a cleanup; call an async function from inside the effect`,
    `${at(RENDER, '<li>')} <li> returned from .map() has no key prop`,
    `${at(RENDER, '<>')} a fragment <>…</> returned from .map() cannot take a key; use <Fragment key={…}>`,
    `${at(RENDER, 'onClick={setCount(0)}')} setCount(…) is called while List renders (a prop like onClick={setCount(…)}); pass a function instead: () => setCount(…)`,
  ])
})

test('stays quiet on correct code: comments, strings, JSX text, memo, forwardRef, state adjusted in an if', () => {
  expect(analyze(CLEAN)).toEqual([])
  const { code } = scan(`const a = "it's"; // useState(\nconst b = <p>Don't {x}</p>`)
  expect(code).not.toContain('useState')
  expect(code).not.toContain("Don't")
  expect(code).toContain('{x}')
  expect(boundNames('{ a, b: c, d = 1, ...rest }: Props, [e, [f]], g: string')).toEqual(['a', 'c', 'd', 'rest', 'e', 'f', 'g'])
})

type World = { files: Record<string, string>; statuses: (string | undefined)[]; runs: (readonly string[])[] }

/** A project on a virtual disk; the bottom `tool.call` applies Edit and Write as the tools would. */
const world = (on: On, files: Record<string, string>, eslint?: { exitCode: number; stdout: string }): World => {
  const w: World = { files, statuses: [], runs: [] }
  on('session.cwd', () => ({ value: '/app' }))
  on('fs.read', ($, e) => (e.path in w.files ? { value: w.files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('fs.exists', ($, e) => ({ value: e.path in w.files || (eslint !== undefined && e.path.startsWith('/app/node_modules/')) }))
  on('process.run', ($, e) => {
    w.runs.push(e.argv)
    return { value: { exitCode: eslint?.exitCode ?? 2, stdout: eslint?.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Write') w.files[e.file_path] = e.content
    if (e.tool === 'Edit') w.files[e.file_path] = (w.files[e.file_path] ?? '').replace(e.old_string, e.new_string)
    return { result: { type: 'update' } }
  })
  return w
}

const ISSUE_FREE = 'export function Hello({ name }) {\n  return <p>Hello {name}</p>\n}\n'

test('notes new issues on the edit result once, with file:line, and shows them in the status line', async ($, on) => {
  const w = world(on, { '/app/src/List.tsx': ISSUE_FREE })
  const first = await $.tool.call({ tool: 'Write', file_path: '/app/src/List.tsx', content: RENDER })
  expect(first.context).toEqual([
    [
      'react-doctor found React issues in src/List.tsx:',
      `- src/List.tsx:3 setCount(…) is called while List renders, which re-renders it again and again; move it into an effect or an event handler`,
      '- src/List.tsx:4 useEffect gets an async function, which returns a promise instead of a cleanup; call an async function from inside the effect',
      '- src/List.tsx:7 <li> returned from .map() has no key prop',
      '- src/List.tsx:9 a fragment <>…</> returned from .map() cannot take a key; use <Fragment key={…}>',
      '- src/List.tsx:17 setCount(…) is called while List renders (a prop like onClick={setCount(…)}); pass a function instead: () => setCount(…)',
      'Fix them, or say why one is intentional.',
    ].join('\n'),
  ])
  expect(w.statuses.at(-1)).toBe('⚛ 5 React issues · List.tsx')

  const again = await $.tool.call({ tool: 'Edit', file_path: '/app/src/List.tsx', old_string: '<li>{row.label}</li>', new_string: '<li key={row.id}>{row.label}</li>' })
  expect(again.context ?? []).toEqual([])
  expect(w.statuses.at(-1)).toBe('⚛ 4 React issues · List.tsx')

  const back = await $.tool.call({ tool: 'Edit', file_path: '/app/src/List.tsx', old_string: '<li key={row.id}>{row.label}</li>', new_string: '<li>{row.label}</li>' })
  expect(back.context?.[0]).toBe('react-doctor found React issues in src/List.tsx:\n- src/List.tsx:7 <li> returned from .map() has no key prop\nFix them, or say why one is intentional.')

  await $.tool.call({ tool: 'Write', file_path: '/app/src/List.tsx', content: ISSUE_FREE })
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.runs).toEqual([])
})

test('checks hooks files that import react, and skips other scripts', async ($, on) => {
  const hook = "import { useEffect } from 'react'\nexport function useTicker(ms) {\n  useEffect(() => {\n    const id = setInterval(tick, ms)\n    return () => clearInterval(id)\n  }, [])\n}\n"
  world(on, {})
  const checked = await $.tool.call({ tool: 'Write', file_path: '/app/src/useTicker.ts', content: hook })
  expect(checked.context?.[0]).toContain('- src/useTicker.ts:3 useEffect in useTicker is missing a dependency: ms')
  const skipped = await $.tool.call({ tool: 'Write', file_path: '/app/src/math.ts', content: 'export function useless(a) { if (a) useless(a - 1) }\n' })
  expect(skipped.context ?? []).toEqual([])
})

test("prefers the project's eslint-plugin-react-hooks for the hook rules", async ($, on) => {
  const report = JSON.stringify([
    {
      filePath: '/app/src/List.tsx',
      messages: [
        { ruleId: 'react-hooks/exhaustive-deps', line: 3, message: "React Hook useEffect has a missing dependency: 'rows'. Either include it or remove the dependency array." },
        { ruleId: 'no-unused-vars', line: 1, message: "'x' is defined but never used." },
      ],
    },
  ])
  const w = world(on, {}, { exitCode: 1, stdout: report })
  const source = 'const List = ({ rows }) => {\n  const [n, setN] = useState(0)\n  useEffect(() => { setN(rows.length) }, [])\n  return <ul>{rows.map(r => <li>{r}</li>)}</ul>\n}\n'
  const ran = await $.tool.call({ tool: 'Write', file_path: '/app/src/List.tsx', content: source })
  expect(w.runs[0]).toEqual([
    '/app/node_modules/.bin/eslint', '--format', 'json', '--rule', 'react-hooks/rules-of-hooks: error', '--rule', 'react-hooks/exhaustive-deps: warn', '/app/src/List.tsx',
  ])
  expect(ran.context?.[0]).toBe(
    [
      'eslint-plugin-react-hooks and react-doctor found React issues in src/List.tsx:',
      "- src/List.tsx:3 React Hook useEffect has a missing dependency: 'rows'",
      '- src/List.tsx:4 <li> returned from .map() has no key prop',
      'Fix them, or say why one is intentional.',
    ].join('\n'),
  )
})

test('falls back to its own check when ESLint cannot run the rules, and can be told not to use ESLint', { options: { useEslint: false } }, async ($, on) => {
  const w = world(on, {}, { exitCode: 2, stdout: '' })
  const ran = await $.tool.call({ tool: 'Write', file_path: '/app/src/Profile.tsx', content: DEPS })
  expect(w.runs).toEqual([])
  expect(ran.context?.[0]).toContain('useEffect in Profile is missing dependencies: userId, onLoad')
})

test('treats a file ESLint ignores as not linted, and checks it itself', async ($, on) => {
  const ignored = JSON.stringify([{ filePath: '/app/src/Profile.tsx', messages: [{ ruleId: null, fatal: false, message: 'File ignored because no matching configuration was supplied.' }] }])
  const w = world(on, {}, { exitCode: 0, stdout: ignored })
  const ran = await $.tool.call({ tool: 'Write', file_path: '/app/src/Profile.tsx', content: DEPS })
  expect(w.runs).toHaveLength(1)
  expect(ran.context?.[0]?.startsWith('react-doctor found React issues in src/Profile.tsx:')).toBe(true)
  expect(ran.context?.[0]).toContain('useEffect in Profile is missing dependencies: userId, onLoad')
})

test('regression: a 300 KB file of components is analysed in well under a second', () => {
  const unit = (i: number) =>
    `function Row${i}({ rows, id }) {\n  const [count, setCount] = useState(0)\n  useEffect(() => { load(id) }, [])\n  return <ul>{rows.map(row => <li>{row.label}</li>)}</ul>\n}\n`
  let source = ''
  for (let i = 0; source.length < 300_000; i += 1) source += unit(i)
  const started = performance.now()
  const issues = analyze(source)
  const ranged = analyze(source, { from: 100, to: 200 })
  expect(performance.now() - started).toBeLessThan(500)
  expect(issues.length).toBeGreaterThan(1000)
  expect(issues.at(-1)?.line).toBeGreaterThan(source.split('\n').length - 10)
  expect(ranged.every(issue => issue.line >= 96 && issue.line <= 205)).toBe(true)
})
