export type Attr = { name: string; value: string | undefined }

export type Tag = {
  name: string
  isClosing: boolean
  isSelfClosing: boolean
  start: number
  /** Index just after the `>`. */
  end: number
  attrs: Attr[]
  /** The tag spreads props ({...props}, v-bind="x"): any attribute might come from there. */
  hasSpread: boolean
}

const MAX_BRACE_SCAN = 4000
const TAG_START = /<(\/?)([A-Za-z][\w.:-]*)/y
const ATTR_NAME = /[^\s=>/{"'<]+/y
const UNQUOTED_VALUE = /[^\s>]+/y

/** Index just after the `}` that closes the `{` at `start` (strings, templates and comments respected); -1 when it never closes. */
const endOfBraces = (text: string, start: number, limit = start + MAX_BRACE_SCAN): number => {
  let depth = 0
  for (let index = start; index < Math.min(text.length, limit); index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    } else if (char === '"' || char === "'" || char === '`') {
      let end = index + 1
      while (end < text.length && text[end] !== char) {
        if (text[end] === '\\') end += 1
        else if (char === '`' && text[end] === '$' && text[end + 1] === '{') end = endOfBraces(text, end + 1, limit) - 1
        if (end < 0) return -1
        end += 1
      }
      index = end
    } else if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2)
      if (close < 0) return -1
      index = close + 1
    } else if (char === '/' && text[index + 1] === '/' && text[index - 1] !== ':') {
      const newline = text.indexOf('\n', index)
      if (newline < 0) return -1
      index = newline
    }
  }
  return -1
}

type Opening = { attrs: Attr[]; hasSpread: boolean; isSelfClosing: boolean; end: number }

/** Reads attributes from `position` (just after the tag name) to the end of the tag; undefined when it does not look like a tag. */
const readAttributes = (text: string, position: number): Opening | undefined => {
  const attrs: Attr[] = []
  let hasSpread = false
  let index = position
  while (index < text.length && index < position + MAX_BRACE_SCAN * 2) {
    const char = text[index] ?? ''
    if (/\s/.test(char)) {
      index += 1
    } else if (char === '>') {
      return { attrs, hasSpread, isSelfClosing: false, end: index + 1 }
    } else if (char === '/' && text[index + 1] === '>') {
      return { attrs, hasSpread, isSelfClosing: true, end: index + 2 }
    } else if (char === '{') {
      const end = endOfBraces(text, index)
      if (end < 0) return undefined
      const inner = text.slice(index + 1, end - 1).trim()
      if (inner.startsWith('...')) hasSpread = true
      else attrs.push({ name: inner, value: undefined })
      index = end
    } else {
      // A bare `<` where an attribute should be means this was no tag (a comparison, a stray bracket).
      if (char === '<') return undefined
      ATTR_NAME.lastIndex = index
      const name = ATTR_NAME.exec(text)?.[0]
      if (name === undefined) {
        index += 1
        continue
      }
      index += name.length
      if (name === 'v-bind' || name.startsWith('...')) hasSpread = true
      while (/\s/.test(text[index] ?? '')) index += 1
      if (text[index] !== '=') {
        attrs.push({ name, value: undefined })
        continue
      }
      index += 1
      while (/\s/.test(text[index] ?? '')) index += 1
      const quote = text[index]
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, index + 1)
        if (close < 0) return undefined
        attrs.push({ name, value: text.slice(index + 1, close) })
        index = close + 1
      } else if (quote === '{') {
        const end = endOfBraces(text, index)
        if (end < 0) return undefined
        attrs.push({ name, value: text.slice(index, end) })
        index = end
      } else {
        UNQUOTED_VALUE.lastIndex = index
        const value = UNQUOTED_VALUE.exec(text)?.[0] ?? ''
        attrs.push({ name, value })
        index += value.length
      }
    }
  }
  return undefined
}

/** Every opening and closing tag of an HTML, JSX, Vue or Svelte source, in order. */
export const scanTags = (text: string): Tag[] => {
  const tags: Tag[] = []
  let index = text.indexOf('<')
  while (index >= 0) {
    if (text.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4)
      index = close < 0 ? -1 : text.indexOf('<', close + 3)
      continue
    }
    TAG_START.lastIndex = index
    const match = TAG_START.exec(text)
    const opening = match === null ? undefined : readAttributes(text, index + match[0].length)
    if (match !== null && opening !== undefined) {
      tags.push({ name: match[2] ?? '', isClosing: match[1] === '/', start: index, ...opening })
      index = text.indexOf('<', opening.end)
    } else {
      index = text.indexOf('<', index + 1)
    }
  }
  return tags
}

// ── Rules ───────────────────────────────────────────────────────────────────

export type Rule = 'img-alt' | 'button-name' | 'link-name' | 'click-handler' | 'input-label' | 'positive-tabindex' | 'autofocus'
export type Issue = { rule: Rule; line: number; message: string; signature: string }

const NON_INTERACTIVE = new Set(['div', 'span', 'li', 'p', 'section', 'article', 'td', 'th', 'tr', 'img', 'svg', 'i', 'small', 'ul', 'ol', 'header', 'footer', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const CLICK = /^(?:onclick|@click(?:\.\w+)*|v-on:click(?:\.\w+)*|on:click|\(click\))$/i
const KEY_HANDLER = /^(?:onkey(?:down|up|press)|@key(?:down|up|press)(?:\.\w+)*|v-on:key(?:down|up|press)(?:\.\w+)*|on:key(?:down|up|press)|\(key(?:down|up|press)\))$/i
/** Attributes that name an element, or fill it with text. */
const NAMES = new Set(['aria-label', 'aria-labelledby', 'title', 'v-text', 'v-html', 'dangerouslysetinnerhtml', 'children', 'textcontent', 'innerhtml'])
/** What names an element from inside: an image's alt, a component's label. */
const CHILD_NAMES = new Set([...NAMES, 'alt', 'label'])
const NO_LABEL_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])
const DIALOG_CONTEXT = /\b(?:dialog|modal|popover|drawer|sheet)\b|aria-modal/i
const FIX = {
  'img-alt': 'add alt text, or alt="" when the image is decorative',
  'button-name': 'give the button text or an aria-label',
  'link-name': 'give the link text or an aria-label',
  'input-label': 'connect a <label> (htmlFor/for, or wrap it) or add aria-label',
} as const

/** `:alt`, `v-bind:alt`, `bind:alt`, `[alt]`, `[attr.alt]` and `alt` all say the same thing. */
const plainName = (name: string): string =>
  name
    .replace(/^(?:v-bind:|bind:|:|\[)/, '')
    .replace(/\]$/, '')
    .replace(/^attr\./i, '')
    .toLowerCase()

const find = (tag: Tag, wanted: (name: string) => boolean): Attr | undefined => tag.attrs.find(attr => wanted(plainName(attr.name)))
const has = (tag: Tag, ...names: string[]): boolean => find(tag, name => names.includes(name)) !== undefined

/** What an attribute says when it is a plain string or number (also inside braces); undefined when it is an expression. */
const literalOf = (attr: Attr | undefined): string | undefined => {
  const value = attr?.value
  if (value === undefined) return undefined
  const braced = /^\{\s*(?:(["'`])([\s\S]*)\1|(-?\d+))\s*\}$/.exec(value)
  if (braced !== null) return braced[2] ?? braced[3]
  return value.startsWith('{') ? undefined : value
}
const valueOf = (tag: Tag, name: string): string | undefined => literalOf(find(tag, other => other === name))

const isNamedBy = (tag: Tag, names: ReadonlySet<string>): boolean => {
  const attr = find(tag, name => names.has(name))
  return attr !== undefined && literalOf(attr)?.trim() !== ''
}

/** The index of the tag that closes the element opened at `index`, or -1 (self-closing, void or unclosed). */
const closerOf = (tags: readonly Tag[], index: number): number => {
  const open = tags[index]
  if (open === undefined || open.isSelfClosing) return -1
  let depth = 1
  for (let next = index + 1; next < tags.length; next += 1) {
    const tag = tags[next]
    if (tag?.name !== open.name) continue
    depth += tag.isClosing ? -1 : tag.isSelfClosing ? 0 : 1
    if (depth === 0) return next
  }
  return -1
}

/** True when what is inside gives the element a name: text, an expression, or a child with its own label. */
const hasNameInside = (text: string, tags: readonly Tag[], index: number, closer: number): boolean => {
  const open = tags[index]
  const close = tags[closer]
  if (open === undefined || close === undefined) return true
  const inner = tags.slice(index + 1, closer)
  if (inner.some(tag => !tag.isClosing && isNamedBy(tag, CHILD_NAMES))) return true

  let content = ''
  let from = open.end
  for (const tag of inner) {
    content += text.slice(from, tag.start)
    from = tag.end
  }
  content += text.slice(from, close.start)
  return content.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}|<!--[\s\S]*?-->|&nbsp;|&#160;/g, '').trim() !== ''
}

/** Line numbers by offset: the newline offsets once, then a binary search per lookup. */
const lineFinder = (text: string): ((offset: number) => number) => {
  const newlines: number[] = []
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) newlines.push(index)
  return offset => {
    let low = 0
    let high = newlines.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((newlines[middle] ?? Infinity) < offset) low = middle + 1
      else high = middle
    }
    return low + 1
  }
}

const andList = (items: readonly string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

const collapse = (text: string, max = 200): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

type Labels = { ranges: readonly (readonly [number, number])[]; targets: ReadonlySet<string> }

const labelsOf = (tags: readonly Tag[]): Labels => {
  const ranges: (readonly [number, number])[] = []
  const targets = new Set<string>()
  tags.forEach((tag, index) => {
    if (tag.isClosing || tag.name.toLowerCase() !== 'label') return
    const target = valueOf(tag, 'for') ?? valueOf(tag, 'htmlfor')
    if (target !== undefined) targets.add(target)
    const closer = closerOf(tags, index)
    if (closer >= 0) ranges.push([tag.start, tags[closer]?.end ?? tag.end])
  })
  return { ranges, targets }
}

const isLabelled = (tag: Tag, labels: Labels): boolean => {
  const idAttr = find(tag, name => name === 'id')
  const id = literalOf(idAttr)
  return (
    isNamedBy(tag, NAMES) ||
    NO_LABEL_TYPES.has((valueOf(tag, 'type') ?? 'text').toLowerCase()) ||
    labels.ranges.some(([from, to]) => tag.start > from && tag.start < to) ||
    // A computed id (useId()) cannot be matched to a label here, so it gets the benefit of the doubt.
    (idAttr !== undefined && (id === undefined || labels.targets.has(id)))
  )
}

/** The accessibility problems in a source, each with a signature that stays the same while the element is unchanged. */
export const findIssues = (text: string): Issue[] => {
  const tags = scanTags(text)
  const labels = labelsOf(tags)
  const isDialog = DIALOG_CONTEXT.test(text)
  const lineOf = lineFinder(text)
  const issues: Issue[] = []

  tags.forEach((tag, index) => {
    if (tag.isClosing) return
    const { name } = tag
    const closer = name === 'button' || name === 'a' ? closerOf(tags, index) : -1
    const end = closer < 0 ? tag.end : (tags[closer]?.end ?? tag.end)
    const add = (rule: Rule, message: string): void => {
      issues.push({ rule, line: lineOf(tag.start), message, signature: `${rule}|${collapse(text.slice(tag.start, end))}` })
    }
    const isUnnamed = closer >= 0 && !isNamedBy(tag, NAMES) && !hasNameInside(text, tags, index, closer)

    // Attributes that may come from a spread ({...props}) cannot be judged, so those checks step aside.
    if (!tag.hasSpread) {
      if (name === 'img' && !has(tag, 'alt')) add('img-alt', `<img> has no alt attribute: ${FIX['img-alt']}`)
      if (name === 'button' && isUnnamed) add('button-name', `<button> has no text or aria-label (icon-only?): ${FIX['button-name']}`)
      if (name === 'a' && has(tag, 'href', 'to', 'routerlink') && isUnnamed) add('link-name', `<a> has no text or aria-label (icon-only link?): ${FIX['link-name']}`)
      if ((name === 'input' || name === 'textarea' || name === 'select') && !isLabelled(tag, labels)) add('input-label', `<${name}> has no label: ${FIX['input-label']}`)
      if (NON_INTERACTIVE.has(name) && tag.attrs.some(attr => CLICK.test(attr.name))) {
        const role = valueOf(tag, 'role')
        const hidden = find(tag, other => other === 'aria-hidden')
        const isHidden = hidden !== undefined && (hidden.value === undefined || literalOf(hidden) === 'true' || /^\{\s*true\s*\}$/.test(hidden.value))
        const isDecorative = role === 'presentation' || role === 'none' || isHidden
        const missing = [
          ...(has(tag, 'role') ? [] : ['role']),
          ...(has(tag, 'tabindex') ? [] : ['tabIndex']),
          ...(tag.attrs.some(attr => KEY_HANDLER.test(attr.name)) ? [] : ['a key handler']),
        ]
        if (!isDecorative && missing.length > 0) add('click-handler', `<${name}> has a click handler but is missing ${andList(missing)}: use a <button> instead`)
      }
    }
    const tabIndex = valueOf(tag, 'tabindex')
    if (tabIndex !== undefined && Number(tabIndex.trim()) > 0) {
      add('positive-tabindex', `tabIndex ${tabIndex.trim()} on <${name}> breaks the natural focus order: use 0, or -1 to focus it from code`)
    }
    const autoFocus = find(tag, other => other === 'autofocus')
    if (!isDialog && autoFocus !== undefined && autoFocus.value?.trim() !== '{false}') {
      add('autofocus', `autoFocus on <${name}> moves focus on load and disorients screen reader users: keep it for dialogs`)
    }
  })
  return issues
}

/** The issues of `after` that `before` did not already have (a multiset difference by signature). */
export const newIssues = (before: string, after: string): Issue[] => {
  const available = new Map<string, number>()
  for (const issue of findIssues(before)) available.set(issue.signature, (available.get(issue.signature) ?? 0) + 1)
  return findIssues(after).filter(issue => {
    const left = available.get(issue.signature) ?? 0
    available.set(issue.signature, left - 1)
    return left <= 0
  })
}
