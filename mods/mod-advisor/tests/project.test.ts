import { describe, expect, test } from 'claude-code/testing'

import {
  commandsIn,
  commandsOf,
  isCatalogOf,
  marketplaceOf,
  parseArgs,
  parseCatalog,
  parseMarketplaceCatalog,
  parseMarketplaces,
  parseOutcome,
  tipLine,
  usageOf,
} from '../hooks/catalog'
import { changesOf, depsOf, isManifest, relativeTo } from '../hooks/project'

const SOURCE = { repository: 'plagemes/claude-mods', branch: 'main' }
const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

describe('manifests', () => {
  test('every ecosystem\'s dependencies are read, normalized', () => {
    expect(depsOf('package.json', JSON.stringify({ dependencies: { next: '15', '@prisma/client': '6' }, devDependencies: { prisma: '6' } })))
      .toEqual(['next', '@prisma/client', 'prisma'])
    expect(depsOf('requirements-dev.txt', '# tools\nDjango>=5.0\npsycopg2_binary==2.9 ; python_version > "3"\n-r base.txt\n\n')).toEqual(['django', 'psycopg2-binary'])
    expect(depsOf('pyproject.toml', [
      '[project]', 'name = "shop"', 'dependencies = [', '  "fastapi>=0.110",', '  "SQLAlchemy[asyncio]",', ']',
      '[tool.poetry.dependencies]', 'python = "^3.12"', 'httpx = "*"',
    ].join('\n'))).toEqual(['fastapi', 'sqlalchemy', 'httpx'])
    expect(depsOf('go.mod', 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgorm.io/gorm v1.25.0\n)\n'))
      .toEqual(['github.com/gin-gonic/gin', 'gin', 'gorm.io/gorm', 'gorm'])
    expect(depsOf('Cargo.toml', '[package]\nname = "x"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n[dev-dependencies]\ninsta = "1"\n'))
      .toEqual(['serde', 'tokio', 'insta'])
    expect(depsOf('composer.json', JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11', 'ext-json': '*' } }))).toEqual(['laravel/framework'])
    expect(depsOf('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n  gem \"pg\"\n")).toEqual(['rails', 'pg'])
    expect(depsOf('package.json', '{ not json')).toEqual([])
    expect(['package.json', 'apps/web/package.json', 'requirements.txt', 'requirements-dev.txt', 'Gemfile', 'README.md'].map(isManifest))
      .toEqual([true, true, true, true, true, false])
  })

  test('paths are made relative to the project root, or refused outside it', () => {
    expect(relativeTo('/work/shop', '/work/shop/prisma/schema.prisma')).toBe('prisma/schema.prisma')
    expect(relativeTo('/work/shop/', './Dockerfile')).toBe('Dockerfile')
    expect(relativeTo('/work/shop', '/work/other/x')).toBeUndefined()
    expect(relativeTo('/work/shop', '../x')).toBeUndefined()
  })
})

describe('shell commands', () => {
  test('installs ask for the manifests again', () => {
    for (const command of ['npm install prisma', 'pnpm add -D vitest', 'yarn', 'pip install django', 'uv add fastapi', 'poetry add httpx',
      'go get github.com/gin-gonic/gin', 'cargo add serde', 'composer require laravel/framework', 'bundle add rails', 'cd web && npm i']) {
      expect(changesOf(command).installs).toBe(true)
    }
    expect(changesOf('npm run build').installs).toBe(false)
    expect(changesOf('npm test').installs).toBe(false)
  })

  test('checkouts and scaffolders ask for a full rescan', () => {
    for (const command of ['git checkout feature/x', 'git pull --rebase', 'git clone https://x/y.git', 'npx create-next-app@latest web',
      'npm create vite@latest', 'django-admin startproject shop', 'cargo new cli', 'terraform init']) {
      expect(changesOf(command).isFull).toBe(true)
    }
    expect(changesOf('git status').isFull).toBe(false)
  })

  test('files created by touch, mkdir, cp, mv, redirections and downloads are named', () => {
    expect(changesOf('touch Dockerfile .dockerignore').paths).toEqual(['Dockerfile', '.dockerignore'])
    expect(changesOf('mkdir -p infra/k8s && cp tmpl/main.tf infra/main.tf').paths).toEqual(['infra/k8s', 'infra/main.tf'])
    expect(changesOf('echo "FROM node:20" > Dockerfile 2>&1').paths).toEqual(['Dockerfile'])
    expect(changesOf('curl -sSL https://x/y -o openapi.yaml').paths).toEqual(['openapi.yaml'])
    expect(changesOf('ls -la > /dev/null').paths).toEqual([])
  })
})

describe('catalog', () => {
  test('catalog.json is read with or without signals, bad entries skipped', () => {
    const catalog = parseCatalog(JSON.stringify({
      version: '2.1.0',
      categories: [{ id: 'core', title: 'Core', tagline: 'Essentials.' }],
      mods: [
        { name: 'mod-store', category: 'core', tier: 'complex', description: 'An app store.', spec: 'long text' },
        { name: 'commit-composer', category: 'git', description: '/commit writes a message.', commands: ['commit'], signals: { intents: ['commit message'], files: 'nope', always: 'yes' } },
        { name: 'bad name!', description: 'x' },
        { description: 'no name' },
        { name: 'mod-store', description: 'duplicate' },
      ],
    }), SOURCE, 1, 'github')
    expect(catalog.version).toBe('2.1.0')
    expect(catalog.mods).toEqual([
      { name: 'mod-store', category: 'core', tier: 'complex', description: 'An app store.' },
      { name: 'commit-composer', category: 'git', description: '/commit writes a message.', commands: ['/commit'], signals: { intents: ['commit message'] } },
    ])
    expect(isCatalogOf(catalog, SOURCE)).toBe(true)
    expect(isCatalogOf(catalog, { ...SOURCE, branch: 'dev' })).toBe(false)
    expect(() => parseCatalog('{"mods": []}', SOURCE, 1, 'github')).toThrow()
    expect(() => parseCatalog('<html>', SOURCE, 1, 'github')).toThrow()
  })

  test('a marketplace file stands in for the catalog, keywords included', () => {
    const catalog = parseMarketplaceCatalog(JSON.stringify({
      name: 'claude-mods',
      metadata: { version: '2.0.0' },
      plugins: [{ name: 'docker-lint', source: './mods/docker-lint', description: 'Flags Dockerfile smells.', category: 'devops', keywords: ['docker'] }],
    }), SOURCE, 5)
    expect(catalog).toMatchObject({ version: '2.0.0', origin: 'local', mods: [{ name: 'docker-lint', category: 'devops', keywords: ['docker'] }] })
  })

  test('commands come from the catalog, the session and the description, each once', () => {
    expect(commandsIn('/eli5, /normal and /expert set how deep. Shows pass/fail and /tmp/x.')).toEqual(['/eli5', '/normal', '/expert'])
    const mod = { name: 'explain-level', category: 'prompting', description: '/eli5, /normal and /expert set how deep Claude\'s explanations go.' }
    expect(commandsOf(mod, ['eli5', 'explain-level'])).toEqual(['/eli5', '/explain-level', '/normal', '/expert'])
    expect(commandsOf({ ...mod, commands: ['/expert'] })).toEqual(['/expert', '/eli5', '/normal'])
    expect(tipLine({ name: 'commit-composer', category: 'git', description: '/commit writes a message from your staged diff.' }, '/commit'))
      .toBe('/commit writes a message from your staged diff')
    expect(tipLine({ name: 'x', category: 'git', description: 'Shows a checklist.' }, '/x')).toBe('/x — shows a checklist')
  })

  test('the README usage section is cut out', () => {
    const readme = '# x\n> y\n\n## What it does\nThings.\n\n## Usage\n| Command | What |\n| --- | --- |\n| `/x` | Runs. |\n\n## Configuration\nNone.\n'
    expect(usageOf(readme)).toBe('| Command | What |\n| --- | --- |\n| `/x` | Runs. |')
    expect(usageOf('# x\nno usage')).toBe('')
  })

  test('the CLI\'s JSON: outcomes and marketplaces', () => {
    expect(parseOutcome(ran('{"command":"install","outcome":"ok","message":"Installed x"}'))).toEqual({ isOk: true, message: 'Installed x' })
    expect(parseOutcome(ran('{"outcome":"failed","failureCode":"not_found","message":"no x"}', 1))).toEqual({ isOk: false, message: 'no x', failureCode: 'not_found' })
    const known = parseMarketplaces(JSON.stringify([
      { name: 'other', source: 'github', repo: 'a/b', installLocation: '/m/other' },
      { name: 'my-mods', source: 'github', repo: 'Plagemes/Claude-Mods', installLocation: '/m/my-mods' },
    ]))
    expect(marketplaceOf(known, 'plagemes/claude-mods')).toEqual({ name: 'my-mods', repo: 'Plagemes/Claude-Mods', installLocation: '/m/my-mods' })
    expect(marketplaceOf([{ name: 'claude-mods', installLocation: '/repo' }], 'plagemes/claude-mods')?.installLocation).toBe('/repo')
    expect(marketplaceOf([], 'plagemes/claude-mods')).toBeUndefined()
  })

  test('/mods-advisor arguments', () => {
    expect(parseArgs('')).toEqual({ kind: 'open', query: '' })
    expect(parseArgs('refresh')).toEqual({ kind: 'refresh' })
    expect(parseArgs('quiet')).toEqual({ kind: 'quiet', value: undefined })
    expect(parseArgs('quiet ON')).toEqual({ kind: 'quiet', value: true })
    expect(parseArgs('quiet maybe')).toMatchObject({ kind: 'usage' })
    expect(parseArgs('why docker-lint')).toEqual({ kind: 'why', name: 'docker-lint' })
    expect(parseArgs('why')).toMatchObject({ kind: 'usage' })
    expect(parseArgs('reset')).toEqual({ kind: 'reset' })
    expect(parseArgs('deploy checks')).toEqual({ kind: 'open', query: 'deploy checks' })
  })
})
