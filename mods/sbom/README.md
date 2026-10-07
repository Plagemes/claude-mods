# sbom
> /sbom generates a software bill of materials with every dependency and its license.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
`/sbom` reads your lockfiles, lists every third-party package with its exact version, finds each one's license, and writes a standard SBOM document at the project root: CycloneDX 1.5 JSON, SPDX 2.3 JSON or a Markdown table. A pane sums it up: packages per ecosystem, a bar per license, and the packages that need a look (copyleft, unknown or non-SPDX licenses).

## Install
```
/plugin install sbom --marketplace plagemes/claude-mods
```

## Usage
- `/sbom` writes `sbom.cdx.json` (CycloneDX 1.5); `/sbom spdx` writes `sbom.spdx.json` (SPDX 2.3); `/sbom md` writes `SBOM.md`.
- The pane's **Write CycloneDX / SPDX / Markdown** buttons (`1`–`3`) write another format from the same scan; **Rescan** (`r`) reads everything again.

```
SBOM · demo-app                                        ✓ sbom.cdx.json
412 packages · npm 380 · PyPI 32 · 37 dev-only
from package-lock.json, api/poetry.lock
Licenses
MIT            ██████████████████████████████ 301
ISC            ████                            42
Apache-2.0     ███                             30
To review: copyleft, unknown or non-SPDX licenses
●  chardet 4.0.0 · PyPI                          LGPL
?  left-pad 1.3.0 · npm                       unknown
```

## Configuration
| Key | Default | What it does |
| --- | --- | --- |
| `format` | `cyclonedx` | What `/sbom` writes with no argument: `cyclonedx`, `spdx` or `md`. |
| `outputDir` | *(root)* | Folder for the document, relative to the project root. |
| `registryLookup` | `false` | Ask npm, PyPI and crates.io for licenses not found locally (cached across sessions). |

## How it works
- Lockfiles at the project root and one folder down: `package-lock.json` (v1–v3), `pnpm-lock.yaml` (v5, v6, v9), `yarn.lock` (classic and Berry), `poetry.lock`, `uv.lock`, `requirements*.txt`, `Cargo.lock`, `go.mod`/`go.sum`, each read by a small pure parser. Dev-only packages are marked from the lockfile's own flags, or by walking the dependency graph from `package.json` / the pnpm importers / uv's dev groups.
- Licenses come from the lockfile itself (npm v2+), then what is installed: `node_modules` (pnpm's store too), a `.venv`'s `METADATA`, the cargo registry, the Go module cache's `LICENSE` file; anything left is `unknown` unless `registryLookup` is on.
- Limits: files over 4 MB cannot be read; workspace and path packages are left out as first-party; SPDX documents record non-SPDX license names as `NOASSERTION`; Go modules are never looked up online.
