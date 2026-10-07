import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'

import { mask } from '../hooks/mask'
import { findLeaks, introducedLeaks } from '../hooks/scan'

const CHART_BAD = `export function Chart() {
  useEffect(() => {
    window.addEventListener('resize', onResize)
  }, [])
  return null
}
`
const CHART_OK = `export function Chart() {
  useEffect(() => {
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return null
}
`

/** A disk (path → text) whose Edit and Write tools apply what they are asked to, as the engine's would. */
const world = (on: On, files: Record<string, string>, outcome: { isError?: true; text?: string } = {}) => {
  const toasts: string[] = []
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('tool.call', (_$, e) => {
    const input = e as Readonly<Record<string, string>>
    if (outcome.isError === undefined) {
      const path = input.file_path ?? ''
      if (e.tool === 'Write') files[path] = input.content ?? ''
      else files[path] = (files[path] ?? '').replace(input.old_string ?? '', input.new_string ?? '')
    }
    return { result: 'ok', text: outcome.text ?? 'ok', ...(outcome.isError === undefined ? {} : { isError: true as const }) }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { toasts, files }
}

test('flags a new effect that adds a listener and never removes it, and toasts', async ($, on) => {
  const { toasts } = world(on, {})

  const ran = await $.tool.call({ tool: 'Write', file_path: '/app/src/Chart.tsx', content: CHART_BAD })

  const [note] = ran.context ?? []
  expect(note).toContain('leak-hint: this edit to /app/src/Chart.tsx may have introduced a leak')
  expect(note).toContain('- line 3: useEffect adds a "resize" listener but returns no cleanup function; it should call removeEventListener')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('possible leak in Chart.tsx:3')
})

test('says nothing when the effect cleans up', async ($, on) => {
  const { toasts } = world(on, {})

  const ran = await $.tool.call({ tool: 'Write', file_path: '/app/src/Chart.tsx', content: CHART_OK })

  expect(ran.context).toBeUndefined()
  expect(toasts).toEqual([])
})

test('flags an edit that takes the cleanup away', async ($, on) => {
  world(on, { '/app/src/Chart.tsx': CHART_OK })

  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: '/app/src/Chart.tsx',
    old_string: "    return () => window.removeEventListener('resize', onResize)\n",
    new_string: '',
  })

  expect(ran.context?.[0]).toContain('useEffect adds a "resize" listener but returns no cleanup function')
})

test('does not repeat what the file already had before the edit', async ($, on) => {
  const { toasts } = world(on, { '/app/src/Chart.tsx': CHART_BAD })

  const ran = await $.tool.call({ tool: 'Edit', file_path: '/app/src/Chart.tsx', old_string: 'return null', new_string: 'return <canvas />' })

  expect(ran.context).toBeUndefined()
  expect(toasts).toEqual([])
})

test('notes only the new leak when an edit adds one beside an old one', async ($, on) => {
  world(on, { '/app/src/Chart.tsx': CHART_BAD })

  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: '/app/src/Chart.tsx',
    old_string: '  return null',
    new_string: '  useEffect(() => {\n    const id = setInterval(tick, 1000)\n  }, [])\n  return null',
  })

  expect(ran.context?.[0]).toContain('adds an interval')
  expect(ran.context?.[0]).not.toContain('resize')
})

test('flags a class that adds a listener in componentDidMount and has no componentWillUnmount', async ($, on) => {
  world(on, {})

  const ran = await $.tool.call({
    tool: 'Write',
    file_path: '/app/src/Panel.jsx',
    content: `class Panel extends Component {\n  componentDidMount() {\n    window.addEventListener('scroll', this.onScroll)\n  }\n}\n`,
  })

  expect(ran.context?.[0]).toContain('Panel.componentDidMount() adds a "scroll" listener but Panel has no teardown method')
})

test('flags a request handler that registers a process listener on every request', async ($, on) => {
  world(on, {})

  const ran = await $.tool.call({
    tool: 'Write',
    file_path: '/app/server.js',
    content: `app.get('/x', (req, res) => {\n  process.on('SIGTERM', () => res.end())\n  req.on('close', () => {})\n})\n`,
  })

  expect(ran.context?.[0]).toContain('a request handler calls process.on("SIGTERM")')
  expect(ran.context?.[0]).not.toContain('req.on')
})

test('leaves tests, dependencies, other languages and failed edits alone', async ($, on) => {
  const { toasts } = world(on, {})
  const paths = ['/app/src/Chart.test.tsx', '/app/node_modules/x/index.js', '/app/notes.md', '/app/src/__tests__/a.ts']

  for (const file_path of paths) {
    const ran = await $.tool.call({ tool: 'Write', file_path, content: CHART_BAD })
    expect(ran.context).toBeUndefined()
  }
  expect(toasts).toEqual([])
})

test('a failed edit is not commented on', async ($, on) => {
  const { toasts } = world(on, { '/app/src/Chart.tsx': CHART_BAD }, { isError: true, text: 'String to replace not found' })

  const ran = await $.tool.call({ tool: 'Edit', file_path: '/app/src/Chart.tsx', old_string: 'zzz', new_string: 'yyy' })

  expect(ran.context).toBeUndefined()
  expect(toasts).toEqual([])
})

test('the ignore option skips matching paths', { options: { ignore: 'legacy/' } }, async ($, on) => {
  world(on, {})

  const skipped = await $.tool.call({ tool: 'Write', file_path: '/app/legacy/Chart.tsx', content: CHART_BAD })
  const checked = await $.tool.call({ tool: 'Write', file_path: '/app/src/Chart.tsx', content: CHART_BAD })

  expect(skipped.context).toBeUndefined()
  expect(checked.context).toHaveLength(1)
})

const messages = (code: string) => findLeaks(code).map(leak => `${leak.line}: ${leak.message}`)

test('effects: a cleanup that misses one of the things started is named, timers in nested handlers are not counted', () => {
  expect(
    messages(`useEffect(() => {
  const id = setInterval(tick, 1000)
  window.addEventListener('scroll', onScroll)
  return () => clearInterval(id)
}, [])`),
  ).toEqual(['3: useEffect adds a "scroll" listener, but its cleanup does not call removeEventListener, so it outlives the effect.'])

  expect(
    messages(`useEffect(() => {
  const onClick = () => { setTimeout(() => setOpen(false), 100) }
  el.addEventListener('click', onClick)
  return () => el.removeEventListener('click', onClick)
}, [])`),
  ).toEqual([])
})

test('effects: subscriptions, abort signals, Svelte onMount and arrow-bodied effects', () => {
  expect(messages('useEffect(() => {\n  store$.subscribe(setValue)\n}, [])')).toHaveLength(1)
  expect(messages('useEffect(() => {\n  const sub = store$.subscribe(setValue)\n  return () => sub.unsubscribe()\n}, [])')).toEqual([])
  expect(messages("useEffect(() => {\n  const c = new AbortController()\n  window.addEventListener('x', h, { signal: c.signal })\n  return () => c.abort()\n}, [])")).toEqual([])
  expect(messages('onMount(() => {\n  const id = setInterval(tick, 1000)\n  return () => clearInterval(id)\n})')).toEqual([])
  expect(messages("useEffect(() => window.addEventListener('x', y), [])")[0]).toContain('returns the call\'s result')
})

test('classes: Angular subscriptions are fine with takeUntil, and this.on in an emitter is not a leak', () => {
  expect(messages('class A {\n  ngOnInit() {\n    this.items$.subscribe(x => {})\n  }\n}')).toHaveLength(1)
  expect(messages('class A {\n  ngOnInit() {\n    this.items$.pipe(takeUntil(this.done$)).subscribe(x => {})\n  }\n}')).toEqual([])
  expect(messages("class Foo extends EventEmitter {\n  constructor() {\n    super()\n    this.on('x', () => {})\n  }\n}")).toEqual([])
})

test('classes: a teardown that misses one of the things started is named', () => {
  expect(
    messages(`class P extends HTMLElement {
  connectedCallback() {
    window.addEventListener('resize', this.r)
    this.t = setInterval(this.tick, 1000)
  }
  disconnectedCallback() {
    clearInterval(this.t)
  }
}`),
  ).toEqual(['3: P.connectedCallback() adds a "resize" listener, but disconnectedCallback() does not call removeEventListener.'])
})

test('Vue: onMounted and mounted() need an unmount hook', () => {
  expect(messages("onMounted(() => {\n  window.addEventListener('resize', f)\n})")[0]).toContain('onMounted adds a "resize" listener but there is no onUnmounted or onBeforeUnmount hook')
  expect(messages("onMounted(() => { window.addEventListener('resize', f) })\nonBeforeUnmount(() => { window.removeEventListener('resize', f) })")).toEqual([])
  expect(messages('export default {\n  mounted() {\n    this.id = setInterval(this.tick, 1000)\n  },\n}')[0]).toContain('mounted() adds an interval')
})

test('handlers: listeners on the request, on locals and removed ones are fine; outer emitters and intervals are not', () => {
  expect(messages("app.get('/e', (req, res) => {\n  req.on('close', () => {})\n  const local = new EventEmitter()\n  local.on('x', () => {})\n})")).toEqual([])
  expect(messages("app.get('/e', (req, res) => {\n  const f = d => res.write(d)\n  bus.on('u', f)\n  req.on('close', () => bus.off('u', f))\n})")).toEqual([])
  expect(messages("app.get('/e', (req, res) => {\n  bus.on('u', f)\n})")).toHaveLength(1)
  expect(messages('app.get(\'/e\', (req, res) => {\n  setInterval(push, 1000)\n})')[0]).toContain('starts an interval that nothing clears')
})

test('strings, comments and templates never count as code', () => {
  const code = [
    'useEffect(() => {',
    '  const s = "window.addEventListener(\'x\', y) {"',
    "  // setInterval(tick, 1) {",
    '  const t = `${a} setInterval( ${b ? `x` : "y"} }`',
    '  return () => {}',
    '}, [])',
  ].join('\n')
  expect(messages(code)).toEqual([])
  expect(mask(code)).toHaveLength(code.length)
  expect(mask("a 'b {' /* { */ c // {\nd")).toBe("a '   '         c     \nd")
})

test('introducedLeaks ignores a finding that only moved to another line', () => {
  const before = findLeaks(CHART_BAD)
  const after = findLeaks(`// a new first line\n\n${CHART_BAD}`)

  expect(after[0]?.line).toBe(before[0]!.line + 2)
  expect(introducedLeaks(before, after)).toEqual([])
  expect(introducedLeaks([], after)).toHaveLength(1)
})

test('effects: returning the subscribe call itself returns its unsubscribe, so it is a cleanup', () => {
  expect(messages('useEffect(() => {\n  return store.subscribe(() => setState(store.getState()))\n}, [])')).toEqual([])
  expect(messages("useEffect(() => {\n  return navigation.addListener('focus', load)\n}, [navigation])")).toEqual([])
  expect(messages('useEffect(() => {\n  store.subscribe(render)\n  return () => {}\n}, [])')).toHaveLength(1)
})
