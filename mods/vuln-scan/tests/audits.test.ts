import { expect, test } from 'claude-code/testing'

import {
  countBySeverity,
  cvss3Score,
  parseCargoAudit,
  parseNpmAudit,
  parsePipAudit,
  parseYarnBerryAudit,
  parseYarnClassicAudit,
  severityFromOsv,
  severityLine,
  severityOfScore,
} from '../hooks/audits'
import { installsIn } from '../hooks/installs'
import { CARGO_AUDIT, NPM_AUDIT_V2, NPM_ENOLOCK, PIP_AUDIT, PNPM_AUDIT, YARN_BERRY_AUDIT, YARN_CLASSIC_AUDIT } from './fixtures'

test('npm audit v2: one finding per advisory, with the fix npm offers', () => {
  const { findings, error } = parseNpmAudit(NPM_AUDIT_V2)
  expect(error).toBeUndefined()
  const minimist = findings.filter(finding => finding.package === 'minimist')
  expect(minimist.map(finding => finding.severity)).toEqual(['critical', 'moderate'])
  expect(minimist[0]).toEqual({
    package: 'minimist',
    severity: 'critical',
    id: 'GHSA-xvch-5gv4-984h',
    title: 'Prototype Pollution in minimist',
    url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h',
    fix: 'minimist@1.2.8',
    range: '>=1.0.0 <1.2.6',
    isDirect: true,
  })
  const bodyParser = findings.filter(finding => finding.package === 'body-parser')
  expect(bodyParser).toHaveLength(2)
  expect(bodyParser.every(finding => finding.fix === 'express@4.22.3' && finding.isDirect === false)).toBe(true)
  expect(findings.find(finding => finding.package === 'serve-static')?.fix).toBe('npm audit fix')
  expect(findings.find(finding => finding.package === 'qs')?.fix).toBeUndefined()
  expect(findings[0]?.severity).toBe('critical')
  expect(parseNpmAudit(NPM_ENOLOCK)).toEqual({ findings: [], error: 'This command requires an existing lockfile.' })
})

test('pnpm and yarn classic advisories, deduplicated across paths', () => {
  const pnpm = parseNpmAudit(PNPM_AUDIT).findings
  expect(pnpm.length).toBeGreaterThan(0)
  const minimist = pnpm.find(finding => finding.package === 'minimist')
  expect(minimist?.version).toBe('1.2.0')
  expect(minimist?.id).toMatch(/^GHSA-/)
  expect(minimist?.fix).toMatch(/^>=/)

  const yarn = parseYarnClassicAudit(YARN_CLASSIC_AUDIT).findings
  expect(yarn).toHaveLength(3)
  expect(yarn.every(finding => finding.id.startsWith('GHSA-') && finding.version !== undefined)).toBe(true)
})

test('yarn Berry advisories carry the tree versions and the vulnerable range', () => {
  const findings = parseYarnBerryAudit(YARN_BERRY_AUDIT).findings
  expect(findings.map(finding => `${finding.package} ${finding.severity}`)).toEqual(['lodash high', 'express moderate', 'express low'])
  expect(findings[0]).toEqual({
    package: 'lodash',
    version: '4.17.15',
    severity: 'high',
    id: 'GHSA-35jh-r3h4-6jhm',
    title: 'Command Injection in lodash',
    url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
    range: '<4.17.21',
  })
})

test('pip-audit findings link their GHSA alias, start unrated and are deduplicated', () => {
  const findings = parsePipAudit(PIP_AUDIT).findings
  expect(findings.map(finding => `${finding.package} ${finding.version} ${finding.id}`)).toEqual([
    'idna 2.10 PYSEC-2024-60',
    'jinja2 2.11.2 PYSEC-2021-66',
    'urllib3 1.26.20 PYSEC-2026-1998',
    'urllib3 1.26.20 PYSEC-2026-1999',
  ])
  expect(findings[0]?.url).toBe('https://github.com/advisories/GHSA-jjg7-2v4v-x38h')
  expect(findings[0]?.fix).toBe('3.7')
  expect(findings[0]?.title.length).toBeLessThanOrEqual(120)
  expect(findings.every(finding => finding.severity === 'unknown')).toBe(true)
  expect(parsePipAudit('[{"name": "flask", "version": "0.5", "vulns": [{"id": "PYSEC-2019-179", "fix_versions": ["1.0"], "description": "Flask before 1.0 is vulnerable."}]}]').findings).toHaveLength(1)
  expect(() => parsePipAudit('ERROR: no such option')).toThrow()
})

test('cargo audit: severity from the CVSS vector, the patched ranges as the fix', () => {
  const findings = parseCargoAudit(CARGO_AUDIT).findings
  expect(findings[0]).toEqual({
    package: 'time',
    version: '0.1.45',
    severity: 'moderate',
    id: 'RUSTSEC-2020-0071',
    title: 'Potential segfault in the time crate',
    url: 'https://rustsec.org/advisories/RUSTSEC-2020-0071.html',
    fix: '>=0.2.23',
  })
})

test('CVSS v3 base scores and OSV ratings', () => {
  expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8)
  expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H')).toBe(7.5)
  expect(cvss3Score('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H')).toBe(5.9)
  expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N')).toBe(6.4)
  expect(cvss3Score('CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0)
  expect(cvss3Score('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeUndefined()
  expect(severityOfScore(9.8)).toBe('critical')
  expect(severityOfScore(3.7)).toBe('low')
  expect(severityFromOsv(JSON.stringify({ id: 'GHSA-jjg7-2v4v-x38h', database_specific: { severity: 'MODERATE' } }))).toBe('moderate')
  expect(severityFromOsv(JSON.stringify({ id: 'PYSEC-2024-60', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }] }))).toBe('high')
  expect(severityFromOsv('not json')).toBe('unknown')
  const counts = countBySeverity(parseNpmAudit(NPM_AUDIT_V2).findings)
  expect(severityLine(counts)).toBe('1 critical · 2 high')
  expect(severityLine(counts, 6)).toBe('1 critical · 2 high · 4 moderate · 4 low')
})

test('finds installs in shell commands, following cd and skipping quoted text', () => {
  expect(installsIn('npm install lodash')).toEqual([{ manager: 'npm', dir: '' }])
  expect(installsIn('cd web && pnpm add -D vitest && cd ../api && uv add requests')).toEqual([
    { manager: 'pnpm', dir: 'web' },
    { manager: 'pip', dir: 'api' },
  ])
  expect(installsIn('yarn')).toEqual([{ manager: 'yarn', dir: '' }])
  expect(installsIn('python3 -m pip install -r requirements.txt && cargo add serde')).toEqual([
    { manager: 'pip', dir: '' },
    { manager: 'cargo', dir: '' },
  ])
  expect(installsIn('npm ci; npm i -g typescript')).toEqual([{ manager: 'npm', dir: '' }])
  expect(installsIn('npm run build && npm test')).toEqual([])
  expect(installsIn('echo "npm install x" && pip --version && cargo install ripgrep && pip install --help')).toEqual([])
  expect(installsIn('poetry add httpx; uv pip install rich')).toEqual([{ manager: 'pip', dir: '' }])
})
