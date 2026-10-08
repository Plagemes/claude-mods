import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { installsIn, lookupOf } from '../hooks/install'
import { fakeHub } from './hub'
import { isPermissive, kindOf, licenseOfNpm, licenseOfPackageJson, licenseOfPypi, licenseOfPyproject, licenseOfText } from '../hooks/licenses'

/** The mock clock of the running test, moved on past afterStart's delay so the hub hello is sent. */
let startClock: ReturnType<typeof mock.clock> | undefined

const MIT_PROJECT = { 'package.json': JSON.stringify({ name: 'app', license: 'MIT' }) }

type Registry = Record<string, { status?: number; body?: unknown; text?: string } | 'hang'>

/** The engine beneath the plugin: a project of `files` in /proj, a registry by URL, a clock and a store, Bash that succeeds unless asked. */
const world = (on: On, files: Record<string, string>, registry: Registry) => {
  const clock = (startClock = mock.clock(on))
  mock.store(on)
  const seen = { fetched: [] as string[], toasts: [] as string[], advance: clock.advance, isFailing: false, ran: 0 }
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.read', (_$, e) => {
    const text = files[e.path.slice('/proj/'.length)]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('http.fetch', async (_$, e) => {
    seen.fetched.push(e.url)
    const answer = registry[e.url] ?? { status: 404 }
    if (answer === 'hang') await new Promise(() => undefined)
    const { status = 200, body, text } = answer as { status?: number; body?: unknown; text?: string }
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text: text ?? JSON.stringify(body ?? {}) } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => {
    seen.ran += 1
    return seen.isFailing ? { isError: true as const, result: 'npm ERR!', text: 'npm ERR!' } : { result: 'added 1 package', text: 'added 1 package' }
  })
  return seen
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const npm = (name: string, license: unknown) => ({ [`https://registry.npmjs.org/${name}/latest`]: { body: { name, license } } })
const pypi = (name: string, info: Record<string, unknown>) => ({ [`https://pypi.org/pypi/${name}/json`]: { body: { info } } })

test('after an npm install of a GPL package it toasts and adds a note for the model, and the install result is kept', async ($, on) => {
  const seen = world(on, MIT_PROJECT, npm('gpl-lib', 'GPL-3.0-only'))

  const result = await bash($, 'npm install gpl-lib')

  expect(result.isError).toBeUndefined()
  expect(result.text).toBe('added 1 package')
  expect(seen.toasts).toEqual(['⚠ gpl-lib is GPL-3.0-only (copyleft), but your project is MIT'])
  expect(result.context?.[0]).toContain('this project is licensed MIT')
  expect(result.context?.[0]).toContain('- gpl-lib is GPL-3.0-only (copyleft)')
  expect(result.context?.[0]).toContain('suggest a permissively licensed alternative')
})

test('permissive packages are not mentioned, and the registry is asked once per package a week', async ($, on) => {
  const seen = world(on, MIT_PROJECT, { ...npm('left-pad', 'MIT'), ...npm('nice', { type: 'Apache-2.0' }) })

  const first = await bash($, 'npm i left-pad nice')
  const again = await bash($, 'pnpm add left-pad')

  expect(first.context).toBeUndefined()
  expect(again.context).toBeUndefined()
  expect(seen.toasts).toEqual([])
  expect(seen.fetched).toEqual(['https://registry.npmjs.org/left-pad/latest', 'https://registry.npmjs.org/nice/latest'])
})

test('flags AGPL, LGPL, SSPL and licenses with no name or a name nobody knows, but not an OR that includes MIT', async ($, on) => {
  const seen = world(on, MIT_PROJECT, {
    ...npm('a', 'AGPL-3.0-or-later'),
    ...npm('b', 'LGPL-2.1'),
    ...npm('c', 'SSPL-1.0'),
    ...npm('d', 'UNLICENSED'),
    ...npm('e', undefined),
    ...npm('f', '(MIT OR GPL-3.0)'),
    ...npm('g', 'MIT AND GPL-2.0'),
    ...npm('h', 'Totally-Custom-License'),
  })

  const result = await bash($, 'npm install a b c d e f g h')

  const note = result.context?.[0] ?? ''
  expect(note).toContain('- a is AGPL-3.0-or-later (copyleft)')
  expect(note).toContain('- b is LGPL-2.1 (weak copyleft)')
  expect(note).toContain('- c is SSPL-1.0 (copyleft)')
  expect(note).toContain('- d has a license I do not recognise ("UNLICENSED")')
  expect(note).toContain('- e declares no license')
  expect(note).toContain('- g is MIT AND GPL-2.0 (copyleft)')
  expect(note).toContain('- h has a license I do not recognise ("Totally-Custom-License")')
  expect(note).not.toContain('- f ')
  expect(seen.toasts[0]).toBe('⚠ a is AGPL-3.0-or-later (copyleft) and 6 more, but your project is MIT')
})

test('PyPI: reads the SPDX expression, then the classifiers, then a short license field', async ($, on) => {
  const seen = world(on, MIT_PROJECT, {
    ...pypi('spdx-gpl', { license_expression: 'GPL-3.0-or-later', classifiers: ['License :: OSI Approved :: MIT License'] }),
    ...pypi('classified', { license: '', classifiers: ['License :: OSI Approved :: GNU General Public License v3 (GPLv3)', 'Programming Language :: Python'] }),
    ...pypi('plain', { license: 'LGPLv2+', classifiers: [] }),
    ...pypi('fine', { classifiers: ['License :: OSI Approved :: BSD License'] }),
    ...pypi('text', { license: 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction.' }),
  })

  const result = await bash($, 'pip install spdx-gpl classified plain fine text')

  const note = result.context?.[0] ?? ''
  expect(note).toContain('- spdx-gpl is GPL-3.0-or-later (copyleft)')
  expect(note).toContain('- classified is GNU General Public License v3 (GPLv3) (copyleft)')
  expect(note).toContain('- plain is LGPLv2+ (weak copyleft)')
  expect(note).not.toContain('- fine')
  expect(note).not.toContain('- text')
  expect(seen.fetched).toHaveLength(5)
})

test('an exact version is looked up as that version', async ($, on) => {
  const seen = world(on, MIT_PROJECT, {
    'https://registry.npmjs.org/@scope%2fpkg/1.2.3': { body: { license: 'GPL-2.0' } },
    'https://pypi.org/pypi/django/4.2.1/json': { body: { info: { license_expression: 'BSD-3-Clause' } } },
    'https://pypi.org/pypi/numpy/json': { body: { info: { license_expression: 'BSD-3-Clause' } } },
  })

  const scoped = await bash($, 'yarn add @scope/pkg@1.2.3')
  await bash($, 'pip install "Django==4.2.1" numpy>=1.2')

  expect(scoped.context?.[0]).toContain('- @scope/pkg is GPL-2.0 (copyleft)')
  expect(seen.fetched).toEqual(['https://registry.npmjs.org/@scope%2fpkg/1.2.3', 'https://pypi.org/pypi/django/4.2.1/json', 'https://pypi.org/pypi/numpy/json'])
})

const PROJECT_LICENSE_CASES: [string, Record<string, string>, boolean][] = [
  ['package.json', { 'package.json': '{ "license": "Apache-2.0" }' }, true],
  ['pyproject.toml', { 'pyproject.toml': '[project]\nname = "x"\nlicense = { text = "BSD-3-Clause" }\n' }, true],
  ['a LICENSE file', { LICENSE: 'MIT License\n\nCopyright (c) 2026 Someone\n\nPermission is hereby granted, free of charge' }, true],
  ['"SEE LICENSE IN" falls through to the LICENSE.md', { 'package.json': '{ "license": "SEE LICENSE IN LICENSE.md" }', 'LICENSE.md': 'Apache License\nVersion 2.0, January 2004' }, true],
  ['a GPL project is not warned', { 'package.json': '{ "license": "GPL-3.0" }' }, false],
  ['a proprietary project is not warned', { 'package.json': '{ "license": "UNLICENSED" }' }, false],
  ['no license anywhere is not warned', { 'package.json': '{ "name": "x" }' }, false],
]

for (const [label, files, isWarned] of PROJECT_LICENSE_CASES) {
  test(`project license from ${label}`, async ($, on) => {
    const seen = world(on, files, npm('gpl-lib', 'GPL-3.0'))

    const result = await bash($, 'npm install gpl-lib')

    expect(result.context !== undefined).toBe(isWarned)
    if (!isWarned) expect(seen.fetched).toEqual([])
  })
}

test('the project license can be set in the settings, overriding what the files say', { options: { projectLicense: 'BSD-2-Clause' } }, async ($, on) => {
  const seen = world(on, { 'package.json': '{ "license": "GPL-3.0" }' }, npm('gpl-lib', 'GPL-3.0'))

  const result = await bash($, 'npm install gpl-lib')

  expect(result.context?.[0]).toContain('this project is licensed BSD-2-Clause')
  expect(seen.toasts).toHaveLength(1)
})

test('without a permissive project license nothing is looked up', async ($, on) => {
  const seen = world(on, { 'package.json': '{ "license": "GPL-3.0" }' }, npm('gpl-lib', 'GPL-3.0'))

  const result = await bash($, 'npm install gpl-lib')

  expect(result.context).toBeUndefined()
  expect(seen.fetched).toEqual([])
})

test('a failed install is not checked, nor are commands that install nothing, global installs or dev dependencies', async ($, on) => {
  const seen = world(on, MIT_PROJECT, { ...npm('gpl-lib', 'GPL-3.0'), ...npm('dev-lib', 'GPL-3.0') })

  seen.isFailing = true
  await bash($, 'npm install gpl-lib')
  seen.isFailing = false
  await bash($, 'npm install')
  await bash($, 'npm install -g gpl-lib')
  await bash($, 'npm test && ls')
  const dev = await bash($, 'npm install -D dev-lib')

  expect(seen.fetched).toEqual([])
  expect(dev.context).toBeUndefined()
})

test('dev dependencies can be checked too, and allowed packages are skipped', { options: { checkDev: true, allowedPackages: 'Reviewed-Lib, other' } }, async ($, on) => {
  const seen = world(on, MIT_PROJECT, { ...npm('dev-lib', 'GPL-3.0'), ...npm('reviewed-lib', 'LGPL-3.0') })

  const result = await bash($, 'npm install -D dev-lib reviewed-lib')

  expect(result.context?.[0]).toContain('- dev-lib is GPL-3.0 (copyleft)')
  expect(result.context?.[0]).not.toContain('reviewed-lib')
  expect(seen.fetched).toEqual(['https://registry.npmjs.org/dev-lib/latest'])
})

test('a registry that is slow, down or missing the package never blocks or fails the install', async ($, on) => {
  const seen = world(on, MIT_PROJECT, {
    'https://registry.npmjs.org/slow/latest': 'hang',
    'https://registry.npmjs.org/down/latest': { status: 503 },
    'https://registry.npmjs.org/garbled/latest': { text: '<html>' },
  })

  const pending = bash($, 'npm install slow down garbled nowhere')
  await seen.advance(4000)
  const result = await pending

  expect(result.isError).toBeUndefined()
  expect(result.text).toBe('added 1 package')
  expect(result.context).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('the lookup timeout is configurable', { options: { timeoutMs: 1000 } }, async ($, on) => {
  const seen = world(on, MIT_PROJECT, { 'https://registry.npmjs.org/slow/latest': 'hang' })

  const pending = bash($, 'npm install slow')
  await seen.advance(1000)

  expect((await pending).context).toBeUndefined()
})

test('license names are classified the way a lawyer would skim them', () => {
  for (const license of ['MIT', 'MIT License', 'Apache-2.0', 'Apache Software License', 'BSD-3-Clause', 'BSD License', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0', 'Python-2.0', 'BlueOak-1.0.0', '(MIT OR Apache-2.0)', 'MIT OR GPL-3.0', 'Apache-2.0 WITH LLVM-exception']) {
    expect(kindOf(license), license).toBe('permissive')
  }
  for (const license of ['GPL-2.0', 'GPL-3.0-or-later', 'GNU General Public License v2 or later (GPLv2+)', 'AGPL-3.0', 'GNU Affero General Public License v3', 'SSPL-1.0', 'EUPL-1.2', 'MIT AND GPL-3.0']) {
    expect(kindOf(license), license).toBe('copyleft')
  }
  for (const license of ['LGPL-2.1', 'LGPL-3.0-only', 'GNU Lesser General Public License v3 (LGPLv3)', 'MPL-2.0', 'EPL-2.0', 'CDDL-1.0']) {
    expect(kindOf(license), license).toBe('weak-copyleft')
  }
  for (const license of ['UNLICENSED', 'Proprietary', 'SEE LICENSE IN LICENSE', '', 'BUSL-1.1', 'Whatever']) {
    expect(kindOf(license), license).toBe('unknown')
  }
  expect(isPermissive('MIT')).toBe(true)
  expect(isPermissive('GPL-3.0')).toBe(false)
})

test('licenses are read from registry documents, package.json, pyproject.toml and LICENSE text', () => {
  expect(licenseOfNpm({ license: 'MIT' })).toBe('MIT')
  expect(licenseOfNpm({ license: { type: 'ISC' } })).toBe('ISC')
  expect(licenseOfNpm({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
  expect(licenseOfNpm({ name: 'x' })).toBeUndefined()
  expect(licenseOfNpm(null)).toBeUndefined()
  expect(licenseOfPypi({ info: { license_expression: 'MIT' } })).toBe('MIT')
  expect(licenseOfPypi({ info: { classifiers: ['License :: OSI Approved :: MIT License', 'License :: OSI Approved :: Apache Software License'] } })).toBe('MIT License OR Apache Software License')
  expect(licenseOfPypi({ info: { license: 'x'.repeat(500) } })).toHaveLength(300)
  expect(licenseOfPypi({ info: {} })).toBeUndefined()
  expect(licenseOfPackageJson('{ "license": "MIT" }')).toBe('MIT')
  expect(licenseOfPackageJson('not json')).toBeUndefined()
  expect(licenseOfPyproject('[tool.poetry]\nlicense = "MIT"\n')).toBe('MIT')
  expect(licenseOfPyproject('classifiers = ["License :: OSI Approved :: MIT License"]')).toBe('MIT License')
  expect(licenseOfText('                    GNU GENERAL PUBLIC LICENSE\n Version 3')).toBe('GPL-3.0')
  expect(licenseOfText('Redistribution and use in source and binary forms, with or without modification, are permitted. Neither the name of')).toBe('BSD-3-Clause')
  expect(licenseOfText('Some custom terms')).toBeUndefined()
})

test('install commands: what counts as a project dependency', () => {
  const names = (command: string) => installsIn(command).map(r => `${r.ecosystem}:${r.name}${r.version === undefined ? '' : `@${r.version}`}${r.isDev ? ' (dev)' : ''}`)

  expect(names('npm install left-pad @babel/core@7.0.0 lodash@^4')).toEqual(['npm:left-pad', 'npm:@babel/core@7.0.0', 'npm:lodash@^4'])
  expect(names('pnpm add -D vitest && yarn add react')).toEqual(['npm:vitest (dev)', 'npm:react'])
  expect(names('bun add --dev tsx')).toEqual(['npm:tsx (dev)'])
  expect(names('npm i -g typescript')).toEqual([])
  expect(names('npm install ./local ../other github:user/repo user/repo https://x.io/a.tgz')).toEqual([])
  expect(names('npm install --prefix web -w app left-pad')).toEqual(['npm:left-pad'])
  expect(names('npm install')).toEqual([])
  expect(names('pip install -r requirements.txt -e . requests==2.31.0 "flask[async]>=2" ./local')).toEqual(['pypi:requests@2.31.0', 'pypi:flask'])
  expect(names('python3 -m pip install --upgrade pip Django==4.*')).toEqual(['pypi:pip', 'pypi:django'])
  expect(names('uv add httpx && uv pip install rich && poetry add --group dev pytest')).toEqual(['pypi:httpx', 'pypi:rich', 'pypi:pytest (dev)'])
  expect(names('sudo -H pip install requests')).toEqual(['pypi:requests'])
  expect(names('git commit -m "npm install left-pad"')).toEqual([])
  expect(names('echo hi')).toEqual([])

  expect(lookupOf({ ecosystem: 'npm', name: '@s/p', version: '^1.0.0', isDev: false })).toEqual({ url: 'https://registry.npmjs.org/@s%2fp/latest', key: 'npm:@s/p@latest' })
  expect(lookupOf({ ecosystem: 'npm', name: 'p', version: 'beta', isDev: false }).url).toBe('https://registry.npmjs.org/p/beta')
  expect(lookupOf({ ecosystem: 'pypi', name: 'p', isDev: false }).url).toBe('https://pypi.org/pypi/p/json')
})

test('regression: installs behind bash -lc, eval and wrappers with options are read', () => {
  const names = (command: string) => installsIn(command).map(r => `${r.ecosystem}:${r.name}`)
  expect(names('bash -lc "npm install left-pad"')).toEqual(['npm:left-pad'])
  expect(names(`sh -ec 'cd web && pip install requests'`)).toEqual(['pypi:requests'])
  expect(names(`eval "yarn add react"`)).toEqual(['npm:react'])
  expect(names('timeout 120 npm i lodash')).toEqual(['npm:lodash'])
  expect(names('env -u PROXY CI=1 nice -n 5 pnpm add zod')).toEqual(['npm:zod'])
  expect(names('sudo -u me -H pip install flask')).toEqual(['pypi:flask'])
  expect(names('bash ./install.sh npm')).toEqual([])
})

test('with mods-hub: says hello, publishes risk.blocked for each license worth a look, and warns through the hub with the same toast as a fallback', async ($, on) => {
  const seen = world(on, MIT_PROJECT, { ...npm('gpl-lib', 'GPL-3.0-only'), ...npm('nolicense', undefined), ...npm('left-pad', 'MIT') })
  const hub = fakeHub(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await startClock?.advance(1_500) // the hello waits for session.start to return (afterStart)
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve()
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])

  const result = await bash($, 'npm install gpl-lib nolicense left-pad')
  expect(result.context?.[0]).toContain('this project is licensed MIT')
  expect(hub.published).toEqual([
    { topic: 'risk.blocked', data: { guard: 'license-checker', tool: 'Bash', reason: 'gpl-lib is GPL-3.0-only (copyleft), but your project is MIT', severity: 'medium' } },
    { topic: 'risk.blocked', data: { guard: 'license-checker', tool: 'Bash', reason: 'nolicense declares no license, but your project is MIT', severity: 'low' } },
  ])
  expect(hub.notified).toEqual([{ level: 'warning', title: '⚠ gpl-lib is GPL-3.0-only (copyleft) and 1 more, but your project is MIT' }])
  expect(seen.toasts).toEqual([])
})

test('with mods-hub, permissive packages publish nothing and say nothing', async ($, on) => {
  const seen = world(on, MIT_PROJECT, { ...npm('left-pad', 'MIT'), ...npm('gpl-lib', 'GPL-3.0-only') })
  const hub = fakeHub(on)
  await bash($, 'npm i left-pad')
  expect(hub.published).toEqual([])
  expect(hub.notified).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('without mods-hub the warning is the toast as before', async ($, on) => {
  const seen = world(on, MIT_PROJECT, npm('gpl-lib', 'GPL-3.0-only'))
  await bash($, 'npm install gpl-lib')
  expect(seen.toasts).toEqual(['⚠ gpl-lib is GPL-3.0-only (copyleft), but your project is MIT'])
})

test('installs are read with the shared shell reader: compound lines, substitutions and nested scripts', () => {
  const names = (command: string) => installsIn(command).map(r => `${r.ecosystem}:${r.name}`)
  expect(names('cd web && npm install left-pad | tee log')).toEqual(['npm:left-pad'])
  expect(names('bash -c "cd web && pnpm add zod"')).toEqual(['npm:zod'])
  expect(names('xargs -n1 pip install < reqs.txt')).toEqual([])
  expect(names('npm install $(cat deps.txt)')).toEqual([])
})
