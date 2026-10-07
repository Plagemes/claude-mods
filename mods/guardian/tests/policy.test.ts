import { expect, test } from 'claude-code/testing'

import { GUARDS, LEVELS, applyChanges, describeChange, planApply, policyFile, policyFor, readPolicyFile } from '../hooks/policy'

const MARKET = 'claude-mods'
const ALL = new Set(GUARDS.map(guard => guard.name))

test('every guard key maps to its column at each level, with one type per key', () => {
  LEVELS.forEach((level, index) => {
    const policy = policyFor(level)
    for (const guard of GUARDS) {
      const options = policy.guards[guard.name]?.options ?? {}
      expect(Object.keys(options).sort()).toEqual(Object.keys(guard.settings).sort())
      for (const [key, column] of Object.entries(guard.settings)) {
        expect(options[key]).toEqual(column[index])
        expect(new Set(column.map(value => typeof value)).size).toBe(1)
      }
    }
  })
})

test('the levels: permissive is looser, strict tighter, standard the guards’ own defaults', () => {
  const permissive = policyFor('permissive').guards
  const standard = policyFor('standard').guards
  const strict = policyFor('strict').guards
  expect(permissive['rm-rf-guard']?.options).toEqual({ allowGitReset: true })
  expect(standard['rm-rf-guard']?.options).toEqual({ allowGitReset: false })
  expect(standard['force-push-guard']?.options.protectedBranches).toBe('main,master,develop,release/*')
  expect(strict['force-push-guard']?.options.protectedBranches).toContain('production')
  expect(strict['crypto-guard']?.options.mode).toBe('block')
  expect(standard['sql-safety']?.options.mode).toBe('warn')
  expect(strict['dependency-sentinel']?.options.minAgeDays).toBe(90)
  expect(strict['redactor']?.options.privateIps).toBe(true)
  expect(permissive['url-allowlist']?.options.mode).toBe('block')

  const recommended = (guards: typeof strict) => Object.entries(guards).filter(([, guard]) => guard.isRecommended).map(([name]) => name)
  expect(recommended(permissive)).toEqual(['secret-shield', 'rm-rf-guard', 'force-push-guard', 'env-guard'])
  expect(recommended(standard)).toContain('curl-pipe-guard')
  expect(recommended(standard)).not.toContain('main-branch-warn')
  expect(recommended(strict)).toContain('main-branch-warn')
  expect(recommended(strict)).not.toContain('offline-mode')
  expect(policyFor('strict').isFallbackOn).toBe(true)
  expect(policyFor('strict', { fallback: false }).isFallbackOn).toBe(false)
  expect(policyFor('standard').isFallbackOn).toBe(false)
})

test('custom builds on a base and keeps only overrides that fit a real key and type', () => {
  const policy = policyFor('custom', {
    base: 'strict',
    overrides: { 'force-push-guard': { protectedBranches: 'main,trunk', unknownKey: 'x' }, 'rm-rf-guard': { allowGitReset: 'yes' }, 'not-a-guard': { a: 1 } },
  })
  expect(policy.base).toBe('strict')
  expect(policy.guards['force-push-guard']?.options).toEqual({ protectedBranches: 'main,trunk' })
  expect(policy.guards['rm-rf-guard']?.options).toEqual({ allowGitReset: false })
  expect(policy.guards['not-a-guard']).toBeUndefined()

  const file = policyFile(policy, '2026-10-07T12:00:00.000Z')
  const read = readPolicyFile(JSON.stringify(file))
  expect(read?.level).toBe('custom')
  expect(read?.base).toBe('strict')
  expect(read?.overrides['force-push-guard']).toEqual({ protectedBranches: 'main,trunk' })
  expect(readPolicyFile('{"level":"paranoid"}')).toBeUndefined()
  expect(readPolicyFile('not json')).toBeUndefined()
})

test('the diff: only installed guards, nothing for defaults left unset, existing keys reused', () => {
  const settings = {
    theme: 'dark',
    permissions: { allow: ['Bash(ls)'] },
    pluginConfigs: {
      'force-push-guard@claude-mods': { options: { protectedBranches: 'main' } },
      'sql-safety': { options: { mode: 'warn', migrationDirs: 'db' } },
      'other@elsewhere': { options: { color: 'red' } },
    },
  }
  const installed = new Set(['force-push-guard', 'sql-safety', 'rm-rf-guard'])
  expect(planApply(settings, policyFor('standard'), installed, MARKET).map(change => describeChange(change))).toEqual([
    'force-push-guard.protectedBranches: "main" → "main,master,develop,release/*"',
  ])

  const strict = planApply(settings, policyFor('strict'), installed, MARKET)
  expect(strict.map(change => `${change.key}:${change.option}`)).toEqual(['force-push-guard@claude-mods:protectedBranches', 'sql-safety:mode'])
  expect(strict.find(change => change.guard === 'sql-safety')).toMatchObject({ before: 'warn', after: 'block' })

  const permissive = planApply(settings, policyFor('permissive'), installed, MARKET)
  expect(permissive.find(change => change.guard === 'rm-rf-guard')).toMatchObject({ key: 'rm-rf-guard@claude-mods', before: undefined, after: true })
  expect(planApply({}, policyFor('standard'), ALL, MARKET)).toEqual([])
})

test('applying writes pluginConfigs entries only and keeps every other setting as it was', () => {
  const settings = {
    theme: 'dark',
    hooks: { Stop: [{ command: 'say done' }] },
    pluginConfigs: { 'sql-safety': { options: { mode: 'warn', migrationDirs: 'db' }, other: 1 }, 'other@elsewhere': { options: { color: 'red' } } },
  }
  const changes = planApply(settings, policyFor('strict'), new Set(['sql-safety', 'rm-rf-guard']), MARKET)
  const written = applyChanges(settings, changes) as typeof settings & { pluginConfigs: Record<string, { options: Record<string, unknown> }> }
  expect(written.theme).toBe('dark')
  expect(written.hooks).toEqual(settings.hooks)
  expect(written.pluginConfigs['other@elsewhere']).toEqual({ options: { color: 'red' } })
  expect(written.pluginConfigs['sql-safety']).toEqual({ options: { mode: 'block', migrationDirs: 'db' }, other: 1 })
  expect(Object.keys(written)).toEqual(['theme', 'hooks', 'pluginConfigs'])
  expect(planApply(written, policyFor('strict'), new Set(['sql-safety', 'rm-rf-guard']), MARKET)).toEqual([])
})
