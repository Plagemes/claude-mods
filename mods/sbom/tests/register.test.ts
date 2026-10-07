import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { purlOf, toCycloneDx, toSpdx } from '../hooks/formats'
import { classifyLicense, licenseFromMetadata, licenseFromText, normalizeLicense } from '../hooks/licenses'
import { distInfoKey, escapeGoPath, pickLockfiles, pnpmStorePath } from '../hooks/sources'
import { GO_MOD, GO_SUM, PACKAGE_JSON, PNPM_LOCK_V9, POETRY_LOCK } from './fixtures'

const PANE_PROPS = { title: 'SBOM', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const BSD_3 =
  'Copyright (c) 2009,2014 Google Inc. All rights reserved.\n\nRedistribution and use in source and binary forms, with or without\n' +
  'modification, are permitted provided that the following conditions are met:\n...\n   * Neither the name of Google Inc. nor the names of its\n' +
  'contributors may be used to endorse or promote products derived from\nthis software without specific prior written permission.\n'

/** A project at /repo: a pnpm app, a Poetry API with its virtualenv, a Go service, and the Go module cache at /gomod. */
const PROJECT: Record<string, string> = {
  '/repo/package.json': PACKAGE_JSON,
  '/repo/pnpm-lock.yaml': PNPM_LOCK_V9,
  '/repo/node_modules/lodash/package.json': JSON.stringify({ name: 'lodash', version: '4.17.15', license: 'MIT' }),
  '/repo/node_modules/minimist/package.json': JSON.stringify({ name: 'minimist', version: '1.2.0', license: 'MIT' }),
  '/repo/node_modules/express/package.json': JSON.stringify({ name: 'express', version: '5.0.0', license: 'MIT' }),
  '/repo/node_modules/.pnpm/@sindresorhus+slugify@1.1.0/node_modules/@sindresorhus/slugify/package.json': JSON.stringify({
    name: '@sindresorhus/slugify',
    version: '1.1.0',
    licenses: [{ type: 'MIT' }],
  }),
  '/repo/node_modules/some-dep/package-lock.json': '{}',
  '/repo/api/poetry.lock': POETRY_LOCK,
  '/repo/api/requirements.txt': 'requests==2.25.1\n',
  '/repo/api/.venv/lib/python3.12/site-packages/requests-2.25.1.dist-info/METADATA': 'Metadata-Version: 2.1\nName: requests\nVersion: 2.25.1\nLicense: Apache 2.0\n\nlong description',
  '/repo/api/.venv/lib/python3.12/site-packages/idna-2.10.dist-info/METADATA': 'Name: idna\nVersion: 2.10\nLicense: BSD-like\n',
  '/repo/svc/go.mod': GO_MOD,
  '/repo/svc/go.sum': GO_SUM,
  '/gomod/github.com/google/uuid@v1.3.0/LICENSE': BSD_3,
}

type World = { writes: Map<string, string>; reads: string[]; fetched: string[]; opened: string[]; toasts: string[] }

const world = (on: On, files: Record<string, string> = PROJECT, registry: Record<string, string> = {}): World => {
  const state: World = { writes: new Map(), reads: [], fetched: [], opened: [], toasts: [] }
  const store = new Map<string, unknown>()
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  mock.env(on, { GOMODCACHE: '/gomod' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/repo\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const entries = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue
      const [name = '', ...rest] = path.slice(prefix.length).split('/')
      entries.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    return entries.size === 0 ? { deny: 'ENOENT' } : { value: [...entries].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    state.reads.push(e.path)
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', ($, e) => {
    state.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    state.fetched.push(e.url)
    const text = registry[e.url]
    if (text === 'OFFLINE') return { deny: 'ENOTFOUND' }
    return { value: { status: text === undefined ? 404 : 200, ok: text !== undefined, headers: {}, text: text ?? 'Not found' } }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    state.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  return state
}

const sbom = ($: Engine, args = '') =>
  $.command.run({ command: 'sbom', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

type CycloneDx = {
  bomFormat: string
  specVersion: string
  serialNumber: string
  metadata: { timestamp: string; component: { name: string } }
  components: { name: string; group?: string; version?: string; scope?: string; purl: string; licenses?: unknown[] }[]
}

test('/sbom reads every lockfile, finds licenses where they are installed and writes CycloneDX 1.5', async ($, on) => {
  const state = world(on)
  const result = await sbom($)
  expect(state.opened).toEqual(['sbom'])
  expect(result.text).toBe('Wrote sbom.cdx.json (CycloneDX 1.5): 32 packages (Go 17, npm 10, PyPI 5), 26 without a known license, 0 copyleft to review.')

  const bom = JSON.parse(state.writes.get('/repo/sbom.cdx.json') ?? '{}') as CycloneDx
  expect(bom.bomFormat).toBe('CycloneDX')
  expect(bom.specVersion).toBe('1.5')
  expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
  expect(bom.metadata.timestamp).toBe('2026-10-07T12:00:00Z')
  expect(bom.metadata.component.name).toBe('demo-app')
  const byPurl = new Map(bom.components.map(component => [component.purl, component]))
  expect(byPurl.get('pkg:npm/%40sindresorhus/slugify@1.1.0')).toEqual({
    type: 'library',
    'bom-ref': 'pkg:npm/%40sindresorhus/slugify@1.1.0',
    group: '@sindresorhus',
    name: 'slugify',
    version: '1.1.0',
    scope: 'required',
    licenses: [{ license: { id: 'MIT' } }],
    purl: 'pkg:npm/%40sindresorhus/slugify@1.1.0',
  })
  expect(byPurl.get('pkg:npm/minimist@1.2.0')?.scope).toBe('excluded')
  // The hoisted express in node_modules is another version: its license is not taken.
  expect(byPurl.get('pkg:npm/express@4.17.1')?.licenses).toBeUndefined()
  expect(byPurl.get('pkg:pypi/requests@2.25.1')?.licenses).toEqual([{ license: { id: 'Apache-2.0' } }])
  expect(byPurl.get('pkg:pypi/idna@2.10')?.licenses).toEqual([{ license: { name: 'BSD-like' } }])
  expect(byPurl.get('pkg:golang/github.com/google/uuid@v1.3.0')?.licenses).toEqual([{ license: { id: 'BSD-3-Clause' } }])
  // Requirements beside poetry.lock, and lockfiles inside node_modules, are not read.
  expect(state.reads).not.toContain('/repo/api/requirements.txt')
  expect(state.reads.some(path => path.startsWith('/repo/node_modules/some-dep'))).toBe(false)
})

test('the pane shows counts, license bars and what to review on every surface; buttons write other formats without rescanning', async ($, on) => {
  const state = world(on)
  await sbom($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'sbom', surface, component: 'Pane', requestId: 'sbom', props: PANE_PROPS })
    const header = (await ui.find({ key: 'header' }))?.text ?? ''
    expect(header).toContain('SBOM · demo-app')
    expect(header).toContain('✓ sbom.cdx.json')
    expect(header).toContain('32 packages · Go 17 · npm 10 · PyPI 5 · 4 dev-only')
    expect(header).toContain('from pnpm-lock.yaml, api/poetry.lock, svc/go.mod')
    expect((await ui.find({ key: 'license:MIT' }))?.text).toContain('3')
    expect((await ui.find({ key: 'review:pypi:idna@2.10' }))?.text).toContain('BSD-like')
    await ui.unmount()
  }

  const readsBefore = state.reads.length
  const ui = await $.ui.mount({ plugin: 'sbom', surface: 'terminal', component: 'Pane', requestId: 'sbom', props: PANE_PROPS })
  await ui.press({ key: 'write:spdx' })
  await ui.unmount()
  expect(state.reads.length).toBe(readsBefore)
  expect(state.toasts.at(-1)).toStartWith('Wrote sbom.spdx.json (SPDX 2.3): 32 packages')

  type Spdx = { spdxVersion: string; packages: { SPDXID: string; name: string; licenseDeclared: string }[]; relationships: { spdxElementId: string; relationshipType: string }[] }
  const spdx = JSON.parse(state.writes.get('/repo/sbom.spdx.json') ?? '{}') as Spdx
  expect(spdx.spdxVersion).toBe('SPDX-2.3')
  expect(spdx.packages).toHaveLength(33)
  expect(spdx.packages.every(entry => /^SPDXRef-[A-Za-z0-9.-]+$/.test(entry.SPDXID))).toBe(true)
  expect(spdx.packages.find(entry => entry.name === 'idna')?.licenseDeclared).toBe('NOASSERTION')
  expect(spdx.packages.find(entry => entry.name === 'requests')?.licenseDeclared).toBe('Apache-2.0')
  const minimist = spdx.packages.find(entry => entry.name === 'minimist')?.SPDXID
  expect(spdx.relationships.find(link => link.spdxElementId === minimist)?.relationshipType).toBe('DEV_DEPENDENCY_OF')
})

test('/sbom md writes a Markdown table into the configured folder', { options: { outputDir: 'docs/' } }, async ($, on) => {
  const state = world(on)
  expect((await sbom($, 'markdown')).text).toStartWith('Wrote docs/SBOM.md (Markdown): 32 packages')
  const markdown = state.writes.get('/repo/docs/SBOM.md') ?? ''
  expect(markdown).toContain('# Software Bill of Materials: demo-app')
  expect(markdown).toContain('| Package | Version | Ecosystem | License | Scope |')
  expect(markdown).toContain('| requests | 2.25.1 | PyPI | Apache-2.0 | runtime |')
  expect(markdown).toContain('| minimist | 1.2.0 | npm | MIT | dev |')
})

test('with registry lookups on, unknown licenses are fetched once and then cached', { options: { registryLookup: true } }, async ($, on) => {
  const files = { '/repo/Cargo.lock': '[[package]]\nname = "itoa"\nversion = "1.0.9"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n' }
  const state = world(on, files, { 'https://crates.io/api/v1/crates/itoa/1.0.9': JSON.stringify({ version: { license: 'MIT OR Apache-2.0' } }) })
  await sbom($)
  await sbom($, 'md')
  expect(state.fetched).toEqual(['https://crates.io/api/v1/crates/itoa/1.0.9'])
  expect(state.writes.get('/repo/SBOM.md')).toContain('| itoa | 1.0.9 | crates.io | MIT OR Apache-2.0 |  |')
})

test('says what it reads when there is no lockfile, and explains unknown formats', async ($, on) => {
  world(on, { '/repo/README.md': '# hi' })
  expect((await sbom($)).text).toStartWith('No dependencies found: no package-lock.json, pnpm-lock.yaml, yarn.lock')
  expect((await sbom($, 'xml')).text).toStartWith('Usage: /sbom [cyclonedx|spdx|md]')
})

test('license names are normalized to SPDX and classified by their most permissive choice', () => {
  expect(normalizeLicense('Apache 2.0')).toBe('Apache-2.0')
  expect(normalizeLicense('(MIT OR Apache-2.0)')).toBe('MIT OR Apache-2.0')
  expect(normalizeLicense('mit')).toBe('MIT')
  expect(normalizeLicense('Apache-2.0/MIT')).toBe('Apache-2.0 OR MIT')
  expect(normalizeLicense('GPL-2.0-or-later WITH Classpath-exception-2.0')).toBe('GPL-2.0-or-later WITH Classpath-exception-2.0')
  expect(normalizeLicense('(AFL-2.1 OR BSD-3-Clause)')).toBe('AFL-2.1 OR BSD-3-Clause')
  expect(normalizeLicense('UNKNOWN')).toBeUndefined()
  expect(normalizeLicense('SEE LICENSE IN LICENSE.md')).toBe('SEE LICENSE IN LICENSE.md')
  expect(classifyLicense('MIT OR GPL-3.0-only')).toBe('permissive')
  expect(classifyLicense('MIT AND GPL-3.0-only')).toBe('copyleft')
  expect(classifyLicense('LGPL-2.1-only')).toBe('weak copyleft')
  expect(classifyLicense('MPL-2.0')).toBe('weak copyleft')
  expect(classifyLicense('BSD-like')).toBe('other')
  expect(classifyLicense(undefined)).toBe('unknown')

  expect(licenseFromMetadata('Name: packaging\nLicense-Expression: Apache-2.0 OR BSD-2-Clause\nLicense-File: LICENSE\n')).toBe('Apache-2.0 OR BSD-2-Clause')
  expect(licenseFromMetadata('Name: chardet\nLicense: LGPL\nClassifier: License :: OSI Approved :: GNU Library or Lesser General Public License (LGPL)\n')).toBe('LGPL')
  expect(licenseFromMetadata('Name: x\nLicense: UNKNOWN\nClassifier: License :: OSI Approved :: MIT License\n\nLicense: GPL in the body')).toBe('MIT')
  expect(licenseFromText(BSD_3)).toBe('BSD-3-Clause')
  expect(licenseFromText('Permission is hereby granted, free of charge, to any person obtaining a copy')).toBe('MIT')
  expect(licenseFromText('                                 Apache License\n                           Version 2.0, January 2004\n')).toBe('Apache-2.0')
  expect(licenseFromText('All rights reserved. Proprietary.')).toBeUndefined()
})

test('package URLs, store paths and the documents keep to their specs', () => {
  expect(purlOf({ ecosystem: 'npm', name: '@types/node', version: '18.0.0' })).toBe('pkg:npm/%40types/node@18.0.0')
  expect(purlOf({ ecosystem: 'pypi', name: 'Typing_Extensions', version: '4.8.0' })).toBe('pkg:pypi/typing-extensions@4.8.0')
  expect(purlOf({ ecosystem: 'golang', name: 'github.com/BurntSushi/toml', version: 'v1.3.2' })).toBe('pkg:golang/github.com/BurntSushi/toml@v1.3.2')
  expect(purlOf({ ecosystem: 'npm', name: 'semver', version: '7.5.4+build.1' })).toBe('pkg:npm/semver@7.5.4%2Bbuild.1')
  expect(escapeGoPath('github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml')
  expect(distInfoKey('Jinja2-2.11.2.dist-info')).toBe('jinja2@2.11.2')
  expect(distInfoKey('jinja2')).toBeUndefined()
  expect(pnpmStorePath('/r', '@a/b', '1.0.0')).toBe('/r/node_modules/.pnpm/@a+b@1.0.0/node_modules/@a/b/package.json')
  expect(pickLockfiles('/r', ['go.sum', 'go.mod', 'uv.lock', 'requirements.txt', 'README.md']).map(one => one.name)).toEqual(['go.mod', 'uv.lock'])

  const meta = { project: 'x', timestamp: '2026-10-07T12:00:00Z', uuid: '00000000-0000-4000-8000-000000000000', sources: ['uv.lock'] }
  const deps = [
    { ecosystem: 'pypi' as const, name: 'numpy', version: '', isDev: false },
    { ecosystem: 'cargo' as const, name: 'serde', version: '1.0.0', license: 'MIT OR Apache-2.0' },
  ]
  const bom = JSON.parse(toCycloneDx(deps, meta)) as CycloneDx
  expect(bom.components[0]).toEqual({ type: 'library', 'bom-ref': 'pkg:pypi/numpy', name: 'numpy', scope: 'required', purl: 'pkg:pypi/numpy' })
  expect(bom.components[1]?.licenses).toEqual([{ expression: 'MIT OR Apache-2.0' }])
  const spdx = JSON.parse(toSpdx(deps, meta)) as { documentNamespace: string; packages: { versionInfo?: string }[] }
  expect(spdx.documentNamespace).toBe('https://spdx.org/spdxdocs/x-00000000-0000-4000-8000-000000000000')
  expect(spdx.packages[1]?.versionInfo).toBeUndefined()
})

test('a lookup that got no answer (offline) is tried again on the next scan; a 404 is remembered', { options: { registryLookup: true } }, async ($, on) => {
  const files = {
    '/repo/Cargo.lock':
      '[[package]]\nname = "itoa"\nversion = "1.0.9"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n' +
      '[[package]]\nname = "private-crate"\nversion = "0.1.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
  }
  const registry: Record<string, string> = { 'https://crates.io/api/v1/crates/itoa/1.0.9': 'OFFLINE' }
  const state = world(on, files, registry)
  await sbom($)
  registry['https://crates.io/api/v1/crates/itoa/1.0.9'] = JSON.stringify({ version: { license: 'MIT OR Apache-2.0' } })
  await sbom($, 'md')
  expect(state.fetched.filter(url => url.includes('itoa'))).toHaveLength(2)
  expect(state.fetched.filter(url => url.includes('private-crate'))).toHaveLength(1)
  expect(state.writes.get('/repo/SBOM.md')).toContain('| itoa | 1.0.9 | crates.io | MIT OR Apache-2.0 |  |')
})
