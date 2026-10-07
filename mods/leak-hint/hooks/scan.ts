import { closingBrace, mask } from './mask'
import { lineFinder, lineText } from './shared/line-index'

/** One place where something is started that nothing visibly stops. `key` says which, so an edit can be told from what was there. */
export type Leak = { line: number; key: string; message: string }

type KindId = 'listener' | 'interval' | 'timeout' | 'subscription' | 'emitter' | 'socket' | 'observer'
type Kind = {
  id: KindId
  /** The call that starts it, matched on masked text. */
  add: RegExp
  /** What stops it, matched on the cleanup's text. */
  remove: RegExp
  noun: (event: string | undefined) => string
  /** What the cleanup has to do, as an instruction. */
  fix: string
  /** The event name is the first string argument. */
  hasEvent?: true
}
type Hit = { kind: Kind; index: number; event: string | undefined; receiver: string | undefined }
type Span = readonly [open: number, close: number]

const quoted = (event: string | undefined, what: string): string => (event === undefined || event === '' ? `a ${what}` : `a "${event}" ${what}`)

const KINDS: readonly Kind[] = [
  { id: 'listener', add: /\baddEventListener\s*\(/g, remove: /\bremoveEventListener\s*\(|\babort\s*\(/, noun: event => quoted(event, 'listener'), fix: 'call removeEventListener', hasEvent: true },
  { id: 'interval', add: /\bsetInterval\s*\(/g, remove: /\bclearInterval\s*\(/, noun: () => 'an interval', fix: 'call clearInterval' },
  { id: 'timeout', add: /\bsetTimeout\s*\(/g, remove: /\bclearTimeout\s*\(/, noun: () => 'a timeout', fix: 'call clearTimeout' },
  {
    id: 'subscription',
    add: /\.subscribe\s*\(/g,
    remove: /\b(?:unsubscribe|dispose|disconnect|close|cancel|abort|stop|unsub\w*)\b/,
    noun: () => 'a subscription',
    fix: 'unsubscribe',
  },
  {
    id: 'emitter',
    add: /\.(?:on|addListener)\s*\(/g,
    remove: /\.(?:off|removeListener|removeAllListeners|removeEventListener)\s*\(|\bunsubscribe\b|\bdispose\b/,
    noun: event => quoted(event, 'handler'),
    fix: 'remove it with off()',
    hasEvent: true,
  },
  { id: 'socket', add: /\bnew\s+(?:WebSocket|EventSource)\s*\(/g, remove: /\.close\s*\(/, noun: () => 'a connection', fix: 'close it' },
  { id: 'observer', add: /\.observe\s*\(/g, remove: /\.(?:disconnect|unobserve)\s*\(/, noun: () => 'an observer', fix: 'call disconnect()' },
]
/** A timeout that fires once is rarely worth a hint outside a component's effect. */
const WITHOUT_TIMEOUT = KINDS.filter(kind => kind.id !== 'timeout')

const EFFECT_HOOKS = 'useEffect|useLayoutEffect|useInsertionEffect|onMount'
const CALLBACK = String.raw`(?:async\s+)?(?:function\b[^(]*\([^)]*\)|\([^)]*\)(?:\s*:\s*[\w<>\[\]|.]+)?\s*=>|[\w$]+\s*=>)`
const callbackBlock = (names: string): RegExp => new RegExp(String.raw`\b(${names})\s*\(\s*${CALLBACK}\s*\{`, 'g')
const callbackExpression = (names: string): RegExp => new RegExp(String.raw`\b(${names})\s*\(\s*(?:\([^)]*\)|[\w$]+)\s*=>\s*(?=[^\s{])`, 'g')

/** A returned function, or a returned name that says it cleans up: what React and Svelte run when the effect ends. */
const CLEANUP_RETURN =
  /\breturn\s+(?:\([^()]*\)(?:\s*:\s*[\w<>[\]|.]+)?\s*=>|[\w$]+\s*=>|function\b|async\b|[\w$.]*(?:unsub|cleanup|clean|dispose|stop|off|remove|cancel|teardown|close|abort|clear|destroy|disconnect)[\w$.]*\s*(?:[;}\n]|$))/i

/** `return store.subscribe(fn)`: the call's own result (an unsubscribe function) is what the effect returns. */
const RETURNED_CALL = /\breturn\s+[\w$]+(?:\??\.[\w$]+)*\s*$/
const RETURNS_ITS_STOP: ReadonlySet<KindId> = new Set(['subscription', 'emitter'])

const CLASS_HEAD = /\bclass\s+([\w$]+)?[^{;]*\{/g
const METHOD_HEAD =
  /^[ \t]*(?:(?:public|private|protected|static|async|override|readonly)\s+)*(?:get\s+|set\s+)?(\[Symbol\.(?:async)?[dD]ispose\]|[\w$]+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{/gm
const SETUP_METHODS =
  /^(?:constructor|componentDidMount|ngOnInit|ngAfterViewInit|ngAfterContentInit|connectedCallback|onInit|onModuleInit|onApplicationBootstrap|init|initialize|mounted|created|start|setup|attach|bind|mount)$/
const TEARDOWN_METHODS =
  /^(?:componentWillUnmount|ngOnDestroy|onDestroy|disconnectedCallback|dispose|destroy|unmounted|beforeUnmount|onModuleDestroy|close|stop|teardown|cleanup|unmount|detach|unbind|shutdown|\[Symbol\.(?:async)?[dD]ispose\])$/
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with'])
/** An RxJS subscription that ends by itself or with the component. */
const SELF_ENDING = /\btakeUntil(?:Destroyed)?\b|\btakeUntilDestroyed\b|\bDestroyRef\b|\.pipe\(\s*(?:take|first)\(/

const VUE_SETUP = callbackBlock('onMounted')
const VUE_TEARDOWN = /\bon(?:Unmounted|BeforeUnmount|Deactivated|ScopeDispose)\s*\(/
const VUE_OPTIONS_SETUP = /\b(mounted|created|beforeMount)\s*(?::\s*(?:async\s+)?function\s*)?\(\s*\)\s*\{/g
const VUE_OPTIONS_TEARDOWN = /\b(?:beforeUnmount|unmounted|beforeDestroy|destroyed)\s*(?::\s*(?:async\s+)?function\s*)?\(/

const HANDLER_HEADS: readonly RegExp[] = [
  /\(\s*(?:req|request|ctx)\b[^)]*\)(?:\s*:\s*[^={]+)?\s*=>\s*\{/g,
  /\b(?:req|request)\s*=>\s*\{/g,
  /\bfunction\s*[\w$]*\s*\(\s*(?:req|request|ctx)\b[^)]*\)(?:\s*:\s*[^{]+)?\s*\{/g,
]

/** `{ ... }` ranges of functions declared inside `masked`: what runs later, not while the surrounding code starts things. */
const nestedFunctions = (masked: string): Span[] => {
  const spans: Span[] = []
  for (const head of masked.matchAll(/=>\s*\{|\bfunction\b[^(]*\([^)]*\)\s*(?::\s*[^{;]+)?\{/g)) {
    const open = head.index + head[0].length - 1
    const close = closingBrace(masked, open)
    if (close !== -1) spans.push([open, close])
  }
  return spans
}

const receiverBefore = (masked: string, index: number): string | undefined =>
  /([\w$]+(?:\??\.[\w$]+)*)\s*$/.exec(masked.slice(Math.max(0, index - 80), index))?.[1]

/** The calls in `masked` that start something, as `kinds` list them; `original` has the event names the masked text blanked. */
const hitsIn = (masked: string, original: string, kinds: readonly Kind[], isNestedSkipped: boolean): Hit[] => {
  const nested = isNestedSkipped ? nestedFunctions(masked) : []
  const hits: Hit[] = []
  for (const kind of kinds) {
    for (const match of masked.matchAll(kind.add)) {
      const index = match.index
      if (nested.some(([open, close]) => index > open && index < close)) continue
      const event = kind.hasEvent === undefined ? undefined : /^[^(]*\(\s*(['"`])([^'"`]*)\1/.exec(original.slice(index, index + 160))?.[2]
      const receiver = kind.id === 'emitter' ? receiverBefore(masked, index) : undefined
      if (receiver === 'this') continue
      hits.push({ kind, index, event, receiver })
    }
  }
  return hits.sort((a, b) => a.index - b.index)
}

const firstOfEach = (hits: readonly Hit[]): Hit[] => [...new Map(hits.map(hit => [`${hit.kind.id}:${hit.event ?? ''}`, hit] as const).reverse()).values()].sort((a, b) => a.index - b.index)

class Source {
  readonly masked: string
  private readonly lineFor: (offset: number) => number

  constructor(readonly original: string) {
    this.masked = mask(original)
    this.lineFor = lineFinder(original)
  }

  lineOf(index: number): number {
    return this.lineFor(index)
  }

  /** The trimmed line an offset is on, which names a finding without its line number. */
  textOfLine(index: number): string {
    return lineText(this.original, this.lineOf(index)).trim()
  }

  leak(rule: string, index: number, message: string): Leak {
    return { line: this.lineOf(index), key: `${rule}|${this.textOfLine(index)}|${message}`, message }
  }
}

const effectLeaks = (source: Source): Leak[] => {
  const leaks: Leak[] = []

  for (const head of source.masked.matchAll(callbackBlock(EFFECT_HOOKS))) {
    const hook = head[1] ?? 'useEffect'
    const open = head.index + head[0].length - 1
    const close = closingBrace(source.masked, open)
    if (close === -1) continue
    const body = source.masked.slice(open + 1, close)
    const hits = firstOfEach(hitsIn(body, source.original.slice(open + 1, close), KINDS, true))
    const cleanup = CLEANUP_RETURN.exec(body)
    const cleanupText = cleanup === null ? undefined : body.slice(cleanup.index)

    for (const { kind, event, index } of hits) {
      if (RETURNS_ITS_STOP.has(kind.id) && RETURNED_CALL.test(body.slice(Math.max(0, index - 80), index))) continue
      const noun = kind.noun(event)
      if (cleanupText === undefined) {
        leaks.push(source.leak('effect', open + 1 + index, `${hook} adds ${noun} but returns no cleanup function; it should ${kind.fix} when the effect ends.`))
      } else if (!kind.remove.test(cleanupText)) {
        leaks.push(source.leak('effect', open + 1 + index, `${hook} adds ${noun}, but its cleanup does not ${kind.fix}, so it outlives the effect.`))
      }
    }
  }

  // `useEffect(() => window.addEventListener(...))` returns the call's result, which is not a cleanup.
  for (const head of source.masked.matchAll(callbackExpression(EFFECT_HOOKS))) {
    const start = head.index + head[0].length
    const end = expressionEnd(source.masked, start)
    const hits = hitsIn(source.masked.slice(start, end), source.original.slice(start, end), KINDS.filter(kind => kind.id !== 'subscription'), false)
    const [first] = hits
    if (first !== undefined) {
      const message = `${head[1]} adds ${first.kind.noun(first.event)} in an arrow function that returns the call's result, which is not a cleanup; use a block body and return a function that will ${first.kind.fix}.`
      leaks.push(source.leak('effect', start + first.index, message))
    }
  }
  return leaks
}

/** Index of the `,` or `)` that ends the expression starting at `start`. */
const expressionEnd = (masked: string, start: number): number => {
  let depth = 0
  for (let i = start; i < masked.length; i++) {
    const char = masked[i]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return i
      depth -= 1
    } else if (char === ',' && depth === 0) return i
  }
  return masked.length
}

/** Vue: what `onMounted` or `mounted()` starts must be stopped by an unmount hook. */
const vueLeaks = (source: Source): Leak[] => {
  const leaks: Leak[] = []
  const setups = [
    ...[...source.masked.matchAll(VUE_SETUP)].map(head => ({ head, name: 'onMounted', teardown: VUE_TEARDOWN, hint: 'onUnmounted or onBeforeUnmount' })),
    ...[...source.masked.matchAll(VUE_OPTIONS_SETUP)].map(head => ({ head, name: `${head[1]}()`, teardown: VUE_OPTIONS_TEARDOWN, hint: 'beforeUnmount or unmounted' })),
  ]
  for (const { head, name, teardown, hint } of setups) {
    const open = head.index + head[0].length - 1
    const close = closingBrace(source.masked, open)
    if (close === -1) continue
    const elsewhere = source.masked.slice(0, open) + source.masked.slice(close)
    const hits = firstOfEach(hitsIn(source.masked.slice(open + 1, close), source.original.slice(open + 1, close), WITHOUT_TIMEOUT, true))
    for (const { kind, event, index } of hits) {
      const noun = kind.noun(event)
      const at = open + 1 + index
      if (!teardown.test(elsewhere)) leaks.push(source.leak('vue', at, `${name} adds ${noun} but there is no ${hint} hook to ${kind.fix}.`))
      else if (!kind.remove.test(elsewhere)) leaks.push(source.leak('vue', at, `${name} adds ${noun}, but no ${hint} hook does ${kind.fix.replace(/^call /, '')}.`))
    }
  }
  return leaks
}

type Method = { name: string; open: number; close: number }

/** The methods declared directly in the class whose body is `open`..`close`. */
const methodsOf = (source: Source, open: number, close: number): Method[] => {
  const body = source.masked.slice(open, close + 1)
  const depths: number[] = []
  let depth = 0
  for (const char of body) {
    if (char === '{') depth += 1
    depths.push(depth)
    if (char === '}') depth -= 1
  }
  const methods: Method[] = []
  for (const head of body.matchAll(METHOD_HEAD)) {
    const name = head[1] ?? ''
    const braceAt = head.index + head[0].length - 1
    if (NOT_METHODS.has(name) || depths[braceAt] !== 2) continue
    const end = closingBrace(source.masked, open + braceAt)
    if (end !== -1) methods.push({ name, open: open + braceAt, close: end })
  }
  return methods
}

/** Classes: what a setup method starts must be stopped by a teardown method. */
const classLeaks = (source: Source): Leak[] => {
  const leaks: Leak[] = []
  for (const head of source.masked.matchAll(CLASS_HEAD)) {
    const open = head.index + head[0].length - 1
    const close = closingBrace(source.masked, open)
    if (close === -1) continue
    const className = head[1] ?? 'the class'
    const methods = methodsOf(source, open, close)
    const teardowns = methods.filter(method => TEARDOWN_METHODS.test(method.name))
    const teardownText = teardowns.map(method => source.masked.slice(method.open, method.close)).join('\n')
    const isSelfEnding = SELF_ENDING.test(source.masked.slice(open, close))

    for (const method of methods.filter(candidate => SETUP_METHODS.test(candidate.name))) {
      const bodyMasked = source.masked.slice(method.open + 1, method.close)
      const hits = firstOfEach(hitsIn(bodyMasked, source.original.slice(method.open + 1, method.close), WITHOUT_TIMEOUT, true))
      for (const { kind, event, index } of hits) {
        if (kind.id === 'subscription' && isSelfEnding) continue
        const at = method.open + 1 + index
        const where = `${className}.${method.name}()`
        const noun = kind.noun(event)
        if (teardowns.length === 0) {
          leaks.push(source.leak('class', at, `${where} adds ${noun} but ${className} has no teardown method (componentWillUnmount, ngOnDestroy, disconnectedCallback, dispose...) to ${kind.fix}.`))
        } else if (!kind.remove.test(teardownText)) {
          leaks.push(source.leak('class', at, `${where} adds ${noun}, but ${teardowns.map(teardown => `${teardown.name}()`).join(' / ')} does not ${kind.fix}.`))
        }
      }
    }
  }
  return leaks
}

/** The names a handler's own parameters and local variables give to things that live and die with one request. */
const requestScoped = (head: string, body: string): Set<string> => {
  const params = (/\(([^)]*)\)/.exec(head)?.[1] ?? head.replace(/=>.*$/s, '')).split(',').map(param => param.trim().split(/[\s:?=]/)[0] ?? '')
  const declared = [...body.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)].map(match => match[1] ?? '')
  return new Set([...params, ...declared].filter(name => name !== ''))
}

/** Request handlers: a listener added for every request on something that outlives the request piles up. */
const handlerLeaks = (source: Source): Leak[] => {
  const leaks: Leak[] = []
  for (const pattern of HANDLER_HEADS) {
    for (const head of source.masked.matchAll(pattern)) {
      const open = head.index + head[0].length - 1
      const close = closingBrace(source.masked, open)
      if (close === -1) continue
      const body = source.masked.slice(open + 1, close)
      const scoped = requestScoped(head[0], body)
      const hits = hitsIn(body, source.original.slice(open + 1, close), KINDS.filter(kind => kind.id === 'emitter' || kind.id === 'interval'), false)

      for (const { kind, event, index, receiver } of hits) {
        const at = open + 1 + index
        if (kind.id === 'interval') {
          if (!/\bclearInterval\s*\(/.test(body)) leaks.push(source.leak('handler', at, 'a request handler starts an interval that nothing clears, so every request leaves one running.'))
          continue
        }
        const root = receiver?.split(/\??\./)[0] ?? ''
        if (receiver === undefined || scoped.has(root) || new RegExp(`${receiver.replace(/[.?]/g, '\\$&')}\\s*\\.\\s*(?:off|removeListener|removeAllListeners)\\s*\\(`).test(body)) continue
        const what = `${receiver}.on(${event === undefined ? '' : `"${event}"`})`
        leaks.push(source.leak('handler', at, `a request handler calls ${what}, so every request adds another listener to something that outlives it. Register it once outside the handler, or remove it when the request ends.`))
      }
    }
  }
  return leaks
}

/** Every start-without-stop the source shows, in file order. A source that is not code this scan reads yields none. */
export const findLeaks = (code: string): Leak[] => {
  const source = new Source(code)
  return [...effectLeaks(source), ...vueLeaks(source), ...classLeaks(source), ...handlerLeaks(source)].sort((a, b) => a.line - b.line)
}

/** The findings in `after` that `before` did not already have: what an edit introduced. Same text on a different line is not new. */
export const introducedLeaks = (before: readonly Leak[], after: readonly Leak[]): Leak[] => {
  const known = new Map<string, number>()
  for (const leak of before) known.set(leak.key, (known.get(leak.key) ?? 0) + 1)
  return after.filter(leak => {
    const remaining = known.get(leak.key) ?? 0
    if (remaining > 0) known.set(leak.key, remaining - 1)
    return remaining === 0
  })
}
