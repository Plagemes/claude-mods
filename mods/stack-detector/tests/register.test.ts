import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptComposeInput } from 'claude-code'

import { fakeHub } from './hub'

const ROOT = '/work/app'

const facts: PromptComposeInput = {
  model: 'claude-opus',
  promptModel: 'claude-opus',
  surfaces: ['terminal'],
  tools: ['Bash'],
  outputStyle: null,
  traits: [],
}

/** A project root in memory: file name → text. */
const project = (on: On, files: Record<string, string>) => {
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({
    value: [
      ...Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false }) as const),
      { name: 'src', kind: 'dir', size: 0, mtimeMs: 0, isLink: false } as const,
    ],
  }))
  on('fs.read', ($, e) => {
    const text = files[e.path.slice(ROOT.length + 1)]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const conventions = async ($: Engine) =>
  (await $.prompt.compose(facts)).sections.find(section => section.id === 'stack-detector:conventions')

const stack = ($: Engine, args = '') =>
  $.command.run({ command: 'stack', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const NEXT_APP = {
  'package.json': JSON.stringify({
    scripts: { test: 'vitest run' },
    dependencies: { next: '14.2.3', react: '18.3.1' },
    devDependencies: { typescript: '^5.4.0', vitest: '^1.6.0' },
  }),
  'pnpm-lock.yaml': 'lockfileVersion: 9',
  'tsconfig.json': '{}',
  Dockerfile: 'FROM node:20-alpine',
  'main.tf': 'terraform {}',
}

test('detects a Next.js app and adds concise conventions for each technology to the system prompt', async ($, on) => {
  project(on, NEXT_APP)
  await start($)

  const section = await conventions($)
  expect(section?.scope).toBe('session')
  const text = section?.text ?? ''
  expect(text).toContain('Detected from the project\'s root files: Next.js, React, TypeScript, Node.js, Docker, Terraform.')
  expect(text.indexOf('## Next.js')).toBeLessThan(text.indexOf('## React'))
  expect(text).toContain("add `'use client'` only where")
  expect(text).toContain('Use pnpm for installs and scripts (pnpm-lock.yaml)')
  expect(text).toContain('Run the tests with `pnpm test` (`vitest run`).')
  expect(text).toContain('never run `terraform apply`')
  expect(text).not.toContain('## Python')
})

test('reads Python, Ruby, PHP and JVM manifests for their frameworks', async ($, on) => {
  project(on, {
    'pyproject.toml': '[project]\ndependencies = ["fastapi>=0.110", "flask-cors"]',
    'go.mod': 'module example.com/app\n\ngo 1.22',
    Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'",
    'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
    'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>',
  })
  await start($)

  const shown = await stack($)
  expect(shown.text).toContain('FastAPI (fastapi)')
  expect(shown.text).toContain('pyproject.toml: fastapi')
  expect(shown.text).not.toContain('Flask')
  for (const name of ['Python (python)', 'Go (go)', 'Ruby on Rails (rails)', 'Laravel (laravel)', 'Spring Boot (spring)']) {
    expect(shown.text).toContain(name)
  }
  expect((await conventions($))?.text).toContain('## Spring Boot')
})

test('skip leaves a technology out, and /stack says so', { options: { skip: 'docker, terraform' } }, async ($, on) => {
  project(on, NEXT_APP)
  await start($)

  const text = (await conventions($))?.text ?? ''
  expect(text).toContain('## Next.js')
  expect(text).not.toContain('## Docker')
  expect(text).not.toContain('## Terraform')

  const shown = await stack($)
  expect(shown.text).toMatch(/– Docker \(docker\)\s+Dockerfile/)
  expect(shown.text).toMatch(/✓ Next\.js \(next\)\s+package\.json: next 14\.2\.3/)
})

test('adds nothing when it recognises nothing', async ($, on) => {
  project(on, { 'README.md': '# notes' })
  await start($)
  expect(await conventions($)).toBeUndefined()
  expect((await stack($, 'rescan')).text).toContain('Nothing recognised')
})

test('regression: with bun the test script runs with `bun run test`, since `bun test` is Bun\'s own runner', async ($, on) => {
  project(on, { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'bun.lock': '{}' })
  await start($)

  const text = (await conventions($))?.text ?? ''
  expect(text).toContain('Run the tests with `bun run test` (`vitest run`).')
  expect(text).not.toContain('`bun test`')
})

test('with mods-hub: the stack is shared as the fact stack-detector.stack, skipped technologies left out', { options: { skip: 'terraform' } }, async ($, on) => {
  project(on, NEXT_APP)
  const hub = fakeHub(on)
  await start($)

  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: [], consumes: [] }])
  const shared = hub.facts.get('stack') as { root: string; ids: string[]; packageManager: string | null; testCommand: string | null; techs: { id: string; evidence: string }[] }
  expect(shared.root).toBe(ROOT)
  expect(shared.ids).toEqual(['next', 'react', 'typescript', 'node', 'docker'])
  expect(shared.techs[0]).toEqual({ id: 'next', name: 'Next.js', evidence: 'package.json: next 14.2.3' })
  expect(shared.packageManager).toBe('pnpm')
  expect(shared.testCommand).toBe('pnpm test')
})
