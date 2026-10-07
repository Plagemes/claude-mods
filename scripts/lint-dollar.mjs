#!/usr/bin/env node
// Finds functions that are handed `$` but whose name is declared again elsewhere
// in the same hooks file (a parameter, a local const/let/var, a destructured
// name). Newer Claude Code engines refuse such a module outright: the plugin
// installs and shows as enabled, but none of its hooks load.
// Usage: node scripts/lint-dollar.mjs [mods/<name> ...]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const dirs = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : readdirSync(join(ROOT, 'mods')).map(name => join('mods', name))

// Names of top-level functions whose first parameter is `$`.
const handedDollar = source => new Set([
  ...[...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(\s*\$\s*[,:)]/gm)].map(m => m[1]),
  ...[...source.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(\s*\$\s*[,:)]/gm)].map(m => m[1]),
])

// Strip comments and string/template contents so names inside them don't count.
const code = source => source
  .replace(/\/\*[\s\S]*?\*\//g, match => ' ' + '\n'.repeat(match.split('\n').length - 1))
  .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, match => '""' + '\n'.repeat(match.split('\n').length - 1))

let problems = 0
for (const dir of dirs) {
  const hooks = resolve(ROOT, dir, 'hooks')
  if (!existsSync(hooks)) continue
  for (const file of readdirSync(hooks).filter(f => /\.(m|c)?[jt]sx?$/.test(f))) {
    const source = readFileSync(join(hooks, file), 'utf8')
    const body = code(source)
    for (const name of handedDollar(source)) {
      const local = new RegExp(
        `\\b(?:const|let|var)\\s+${name}\\b|\\b(?:const|let|var)\\s*[{[][^=;]*\\b${name}\\b[^=;]*[}\\]]\\s*=|\\bfor\\s*\\(\\s*(?:const|let|var)\\s+${name}\\b|\\bcatch\\s*\\(\\s*${name}\\b`,
      )
      // A parameter: only on lines that declare a function or an arrow.
      const parameter = new RegExp(`[(,]\\s*${name}\\s*[?]?\\s*[,):=]`)
      const isSignature = text => /\bfunction\b|=>/.test(text)
      const redeclared = { test: text => local.test(text) || (isSignature(text) && parameter.test(text.replace(/\{[^{}]*\}/g, '{}'))) }
      const declarations = body.match(new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\b`, 'g'))?.length ?? 0
      const offenders = []
      if (declarations > 1) offenders.push(`declared ${declarations} times`)
      for (const line of body.split('\n').map((text, i) => ({ text, i }))) {
        if (redeclared.test(line.text) && !new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name}\\b|^(?:export\\s+)?const\\s+${name}\\s*=`).test(line.text)) {
          offenders.push(`line ${line.i + 1}: ${line.text.trim().slice(0, 90)}`)
        }
      }
      if (offenders.length > 0) {
        problems += 1
        console.log(`✗ ${dir}/hooks/${file}: \`${name}\` is handed $ but also\n    ${offenders.join('\n    ')}`)
      }
    }
  }
}
console.log(problems === 0 ? '✓ no function handed $ is redeclared' : `${problems} problem(s)`)
process.exit(problems === 0 ? 0 : 1)
