# vuln-scan
> After installs, runs npm audit or pip-audit and shows any vulnerabilities in a pane.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
Whenever Claude (or you, through Claude's shell) installs packages, vuln-scan runs the matching auditor in the background and puts the result in the status line: `🛡 1 critical · 2 high`. `/vulns` opens a pane with each advisory, the package and version it hits, a link to it and the version that fixes it, plus a button that asks Claude to do the upgrades and re-run the tests.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install vuln-scan@claude-mods
```

## Usage
- Automatic: after `npm install|ci|add`, `pnpm add|install`, `yarn [add|install]`, `pip install`, `python -m pip install`, `uv add|sync|pip install`, `poetry add|install`, `cargo add|update` (following any `cd` in the command).
- `/vulns` opens the pane (and audits the current folder if nothing was audited yet); `/vulns scan` audits again.

```
🛡 1 critical · 2 high · 4 moderate · 4 low
npm audit · just now · 11 findings
CRITICAL minimist 1.2.0      Prototype Pollution in minimist
         GHSA-xvch-5gv4-984h → minimist@1.2.8
HIGH     qs                  qs vulnerable to Prototype Pollution
         GHSA-hrpp-h998-j3pp · no fix yet
[ Ask Claude to fix ]  [ Re-scan ]  [ Close ]
```

## Configuration
| Key | Default | What it does |
| --- | --- | --- |
| `autoScan` | `true` | Audit after each successful install. |
| `timeoutSeconds` | `120` | How long one auditor may run (at most 600). |
| `pipAudit` | `pip-audit` | How to run pip-audit when the virtualenv has none, e.g. `uvx pip-audit`. |
| `lookupSeverity` | `true` | Ask osv.dev for the severity of Python advisories (pip-audit reports none). |

## How it works
- A `tool.call` hook on Bash spots install commands; 1.5 s after the last one it runs `npm audit --json`, `pnpm audit --json`, `yarn audit --json` (or `yarn npm audit --json --recursive` on Yarn 2+), `pip-audit -f json --path <.venv site-packages>` (or `-r requirements.txt`), or `cargo audit --json`, each with a timeout, and parses the JSON with pure parsers.
- Severities come from the auditor, from the advisory's CVSS v3 vector (cargo), or from OSV (Python). Fixes come from `fixAvailable` (npm), `patched_versions` (pnpm, yarn 1), `fix_versions` (pip-audit) and `patched` (cargo); Yarn 2+ gives none.
- Limits: needs the auditors installed (`cargo audit` is the `cargo-audit` crate); npm audit needs a `package-lock.json`; auditors query their advisory databases over the network; failed installs are not audited.
