// Pure parts of the catalog: reading components and their props out of source text, searching,
// name similarity and the system prompt section. No `$` here.

import type { ComponentCatalogEntry, ComponentCatalogProp } from '../types'

export type Component = ComponentCatalogEntry
export type Prop = ComponentCatalogProp

const MAX_PURPOSE_CHARS = 110
const MAX_TYPE_CHARS = 60
const OPENERS: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' }
const CLOSERS = new Set([')', '}', ']', '>'])

/** Files that can hold components; tests, stories and declarations are skipped. */
export const COMPONENT_FILE = /\.(tsx|jsx|ts|js|mjs|vue|svelte)$/i
const SKIPPED_FILE = /\.(test|spec|stories|story|d)\.[a-z]+$|\.stories\.mdx$/i

export const isComponentFile = (path: string): boolean => COMPONENT_FILE.test(path) && !SKIPPED_FILE.test(path)

const baseName = (path: string): string => path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? path

/** `user-card` and `user_card` → `UserCard`; `index` takes the folder's name. */
export const componentNameFromPath = (path: string): string => {
  const parts = path.split(/[\\/]/)
  let base = baseName(path)
  if (/^index$/i.test(base) && parts.length >= 2) base = parts[parts.length - 2] ?? base
  return base.replace(/(^|[-_.\s]+)([a-zA-Z0-9])/g, (_, __, char: string) => char.toUpperCase())
}

/** The index of the bracket closing the one at `open`, skipping strings and comments; -1 when unbalanced. */
export const matchClose = (text: string, open: number): number => {
  const stack: string[] = []
  for (let i = open; i < text.length; i += 1) {
    const char = text[i] as string
    if (char === '"' || char === "'" || char === '`') {
      const end = skipString(text, i)
      if (end === -1) return -1
      i = end
      continue
    }
    if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      if (end === -1) return -1
      i = end
      continue
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (char === '=' && text[i + 1] === '>') {
      i += 1
      continue
    }
    const closer = OPENERS[char]
    if (closer !== undefined && (char !== '<' || stack.at(-1) === '>' || i === open)) {
      stack.push(closer)
      continue
    }
    if (CLOSERS.has(char) && stack.at(-1) === char) {
      stack.pop()
      if (stack.length === 0) return i
    }
  }
  return -1
}

const skipString = (text: string, start: number): number => {
  const quote = text[start]
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1
    else if (text[i] === quote) return i
  }
  return -1
}

/** Splits `text` at any of `separators` that stand outside brackets and strings. */
export const splitTopLevel = (text: string, separators: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    if (char === '"' || char === "'" || char === '`') {
      const end = skipString(text, i)
      i = end === -1 ? text.length : end
      continue
    }
    if (char === '=' && text[i + 1] === '>') {
      i += 1
      continue
    }
    if ('({[<'.includes(char)) depth += 1
    else if (')}]>'.includes(char)) depth = Math.max(0, depth - 1)
    else if (depth === 0 && separators.includes(char)) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(part => part !== '')
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

const squeeze = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const FIELD = /^(?:readonly\s+)?(['"]?)([A-Za-z_$][\w$-]*)\1\s*(\?)?\s*(:|\()([\s\S]*)$/
const FIELD_START = /\n(?=\s*(?:readonly\s+)?['"]?[A-Za-z_$][\w$-]*['"]?\s*\??\s*[:(])/

/** The fields of an object type's body (`a: string; b?: number`), in order. */
export const fieldsOf = (body: string): Prop[] => {
  const chunks = splitTopLevel(stripComments(body), ';,').flatMap(chunk => chunk.split(FIELD_START))
  const props: Prop[] = []
  for (const chunk of chunks) {
    const match = FIELD.exec(chunk.trim())
    if (match === null) continue
    const [, , name = '', optional, kind, rest = ''] = match
    const type = kind === '(' ? 'function' : squeeze(rest.replace(/[;,]\s*$/, ''), MAX_TYPE_CHARS)
    props.push({ name, ...(type === '' ? {} : { type }), ...(optional === '?' ? { isOptional: true } : {}) })
  }
  return props
}

/** Object types declared in a file: `interface X { }`, `type X = { }` (an intersection's literal parts too). */
export const typesOf = (text: string): Map<string, Prop[]> => {
  const types = new Map<string, Prop[]>()
  const declaration = /\b(?:interface\s+([A-Z][\w$]*)(?:\s*<[^{]*>)?(?:\s+extends\s+[^{]+)?\s*\{|type\s+([A-Z][\w$]*)(?:\s*<[^=]*>)?\s*=)/g
  for (const match of text.matchAll(declaration)) {
    const name = match[1] ?? match[2]
    if (name === undefined) continue
    const after = (match.index ?? 0) + match[0].length
    if (match[1] !== undefined) {
      const close = matchClose(text, after - 1)
      if (close !== -1) types.set(name, fieldsOf(text.slice(after, close)))
      continue
    }
    // `type X = A & { ... }`: gather the literal parts up to the end of the declaration.
    const fields: Prop[] = []
    let i = after
    while (i < text.length) {
      while (i < text.length && /[\s&|(]/.test(text[i] as string)) i += 1
      if (text[i] === '{') {
        const close = matchClose(text, i)
        if (close === -1) break
        fields.push(...fieldsOf(text.slice(i + 1, close)))
        i = close + 1
        continue
      }
      const word = /^[\w$.]+(?:<)?/.exec(text.slice(i))
      if (word === null) break
      i += word[0].length
      if (word[0].endsWith('<')) {
        const close = matchClose(text, i - 1)
        if (close === -1) break
        i = close + 1
      }
    }
    if (fields.length > 0) types.set(name, fields)
  }
  return types
}

const mergeProps = (...lists: Prop[][]): Prop[] => {
  const merged = new Map<string, Prop>()
  for (const list of lists) {
    for (const prop of list) {
      const known = merged.get(prop.name)
      merged.set(prop.name, { ...prop, ...known, ...(prop.isOptional || known?.isOptional ? { isOptional: true } : {}) })
    }
  }
  return [...merged.values()]
}

/** The props a type annotation names, from the object types declared in the same file. */
const propsOfAnnotation = (annotation: string, types: Map<string, Prop[]>): Prop[] => {
  const inline = annotation.trim().startsWith('{') ? fieldsOf(annotation.trim().slice(1, -1)) : []
  const named = [...annotation.matchAll(/\b[A-Z][\w$]*\b/g)].flatMap(match => types.get(match[0]) ?? [])
  return mergeProps(inline, named)
}

/** Props from a component's parameter list: destructured names, merged with its declared type. */
export const propsOfParams = (params: string, types: Map<string, Prop[]>): Prop[] => {
  const first = splitTopLevel(params, ',')[0]?.trim() ?? ''
  if (first.startsWith('{')) {
    const close = matchClose(first, 0)
    if (close === -1) return []
    const destructured: Prop[] = splitTopLevel(first.slice(1, close), ',').map(part => {
      if (part.startsWith('...')) return { name: part.replace(/\s*[:=][\s\S]*$/, '') }
      const name = /^['"]?([\w$-]+)/.exec(part)?.[1] ?? part
      return { name, ...(/^[^:]*=/.test(part) || /=/.test(part.split(':')[0] ?? '') ? { isOptional: true } : {}) }
    })
    const annotation = /^\s*:\s*([\s\S]+?)\s*(?:=[^>][\s\S]*)?$/.exec(first.slice(close + 1))?.[1] ?? ''
    const typed = propsOfAnnotation(annotation, types)
    if (typed.length === 0) return destructured
    const rest = destructured.filter(prop => prop.name.startsWith('...'))
    const defaults = new Set(destructured.filter(prop => prop.isOptional).map(prop => prop.name))
    const known = new Set(typed.map(prop => prop.name))
    const extra = destructured.filter(prop => !prop.name.startsWith('...') && !known.has(prop.name))
    return [...typed.map(prop => (defaults.has(prop.name) ? { ...prop, isOptional: true } : prop)), ...extra, ...rest]
  }
  const annotation = /^[\w$]+\s*\??\s*:\s*([\s\S]+)$/.exec(first)?.[1]
  return annotation === undefined ? [] : propsOfAnnotation(annotation, types)
}

/** The one-line summary of the doc comment ending just before `index`, or ''. */
export const docBefore = (text: string, index: number): string => {
  const before = text.slice(0, index).replace(/\s+$/, '')
  if (before.endsWith('*/')) {
    const start = before.lastIndexOf('/*')
    if (start === -1) return ''
    return summaryOf(before.slice(start + 2, -2))
  }
  const lines = before.split('\n')
  const comments: string[] = []
  while (lines.length > 0 && /^\s*\/\//.test(lines.at(-1) ?? '')) comments.unshift((lines.pop() ?? '').replace(/^\s*\/\/+\s?/, ''))
  return summaryOf(comments.join('\n'))
}

/** First sentence of a comment's prose, its `@tags` and `*` gutters left out. */
export const summaryOf = (comment: string): string => {
  const prose = comment
    .split('\n')
    .map(line => line.replace(/^\s*\*+\s?/, '').trim())
    .filter(line => !line.startsWith('@') && !/^eslint|^prettier|^@ts-|^#region/.test(line))
    .join(' ')
    .replace(/\{@link\s+([^}|]+)(?:\|[^}]*)?\}/g, '$1')
    .trim()
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(prose)?.[0] ?? prose
  return squeeze(sentence, MAX_PURPOSE_CHARS)
}

/** The comment a file opens with (before its imports), for a file that holds one component. */
const leadingComment = (text: string): string => {
  const head = /^\s*(?:(['"])use (?:client|server|strict)\1;?\s*)?(\/\*[\s\S]*?\*\/|(?:\s*\/\/[^\n]*\n?)+)/.exec(text)
  const comment = head?.[2]
  if (comment === undefined) return ''
  return summaryOf(comment.startsWith('/*') ? comment.slice(2, -2) : comment.replace(/^\s*\/\/+\s?/gm, ''))
}

/** A component found in a file: where it is declared (-1: the whole file) and, when known already, its purpose. */
type Found = { name: string; index: number; props: Prop[]; purpose?: string }

const WRAPPER_HEAD = /^\s*(?:React\.)?(?:memo|forwardRef|observer)\s*(<[\s\S]*?>)?\s*$/
const FUNCTION_HEAD = /^\s*(?:async\s*)?(?:function\s*\*?\s*[\w$]*\s*)?(?:<[^()]*>\s*)?$/
const MAX_HEAD_CHARS = 160
const MAX_WRAPPERS = 2

/** The parameter list after `=` of `const Name = ...` (through `memo(`/`forwardRef<R, P>(`), and the types a wrapper names. */
const paramsAfterEquals = (text: string, start: number): { params: string; annotation: string } | undefined => {
  let from = start
  let annotation = ''
  for (let wrappers = 0; ; wrappers += 1) {
    const open = text.indexOf('(', from)
    if (open === -1 || open - from > MAX_HEAD_CHARS) return wrappers === 0 ? undefined : { params: '', annotation }
    const head = text.slice(from, open)
    const wrapper = WRAPPER_HEAD.exec(head)
    if (wrapper !== null && wrappers < MAX_WRAPPERS) {
      annotation += ` ${wrapper[1] ?? ''}`
      from = open + 1
      continue
    }
    if (!FUNCTION_HEAD.test(head)) return wrappers === 0 ? undefined : { params: '', annotation }
    const close = matchClose(text, open)
    if (close === -1) return undefined
    const isArrowOrFunction = /^\s*(?::[^=]*?)?=>|^\s*(?::[^{]*?)?\{/.test(text.slice(close + 1, close + 200))
    if (!isArrowOrFunction) return wrappers === 0 ? undefined : { params: '', annotation }
    return { params: text.slice(open + 1, close), annotation }
  }
}

const reactComponents = (text: string, path: string): Found[] => {
  const types = typesOf(text)
  const found: Found[] = []
  const exported = new Set<string>()
  for (const match of text.matchAll(/^\s*export\s+default\s+(?:(?:React\.)?(?:memo|forwardRef|observer)\s*\(\s*)?([A-Z][\w$]*)\s*\)?\s*;?\s*$/gm)) {
    exported.add(match[1] as string)
  }
  for (const match of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of (match[1] ?? '').split(',')) exported.add(part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
  }
  const fromFunctions = /^[ \t]*(export[ \t]+(?:default[ \t]+)?)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Z][\w$]*)?[ \t]*(<[^(\n]*>)?[ \t]*\(/gm
  for (const match of text.matchAll(fromFunctions)) {
    const isExported = match[1] !== undefined
    const name = match[2] ?? (isExported && /default/.test(match[1] ?? '') ? componentNameFromPath(path) : undefined)
    if (name === undefined || (!isExported && !exported.has(name))) continue
    const open = (match.index ?? 0) + match[0].length - 1
    const close = matchClose(text, open)
    if (close === -1) continue
    found.push({ name, index: match.index ?? 0, props: propsOfParams(text.slice(open + 1, close), types) })
  }
  const fromConsts = /^[ \t]*(export[ \t]+)?const[ \t]+([A-Z][\w$]*)[ \t]*(?::([^=\n]+))?=(?!=)/gm
  for (const match of text.matchAll(fromConsts)) {
    const name = match[2] as string
    if (match[1] === undefined && !exported.has(name)) continue
    const annotation = match[3] ?? ''
    const isTypedComponent = /\b(?:FC|FunctionComponent|VFC|ComponentType|ForwardRefExoticComponent)\b/.test(annotation)
    const after = paramsAfterEquals(text, (match.index ?? 0) + match[0].length)
    if (after === undefined && !isTypedComponent) continue
    const props = mergeProps(propsOfParams(after?.params ?? '', types), propsOfAnnotation(`${annotation} ${after?.annotation ?? ''}`, types))
    found.push({ name, index: match.index ?? 0, props })
  }
  const fromClasses = /^[ \t]*(export[ \t]+(?:default[ \t]+)?)?class[ \t]+([A-Z][\w$]*)[ \t]+extends[ \t]+(?:React\.)?(?:Pure)?Component[ \t]*(<[^{]*>)?/gm
  for (const match of text.matchAll(fromClasses)) {
    const name = match[2] as string
    if (match[1] === undefined && !exported.has(name)) continue
    found.push({ name, index: match.index ?? 0, props: propsOfAnnotation(match[3] ?? '', types) })
  }
  // A plain JS/TS file counts only when it draws markup.
  if (/\.(?:ts|js|mjs)$/i.test(path) && !/<\/?[A-Za-z][\w.]*[\s/>]|React\.createElement|\bjsx\(/.test(text)) return []
  return found
}

const vueComponent = (text: string, path: string): Found[] => {
  const script = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1] ?? '').join('\n')
  const types = typesOf(script)
  const name = /\bname\s*:\s*['"]([\w-]+)['"]/.exec(script)?.[1]
  let props: Prop[] = []
  const typed = /defineProps\s*<\s*([\s\S]*?)\s*>\s*\(/.exec(script)
  if (typed !== null) {
    props = propsOfAnnotation(typed[1] ?? '', types)
  } else {
    const runtime = /(?:defineProps\s*\(\s*|\bprops\s*:\s*)([[{])/.exec(script)
    if (runtime !== null) {
      const open = (runtime.index ?? 0) + runtime[0].length - 1
      const close = matchClose(script, open)
      const inner = close === -1 ? '' : script.slice(open + 1, close)
      props =
        runtime[1] === '['
          ? splitTopLevel(inner, ',').map(part => ({ name: part.replace(/['"`]/g, '') }))
          : splitTopLevel(inner, ',').flatMap(part => {
              const field = /^['"]?([\w$-]+)['"]?\s*:\s*([\s\S]*)$/.exec(part)
              if (field === null) return []
              const value = field[2] ?? ''
              const type = /^\s*([A-Z]\w*)\b/.exec(value)?.[1] ?? /\btype\s*:\s*([\w[\], ]+?)\s*(?:,|$)/.exec(value)?.[1]
              const isRequired = /\brequired\s*:\s*true\b/.test(value)
              return [{ name: field[1] ?? '', ...(type === undefined ? {} : { type }), ...(isRequired ? {} : { isOptional: true }) }]
            })
    }
  }
  const comment = /^\s*<!--([\s\S]*?)-->/.exec(text)?.[1]
  const purpose = comment === undefined ? leadingComment(script) : summaryOf(comment.replace(/^\s*@component\b/, ''))
  return [{ name: componentNameFromPath(name ?? path), index: -1, props, purpose }]
}

const svelteComponent = (text: string, path: string): Found[] => {
  const script = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1] ?? '').join('\n')
  const types = typesOf(script)
  const props: Prop[] = []
  for (const match of script.matchAll(/\bexport\s+let\s+([\w$]+)\s*(?::\s*([^=;\n]+))?(=)?/g)) {
    const type = match[2]?.trim()
    props.push({ name: match[1] as string, ...(type ? { type: squeeze(type, MAX_TYPE_CHARS) } : {}), ...(match[3] ? { isOptional: true } : {}) })
  }
  const runes = /\blet\s*(\{[\s\S]*?\})\s*(?::\s*([^=]+?))?\s*=\s*\$props\s*\(/.exec(script)
  if (runes !== null) props.push(...propsOfParams(`${runes[1] ?? ''}${runes[2] ? `: ${runes[2]}` : ''}`, types))
  const comment = /<!--\s*@component\b([\s\S]*?)-->/.exec(text)?.[1] ?? /^\s*<!--([\s\S]*?)-->/.exec(text)?.[1]
  return [{ name: componentNameFromPath(path), index: -1, props, purpose: comment === undefined ? '' : summaryOf(comment) }]
}

const angularComponents = (text: string): Found[] => {
  const found: Found[] = []
  for (const match of text.matchAll(/@Component\s*\(\s*\{([\s\S]*?)\}\s*\)\s*(?:@[\w.]+\([^)]*\)\s*)*export\s+(?:default\s+)?class\s+([A-Z][\w$]*)/g)) {
    const name = match[2] as string
    const classStart = (match.index ?? 0) + match[0].length
    const open = text.indexOf('{', classStart)
    const close = open === -1 ? -1 : matchClose(text, open)
    const body = close === -1 ? '' : text.slice(open + 1, close)
    const props: Prop[] = []
    for (const input of body.matchAll(/@Input\(\s*(?:['"]([\w$]+)['"])?[^)]*\)\s*(?:set\s+)?([\w$]+)\s*([!?])?\s*(?::\s*([^;=\n(]+))?/g)) {
      const type = input[4]?.trim()
      props.push({ name: input[1] ?? (input[2] as string), ...(type ? { type: squeeze(type, MAX_TYPE_CHARS) } : {}), ...(input[3] === '?' ? { isOptional: true } : {}) })
    }
    for (const input of body.matchAll(/\b([\w$]+)\s*=\s*input(\.required)?\s*(?:<([^>]*)>)?\s*\(/g)) {
      props.push({ name: input[1] as string, ...(input[3] ? { type: squeeze(input[3], MAX_TYPE_CHARS) } : {}), ...(input[2] ? {} : { isOptional: true }) })
    }
    const selector = /selector\s*:\s*['"]([^'"]+)['"]/.exec(match[1] ?? '')?.[1]
    const doc = docBefore(text, match.index ?? 0)
    found.push({ name, index: match.index ?? 0, props, purpose: doc !== '' ? doc : selector === undefined ? '' : `<${selector}>` })
  }
  return found
}

/** Every component a source file declares, with its props and a one-line purpose. */
export const parseComponents = (path: string, text: string): Component[] => {
  if (!isComponentFile(path)) return []
  const extension = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase()
  const framework: Component['framework'] =
    extension === 'vue' ? 'vue' : extension === 'svelte' ? 'svelte' : /@Component\s*\(/.test(text) && /\.ts$/i.test(path) ? 'angular' : 'react'
  const found =
    framework === 'vue'
      ? vueComponent(text, path)
      : framework === 'svelte'
        ? svelteComponent(text, path)
        : framework === 'angular'
          ? angularComponents(text)
          : reactComponents(text, path)
  const fileComment = leadingComment(text)
  const seen = new Set<string>()
  const components: Component[] = []
  for (const item of found) {
    if (seen.has(item.name)) continue
    seen.add(item.name)
    const own = item.purpose ?? (item.index >= 0 ? docBefore(text, item.index) : '')
    const purpose = own !== '' ? own : found.length === 1 ? fileComment : ''
    components.push({ name: item.name, path, purpose, props: item.props, framework })
  }
  return components
}

/** Edit distance between two names (insert, delete, substitute), case-folded. */
export const levenshtein = (a: string, b: string): number => {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost)
    }
    previous = current
  }
  return previous[right.length] ?? 0
}

const normalizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** How many edits two names may be apart and still read as the same component. */
const tolerance = (length: number): number => (length <= 4 ? 0 : length <= 7 ? 1 : length <= 12 ? 2 : 3)

/** Existing components whose name is the same as, or a near miss of, `name` (in another file). */
export const similarComponents = (name: string, path: string, catalog: readonly Component[]): Component[] => {
  const wanted = normalizeName(name)
  return catalog
    .filter(component => component.path !== path)
    .map(component => ({ component, distance: levenshtein(wanted, normalizeName(component.name)) }))
    .filter(({ component, distance }) => distance <= tolerance(Math.min(wanted.length, normalizeName(component.name).length)))
    .sort((a, b) => a.distance - b.distance)
    .map(({ component }) => component)
}

export const describeProps = (props: readonly Prop[], withTypes: boolean): string =>
  props.map(prop => `${prop.name}${prop.isOptional ? '?' : ''}${withTypes && prop.type !== undefined ? `: ${prop.type}` : ''}`).join(', ')

/** Components matching every word of `query` in their name, path, purpose or props. */
export const searchComponents = (components: readonly Component[], query: string): Component[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...components]
  const scored = components.flatMap(component => {
    const name = component.name.toLowerCase()
    const haystack = `${name} ${component.path.toLowerCase()} ${component.purpose.toLowerCase()} ${component.props.map(p => p.name.toLowerCase()).join(' ')}`
    if (!words.every(word => haystack.includes(word))) return []
    const score = words.reduce((sum, word) => sum + (name.startsWith(word) ? 3 : name.includes(word) ? 2 : 0), 0)
    return [{ component, score }]
  })
  return scored.sort((a, b) => b.score - a.score || a.component.name.localeCompare(b.component.name)).map(({ component }) => component)
}

/** The system prompt section: names, paths, purposes and prop names, capped at `maxChars`. */
export const catalogSection = (components: readonly Component[], dirs: readonly string[], maxChars: number): string | null => {
  if (components.length === 0 || maxChars <= 0) return null
  const head = [
    '# Existing UI components',
    `This project already has these UI components (scanned from ${dirs.join(', ')}). Before creating a new component, check this list and reuse or extend a matching one instead of writing a near-duplicate. The person can run /components to browse them with their props.`,
  ].join('\n')
  const lines: string[] = []
  let used = head.length
  const sorted = [...components].sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name))
  for (const [index, component] of sorted.entries()) {
    const props = component.props.length === 0 ? '' : ` · props: ${squeeze(describeProps(component.props, false), 120)}`
    const line = `- ${component.name} (${component.path})${component.purpose === '' ? '' : `: ${component.purpose}`}${props}`
    const remaining = sorted.length - index
    const tail = `\n…and ${remaining} more (run /components to see all).`
    if (used + line.length + 1 + (remaining > 1 ? tail.length : 0) > maxChars) {
      lines.push(tail.trim())
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return `${head}\n${lines.join('\n')}`
}
