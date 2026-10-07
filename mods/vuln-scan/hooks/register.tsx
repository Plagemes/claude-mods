import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { VulnReport, VulnScan } from '../types'
import {
  SEVERITY_RANK,
  countBySeverity,
  parseCargoAudit,
  parseNpmAudit,
  parsePipAudit,
  parseYarnBerryAudit,
  parseYarnClassicAudit,
  severityFromOsv,
  severityLine,
  sortFindings,
} from './audits'
import type { AuditResult, Finding, Severity } from './audits'
import { installsIn } from './installs'
import type { Install, Manager } from './installs'

type Settings = { timeoutMs: number; pipAudit: string[]; lookupSeverity: boolean; autoScan: boolean }
type Target = { manager: Manager; dir: string }
type Memory = { pending: Map<string, Target>; debounce: Timer | undefined; clearStatus: Timer | undefined; isBusy: boolean }
/** How to run one auditor: the command, and the parser for what it prints. */
type Plan = { tool: string; argv: string[]; parse: (text: string) => AuditResult } | { tool: string; error: string }

const PANE = 'vulns'
const EMPTY: VulnReport = { scans: [], running: null }
const DEBOUNCE_MS = 1_500
const CLEAN_STATUS_MS = 60_000
const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600
const OSV_TIMEOUT_MS = 8_000
const MAX_OSV_LOOKUPS = 25
const MAX_ROWS = 40
const MAX_PROMPT_FINDINGS = 30
const NARROW_COLUMNS = 72
/** Every severity kind in summaries (the status line keeps to the two worst). */
const ALL_KINDS = 6
const INSTALL_HINTS: Record<string, string> = {
  'pip-audit': 'pip-audit is not installed (pipx install pip-audit)',
  npm: 'npm is not installed',
  pnpm: 'pnpm is not installed',
  yarn: 'yarn is not installed',
  cargo: 'cargo is not installed',
}
const VENV_DIRS = ['.venv', 'venv', 'env']
const RUN_ENV = { NO_COLOR: '1', FORCE_COLOR: '0', npm_config_fund: 'false', npm_config_update_notifier: 'false' }
const SEVERITY_STYLE: Record<Severity, { label: string; color: string }> = {
  critical: { label: 'CRITICAL', color: 'error' },
  high: { label: 'HIGH', color: 'error' },
  moderate: { label: 'MODERATE', color: 'warning' },
  low: { label: 'LOW', color: 'suggestion' },
  info: { label: 'INFO', color: 'inactive' },
  unknown: { label: 'UNRATED', color: 'inactive' },
}

const report = atom({ plugin: 'vuln-scan', key: 'report' } as const, EMPTY)

const joinPath = (...parts: string[]): string =>
  parts
    .filter(part => part !== '')
    .join('/')
    .replace(/\/{2,}/g, '/')

const relativeTo = (root: string, path: string): string =>
  path === root ? '' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

const targetKey = (target: Target): string => `${target.manager}\0${target.dir}`

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => false)
}

/** The site-packages of the project's virtualenv (or the active one), if any. */
async function sitePackagesOf($: EngineInterface, dir: string): Promise<{ venv: string; sitePackages: string } | undefined> {
  const active = await $.env.get('VIRTUAL_ENV').catch(() => undefined)
  const venvs = [...VENV_DIRS.map(name => joinPath(dir, name)), ...(active === undefined || active === '' ? [] : [active])]
  for (const venv of venvs) {
    const windows = joinPath(venv, 'Lib', 'site-packages')
    if (await exists($, windows)) return { venv, sitePackages: windows }
    const pythons = await $.fs.list(joinPath(venv, 'lib')).catch(() => [])
    const python = pythons.find(entry => entry.kind === 'dir' && entry.name.startsWith('python'))
    if (python !== undefined) return { venv, sitePackages: joinPath(venv, 'lib', python.name, 'site-packages') }
  }
  return undefined
}

/** Which auditor checks a manager's packages in a folder, and how. */
async function planFor($: EngineInterface, settings: Settings, target: Target): Promise<Plan> {
  const { dir } = target
  switch (target.manager) {
    case 'npm': {
      const hasLock = (await exists($, joinPath(dir, 'package-lock.json'))) || (await exists($, joinPath(dir, 'npm-shrinkwrap.json')))
      if (!hasLock) return { tool: 'npm audit', error: 'no package-lock.json to audit' }
      return { tool: 'npm audit', argv: ['npm', 'audit', '--json'], parse: parseNpmAudit }
    }
    case 'pnpm':
      return { tool: 'pnpm audit', argv: ['pnpm', 'audit', '--json'], parse: parseNpmAudit }
    case 'yarn': {
      const lock = await $.fs.read(joinPath(dir, 'yarn.lock')).catch(() => '')
      const isBerry = (await exists($, joinPath(dir, '.yarnrc.yml'))) || (typeof lock === 'string' && /^__metadata:/m.test(lock))
      return isBerry
        ? { tool: 'yarn npm audit', argv: ['yarn', 'npm', 'audit', '--json', '--recursive'], parse: parseYarnBerryAudit }
        : { tool: 'yarn audit', argv: ['yarn', 'audit', '--json'], parse: parseYarnClassicAudit }
    }
    case 'pip': {
      const found = await sitePackagesOf($, dir)
      const local = found === undefined ? undefined : joinPath(found.venv, 'bin', 'pip-audit')
      const command = local !== undefined && (await exists($, local)) ? [local] : settings.pipAudit
      const base = [...command, '-f', 'json', '--progress-spinner', 'off']
      if (found !== undefined) return { tool: 'pip-audit', argv: [...base, '--path', found.sitePackages], parse: parsePipAudit }
      if (await exists($, joinPath(dir, 'requirements.txt'))) {
        return { tool: 'pip-audit', argv: [...base, '-r', 'requirements.txt'], parse: parsePipAudit }
      }
      return { tool: 'pip-audit', error: 'no virtualenv or requirements.txt to audit' }
    }
    case 'cargo':
      return { tool: 'cargo audit', argv: ['cargo', 'audit', '--json'], parse: parseCargoAudit }
  }
}

/** Why an auditor that printed nothing readable failed, in a few words. */
function failureOf(tool: string, stdout: string, stderr: string): string {
  const said = `${stderr}\n${stdout}`
  if (/no such (?:sub)?command:?\s*`?audit/i.test(said)) return 'cargo-audit is not installed (cargo install cargo-audit)'
  if (/ENOLOCK|requires (?:an existing )?lockfile/i.test(said)) return 'no lockfile to audit'
  const line = said
    .split('\n')
    .map(text => text.trim())
    .find(text => text !== '' && !/^(?:warning|npm warn)/i.test(text))
  return line === undefined ? `${tool} printed nothing to read` : line.slice(0, 160)
}

async function runAudit($: EngineInterface, settings: Settings, target: Target, cwd: string): Promise<VulnScan> {
  const plan = await planFor($, settings, target)
  const base = { tool: plan.tool, manager: target.manager, dir: relativeTo(cwd, target.dir), at: await $.clock.now() }
  if ('error' in plan) return { ...base, findings: [], error: plan.error }
  await update($, report, (current): VulnReport => ({ ...current, running: plan.tool }))
  try {
    const ran = await $.process.run(plan.argv, { cwd: target.dir, timeoutMs: settings.timeoutMs, env: RUN_ENV })
    let result: AuditResult
    try {
      result = plan.parse(ran.stdout)
    } catch {
      return { ...base, findings: [], error: failureOf(plan.tool, ran.stdout, ran.stderr) }
    }
    const findings = target.manager === 'pip' && settings.lookupSeverity ? await rateWithOsv($, result.findings) : result.findings
    return { ...base, findings, error: result.error }
  } catch (error) {
    const text = String(error)
    const program = plan.tool.split(' ')[0] ?? plan.tool
    const reason = /failed to start|ENOENT/i.test(text)
      ? (INSTALL_HINTS[program] ?? `${program} is not installed`)
      : /still running/i.test(text)
        ? `stopped after ${settings.timeoutMs / 1000}s`
        : text
    return { ...base, findings: [], error: reason }
  }
}

/** pip-audit rates nothing: ask OSV for each advisory's severity (its GHSA alias first, which carries GitHub's rating). */
async function rateWithOsv($: EngineInterface, findings: readonly Finding[]): Promise<Finding[]> {
  const rated = await Promise.all(
    findings.map(async (finding, index): Promise<Finding> => {
      if (index >= MAX_OSV_LOOKUPS) return finding
      const id = finding.aliases?.find(alias => alias.startsWith('GHSA-')) ?? finding.id
      const text = await fetchWithin($, `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`)
      return text === undefined ? finding : { ...finding, severity: severityFromOsv(text) }
    }),
  )
  return sortFindings(rated)
}

async function fetchWithin($: EngineInterface, url: string): Promise<string | undefined> {
  let timer: Timer | undefined
  const deadline = new Promise<undefined>(resolve => {
    timer = $.clock.after(OSV_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const response = await Promise.race([$.http.fetch(url), deadline])
    return response?.ok === true ? response.text : undefined
  } catch {
    return undefined
  } finally {
    timer?.cancel()
  }
}

/** The status line for every scan so far: `🛡 1 critical · 2 high`, or a passing note that clears itself. */
async function showStatus($: EngineInterface, memory: Memory): Promise<void> {
  const { scans } = await read($, report)
  memory.clearStatus?.cancel()
  const counts = countBySeverity(scans.flatMap(scan => scan.findings))
  const line = severityLine(counts)
  if (line !== '') {
    $.ui.status(`🛡 ${line}`)
  } else if (scans.some(scan => scan.error === undefined)) {
    $.ui.status('🛡 no known vulnerabilities')
    memory.clearStatus = $.clock.after(CLEAN_STATUS_MS, () => $.ui.status(undefined))
  }
}

/** Runs each target's auditor in turn and records what it found. */
async function scanTargets($: EngineInterface, settings: Settings, memory: Memory, targets: readonly Target[]): Promise<void> {
  if (memory.isBusy) {
    for (const target of targets) memory.pending.set(targetKey(target), target)
    return
  }
  memory.isBusy = true
  try {
    const cwd = await $.session.cwd()
    for (const target of targets) {
      const scan = await runAudit($, settings, target, cwd)
      await update($, report, (current): VulnReport => ({
        running: null,
        scans: [...current.scans.filter(one => !(one.manager === scan.manager && one.dir === scan.dir)), scan],
      }))
      if (scan.error !== undefined) $.ui.toast(`${scan.tool}${scan.dir === '' ? '' : ` (${scan.dir})`} could not run: ${scan.error}`)
    }
    await showStatus($, memory)
  } finally {
    memory.isBusy = false
    await update($, report, (current): VulnReport => ({ ...current, running: null }))
  }
  if (memory.pending.size > 0) await flushPending($, settings, memory)
}

async function flushPending($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  const targets = [...memory.pending.values()]
  memory.pending.clear()
  await scanTargets($, settings, memory, targets)
}

/** The auditors that apply to a folder, from the lockfiles and virtualenvs in it. */
async function detectTargets($: EngineInterface, dir: string): Promise<Target[]> {
  const names = new Set((await $.fs.list(dir).catch(() => [])).map(entry => entry.name))
  const managers: Manager[] = []
  if (names.has('package-lock.json') || names.has('npm-shrinkwrap.json')) managers.push('npm')
  if (names.has('pnpm-lock.yaml')) managers.push('pnpm')
  if (names.has('yarn.lock')) managers.push('yarn')
  if (['poetry.lock', 'uv.lock', 'requirements.txt', ...VENV_DIRS].some(name => names.has(name))) managers.push('pip')
  if (names.has('Cargo.lock')) managers.push('cargo')
  return managers.map(manager => ({ manager, dir }))
}

/** Scans what `/vulns` should show: the folders scanned before, else what the session's folder holds. */
async function rescan($: EngineInterface, settings: Settings, memory: Memory): Promise<number> {
  const cwd = await $.session.cwd()
  const { scans } = await read($, report)
  const targets = scans.length > 0 ? scans.map(scan => ({ manager: scan.manager, dir: joinPath(cwd, scan.dir) || cwd })) : await detectTargets($, cwd)
  if (targets.length > 0) $.clock.after(0, () => void scanTargets($, settings, memory, targets))
  return targets.length
}

function fixPrompt(scans: readonly VulnScan[]): string {
  const findings = sortFindings(scans.flatMap(scan => scan.findings))
  const tools = [...new Set(scans.filter(scan => scan.findings.length > 0).map(scan => scan.tool))].join(' and ')
  const lines = findings.slice(0, MAX_PROMPT_FINDINGS).map(finding => {
    const version = finding.version === undefined ? '' : ` ${finding.version}`
    const fix = finding.fix === undefined ? 'no fixed version known' : `fix: ${finding.fix}`
    return `- ${finding.package}${version}: ${finding.severity}, ${finding.id} ${finding.title} (${fix})`
  })
  const more = findings.length > MAX_PROMPT_FINDINGS ? [`- …and ${findings.length - MAX_PROMPT_FINDINGS} more; re-run the audit to see them.`] : []
  return [
    `Fix these dependency vulnerabilities that ${tools} reported:`,
    ...lines,
    ...more,
    '',
    'Upgrade each package to a fixed version with the project\'s own package manager, the smallest upgrade that fixes it; ' +
      'for a transitive package, upgrade the direct dependency that pulls it in, or pin it with overrides/resolutions. ' +
      'Call out any major-version upgrade before making it. Then run the tests and the audit again to confirm.',
  ].join('\n')
}

async function askToFix($: EngineInterface): Promise<void> {
  const { scans } = await read($, report)
  const count = scans.reduce((sum, scan) => sum + scan.findings.length, 0)
  if (count === 0) return
  const text = fixPrompt(scans)
  $.clock.after(1, () => void $.prompt.submit({ text, asUser: true }).catch(() => undefined))
  $.ui.toast(`Asked Claude to fix ${count} vulnerabilit${count === 1 ? 'y' : 'ies'}.`)
}

async function pressRescan($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  if ((await rescan($, settings, memory)) === 0) $.ui.toast('Nothing here to audit: no lockfile or virtualenv.')
}

const ago = (now: number, at: number): string => {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}

export const register: Register = (on, options) => {
  const seconds = Number(options.timeoutSeconds) > 0 ? Number(options.timeoutSeconds) : DEFAULT_TIMEOUT_SECONDS
  const pipAudit = typeof options.pipAudit === 'string' && options.pipAudit.trim() !== '' ? options.pipAudit.trim().split(/\s+/) : ['pip-audit']
  const settings: Settings = {
    timeoutMs: Math.min(seconds, MAX_TIMEOUT_SECONDS) * 1000,
    pipAudit,
    lookupSeverity: options.lookupSeverity !== false,
    autoScan: options.autoScan !== false,
  }
  const memory: Memory = { pending: new Map(), debounce: undefined, clearStatus: undefined, isBusy: false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'vulns',
      description: 'Known vulnerabilities in your dependencies (npm/pnpm/yarn audit, pip-audit, cargo audit)',
      argumentHint: '[scan]',
    })
    return next(e)
  })

  on('command.run', { command: 'vulns' }, async ($, e) => {
    const { scans } = await read($, report)
    const wantsScan = /^(?:scan|rescan|refresh)$/i.test(e.args.trim())
    if (wantsScan || scans.length === 0) {
      const count = await rescan($, settings, memory)
      if (count === 0) return { text: 'Nothing here to audit: no package-lock.json, pnpm-lock.yaml, yarn.lock, Python lock or virtualenv, or Cargo.lock.' }
      await $.ui.open({ id: PANE, title: 'Vulnerabilities' }).catch(() => undefined)
      return { text: `Auditing ${count} project${count === 1 ? '' : 's'}…` }
    }
    await $.ui.open({ id: PANE, title: 'Vulnerabilities' }).catch(() => undefined)
    const line = severityLine(countBySeverity(scans.flatMap(scan => scan.findings)), ALL_KINDS)
    return { text: line === '' ? 'No known vulnerabilities in the last audit.' : `🛡 ${line}` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!settings.autoScan || e.tool !== 'Bash' || ran.deny !== undefined || ran.isError === true) return ran
    const installs: Install[] = installsIn(e.command)
    if (installs.length === 0) return ran
    const cwd = await $.session.cwd().catch(() => '')
    for (const install of installs) {
      const dir = install.dir.startsWith('/') ? install.dir : joinPath(cwd, install.dir) || cwd
      memory.pending.set(targetKey({ manager: install.manager, dir }), { manager: install.manager, dir })
    }
    memory.debounce?.cancel()
    memory.debounce = $.clock.after(DEBOUNCE_MS, () => void flushPending($, settings, memory))
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const current = await read($, report)
    const now = await $.clock.now()
    const findings = current.scans.flatMap(scan => scan.findings.map(finding => ({ scan, finding })))
    findings.sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.finding.package.localeCompare(b.finding.package))
    const counts = countBySeverity(findings.map(item => item.finding))
    const summary = severityLine(counts, ALL_KINDS)
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const packageWidth = Math.min(28, Math.max(12, Math.floor(e.props.bodyColumns / 4)))

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="summary" flexDirection="column">
          <Text bold color={summary === '' ? 'success' : counts.critical + counts.high > 0 ? 'error' : 'warning'}>
            🛡 {summary === '' ? (current.scans.length === 0 ? 'No audit yet' : 'No known vulnerabilities') : summary}
          </Text>
          {current.scans.map(scan => (
            <Text key={`scan:${scan.manager}:${scan.dir}`} dimColor={scan.error === undefined} color={scan.error === undefined ? undefined : 'warning'} wrap="truncate-end">
              {scan.tool}
              {scan.dir === '' ? '' : ` · ${scan.dir}`} · {ago(now, scan.at)} ·{' '}
              {scan.error === undefined ? `${scan.findings.length} finding${scan.findings.length === 1 ? '' : 's'}` : `could not run: ${scan.error}`}
            </Text>
          ))}
          {current.running !== null && <Text color="suggestion">⧗ running {current.running}…</Text>}
        </Box>
        {findings.length > 0 && (
          <Box key="findings" flexDirection="column">
            {findings.slice(0, MAX_ROWS).map(({ scan, finding }) => {
              const style = SEVERITY_STYLE[finding.severity]
              const name = `${finding.package}${finding.version === undefined ? '' : ` ${finding.version}`}`
              return (
                <Box key={`finding:${scan.manager}:${scan.dir}:${finding.package}:${finding.id}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text color={style.color} bold={finding.severity === 'critical'}>
                      {style.label.padEnd(8)}
                    </Text>
                    <Text bold wrap="truncate-end">
                      {isNarrow ? name : name.length > packageWidth ? `${name.slice(0, packageWidth - 1)}…` : name.padEnd(packageWidth)}
                    </Text>
                    {!isNarrow && (
                      <Box flexGrow={1}>
                        <Text wrap="truncate-end">{finding.title}</Text>
                      </Box>
                    )}
                  </Box>
                  <Box flexDirection="row" gap={1} paddingLeft={9}>
                    {isNarrow && <Text wrap="truncate-end">{finding.title}</Text>}
                    {finding.url === undefined ? <Text dimColor>{finding.id}</Text> : <Link href={finding.url} label={finding.id} />}
                    <Text color={finding.fix === undefined ? 'inactive' : 'success'}>
                      {finding.fix === undefined ? '· no fix yet' : `→ ${finding.fix}`}
                    </Text>
                  </Box>
                </Box>
              )
            })}
            {findings.length > MAX_ROWS && <Text dimColor>…and {findings.length - MAX_ROWS} more.</Text>}
          </Box>
        )}
        <Box key="actions" flexDirection="row" gap={1}>
          {findings.length > 0 && <Button key="fix" label="Ask Claude to fix" hotkey="f" variant="primary" onPress={() => void askToFix($)} />}
          <Button key="rescan" label="Re-scan" hotkey="r" onPress={() => void pressRescan($, settings, memory)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
