/** How a license affects a project that depends on it. */
export type Kind = 'permissive' | 'weak-copyleft' | 'copyleft' | 'unknown'

const PERMISSIVE =
  /^(?:mit(?:-0|-cmu)?|x11|isc|0bsd|bsd(?:-\d-clause(?:-clear)?)?|apache(?:-?\d(?:\.\d)?)?|unlicense|the unlicense|cc0(?:-1\.0)?|wtfpl|zlib|libpng|ncsa|psf(?:-2\.0)?|python(?:-2\.0)?|bsl-1\.0|boost|blueoak(?:-1\.0\.0)?|artistic-2\.0|hpnd|postgresql|curl|public domain|ofl(?:-1\.1)?|cc-by(?:-\d\.\d)?|json|unicode(?:-dfs-2016|-3\.0)?)$/

/** Words in a license name or text, checked in this order, so AGPL and LGPL are not read as GPL. */
const RULES: readonly (readonly [RegExp, Kind])[] = [
  [/\bagpl|affero/i, 'copyleft'],
  [/\bsspl\b|server side public license/i, 'copyleft'],
  [/\blgpl|lesser general public|library general public/i, 'weak-copyleft'],
  [/\bgpl|general public license/i, 'copyleft'],
  [/\beupl\b|european union public|\bosl-?\d|open software license|\bcpal\b|\brpl\b/i, 'copyleft'],
  [/\bmpl|mozilla public|\bepl|eclipse public|\bcddl|common development and distribution|\bcecill/i, 'weak-copyleft'],
  [/\b(?:unlicensed|proprietary|commercial|all rights reserved)\b|see license in|\bbusl\b|business source|commons clause|elastic license|polyform/i, 'unknown'],
]

/** The strictness of each kind, to pick the worst of an `AND` and the best of an `OR`. */
const ORDER: Readonly<Record<Kind, number>> = { permissive: 0, unknown: 1, 'weak-copyleft': 2, copyleft: 3 }

const worse = (a: Kind, b: Kind): Kind => (ORDER[a] >= ORDER[b] ? a : b)

/** One license name (no `AND`/`OR`). */
const kindOfName = (name: string): Kind => {
  const clean = name.trim().replace(/^[(\s]+|[)\s]+$/g, '')
  if (clean === '') return 'unknown'
  const first = RULES.find(([pattern]) => pattern.test(clean))
  if (first !== undefined) return first[1]
  return PERMISSIVE.test(clean.toLowerCase().replace(/[-_ ](?:only|or-later|license|licence)\b/g, '').replace(/\s+/g, '-')) ||
    /\b(?:mit|bsd|isc|apache|psf|python software foundation|zlib|unlicense|public domain|cc0|creative commons zero)\b/i.test(clean)
    ? 'permissive'
    : 'unknown'
}

/** A license string or SPDX expression: `MIT AND GPL-3.0` binds you to both, `MIT OR GPL-3.0` lets you pick. Operators are upper case, so "v2 or later" is not an alternative. */
export const kindOf = (license: string): Kind => {
  const alternatives = license.split(/\s+OR\s+/).map(branch =>
    branch.split(/\s+AND\s+/).reduce<Kind>((kind, part) => worse(kind, kindOfName(part)), 'permissive'),
  )
  return alternatives.reduce((best, kind) => (ORDER[kind] < ORDER[best] ? kind : best))
}

export const isPermissive = (license: string): boolean => kindOf(license) === 'permissive'

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const textOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  const type = objectOf(value)?.type
  return typeof type === 'string' && type.trim() !== '' ? type.trim() : undefined
}

/** The license an npm version document names (`license`, or the old `licenses` list), or undefined when it names none. */
export const licenseOfNpm = (document: unknown): string | undefined => {
  const record = objectOf(document)
  const single = textOf(record?.license)
  if (single !== undefined) return single
  const list = Array.isArray(record?.licenses) ? record.licenses.map(textOf).filter((name): name is string => name !== undefined) : []
  return list.length === 0 ? undefined : list.join(' OR ')
}

/** The license a LICENSE / COPYING file's text is, by its well-known wording. */
export const licenseOfText = (text: string): string | undefined => {
  const head = text.slice(0, 3000)
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(head)) return 'AGPL-3.0'
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(head)) return 'LGPL-3.0'
  if (/GNU GENERAL PUBLIC LICENSE/i.test(head)) return 'GPL-3.0'
  if (/Server Side Public License/i.test(head)) return 'SSPL-1.0'
  if (/Mozilla Public License/i.test(head)) return 'MPL-2.0'
  if (/Apache License,?\s+Version 2\.0/i.test(head)) return 'Apache-2.0'
  if (/Permission is hereby granted, free of charge|^\s*MIT License/im.test(head)) return 'MIT'
  if (/Redistribution and use in source and binary forms/i.test(head)) {
    return /Neither the name of|endorse or promote/i.test(head) ? 'BSD-3-Clause' : 'BSD-2-Clause'
  }
  if (/Permission to use, copy, modify, and\/or distribute this software|^\s*ISC License/im.test(head)) return 'ISC'
  if (/free and unencumbered software released into the public domain/i.test(head)) return 'Unlicense'
  return undefined
}

const CLASSIFIER = /^License :: (?:OSI Approved :: )?(.+)$/

/** The license a PyPI document names: the SPDX expression, else the trove classifiers, else a short `license` field. */
export const licenseOfPypi = (document: unknown): string | undefined => {
  const info = objectOf(objectOf(document)?.info)
  const expression = textOf(info?.license_expression)
  if (expression !== undefined) return expression
  const classifiers = (Array.isArray(info?.classifiers) ? info.classifiers : [])
    .map(entry => CLASSIFIER.exec(String(entry))?.[1])
    .filter((name): name is string => name !== undefined && !/^(?:Other\/Proprietary|DFSG approved|Freely Distributable)/.test(name))
  if (classifiers.length > 0) return classifiers.join(' OR ')
  const field = textOf(info?.license)
  if (field === undefined) return undefined
  // Some packages paste the whole license text here: recognise it by its wording.
  return field.length > 120 ? (licenseOfText(field) ?? field.slice(0, 300)) : field
}

/** `license = "MIT"`, `license = { text = "MIT" }` or a `License ::` classifier of a pyproject.toml; `{ file = ... }` is the LICENSE file's job. */
export const licenseOfPyproject = (toml: string): string | undefined => {
  const plain = /^\s*license\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1]
  if (plain !== undefined) return plain
  const table = /^\s*license\s*=\s*\{\s*text\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1]
  if (table !== undefined) return table
  const classifier = /["']License :: (?:OSI Approved :: )?([^"']+)["']/.exec(toml)?.[1]
  return classifier
}

/** The `license` of a package.json's text (a string, `{ type }` or the old `licenses` list); undefined for text that is not JSON. */
export const licenseOfPackageJson = (text: string): string | undefined => {
  try {
    return licenseOfNpm(JSON.parse(text))
  } catch {
    return undefined
  }
}
