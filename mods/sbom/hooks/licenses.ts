/** How a license constrains reuse, as the pane groups them. */
export type LicenseClass = 'permissive' | 'weak copyleft' | 'copyleft' | 'other' | 'unknown'

/** SPDX license ids common in package registries (the subset this mod recognises as ids). */
export const SPDX_IDS = new Set([
  '0BSD', 'AFL-3.0', 'AGPL-1.0', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-1.1', 'Apache-2.0', 'APSL-2.0',
  'Artistic-1.0', 'Artistic-2.0', 'BlueOak-1.0.0', 'BSD-1-Clause', 'BSD-2-Clause', 'BSD-2-Clause-Patent', 'BSD-3-Clause',
  'BSD-3-Clause-Clear', 'BSD-4-Clause', 'BSL-1.0', 'CAL-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0',
  'CC0-1.0', 'CDDL-1.0', 'CDDL-1.1', 'CECILL-2.1', 'EPL-1.0', 'EPL-2.0', 'EUPL-1.1', 'EUPL-1.2', 'GPL-2.0', 'GPL-2.0-only',
  'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'HPND', 'ISC', 'LGPL-2.0', 'LGPL-2.0-only',
  'LGPL-2.0-or-later', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'MIT', 'MIT-0', 'MIT-CMU', 'MPL-1.1', 'MPL-2.0', 'MPL-2.0-no-copyleft-exception', 'MS-PL', 'NCSA', 'ODbL-1.0', 'OFL-1.1',
  'OpenSSL', 'OSL-3.0', 'PostgreSQL', 'PSF-2.0', 'Python-2.0', 'Python-2.0.1', 'Ruby', 'SSPL-1.0', 'Unicode-3.0',
  'Unicode-DFS-2016', 'Unlicense', 'UPL-1.0', 'W3C', 'WTFPL', 'X11', 'Zlib', 'ZPL-2.1',
  'AFL-1.1', 'AFL-1.2', 'AFL-2.0', 'AFL-2.1', 'Apache-1.0', 'BSD-2-Clause-FreeBSD', 'BSD-3-Clause-LBNL', 'BSD-Source-Code', 'bzip2-1.0.6',
  'CC-BY-2.0', 'CC-BY-SA-2.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-PDDC', 'curl', 'EUPL-1.0', 'GFDL-1.3', 'GFDL-1.3-only', 'ICU', 'IJG',
  'JSON', 'libpng-2.0', 'MirOS', 'MPL-1.0', 'NTP', 'OFL-1.0', 'PHP-3.01', 'Sleepycat', 'Unicode-TOU', 'Vim', 'W3C-20150513',
  'Beerware', 'ZPL-2.0',
])
const SPDX_EXCEPTIONS = new Set(['LLVM-exception', 'Classpath-exception-2.0', 'GCC-exception-3.1', 'Autoconf-exception-3.0'])
const BY_LOWER = new Map([...SPDX_IDS].map(id => [id.toLowerCase(), id]))

/** Names packages write instead of SPDX ids, lower-cased, and the id they mean. */
const ALIASES: Record<string, string> = {
  'apache 2.0': 'Apache-2.0',
  'apache-2': 'Apache-2.0',
  'apache 2': 'Apache-2.0',
  'apache2': 'Apache-2.0',
  'apache license 2.0': 'Apache-2.0',
  'apache license, version 2.0': 'Apache-2.0',
  'apache software license': 'Apache-2.0',
  'apache software license 2.0': 'Apache-2.0',
  'mit license': 'MIT',
  'the mit license': 'MIT',
  'mit/x11': 'MIT',
  'expat': 'MIT',
  'isc license': 'ISC',
  'isc license (iscl)': 'ISC',
  'bsd-2': 'BSD-2-Clause',
  'bsd-3': 'BSD-3-Clause',
  'new bsd': 'BSD-3-Clause',
  'new bsd license': 'BSD-3-Clause',
  'modified bsd': 'BSD-3-Clause',
  'simplified bsd': 'BSD-2-Clause',
  '3-clause bsd': 'BSD-3-Clause',
  '2-clause bsd': 'BSD-2-Clause',
  'mozilla public license 2.0 (mpl 2.0)': 'MPL-2.0',
  'mpl 2.0': 'MPL-2.0',
  'mpl-2': 'MPL-2.0',
  'psf': 'PSF-2.0',
  'psfl': 'PSF-2.0',
  'python software foundation license': 'PSF-2.0',
  'gplv2': 'GPL-2.0-only',
  'gplv3': 'GPL-3.0-only',
  'gplv2+': 'GPL-2.0-or-later',
  'gplv3+': 'GPL-3.0-or-later',
  'lgplv3': 'LGPL-3.0-only',
  'lgplv2.1': 'LGPL-2.1-only',
  'the unlicense': 'Unlicense',
  'the unlicense (unlicense)': 'Unlicense',
  'public domain': 'Unlicense',
  'zlib/libpng': 'Zlib',
  'boost software license 1.0 (bsl-1.0)': 'BSL-1.0',
  'eclipse public license 2.0 (epl-2.0)': 'EPL-2.0',
  'gnu general public license v3 (gplv3)': 'GPL-3.0-only',
  'gnu general public license v2 (gplv2)': 'GPL-2.0-only',
  'gnu lesser general public license v3 (lgplv3)': 'LGPL-3.0-only',
  'gnu lesser general public license v2 or later (lgplv2+)': 'LGPL-2.0-or-later',
  'gnu affero general public license v3': 'AGPL-3.0-only',
}

const COPYLEFT = /^(?:A?GPL|SSPL|OSL|CC-BY-SA|EUPL|CECILL|ODbL)/i
const WEAK_COPYLEFT = /^(?:LGPL|MPL|EPL|CDDL|MS-RL|CPL|APSL|Artistic-1)/i

/** One license id spelled the SPDX way when it is one (`mit` → `MIT`), else undefined. */
const asSpdxId = (token: string): string | undefined => {
  const trimmed = token.trim()
  if (trimmed.startsWith('LicenseRef-')) return trimmed
  const plus = trimmed.endsWith('+')
  const id = BY_LOWER.get((plus ? trimmed.slice(0, -1) : trimmed).toLowerCase())
  return id === undefined ? undefined : plus ? `${id}+` : id
}

/** The tokens of an SPDX expression; undefined when it is not one this mod can read. */
const spdxExpression = (text: string): string | undefined => {
  const tokens = text.replace(/([()])/g, ' $1 ').split(/\s+/).filter(token => token !== '')
  if (tokens.length === 0) return undefined
  const out: string[] = []
  let expectsLicense = true
  let depth = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    const upper = token.toUpperCase()
    if (token === '(') {
      if (!expectsLicense) return undefined
      depth += 1
      out.push(token)
    } else if (token === ')') {
      if (expectsLicense || depth === 0) return undefined
      depth -= 1
      out.push(token)
    } else if (upper === 'AND' || upper === 'OR') {
      if (expectsLicense) return undefined
      expectsLicense = true
      out.push(upper)
    } else if (upper === 'WITH') {
      const exception = tokens[i + 1]
      if (expectsLicense || exception === undefined || !SPDX_EXCEPTIONS.has(exception)) return undefined
      out.push('WITH', exception)
      i += 1
    } else {
      const id = asSpdxId(token)
      if (!expectsLicense || id === undefined) return undefined
      out.push(id)
      expectsLicense = false
    }
  }
  if (expectsLicense || depth !== 0) return undefined
  return out.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')')
}

/**
 * A license as packages declare it, tidied: an SPDX id or expression where
 * it reads as one (`Apache 2.0` → `Apache-2.0`, `(MIT OR Apache-2.0)` →
 * `MIT OR Apache-2.0`), the declared text otherwise; undefined for none.
 */
export const normalizeLicense = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text === '' || /^(?:unknown|none|undefined|null|see license(?: file)?|other\/proprietary license|n\/a)$/i.test(text)) {
    return undefined
  }
  const alias = ALIASES[text.toLowerCase()]
  if (alias !== undefined) return alias
  const expression = spdxExpression(text.replace(/\s*\/\s*/g, ' OR '))
  if (expression !== undefined) {
    const bare = expression.match(/^\((.*)\)$/)?.[1]
    return bare !== undefined && spdxExpression(bare) !== undefined ? bare : expression
  }
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/** Whether a normalized license is an SPDX id or expression (as CycloneDX and SPDX documents need). */
export const isSpdx = (license: string): boolean => spdxExpression(license) !== undefined

export const isSingleSpdxId = (license: string): boolean => asSpdxId(license) !== undefined && !/\s/.test(license)

/** The most permissive reading of an expression: `MIT OR GPL-3.0` is permissive, `MIT AND GPL-3.0` copyleft. */
export const classifyLicense = (license: string | undefined): LicenseClass => {
  if (license === undefined) return 'unknown'
  if (!isSpdx(license)) return 'other'
  const rank = (id: string): number => (COPYLEFT.test(id) ? 2 : WEAK_COPYLEFT.test(id) ? 1 : 0)
  const alternatives = license.replace(/[()]/g, '').split(/ OR /)
  const best = Math.min(
    ...alternatives.map(part => Math.max(...part.split(/ AND /).map(term => rank(term.split(' WITH ')[0] as string)))),
  )
  return best === 2 ? 'copyleft' : best === 1 ? 'weak copyleft' : 'permissive'
}

// ── Where licenses are read from ─────────────────────────────────────────────

/** `license` of a package.json (`"MIT"`, `{ "type": "MIT" }`, or the old `licenses: [{ type }]`). */
export const licenseFromPackageJson = (text: string): { name?: string; version?: string; license?: string } => {
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof manifest !== 'object' || manifest === null) return {}
  const record = manifest as Record<string, unknown>
  const typeOf = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : typeof value === 'object' && value !== null ? stringField(value, 'type') : undefined
  let license = typeOf(record.license)
  if (license === undefined && Array.isArray(record.licenses)) {
    const types = record.licenses.map(typeOf).filter((type): type is string => type !== undefined)
    if (types.length > 0) license = types.length === 1 ? types[0] : `(${types.join(' OR ')})`
  }
  return { name: stringField(record, 'name'), version: stringField(record, 'version'), license: normalizeLicense(license) }
}

const stringField = (value: object, key: string): string | undefined => {
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

const CLASSIFIER_LICENSES: Record<string, string> = {
  'MIT License': 'MIT',
  'Apache Software License': 'Apache-2.0',
  'BSD License': 'BSD',
  'ISC License (ISCL)': 'ISC',
  'Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0',
  'Python Software Foundation License': 'PSF-2.0',
  'The Unlicense (Unlicense)': 'Unlicense',
  'GNU General Public License v2 (GPLv2)': 'GPL-2.0-only',
  'GNU General Public License v3 (GPLv3)': 'GPL-3.0-only',
  'GNU General Public License v2 or later (GPLv2+)': 'GPL-2.0-or-later',
  'GNU General Public License v3 or later (GPLv3+)': 'GPL-3.0-or-later',
  'GNU Lesser General Public License v2 (LGPLv2)': 'LGPL-2.0-only',
  'GNU Lesser General Public License v3 (LGPLv3)': 'LGPL-3.0-only',
  'GNU Library or Lesser General Public License (LGPL)': 'LGPL',
  'GNU Affero General Public License v3': 'AGPL-3.0-only',
  'Eclipse Public License 2.0 (EPL-2.0)': 'EPL-2.0',
  'Zope Public License': 'ZPL-2.1',
}

/**
 * The license of a Python distribution from its METADATA headers:
 * `License-Expression` first, then a short `License`, then the trove
 * classifiers.
 */
export const licenseFromMetadata = (text: string): string | undefined => {
  const headerEnd = text.search(/\r?\n\r?\n/)
  const headers = (headerEnd === -1 ? text : text.slice(0, headerEnd)).split(/\r?\n/)
  const values = (name: string): string[] =>
    headers.filter(line => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)).map(line => line.slice(name.length + 1).trim())
  const expression = values('License-Expression')[0]
  if (expression !== undefined && expression !== '') return normalizeLicense(expression)
  const declared = values('License')[0]
  if (declared !== undefined && declared !== '' && declared.length <= 64 && !/^UNKNOWN$/i.test(declared)) {
    return normalizeLicense(declared)
  }
  const classified = values('Classifier')
    .filter(value => value.startsWith('License :: '))
    .map(value => value.split(' :: ').at(-1) ?? '')
    .map(name => CLASSIFIER_LICENSES[name] ?? name)
    .filter(name => name !== 'OSI Approved' && name !== '')
  if (classified.length === 0) return undefined
  return normalizeLicense(classified.length === 1 ? classified[0] : classified.join(' OR '))
}

/** `license = "..."` from a crate's Cargo.toml `[package]` table. */
export const licenseFromCargoToml = (text: string): string | undefined => {
  const match = /^\s*license\s*=\s*"([^"]+)"/m.exec(text)
  return normalizeLicense(match?.[1])
}

/** The license a LICENSE file's text most likely is, by its well-known wording; undefined when unsure. */
export const licenseFromText = (text: string): string | undefined => {
  const body = text.replace(/\s+/g, ' ')
  if (/Apache License,? Version 2\.0/i.test(body)) return 'Apache-2.0'
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(body)) return 'AGPL-3.0-only'
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(body)) return /Version 3/i.test(body) ? 'LGPL-3.0-only' : 'LGPL-2.1-only'
  if (/GNU GENERAL PUBLIC LICENSE/i.test(body)) return /Version 3/i.test(body) ? 'GPL-3.0-only' : 'GPL-2.0-only'
  if (/Mozilla Public License,? (?:version|v\.?) ?2\.0/i.test(body)) return 'MPL-2.0'
  if (/Permission is hereby granted, free of charge/i.test(body)) return 'MIT'
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(body)) return 'ISC'
  if (/Redistribution and use in source and binary forms/i.test(body)) {
    if (/advertising materials/i.test(body)) return 'BSD-4-Clause'
    return /Neither the name|names of its contributors/i.test(body) ? 'BSD-3-Clause' : 'BSD-2-Clause'
  }
  if (/This is free and unencumbered software released into the public domain/i.test(body)) return 'Unlicense'
  return undefined
}

/** The license PyPI's JSON API reports for a release (`info.license_expression`, `info.license`, classifiers). */
export const licenseFromPypiJson = (text: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const info = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).info : undefined
  if (typeof info !== 'object' || info === null) return undefined
  const record = info as Record<string, unknown>
  // A whole license text pasted into the field is no name: only a one-line value counts.
  const field = (key: string): string => {
    const value = record[key]
    return typeof value === 'string' && !/[\r\n]/.test(value.trim()) ? value.trim() : ''
  }
  const classifiers = Array.isArray(record.classifiers) ? record.classifiers.filter((item): item is string => typeof item === 'string') : []
  const headers = [`License-Expression: ${field('license_expression')}`, `License: ${field('license')}`, ...classifiers.map(item => `Classifier: ${item}`)]
  return licenseFromMetadata(headers.join('\n'))
}

/** The license crates.io's API reports for a crate version (`version.license`). */
export const licenseFromCratesJson = (text: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    const version = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).version : undefined
    const license = typeof version === 'object' && version !== null ? (version as Record<string, unknown>).license : undefined
    return typeof license === 'string' ? normalizeLicense(license) : undefined
  } catch {
    return undefined
  }
}
