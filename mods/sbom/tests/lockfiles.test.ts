import { expect, test } from 'claude-code/testing'

import {
  compareGoVersions,
  lockfileKind,
  parseCargoLock,
  parseGoMod,
  parseGoSum,
  parsePackageLock,
  parsePnpmLock,
  parsePoetryLock,
  parseRequirements,
  parseUvLock,
  parseYarnLock,
  pnpmKey,
  rootsOfManifest,
} from '../hooks/lockfiles'
import type { Dependency } from '../hooks/lockfiles'
import { parseToml } from '../hooks/toml'
import { parseYaml } from '../hooks/yaml'
import {
  CARGO_LOCK,
  GO_MOD,
  GO_SUM,
  PACKAGE_JSON,
  PACKAGE_LOCK_V3,
  PNPM_LOCK_V9,
  POETRY_LOCK,
  UV_LOCK,
  YARN_LOCK_BERRY,
  YARN_LOCK_V1,
} from './fixtures'

const byName = (found: readonly Dependency[]) => new Map(found.map(one => [`${one.name}@${one.version}`, one]))
const devNames = (found: readonly Dependency[]) =>
  found
    .filter(one => one.isDev === true)
    .map(one => one.name)
    .sort()

test('package-lock v3: nested copies, scoped names, dev flags and licenses; workspace links left out', () => {
  const found = parsePackageLock(PACKAGE_LOCK_V3)
  const named = byName(found)
  expect(named.get('@sindresorhus/slugify@1.1.0')).toEqual({ ecosystem: 'npm', name: '@sindresorhus/slugify', version: '1.1.0', isDev: false, license: 'MIT' })
  expect(named.has('escape-string-regexp@2.0.0')).toBe(true)
  expect(named.has('escape-string-regexp@4.0.0')).toBe(true)
  expect(named.get('request@2.88.2')?.license).toBe('Apache-2.0')
  expect(devNames(found)).toEqual(['@types/node', 'minimist'])
  expect(found.some(one => one.name === '@demo/util')).toBe(false)
  expect(found).toHaveLength(10)
})

test('package-lock v1: the nested dependencies tree', () => {
  const v1 = JSON.stringify({
    name: 'old-app',
    lockfileVersion: 1,
    dependencies: {
      debug: { version: '2.6.9', requires: { ms: '2.0.0' }, dependencies: { ms: { version: '2.0.0' } } },
      ms: { version: '2.1.3' },
      mocha: { version: '8.4.0', dev: true },
      local: { version: 'file:../local' },
    },
  })
  const found = parsePackageLock(v1)
  expect(found.map(one => `${one.name}@${one.version}`)).toEqual(['debug@2.6.9', 'ms@2.0.0', 'ms@2.1.3', 'mocha@8.4.0'])
  expect(devNames(found)).toEqual(['mocha'])
})

test('pnpm v9: dev scope from walking importers through snapshots', () => {
  const found = parsePnpmLock(PNPM_LOCK_V9)
  expect(found).toHaveLength(10)
  expect(byName(found).get('@sindresorhus/transliterate@0.1.2')).toEqual({
    ecosystem: 'npm',
    name: '@sindresorhus/transliterate',
    version: '0.1.2',
    isDev: false,
  })
  expect(devNames(found)).toEqual(['@types/node', 'minimist'])
})

test('pnpm v5 and v6 keys, peer suffixes and their dev flags', () => {
  expect(pnpmKey('/@babel/core/7.20.0_supports-color@8.1.1', true)).toEqual({ name: '@babel/core', version: '7.20.0' })
  expect(pnpmKey('/ws@8.13.0(bufferutil@4.0.7)', false)).toEqual({ name: 'ws', version: '8.13.0' })
  expect(pnpmKey("@types/node@20.4.2", false)).toEqual({ name: '@types/node', version: '20.4.2' })
  const v6 = [
    "lockfileVersion: '6.0'",
    '',
    'dependencies:',
    '  ws:',
    '    specifier: ^8.13.0',
    '    version: 8.13.0(bufferutil@4.0.7)',
    '',
    'packages:',
    '',
    '  /bufferutil@4.0.7:',
    '    resolution: {integrity: sha512-abc}',
    "    engines: {node: '>=6.14.2'}",
    '    requiresBuild: true',
    '    dev: false',
    '',
    '  /ws@8.13.0(bufferutil@4.0.7):',
    '    resolution: {integrity: sha512-def}',
    '    peerDependencies:',
    '      bufferutil: ^4.0.1',
    '    dev: false',
    '',
    '  /vitest@0.34.1:',
    '    resolution: {integrity: sha512-ghi}',
    '    hasBin: true',
    '    dev: true',
    '',
    '  github.com/user/repo/abc123:',
    '    resolution: {tarball: https://codeload.github.com/user/repo/tar.gz/abc123}',
    '    name: repo-pkg',
    '    version: 1.0.0',
    '    dev: false',
  ].join('\n')
  const found = parsePnpmLock(v6)
  expect(found.map(one => `${one.name}@${one.version}:${String(one.isDev)}`)).toEqual([
    'bufferutil@4.0.7:false',
    'ws@8.13.0:false',
    'vitest@0.34.1:true',
    'repo-pkg@1.0.0:false',
  ])
})

test('yarn v1 and Berry: names from descriptors, workspace entries out, dev scope from package.json', () => {
  const roots = rootsOfManifest(PACKAGE_JSON)
  const classic = parseYarnLock(YARN_LOCK_V1, roots)
  expect(byName(classic).has('escape-string-regexp@2.0.0')).toBe(true)
  expect(byName(classic).has('@sindresorhus/transliterate@0.1.2')).toBe(true)
  expect(devNames(classic)).toEqual(['@types/node', 'minimist'])

  const berry = parseYarnLock(YARN_LOCK_BERRY, roots)
  expect(berry.some(one => one.name === 'demo-app')).toBe(false)
  expect(byName(berry).get('lodash.deburr@4.1.0')?.isDev).toBe(false)
  expect(devNames(berry)).toEqual(['@types/node', 'minimist'])
  expect(parseYarnLock(YARN_LOCK_BERRY).every(one => one.isDev === undefined)).toBe(true)

  const alias = parseYarnLock('"string-width-cjs@npm:string-width@^4.2.0":\n  version "4.2.3"\n')
  expect(alias).toEqual([{ ecosystem: 'npm', name: 'string-width', version: '4.2.3' }])
})

test('poetry.lock groups and uv.lock dev groups mark dev packages; names are normalized', () => {
  const poetry = parsePoetryLock(POETRY_LOCK)
  expect(poetry.map(one => one.name).sort()).toEqual(['django', 'idna', 'iniconfig', 'pytest', 'requests'])
  expect(devNames(poetry)).toEqual(['iniconfig', 'pytest'])
  const legacy = parsePoetryLock('[[package]]\nname = "Flask_Cors"\nversion = "3.0.10"\ncategory = "dev"\noptional = false\n')
  expect(legacy).toEqual([{ ecosystem: 'pypi', name: 'flask-cors', version: '3.0.10', isDev: true }])

  const uv = parseUvLock(UV_LOCK)
  expect(uv.some(one => one.name === 'demo-py')).toBe(false)
  expect(byName(uv).get('jinja2@2.11.2')?.isDev).toBe(false)
  expect(byName(uv).get('urllib3@1.26.20')?.isDev).toBe(false)
  expect(devNames(uv)).toEqual(['colorama', 'iniconfig', 'packaging', 'pluggy', 'pygments', 'pytest'])
})

test('requirements files: pins, extras, markers, hashes and continuations; options and URLs skipped', () => {
  const text = [
    '# app requirements',
    '-r base.txt',
    '--index-url https://pypi.org/simple',
    'Django==4.2.7 \\',
    '    --hash=sha256:abc \\',
    '    --hash=sha256:def',
    'requests[socks]==2.31.0 ; python_version >= "3.8"  # pinned',
    'numpy>=1.24',
    'typing_extensions===4.8.0',
    'mylib @ https://example.com/mylib-1.0.tar.gz',
    '-e git+https://github.com/x/y.git#egg=y',
  ].join('\n')
  expect(parseRequirements(text)).toEqual([
    { ecosystem: 'pypi', name: 'django', version: '4.2.7', isDev: false },
    { ecosystem: 'pypi', name: 'requests', version: '2.31.0', isDev: false },
    { ecosystem: 'pypi', name: 'numpy', version: '', isDev: false },
    { ecosystem: 'pypi', name: 'typing-extensions', version: '4.8.0', isDev: false },
  ])
  expect(lockfileKind('requirements-dev.txt')).toBe('requirements.txt')
  expect(lockfileKind('package.json')).toBeUndefined()
})

test('Cargo.lock leaves out the crate itself; go.mod lists requires, go.sum keeps the highest version', () => {
  const cargo = parseCargoLock(CARGO_LOCK)
  expect(cargo.some(one => one.name === 'demo-rs')).toBe(false)
  expect(byName(cargo).has('time@0.1.45')).toBe(true)
  expect(cargo.every(one => one.ecosystem === 'cargo')).toBe(true)

  const mod = parseGoMod(GO_MOD)
  expect(mod).toHaveLength(17)
  expect(byName(mod).has('github.com/google/uuid@v1.3.0')).toBe(true)
  expect(byName(mod).has('golang.org/x/crypto@v0.0.0-20200622213623-75b288015ac9')).toBe(true)

  const sum = parseGoSum(GO_SUM)
  expect(byName(sum).has('github.com/davecgh/go-spew@v1.1.1')).toBe(true)
  expect(byName(sum).has('github.com/davecgh/go-spew@v1.1.0')).toBe(false)
  expect(compareGoVersions('v1.10.0', 'v1.9.3')).toBeGreaterThan(0)
  expect(compareGoVersions('v0.0.0-20200622213623-75b288015ac9', 'v0.0.0-20190308221718-c2843e01d9a2')).toBeGreaterThan(0)
})

test('the TOML and YAML readers cover what lockfiles use', () => {
  const toml = parseToml(
    [
      '# comment',
      'version = 4',
      '[[package]]',
      'name = "a"',
      "literal = 'C:\\path'",
      'deps = [',
      '  { name = "b", marker = "python_version < \\"3.11\\"" },  # trailing',
      '  "c",',
      ']',
      '[package.extras]',
      'socks = ["PySocks (>=1.5.6, !=1.5.7)"]',
      '[[package]]',
      'name = "d"',
      'when = 2024-01-01T00:00:00Z',
      'ok = true',
    ].join('\n'),
  )
  expect(toml).toEqual({
    version: 4,
    package: [
      { name: 'a', literal: 'C:\\path', deps: [{ name: 'b', marker: 'python_version < "3.11"' }, 'c'], extras: { socks: ['PySocks (>=1.5.6, !=1.5.7)'] } },
      { name: 'd', when: '2024-01-01T00:00:00Z', ok: true },
    ],
  })
  expect(() => parseToml('name = ')).toThrow()

  const yaml = parseYaml("a:\n  'b@1': {}\n  c:\n    - x\n    - 'y'\n  d: {integrity: z}  # note\ne: \"q\"\n")
  expect(yaml).toEqual({ a: { 'b@1': {}, c: ['x', 'y'], d: '{integrity: z}' }, e: 'q' })
})
