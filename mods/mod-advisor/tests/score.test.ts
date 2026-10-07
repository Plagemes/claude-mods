import { describe, expect, test } from 'claude-code/testing'

import {
  buildIndex,
  compileGlob,
  describeEvidence,
  detectStack,
  headOf,
  isWorthRecommending,
  matchGlob,
  NOW_MIN,
  rankIntent,
  rankProject,
  reasonOf,
  recommendable,
  rollIntent,
  stackLabels,
  stem,
  TIP_MIN,
  tokensOf,
} from '../hooks/score'
import type { ProjectFacts } from '../hooks/score'
import type { AdvisorMod } from '../types'
import { CATALOG_MODS, REAL_SIGNALS } from './fixtures'

const NEXT_PRISMA: ProjectFacts = {
  files: ['package.json', 'next.config.mjs', 'tsconfig.json', 'app/page.tsx', 'app/layout.tsx', 'prisma/schema.prisma', 'README.md'],
  dirs: ['app', 'prisma', 'public', '.git'],
  deps: ['next', 'react', 'react-dom', 'prisma', '@prisma/client', 'typescript'],
}
const DJANGO: ProjectFacts = {
  files: ['manage.py', 'requirements.txt', 'shop/models.py', 'shop/views.py', 'shop/migrations/0001_initial.py'],
  dirs: ['shop', 'shop/migrations'],
  deps: ['django', 'psycopg2-binary', 'gunicorn'],
}
const GO: ProjectFacts = {
  files: ['go.mod', 'go.sum', 'main.go', 'internal/api/server.go'],
  dirs: ['internal', 'internal/api'],
  deps: ['github.com/gin-gonic/gin', 'gin'],
}
const TERRAFORM: ProjectFacts = {
  files: ['main.tf', 'variables.tf', 'modules/vpc/main.tf', '.terraform.lock.hcl'],
  dirs: ['modules', 'modules/vpc'],
  deps: [],
}
const EMPTY: ProjectFacts = { files: [], dirs: [], deps: [] }

const names = (facts: ProjectFacts, mods: readonly AdvisorMod[] = CATALOG_MODS, exclude?: Set<string>) =>
  rankProject(mods, facts, exclude).picks.map(pick => pick.name)

const INDEX = buildIndex(CATALOG_MODS)
const top = (prompt: string, index = INDEX) => rankIntent(index, prompt)[0]

describe('text', () => {
  test('stems both sides alike, so plural, -ing and -ed forms meet', () => {
    expect(['deploy', 'deploys', 'deploying', 'deployed'].map(stem)).toEqual(['deploy', 'deploy', 'deploy', 'deploy'])
    expect([stem('files'), stem('file')]).toEqual(['file', 'file'])
    expect([stem('changes'), stem('change'), stem('changed')]).toEqual(['chang', 'chang', 'chang'])
    expect([stem('branches'), stem('branch')]).toEqual(['branch', 'branch'])
  })

  test('prompts are read through the lexicon: Italian and shorthand become the catalog\'s words', () => {
    const stems = (text: string) => tokensOf(text, true).map(token => token.stem)
    expect(stems('Perché i test sono così lenti?')).toEqual(expect.arrayContaining(['test', 'slow']))
    expect(stems('fai il deploy in produzione')).toEqual(expect.arrayContaining(['deploy', 'production']))
    expect(stems('ship it to prod')).toEqual(expect.arrayContaining(['deploy', 'production']))
    expect(stems('the and of il la di')).toEqual([])
    // Paths and plain extensions name places, not needs; a technology's own extension stays.
    expect(stems('write /tmp/mod-advisor/demo/main.tf and fix src/app/page.tsx, then k8s/service.yaml')).toEqual(['writ', 'k8s', 'kubernet', 'kubectl', 'servic'])
    expect(stems('edit main.tf and schema.prisma')).toEqual(['edit', 'main', 'tf', 'terraform', 'schema', 'prisma'])
    // Descriptions are read as written.
    expect(tokensOf('produzione').map(token => token.stem)).toEqual(['produzion'])
  })

  test('the head of a description stops at its first clause, parentheses kept whole', () => {
    expect(headOf('Warns when the disk is nearly full before builds, installs and docker pulls.')).toBe('Warns when the disk is nearly full before builds')
    expect(headOf('Stops production-affecting commands (terraform apply, kubectl on prod) unless allowed.'))
      .toBe('Stops production-affecting commands (terraform apply, kubectl on prod) unless allowed')
    expect(headOf('Flags Dockerfile smells: :latest tags')).toBe('Flags Dockerfile smells')
  })

  test('globs match a name at any depth without a slash, the whole path with one, folders with a trailing slash', () => {
    expect(matchGlob(TERRAFORM, '*.tf')).toBe('main.tf')
    expect(matchGlob({ ...EMPTY, files: ['infra/prod/main.tf'] }, '*.tf')).toBe('infra/prod/main.tf')
    expect(matchGlob(NEXT_PRISMA, 'prisma/schema.prisma')).toBe('prisma/schema.prisma')
    expect(matchGlob({ ...EMPTY, files: ['db/prisma/schema.prisma'] }, 'prisma/schema.prisma')).toBeUndefined()
    expect(matchGlob({ ...EMPTY, files: ['db/prisma/schema.prisma'] }, '**/schema.prisma')).toBe('db/prisma/schema.prisma')
    expect(matchGlob({ ...EMPTY, files: ['.github/workflows/ci.yml'] }, '.github/workflows/*.{yml,yaml}')).toBe('.github/workflows/ci.yml')
    expect(matchGlob({ ...EMPTY, files: ['k8s'] }, 'k8s/')).toBeUndefined()
    expect(matchGlob({ ...EMPTY, dirs: ['deploy/k8s'] }, 'k8s/')).toBe('deploy/k8s')
    expect(compileGlob('next.config.*').pattern.test('next.config.mjs')).toBe(true)
  })
})

describe('project fit from a catalog without signals', () => {
  test('a Next.js + Prisma project gets its framework, ORM and TypeScript mods', () => {
    const { picks, stack } = rankProject(CATALOG_MODS, NEXT_PRISMA)
    const picked = picks.map(pick => pick.name)
    expect(stackLabels(stack)).toEqual(['Next.js', 'Prisma', 'React'])
    expect(picked.slice(0, 3)).toEqual(expect.arrayContaining(['next-guard', 'react-doctor']))
    expect(picked).toEqual(expect.arrayContaining(['next-guard', 'react-doctor', 'schema-sync', 'typecheck-gate']))
    expect(picked).not.toContain('docker-lint')
    expect(picked).not.toContain('django-migrate-watch')
    expect(picked).not.toContain('go-mod-tidy')
    expect(picks.length).toBeLessThanOrEqual(8)
    expect(reasonOf(picks.find(pick => pick.name === 'schema-sync')!)).toBe('Prisma · uses prisma')
  })

  test('a Django project gets Django and SQL mods, not another stack\'s', () => {
    const picked = names(DJANGO)
    expect(picked[0]).toBe('django-migrate-watch')
    expect(picked).toEqual(expect.arrayContaining(['sql-safety', 'venv-guard', 'migration-guard']))
    // schema-sync names Prisma and Drizzle: sharing "schema" and "migration" with Django does not make it fit.
    expect(picked).not.toContain('schema-sync')
    expect(picked).not.toContain('next-guard')
  })

  test('a Go project gets go-mod-tidy, and "go green" in a description does not count', () => {
    expect(names(GO)).toEqual(['go-mod-tidy'])
  })

  test('a Terraform project gets the plan pane and the production guards', () => {
    expect(names(TERRAFORM)).toEqual(['terraform-plan-pane', 'prod-guard', 'cloud-cost-warn'])
  })

  test('an empty repository gets nothing, and detects nothing', () => {
    expect(names(EMPTY)).toEqual([])
    expect(detectStack(EMPTY)).toEqual([])
  })

  test('installed and dismissed mods are never offered', () => {
    const picked = names(NEXT_PRISMA, CATALOG_MODS, new Set(['next-guard', 'schema-sync']))
    expect(picked).not.toContain('next-guard')
    expect(picked).not.toContain('schema-sync')
    expect(picked).toContain('react-doctor')
  })

  test('a Dockerfile added later brings the Docker mods, with the file as the reason', () => {
    const withDocker = { ...NEXT_PRISMA, files: [...NEXT_PRISMA.files, 'Dockerfile'] }
    const { picks } = rankProject(CATALOG_MODS, withDocker)
    const lint = picks.find(pick => pick.name === 'docker-lint')
    expect(lint).toBeDefined()
    expect(lint?.evidence[0]).toMatchObject({ kind: 'stack', detail: 'Docker', cause: { kind: 'file', detail: 'Dockerfile' } })
    expect(describeEvidence(lint!.evidence[0]!, true)).toBe('you added Dockerfile')
  })
})

describe('project fit from signals', () => {
  const WITH_SIGNALS: AdvisorMod[] = [
    { name: 'tf-cost', category: 'devops', description: 'Prices a Next.js plan.', signals: { files: ['*.tf'] } },
    { name: 'prisma-studio-pane', category: 'data', description: 'Browse tables.', signals: { deps: ['@prisma/*'], files: ['schema.prisma'] } },
    { name: 'next-only', category: 'stacks', description: 'Next.js and React helper.', signals: { deps: ['next'] } },
    { name: 'cost-meter', category: 'cost', description: 'Live session cost.', signals: { always: true, intents: ['cost'] } },
  ]

  test('signals decide alone: files and dependencies found, essentials everywhere', () => {
    expect(names(TERRAFORM, WITH_SIGNALS)).toEqual(['tf-cost', 'cost-meter'])
    expect(names(NEXT_PRISMA, WITH_SIGNALS)).toEqual(['prisma-studio-pane', 'next-only', 'cost-meter'])
    expect(names(EMPTY, WITH_SIGNALS)).toEqual(['cost-meter'])
    const { picks } = rankProject(WITH_SIGNALS, NEXT_PRISMA)
    expect(picks[0]?.evidence.map(evidence => describeEvidence(evidence))).toEqual(['uses @prisma/client', 'prisma/schema.prisma found'])
    expect(reasonOf(picks[2]!)).toBe('an essential for every project')
  })

  test('a new mod nobody has heard of is picked up from its catalog entry alone', () => {
    const astro: AdvisorMod = { name: 'astro-islands', category: 'frontend', description: 'Checks Astro islands hydrate.', signals: { deps: ['astro'], files: ['astro.config.*'] } }
    const svelte: AdvisorMod = { name: 'rune-check', category: 'stacks', description: 'Flags Svelte 5 rune mistakes as Claude writes components.' }
    const project: ProjectFacts = { files: ['astro.config.mjs', 'src/App.svelte', 'package.json'], dirs: ['src'], deps: ['astro', 'svelte'] }
    expect(names(project, [...CATALOG_MODS, astro, svelte]).slice(0, 2)).toEqual(['astro-islands', 'rune-check'])
    expect(names(DJANGO, [...CATALOG_MODS, astro, svelte])).not.toContain('astro-islands')

    const netsim: AdvisorMod = { name: 'net-sim', category: 'api', description: '/netsim simulates a slow, flaky network so you can test retries.' }
    expect(top('can you simulate a flaky network to test the retries?', buildIndex([...CATALOG_MODS, netsim]))?.name).toBe('net-sim')
  })
})

describe('the catalog\'s real signals', () => {
  // The snapshot with the signals catalog.json now carries for a few mods; the rest stay without.
  const MIXED = CATALOG_MODS.map(mod => (REAL_SIGNALS[mod.name] === undefined ? mod : { ...mod, signals: REAL_SIGNALS[mod.name] }))
  const MIXED_INDEX = buildIndex(MIXED)

  test('project fit mixes mods with and without signals', () => {
    const withDocker: ProjectFacts = { ...NEXT_PRISMA, files: [...NEXT_PRISMA.files, 'docker/Dockerfile'], dirs: [...NEXT_PRISMA.dirs, 'docker', 'k8s'] }
    const { picks } = rankProject(MIXED, withDocker)
    const picked = picks.map(pick => pick.name)
    expect(picked.slice(0, 2)).toEqual(['schema-sync', 'next-guard'])
    expect(picks[0]?.evidence.map(evidence => describeEvidence(evidence))).toEqual(['uses prisma', 'uses @prisma/client', 'prisma/schema.prisma found'])
    expect(picked).toEqual(expect.arrayContaining(['docker-lint', 'react-doctor']))
    // Essentials come last, after the fits.
    expect(picked.slice(-2)).toEqual(['git-status-line', 'cost-meter'])
    expect(reasonOf(picks.find(pick => pick.name === 'docker-lint')!)).toBe('docker/Dockerfile found')
    // `k8s/**` needs a file under k8s/, not the folder alone.
    expect(picked).not.toContain('k8s-dry-run')
    expect(names({ ...withDocker, files: [...withDocker.files, 'k8s/deploy.yaml'] }, MIXED)).toContain('k8s-dry-run')
  })

  test('a mod whose signals name a manifest it shares with many still loses to the one about the stack', () => {
    expect(names(GO, MIXED).slice(0, 2)).toEqual(['go-mod-tidy', 'dependency-sentinel'])
  })

  test('intent phrases, Italian ones included, decide the prompt', () => {
    expect(top('scrivi il messaggio di commit', MIXED_INDEX)?.evidence[0]?.detail).toBe('messaggio di commit')
    expect(top('the docker build is failing', MIXED_INDEX)?.name).toBe('docker-lint')
    expect(top('i test sono troppo lenti', MIXED_INDEX)?.name).toBe('slow-test-flag')
    expect(top('quanto ho speso oggi?', MIXED_INDEX)?.name).toBe('cost-meter')
    expect(recommendable(rollIntent([rankIntent(MIXED_INDEX, 'the docker build is failing')])).map(one => one.name)[0]).toBe('docker-lint')
  })
})

describe('intents', () => {
  test('English prompts find the mod that fits', () => {
    expect(top('deploy this to production')?.name).toBe('deploy-checklist')
    expect(top('write a commit message for my staged changes')?.name).toBe('commit-composer')
    expect(top('why are my tests so slow?')?.name).toBe('slow-test-flag')
    expect(top('how much am I spending in this session?')?.name).toBe('daily-spend')
    expect(top('notify me when it finishes')?.name).toBe('desktop-notify')
    expect(top('draft a pull request description')?.name).toBe('pr-describer')
  })

  test('Italian prompts find the same mods', () => {
    expect(top('fai il deploy in produzione')?.name).toBe('deploy-checklist')
    expect(top('scrivi il messaggio di commit')?.name).toBe('commit-composer')
    expect(top('perché i test sono così lenti?')?.name).toBe('slow-test-flag')
    expect(top('quanto sto spendendo?')?.name).toBe('daily-spend')
  })

  test('small talk and everyday coding requests match nothing worth showing', () => {
    for (const prompt of ['hello', 'thanks!', 'fix the login bug in auth.ts', 'refactor the user service', 'rinomina questa variabile']) {
      expect(rankIntent(INDEX, prompt).filter(one => one.score >= NOW_MIN)).toEqual([])
    }
  })

  test('a mod named after what is asked scores high enough for a tip', () => {
    const commit = top('write a commit message')
    expect(commit?.score).toBeGreaterThanOrEqual(TIP_MIN)
    expect(commit?.evidence.map(evidence => evidence.detail)).toEqual(['commit', 'message', 'write'])
    expect(reasonOf(commit!)).toBe('you\'re asking about "commit"')
  })

  test('intent phrases from signals count as a strong match', () => {
    const mods: AdvisorMod[] = [
      { name: 'ship-it', category: 'devops', description: 'A release train.', signals: { intents: ['go live', 'cut a release'] } },
      ...CATALOG_MODS,
    ]
    const first = top('we need to go live tonight', buildIndex(mods))
    expect(first?.name).toBe('ship-it')
    expect(first?.evidence[0]?.detail).toBe('go live')
  })

  test('the rolling window decays old prompts and remembers repeated ones', () => {
    const deploy = rankIntent(INDEX, 'deploy this to production')
    const chat = rankIntent(INDEX, 'hello')
    const once = rollIntent([deploy]).find(one => one.name === 'deploy-checklist')!
    // One mention of one word: shown under "now", not yet recommended.
    expect(once.score).toBeGreaterThanOrEqual(NOW_MIN)
    expect(isWorthRecommending(once)).toBe(false)
    const twice = rollIntent([deploy, chat, deploy]).find(one => one.name === 'deploy-checklist')!
    expect(twice.hits).toBe(2)
    expect(isWorthRecommending(twice)).toBe(true)
    const faded = rollIntent([chat, chat, chat, chat, deploy]).find(one => one.name === 'deploy-checklist')!
    expect(faded.score).toBeLessThan(NOW_MIN)
    // Two telling words in one prompt are enough at once.
    expect(isWorthRecommending(rollIntent([rankIntent(INDEX, 'write a commit message')])[0]!)).toBe(true)
  })

  test('only clear winners are recommended: a mod that merely shares common words is not', () => {
    const commit = rankIntent(INDEX, 'write a commit message')
    const rolled = rollIntent([rankIntent(INDEX, 'write the commit message again'), commit])
    // secret-shield "blocks writes that would commit API keys": it shares "write" and "commit", nothing that names it.
    expect(rolled.map(one => one.name)).toContain('secret-shield')
    expect(recommendable(rolled).map(one => one.name)).toEqual(['commit-composer'])
  })
})
