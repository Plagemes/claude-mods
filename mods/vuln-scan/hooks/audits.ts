import type { VulnFinding as Finding, VulnSeverity as Severity } from '../types'

export type { Finding, Severity }

/** What one auditor's output came to: its findings, or why it could not say. */
export type AuditResult = { findings: Finding[]; error?: string }

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'info', 'unknown']
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, unknown: 5 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** A severity word from any auditor (`MODERATE`, `medium`, `High`) on one scale. */
export const severityOf = (word: unknown): Severity => {
  const lower = typeof word === 'string' ? word.toLowerCase() : ''
  if (lower === 'critical' || lower === 'high' || lower === 'moderate' || lower === 'low' || lower === 'info') return lower
  if (lower === 'medium') return 'moderate'
  if (lower === 'none' || lower === 'informational') return 'info'
  return 'unknown'
}

const parseJson = (text: string): unknown => {
  const start = text.search(/[[{]/)
  if (start === -1) throw new SyntaxError('no JSON in the output')
  return JSON.parse(text.slice(start))
}

/** Each JSON value of newline-delimited output; lines that are not JSON are skipped. */
const jsonLines = (text: string): unknown[] =>
  text.split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return []
    try {
      return [JSON.parse(trimmed) as unknown]
    } catch {
      return []
    }
  })

/** The advisory id a URL names (`.../GHSA-xxxx-xxxx-xxxx`), else the fallback. */
const idFrom = (url: string | undefined, fallback: string): string => {
  const ghsa = url === undefined ? undefined : /GHSA-[\w]{4}-[\w]{4}-[\w]{4}/i.exec(url)?.[0]
  return ghsa ?? fallback
}

/** Distinct findings by package and advisory id, worst first. */
export const sortFindings = (findings: readonly Finding[]): Finding[] => {
  const seen = new Set<string>()
  return findings
    .filter(finding => {
      const key = `${finding.package}\0${finding.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.package.localeCompare(b.package) || a.id.localeCompare(b.id))
}

// ── CVSS v3 ─────────────────────────────────────────────────────────────────

const WEIGHTS: Record<string, Record<string, number>> = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
}

/** CVSS v3's round-up to one decimal, as the specification defines it. */
const roundUp = (value: number): number => {
  const scaled = Math.round(value * 100_000)
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10
}

/** The base score of a CVSS v3.x vector (`CVSS:3.1/AV:N/AC:L/...`); undefined for another version or a malformed one. */
export const cvss3Score = (vector: string): number | undefined => {
  if (!/^CVSS:3\.[01]\//.test(vector)) return undefined
  const metrics = Object.fromEntries(vector.split('/').slice(1).map(part => part.split(':') as [string, string]))
  const weight = (name: string): number | undefined => WEIGHTS[name]?.[metrics[name] ?? '']
  const scopeChanged = metrics.S === 'C'
  const pr = { N: 0.85, L: scopeChanged ? 0.68 : 0.62, H: scopeChanged ? 0.5 : 0.27 }[metrics.PR ?? '']
  const [av, ac, ui, c, i, a] = ['AV', 'AC', 'UI', 'C', 'I', 'A'].map(weight)
  if ([av, ac, ui, c, i, a, pr].some(value => value === undefined) || (metrics.S !== 'U' && metrics.S !== 'C')) return undefined
  const iss = 1 - (1 - (c as number)) * (1 - (i as number)) * (1 - (a as number))
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss
  const exploitability = 8.22 * (av as number) * (ac as number) * (pr as number) * (ui as number)
  if (impact <= 0) return 0
  return roundUp(Math.min(scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability, 10))
}

/** The qualitative rating of a CVSS score. */
export const severityOfScore = (score: number | undefined): Severity => {
  if (score === undefined) return 'unknown'
  if (score >= 9) return 'critical'
  if (score >= 7) return 'high'
  if (score >= 4) return 'moderate'
  if (score > 0) return 'low'
  return 'info'
}

// ── npm, pnpm, yarn ─────────────────────────────────────────────────────────

/** A v1-style advisory (npm 6, pnpm, yarn classic) as a finding. */
const fromAdvisory = (advisory: Record<string, unknown>): Finding | undefined => {
  const name = str(advisory.module_name)
  if (name === undefined) return undefined
  const url = str(advisory.url)
  const patched = str(advisory.patched_versions)
  const findings = Array.isArray(advisory.findings) ? advisory.findings.filter(isRecord) : []
  const versions = [...new Set(findings.map(found => str(found.version)).filter((v): v is string => v !== undefined))]
  return {
    package: name,
    version: versions.join(', ') || undefined,
    severity: severityOf(advisory.severity),
    id: str(advisory.github_advisory_id) ?? idFrom(url, String(advisory.id ?? '?')),
    title: str(advisory.title) ?? 'Vulnerability',
    url,
    fix: patched === undefined || patched === '<0.0.0' ? undefined : patched,
    range: str(advisory.vulnerable_versions),
  }
}

const npmFix = (fixAvailable: unknown): string | undefined => {
  if (fixAvailable === true) return 'npm audit fix'
  if (!isRecord(fixAvailable)) return undefined
  const target = `${String(fixAvailable.name)}@${String(fixAvailable.version)}`
  return fixAvailable.isSemVerMajor === true ? `${target} (major)` : target
}

/**
 * `npm audit --json` (report version 2, npm 7+, and the advisories form of
 * npm 6) and `pnpm audit --json`, which writes the npm 6 form. Each
 * advisory a package is vulnerable through is one finding; packages only
 * affected through another one are that one's findings.
 */
export const parseNpmAudit = (text: string): AuditResult => {
  const report = parseJson(text)
  if (!isRecord(report)) throw new SyntaxError('the audit report is not a JSON object')
  if (isRecord(report.error)) {
    return { findings: [], error: str(report.error.summary) ?? str(report.error.code) ?? 'npm audit failed' }
  }
  const findings: Finding[] = []
  if (isRecord(report.vulnerabilities)) {
    for (const record of Object.values(report.vulnerabilities)) {
      if (!isRecord(record) || !Array.isArray(record.via)) continue
      for (const via of record.via.filter(isRecord)) {
        const url = str(via.url)
        findings.push({
          package: str(via.name) ?? str(record.name) ?? '?',
          severity: severityOf(via.severity),
          id: idFrom(url, String(via.source ?? '?')),
          title: str(via.title) ?? 'Vulnerability',
          url,
          fix: npmFix(record.fixAvailable),
          range: str(via.range),
          isDirect: record.isDirect === true,
        })
      }
    }
  } else if (isRecord(report.advisories)) {
    for (const advisory of Object.values(report.advisories)) {
      const finding = isRecord(advisory) ? fromAdvisory(advisory) : undefined
      if (finding !== undefined) findings.push(finding)
    }
  }
  return { findings: sortFindings(findings) }
}

/** `yarn audit --json` (Yarn 1): one auditAdvisory line per path to an advisory. */
export const parseYarnClassicAudit = (text: string): AuditResult => {
  const findings: Finding[] = []
  for (const line of jsonLines(text)) {
    if (!isRecord(line) || line.type !== 'auditAdvisory' || !isRecord(line.data) || !isRecord(line.data.advisory)) continue
    const finding = fromAdvisory(line.data.advisory)
    if (finding !== undefined) findings.push(finding)
  }
  return { findings: sortFindings(findings) }
}

/** `yarn npm audit --json` (Yarn 2+): one `{ value, children }` line per advisory. */
export const parseYarnBerryAudit = (text: string): AuditResult => {
  const findings: Finding[] = []
  for (const line of jsonLines(text)) {
    if (!isRecord(line) || !isRecord(line.children)) continue
    const advisory = line.children
    const url = str(advisory.URL)
    const versions = Array.isArray(advisory['Tree Versions']) ? advisory['Tree Versions'].filter(v => typeof v === 'string') : []
    findings.push({
      package: str(line.value) ?? '?',
      version: versions.join(', ') || undefined,
      severity: severityOf(advisory.Severity),
      id: idFrom(url, String(advisory.ID ?? '?')),
      title: str(advisory.Issue) ?? 'Vulnerability',
      url,
      range: str(advisory['Vulnerable Versions']),
    })
  }
  return { findings: sortFindings(findings) }
}

// ── Python, Rust ────────────────────────────────────────────────────────────

/** The first sentence of a long description, as a title. */
const titleFrom = (description: string | undefined): string => {
  if (description === undefined) return 'Vulnerability'
  const text = description.replace(/^#+\s*\w+\s*/, '').replace(/\s+/g, ' ').trim()
  const sentence = /^(.{20,}?[.!?])\s/.exec(text)?.[1] ?? text
  return sentence.length > 120 ? `${sentence.slice(0, 117)}…` : sentence
}

/**
 * `pip-audit -f json` (an object with `dependencies`, or the bare list of
 * older releases). pip-audit reports no severity: findings start
 * `unknown` until looked up (OSV).
 */
export const parsePipAudit = (text: string): AuditResult => {
  const report = parseJson(text)
  const dependencies = Array.isArray(report) ? report : isRecord(report) && Array.isArray(report.dependencies) ? report.dependencies : undefined
  if (dependencies === undefined) throw new SyntaxError('pip-audit wrote no dependency list')
  const findings: Finding[] = []
  for (const dependency of dependencies.filter(isRecord)) {
    const vulns = Array.isArray(dependency.vulns) ? dependency.vulns.filter(isRecord) : []
    for (const vuln of vulns) {
      const id = str(vuln.id) ?? '?'
      const aliases = Array.isArray(vuln.aliases) ? vuln.aliases.filter((alias): alias is string => typeof alias === 'string') : []
      const ghsa = aliases.find(alias => alias.startsWith('GHSA-'))
      const fixes = Array.isArray(vuln.fix_versions) ? vuln.fix_versions.filter((v): v is string => typeof v === 'string') : []
      findings.push({
        package: str(dependency.name) ?? '?',
        version: str(dependency.version),
        severity: 'unknown',
        id,
        aliases,
        title: titleFrom(str(vuln.description)),
        url: ghsa !== undefined ? `https://github.com/advisories/${ghsa}` : `https://osv.dev/vulnerability/${id}`,
        fix: fixes.length > 0 ? fixes[0] : undefined,
      })
    }
  }
  return { findings: sortFindings(findings) }
}

/** `cargo audit --json`: severity from the advisory's CVSS vector; informational warnings are not vulnerabilities. */
export const parseCargoAudit = (text: string): AuditResult => {
  const report = parseJson(text)
  if (!isRecord(report) || !isRecord(report.vulnerabilities)) throw new SyntaxError('cargo audit wrote no vulnerabilities section')
  const list = Array.isArray(report.vulnerabilities.list) ? report.vulnerabilities.list.filter(isRecord) : []
  const findings = list.flatMap((entry): Finding[] => {
    const advisory = isRecord(entry.advisory) ? entry.advisory : {}
    const pkg = isRecord(entry.package) ? entry.package : {}
    const patched = isRecord(entry.versions) && Array.isArray(entry.versions.patched) ? entry.versions.patched.filter(v => typeof v === 'string') : []
    const cvss = str(advisory.cvss)
    const id = str(advisory.id) ?? '?'
    return [
      {
        package: str(pkg.name) ?? str(advisory.package) ?? '?',
        version: str(pkg.version),
        severity: cvss === undefined ? 'unknown' : severityOfScore(cvss3Score(cvss)),
        id,
        title: str(advisory.title) ?? 'Vulnerability',
        url: `https://rustsec.org/advisories/${id}.html`,
        fix: patched.length > 0 ? patched.join(' or ') : undefined,
      },
    ]
  })
  return { findings: sortFindings(findings) }
}

/** The severity an OSV record gives: GitHub's own rating, else its CVSS v3 vector's score. */
export const severityFromOsv = (text: string): Severity => {
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return 'unknown'
  }
  if (!isRecord(record)) return 'unknown'
  const rated = isRecord(record.database_specific) ? severityOf(record.database_specific.severity) : 'unknown'
  if (rated !== 'unknown') return rated
  const vectors = Array.isArray(record.severity) ? record.severity.filter(isRecord) : []
  const v3 = vectors.map(entry => str(entry.score)).find(score => score?.startsWith('CVSS:3') === true)
  return v3 === undefined ? 'unknown' : severityOfScore(cvss3Score(v3))
}

// ── Summaries ───────────────────────────────────────────────────────────────

export const countBySeverity = (findings: readonly Finding[]): Record<Severity, number> => {
  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, unknown: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

/** `1 critical · 2 high` (the two worst kinds), or '' for none. */
export const severityLine = (counts: Record<Severity, number>, kinds = 2): string =>
  SEVERITIES.filter(severity => counts[severity] > 0)
    .slice(0, kinds)
    .map(severity => `${counts[severity]} ${severity === 'unknown' ? 'unrated' : severity}`)
    .join(' · ')
