export type Notice = {
  /** The line the notice is on, trimmed and cut for display. */
  text: string
  kind: 'copyright' | 'license' | 'reserved'
  /** Who the copyright line names, when it names someone. */
  holder?: string
  /** License families the line names (`MIT`, `GPL`, ...); empty when it names a license this file cannot place. */
  families: string[]
}

/** What the project says about itself: the license families and copyright holders that are not foreign here. */
export type Project = {
  families: Set<string>
  /** Display names, for the message to Claude. */
  holders: string[]
  /** Lower-case words of the holders' names, what a notice's holder is compared on. */
  holderWords: Set<string>
  /** The project's own license says "All rights reserved", or it has none to share. */
  allowsReserved: boolean
}

/** A piece of text a tool call put in a file, with the text it replaced, so lines that were already there are not news. */
export type Change = { added: string; before: string }

const MAX_NOTICE_LENGTH = 120
const SCANNED_CHARS = 200_000
const MIN_WORD_LENGTH = 3

// Order matters: AGPL and LGPL name themselves as GPL too.
const LICENSE_FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ['AGPL', /\bAGPL|\bAffero\b/i],
  ['LGPL', /\bLGPL|\bLesser General Public/i],
  ['GPL', /\bGPL|\bGeneral Public License/i],
  ['Apache', /\bApache\b/i],
  ['MIT', /\bMIT\b|Permission is hereby granted, free of charge/i],
  ['BSD', /\bBSD\b|Redistribution and use in source and binary forms/i],
  ['ISC', /\bISC\b/],
  ['MPL', /\bMPL\b|\bMozilla Public/i],
  ['Unlicense', /\bunlicense\b|free and unencumbered software/i],
  ['CC0', /\bCC0\b/i],
  ['Proprietary', /\bUNLICENSED\b|\bproprietary\b/i],
]

const SPDX = /SPDX-License-Identifier:\s*([^*\r\n]+)/i
const LICENSED_UNDER = /\blicensed\s+under\b/i
const GNU_GPL = /\bGNU\s+(?:Affero\s+|Lesser\s+)?General\s+Public\s+License\b/i
const ALL_RIGHTS_RESERVED = /\ball\s+rights\s+reserved\b/i
/** `Copyright (c)`, `Copyright ©`, `Copyright 2020`, `(c) 2020`, `© 2020`: the forms that are a notice and not the word. */
const COPYRIGHT = /(?:copyright\s*(?:\(c\)|©)|copyright\s+(?=\d{4})|\(c\)\s*(?=\d{4})|©)\s*/i
const YEARS = /^(?:\d{4}\s*(?:[-–—,]\s*(?:\d{4}|present)\s*)*[,.:]?\s*)+/i
const GENERIC_WORDS = new Set([
  'inc', 'llc', 'ltd', 'gmbh', 'corp', 'corporation', 'company', 'the', 'and', 'others', 'all', 'team', 'project', 'contributors',
  'contributor', 'authors', 'author', 'developers', 'software', 'foundation', 'group', 'labs', 'systems', 'technologies', 'open', 'source',
])
/** Paths whose job is to carry notices of other people: license files, vendored and third-party code. */
const NOTICE_HOMES = /(?:^|[\\/])(?:LICEN[CS]E[^\\/]*|COPYING[^\\/]*|NOTICE[^\\/]*|UNLICENSE|AUTHORS|[^\\/]*\.license)$|(?:^|[\\/])(?:node_modules|vendor|vendors|third[_-]?party|licenses|\.git)[\\/]/i

/** The license family a name or text points to (`Apache License, Version 2.0` is `Apache`), if it points to one. */
export const familyOf = (text: string): string | undefined => LICENSE_FAMILIES.find(([, pattern]) => pattern.test(text))?.[0]

/** The families an SPDX expression names (`MIT OR Apache-2.0`); a part this file cannot place is left out. */
const familiesOfExpression = (expression: string): string[] =>
  expression
    .split(/\s+(?:OR|AND|WITH)\s+|[()]/i)
    .map(part => familyOf(part))
    .filter((family): family is string => family !== undefined)

/** The lower-case words of a name that say who it is: no `Inc`, `Contributors`, `Software` and the like. */
export const wordsOf = (name: string): string[] =>
  (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= MIN_WORD_LENGTH && !GENERIC_WORDS.has(word))

/** Who a copyright line names: what follows the mark and the years, without emails, links, "All rights reserved" and comment closers. */
export const holderOf = (line: string): string | undefined => {
  const mark = COPYRIGHT.exec(line)
  if (mark === null) return undefined
  const holder = line
    .slice(mark.index + mark[0].length)
    .replace(YEARS, '')
    .replace(/\ball\s+rights\s+reserved\b.*$/i, '')
    .replace(/<[^>]*>|\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\*\/|-->/g, ' ')
    .replace(/^by\s+/i, '')
    .replace(/^[\s.,;:*#/-]+|[\s.,;:*#/-]+$/g, '')
  return holder === '' ? undefined : holder
}

const noticeOf = (line: string): Notice | undefined => {
  const text = line.trim().length > MAX_NOTICE_LENGTH ? `${line.trim().slice(0, MAX_NOTICE_LENGTH - 1)}…` : line.trim()
  const spdx = SPDX.exec(line)
  if (spdx !== null) return { text, kind: 'license', families: familiesOfExpression(spdx[1] ?? '') }
  if (COPYRIGHT.test(line)) return { text, kind: 'copyright', holder: holderOf(line), families: [] }
  if (LICENSED_UNDER.test(line) || GNU_GPL.test(line)) {
    const family = familyOf(line)
    return { text, kind: 'license', families: family === undefined ? [] : [family] }
  }
  if (ALL_RIGHTS_RESERVED.test(line)) return { text, kind: 'reserved', families: [] }
  return undefined
}

/** The notices on lines of `change.added` that its `before` text did not already have. */
export const noticesIn = (change: Change): Notice[] => {
  const known = new Set(change.before.slice(0, SCANNED_CHARS).split('\n').map(line => line.trim()))
  const found = change.added
    .slice(0, SCANNED_CHARS)
    .split('\n')
    .filter(line => !known.has(line.trim()))
    .map(noticeOf)
    .filter((notice): notice is Notice => notice !== undefined)
  // "All rights reserved." under a copyright line is that line's tail: the holder decides, not the sentence.
  return found.some(notice => notice.kind === 'copyright') ? found.filter(notice => notice.kind !== 'reserved') : found
}

/** Whether a notice is not the project's own: another holder, another license, or a claim the project does not make. */
export const isForeign = (notice: Notice, project: Project): boolean => {
  if (notice.kind === 'license') return notice.families.length === 0 || !notice.families.some(family => project.families.has(family))
  if (notice.kind === 'reserved') return !project.allowsReserved
  const words = wordsOf(notice.holder ?? '')
  // A bare "Copyright (c) 2020", or a holder like "The Authors", names nobody to compare with.
  return words.length > 0 && !words.some(word => project.holderWords.has(word))
}

/** What a LICENSE file says: its license family and the holders on its copyright lines. */
export const parseLicenseText = (text: string): Partial<Project> & { holders: string[] } => {
  const family = familyOf(text.slice(0, 4000))
  // The GNU texts carry the Free Software Foundation's own copyright line, which says nothing about this project.
  const holders = text
    .split('\n')
    .map(holderOf)
    .filter((holder): holder is string => holder !== undefined && !/free software foundation/i.test(holder))
  return {
    families: new Set(family === undefined ? [] : [family]),
    holders,
    allowsReserved: ALL_RIGHTS_RESERVED.test(text) || family === 'Proprietary' || family === undefined,
  }
}

type PersonField = string | { name?: unknown } | undefined

const nameOfPerson = (person: PersonField): string | undefined => {
  const raw = typeof person === 'string' ? person : typeof person?.name === 'string' ? person.name : undefined
  const name = raw?.replace(/<[^>]*>|\([^)]*\)/g, '').trim()
  return name === undefined || name === '' ? undefined : name
}

/** What package.json says: its `license` (or legacy `licenses`), and the names in `author`, `contributors`, `maintainers` and the `@scope`. */
export const parsePackageJson = (text: string): Partial<Project> & { holders: string[] } => {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { holders: [] }
  }
  const licenseField = manifest.license
  const legacy = Array.isArray(manifest.licenses) ? manifest.licenses.map(entry => (entry as { type?: unknown })?.type) : []
  const names = [licenseField, ...legacy].map(entry => (typeof entry === 'string' ? entry : (entry as { type?: unknown } | undefined)?.type))
  const families = names.flatMap(name => (typeof name === 'string' ? familiesOfExpression(name) : []))
  const people = [manifest.author, ...(Array.isArray(manifest.contributors) ? manifest.contributors : []), ...(Array.isArray(manifest.maintainers) ? manifest.maintainers : [])]
  const scope = typeof manifest.name === 'string' && manifest.name.startsWith('@') ? manifest.name.slice(1).split('/')[0] : undefined
  const holders = [...people.map(person => nameOfPerson(person as PersonField)), scope].filter((holder): holder is string => holder !== undefined)
  return { families: new Set(families), holders, allowsReserved: families.includes('Proprietary') }
}

/** The project's identity from its parts; an `allow` list adds holders and licenses that are fine here too. */
export const mergeProject = (parts: ReadonlyArray<Partial<Project> & { holders: string[] }>, allow: readonly string[]): Project => {
  const families = new Set<string>()
  const holders: string[] = []
  for (const part of parts) {
    for (const family of part.families ?? []) families.add(family)
    holders.push(...part.holders)
  }
  for (const term of allow) {
    const family = familyOf(term)
    if (family !== undefined) families.add(family)
    holders.push(term)
  }
  return {
    families,
    holders: [...new Set(holders)],
    holderWords: new Set(holders.flatMap(wordsOf)),
    allowsReserved: parts.some(part => part.allowsReserved === true),
  }
}

export const isNoticeHome = (path: string): boolean => NOTICE_HOMES.test(path)

/** The new text each part of a write-type call puts in the file, beside what it replaced. `existing` is a Write's old file. */
export const changesOf = (input: Readonly<Record<string, unknown>>, existing: string): Change[] => {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const changes: Change[] = [
    { added: text(input.new_string), before: text(input.old_string) },
    { added: text(input.content), before: existing },
    { added: text(input.new_source), before: '' },
  ]
  for (const edit of Array.isArray(input.edits) ? input.edits : []) {
    const fields = typeof edit === 'object' && edit !== null ? (edit as Record<string, unknown>) : {}
    changes.push({ added: text(fields.new_string), before: text(fields.old_string) })
  }
  return changes.filter(change => change.added !== '')
}

/** How the project reads in a message: `MIT, © Plagemes`. */
export const describeProject = (project: Project): string => {
  const license = project.families.size > 0 ? [...project.families].join('/') : 'no license found'
  const holders = project.holders.slice(0, 2).join(', ')
  return holders === '' ? license : `${license}, © ${holders}`
}
