import { expect, test } from 'claude-code/testing'

import {
  classify,
  compareVersions,
  jsonStream,
  kindLine,
  parseCargoOutdated,
  parseGoList,
  parseNpmOutdated,
  parsePipOutdated,
  parsePnpmOutdated,
  parseYarnOutdated,
  pyprojectNames,
  requirementNames,
  safeUpgrades,
  sortByRisk,
  upgradeCommand,
  upgradePrompt,
} from '../hooks/outdated'
import type { Package } from '../hooks/outdated'
import { CARGO_OUTDATED, GO_LIST, NPM_OUTDATED, PIP_OUTDATED, PNPM_OUTDATED, YARN_OUTDATED } from './fixtures'

const brief = (packages: readonly Package[]) =>
  Object.fromEntries(packages.map(pkg => [pkg.name, `${pkg.current}→${pkg.latest} ${pkg.kind}${pkg.safe === undefined ? '' : ` safe ${pkg.safe.version} ${pkg.safe.kind}`}`]))

test('semver: majors, 0.x minors as majors, pre-releases and build tags', () => {
  expect(classify('4.17.1', '5.2.1')).toBe('major')
  expect(classify('4.17.1', '4.22.3')).toBe('minor')
  expect(classify('2.1.2', '2.1.3')).toBe('patch')
  expect(classify('0.3.7', '0.42.0')).toBe('major')
  expect(classify('0.3.7', '0.3.9')).toBe('patch')
  expect(classify('0.0.3', '0.0.4')).toBe('major')
  expect(classify('v0.0.0-20200622213623-75b288015ac9', 'v0.43.0')).toBe('major')
  expect(classify('2.0.0', '2.0.0')).toBeUndefined()
  expect(classify('3.0.0', '2.9.9')).toBeUndefined()
  expect(classify('2023.7.22', '2026.7.22')).toBe('major')
  expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
})

test('npm outdated --json --long: latest jump, the wanted version as the safe one, dev flags', () => {
  const packages = parseNpmOutdated(NPM_OUTDATED)
  expect(brief(packages)).toEqual({
    '@types/node': '18.0.0→26.6.4 major safe 18.19.130 minor',
    debug: '4.3.1→4.4.3 minor safe 4.4.3 minor',
    express: '4.17.1→5.2.1 major safe 4.22.3 minor',
    lodash: '4.17.15→4.18.1 minor safe 4.18.1 minor',
    ms: '2.1.2→2.1.3 patch safe 2.1.3 patch',
    react: '17.0.2→19.3.0 major',
    request: '2.88.0→2.88.2 patch safe 2.88.2 patch',
    typescript: '4.9.4→7.0.2 major safe 4.9.5 patch',
  })
  expect(packages.filter(pkg => pkg.isDev).map(pkg => pkg.name)).toEqual(['@types/node', 'typescript'])
  expect(() => parseNpmOutdated('{"error":{"code":"ENOENT","summary":"No package.json"}}')).toThrow()
})

test('pnpm reports deprecation; yarn 1 writes a table', () => {
  const pnpm = parsePnpmOutdated(PNPM_OUTDATED)
  expect(pnpm.find(pkg => pkg.name === 'request')?.deprecated).toBe('deprecated on the registry')
  expect(pnpm.find(pkg => pkg.name === 'minimist')).toEqual({
    manager: 'pnpm',
    name: 'minimist',
    current: '1.2.0',
    latest: '1.2.8',
    kind: 'patch',
    safe: { version: '1.2.8', kind: 'patch' },
    isDev: true,
    isDirect: true,
  })
  const yarn = parseYarnOutdated(YARN_OUTDATED)
  expect(brief(yarn)).toEqual({
    '@sindresorhus/slugify': '1.1.0→3.0.1 major',
    '@types/node': '18.0.0→26.6.4 major',
    express: '4.17.1→5.2.1 major',
    lodash: '4.17.15→4.18.1 minor safe 4.18.1 minor',
    minimist: '1.2.0→1.2.8 patch safe 1.2.8 patch',
  })
})

test('pip list marks what the project asks for directly; cargo outdated keeps compatible versions', () => {
  const direct = pyprojectNames(
    '[project]\nname = "demo-py"\ndescription = "Add your description here"\nrequires-python = ">=3.13"\ndependencies = [\n  "requests>=2.25",\n  "Flask[async]==2.0.0",\n]\n\n[dependency-groups]\ndev = ["pytest>=8"]\n',
  )
  expect([...direct].sort()).toEqual(['flask', 'pytest', 'requests'])
  const poetry = pyprojectNames('[tool.poetry]\nname = "app"\n\n[tool.poetry.dependencies]\npython = "^3.10"\nDjango = "3.2.0"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n')
  expect([...poetry].sort()).toEqual(['django', 'pytest'])
  const pip = parsePipOutdated(PIP_OUTDATED, direct)
  expect(pip.filter(pkg => pkg.isDirect).map(pkg => pkg.name)).toEqual(['Flask', 'requests'])
  expect(pip.find(pkg => pkg.name === 'six')).toEqual({
    manager: 'pip',
    name: 'six',
    current: '1.15.0',
    latest: '1.17.0',
    kind: 'minor',
    safe: { version: '1.17.0', kind: 'minor' },
    isDirect: false,
  })
  expect(parsePipOutdated(PIP_OUTDATED).every(pkg => pkg.isDirect === undefined)).toBe(true)
  expect(requirementNames('requests==2.25.1\n-r base.txt\nsix ; python_version < "3"\n# comment\n')).toEqual(new Set(['requests', 'six']))

  expect(brief(parseCargoOutdated(CARGO_OUTDATED))).toEqual({ time: '0.1.45→0.3.55 major' })
  const compat = parseCargoOutdated(
    '{"crate_name":"x","dependencies":[{"name":"serde","project":"1.0.100","compat":"1.0.229","latest":"1.0.229","kind":"Normal","platform":null},{"name":"a->b","project":"1.0.0","compat":"---","latest":"Removed","kind":"Normal","platform":null}]}',
  )
  expect(brief(compat)).toEqual({ serde: '1.0.100→1.0.229 patch safe 1.0.229 patch' })
})

test('go list -u -m -json: a stream of objects; the main module skipped, indirect ones flagged', () => {
  expect(jsonStream('{"a": "}"}\n{"b": {"c": 1}}')).toEqual([{ a: '}' }, { b: { c: 1 } }])
  const go = parseGoList(GO_LIST)
  expect(brief(go)).toEqual({
    'github.com/gin-gonic/gin': 'v1.7.0→v1.12.0 minor safe v1.12.0 minor',
    'github.com/google/uuid': 'v1.3.0→v1.6.0 minor safe v1.6.0 minor',
    'golang.org/x/text': 'v0.3.7→v0.42.0 major',
    'github.com/gin-contrib/sse': 'v0.1.0→v1.1.2 major',
  })
  expect(go.find(pkg => pkg.name === 'github.com/gin-contrib/sse')?.isDirect).toBe(false)
  const deprecated = parseGoList('{"Path":"github.com/old/lib","Version":"v1.0.0","Deprecated":"use github.com/new/lib"}')
  expect(deprecated[0]?.deprecated).toBe('use github.com/new/lib')
})

test('risk order, upgrade commands and the prompt for safe upgrades', () => {
  const npm = parseNpmOutdated(NPM_OUTDATED)
  npm.forEach(pkg => {
    if (pkg.name === 'request') pkg.deprecated = 'request has been deprecated'
  })
  expect(sortByRisk(npm).map(pkg => pkg.name)).toEqual(['@types/node', 'express', 'react', 'typescript', 'debug', 'lodash', 'request', 'ms'])
  expect(kindLine(npm)).toBe('4 major · 2 minor · 2 patch · 1 deprecated')
  const typescript = npm.find(pkg => pkg.name === 'typescript') as Package
  expect(upgradeCommand(typescript)).toBe('npm install typescript@7.0.2 --save-dev')
  expect(upgradeCommand({ ...typescript, manager: 'pnpm' }, '4.9.5')).toBe('pnpm add typescript@4.9.5 -D')
  expect(upgradeCommand({ manager: 'pip', name: 'six', current: '1.15.0', latest: '1.17.0', kind: 'minor' })).toBe('pip install --upgrade "six==1.17.0"')
  expect(upgradeCommand({ manager: 'go', name: 'golang.org/x/text', current: 'v0.3.7', latest: 'v0.42.0', kind: 'major' })).toBe('go get golang.org/x/text@v0.42.0')

  const safe = safeUpgrades(npm)
  expect(safe.map(pkg => pkg.name).sort()).toEqual(['@types/node', 'debug', 'express', 'lodash', 'ms', 'request', 'typescript'])
  const prompt = upgradePrompt(safe)
  expect(prompt).toStartWith('Upgrade these dependencies to their newest patch or minor version, no major upgrades:')
  expect(prompt).toContain('- express 4.17.1 → 4.22.3 (minor): `npm install express@4.22.3`')
  expect(prompt).toContain('run the test suite')
})
