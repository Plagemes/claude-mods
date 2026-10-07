import type { Register } from 'claude-code'

const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit)$/

/** Lockfile name -> the command that regenerates it. */
const LOCKFILES: Readonly<Record<string, string>> = {
  'package-lock.json': 'npm install (or npm install <package>)',
  'npm-shrinkwrap.json': 'npm shrinkwrap',
  'pnpm-lock.yaml': 'pnpm install',
  'yarn.lock': 'yarn install',
  'bun.lockb': 'bun install',
  'bun.lock': 'bun install',
  'Cargo.lock': 'cargo update (or cargo build)',
  'poetry.lock': 'poetry lock',
  'uv.lock': 'uv lock',
  'Gemfile.lock': 'bundle install',
  'composer.lock': 'composer update',
  'go.sum': 'go mod tidy',
  'Pipfile.lock': 'pipenv lock',
  'pdm.lock': 'pdm lock',
  'mix.lock': 'mix deps.get',
  'pubspec.lock': 'dart pub get',
  'Podfile.lock': 'pod install',
  'flake.lock': 'nix flake lock',
}

function fileOf(input: Readonly<Record<string, unknown>>): string {
  return typeof input.file_path === 'string' ? input.file_path : ''
}

export const register: Register = on => {
  on('tool.call', { tool: EDIT_TOOLS }, ($, e, next) => {
    const path = fileOf(e)
    const name = path.slice(path.search(/[^/\\]*$/))
    const regenerate = Object.hasOwn(LOCKFILES, name) ? LOCKFILES[name] : undefined

    return regenerate === undefined
      ? next(e)
      : { deny: `lockfile-guard: ${name} is generated, so it is not edited by hand. Change the manifest, then regenerate it with: ${regenerate}.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'lockfile-guard: its check failed, so the edit was blocked.' }))
}
