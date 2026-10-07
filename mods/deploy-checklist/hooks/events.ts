// What a deploy command deploys, for the `deploy.*` events. Pure: no `$`, unit-tested directly.

import { deployKind } from './checks'
import { simpleCommands } from './shared/shell'

/** Package runners whose next word is the tool that really runs. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'dlx'])
const PRODUCTION_FLAG = /^--prod(?:uction|IfUnlocked)?$/
const VALUED_ENVIRONMENT = new Set(['--env', '--environment', '-e', '--context', '--project', '--app', '-a', '--alias'])
const URL = /https?:\/\/[^\s"'<>)]+/

export type DeployTarget = { target: string; environment: string }

/**
 * The tool a deploy line runs (`vercel`, `fly`, `kubectl`...) and where it goes: production for `--prod` and
 * `cap production deploy`, the value of `--env`/`--context`/`--app`-like flags, the npm registry for a publish,
 * `default` otherwise. Read with the shell lexer every Claude Mod shares, so `cd web && npx vercel --prod` is vercel.
 */
export function deployTargetOf(command: string, extra: RegExp | undefined): DeployTarget | undefined {
  const kind = deployKind(command, extra)
  if (kind === undefined) return undefined
  const deploying = simpleCommands(command).find(one => deployKind(one.argv.join(' '), extra) !== undefined)
  if (deploying === undefined) return { target: kind.split(' ')[0] ?? kind, environment: 'default' }
  const argv = RUNNERS.has(deploying.name) ? deploying.argv.slice(1) : deploying.argv
  const target = (argv[0] ?? deploying.name).split('/').pop() ?? deploying.name
  const valued = argv.findIndex(word => VALUED_ENVIRONMENT.has(word.split('=')[0] ?? word))
  const flag = valued === -1 ? undefined : argv[valued]
  const value = flag === undefined ? undefined : flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : argv[valued + 1]
  const environment =
    argv.some(word => PRODUCTION_FLAG.test(word)) || (target === 'cap' && argv[1] === 'production')
      ? 'production'
      : value !== undefined && value !== ''
        ? value
        : /publish/.test(kind)
          ? 'registry'
          : 'default'
  return { target, environment }
}

/** The first link a deploy printed (vercel and netlify print the deployment's URL). */
export const urlIn = (output: string): string | undefined => URL.exec(output)?.[0]

/** Why a deploy failed, in one line: the output's last line that says error, else its last line. */
export function failureOf(output: string): string {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
  const line = lines.findLast(one => /\b(?:error|failed|fatal)\b/i.test(one)) ?? lines.at(-1) ?? 'the deploy command failed'
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}
