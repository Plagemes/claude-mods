import { expect, test } from 'claude-code/testing'

import { classify, keywordsOf, matchRule, tierFromReply } from '../hooks/classify'
import type { Tier } from '../hooks/classify'

// 55 short task statements, English and Italian, across the three tiers.
const PROMPTS: readonly (readonly [Tier, string])[] = [
 ['light','Find all usages of `parseConfig` in the repo and list the files with line numbers.'],
 ['light','Search the codebase for where the JWT token is validated and report the file and function.'],
 ['light','Read src/server/router.ts and summarise how requests are dispatched.'],
 ['light','List every environment variable the app reads, with the file that reads it.'],
 ['light','Run `npm test` and report which tests fail, with the error messages. Do not fix anything.'],
 ['light','Fetch the React 19 docs for useOptimistic and summarise the API.'],
 ['light','Rename the `userId` prop to `accountId` in src/components/Avatar.tsx.'],
 ['light','Apply the following diff to lib/math.py:\n--- a/lib/math.py\n+++ b/lib/math.py'],
 ['light','Bump the version in package.json to 2.3.1 and update the CHANGELOG heading.'],
 ['light','Extract the error codes from errors.md into a JSON object.'],
 ['light','Create a new `OrdersPage` component by copying the existing `UsersPage` template.'],
 ['light','Where is the rate limiter configured? Just tell me the file and the setting.'],
 ['light','Format all Python files under scripts/ with black.'],
 ['light','Grep the logs in /var/log/app for "timeout" and count occurrences per hour.'],
 ['light','Summarise the architecture of the payments module.'],
 ['light','Trova tutti i file che importano `lodash` e elencali.'],
 ['light','Leggi il README e riassumi come si avvia il progetto in locale.'],
 ['light','Cerca dove viene definita la funzione `calcolaTotale`.'],
 ['light','Esegui i test e riporta l\'output degli errori, senza modificare nulla.'],
 ['light','Rinomina la variabile `tmp` in `buffer` nel file utils.js.'],
 ['light','Estrai i codici di errore dal file errors.md in una tabella markdown.'],
 ['standard','Implement a `--dry-run` flag for the deploy CLI command that prints the actions instead of running them.'],
 ['standard','Write unit tests for the `slugify` helper covering unicode and empty strings.'],
 ['standard','Fix the bug where the date picker shows the wrong month. Repro: open settings, pick Jan 31, the input shows March.'],
 ['standard','Refactor src/cart/total.ts to extract the discount logic into its own function.'],
 ['standard','Add a new `GET /api/orders/:id` endpoint following the existing pattern in routes/users.ts.'],
 ['standard','Review this diff for obvious bugs:\n+ const x = a ?? b'],
 ['standard','Update the README to document the new configuration options.'],
 ['standard','Add a migration that adds a nullable `archived_at` column to the projects table, like the other migrations.'],
 ['standard','The login form doesn\'t submit when pressing Enter — find out why and fix it.'],
 ['standard','Convert the class component `Modal` to a function component with hooks.'],
 ['standard','Add a unit test for the JWT parser that covers expired tokens.'],
 ['standard','Implementa la paginazione nella lista ordini usando lo stesso componente della lista utenti.'],
 ['standard','Scrivi i test per la funzione `parseDate`, inclusi i casi limite.'],
 ['standard','Correggi il bug per cui il carrello non si aggiorna dopo il login. Per riprodurlo: aggiungi un prodotto, fai logout e login.'],
 ['standard','Rifattorizza il modulo pagamenti per separare la validazione dal salvataggio.'],
 ['standard','Aggiorna la documentazione dell\'API con i nuovi parametri.'],
 ['deep','Design the architecture for multi-tenant support: how should we isolate data per tenant? Weigh the trade-offs of schema-per-tenant vs row-level security.'],
 ['deep','Do a security review of the new file upload endpoint: look for path traversal, injection and auth bypass.'],
 ['deep','There\'s an intermittent deadlock between the job scheduler and the DB pool. Find the root cause.'],
 ['deep','The API p99 latency doubled after the last release; profile it and find the root cause of the regression.'],
 ['deep','Write a script to migrate production user data from the legacy table to the new schema, with a rollback plan.'],
 ['deep','Rename the `User.id` field to `User.uuid` across the whole codebase — it is part of the public API.'],
 ['deep','Merge the findings of the three parallel agents into one consistent report and resolve contradictions.'],
 ['deep','The requirements here are ambiguous: the PM wants offline mode but also real-time sync. Figure out what we should build.'],
 ['deep','This test still fails after two attempts at fixing it; take over and fix it properly.'],
 ['deep','Replace the hand-rolled password hashing with argon2 and rehash existing passwords on next login.'],
 ['deep','Refactor the error handling in all 14 services to use the new Result type.'],
 ['deep','Fix the flaky checkout test that sometimes fails on CI.'],
 ['deep','Progetta l\'architettura del sistema di notifiche e valuta i compromessi tra code e webhook.'],
 ['deep','Fai una revisione di sicurezza del modulo di autenticazione.'],
 ['deep','C\'è una condizione di gara nel salvataggio degli ordini: trova la causa e correggila.'],
 ['deep','Migra i dati di produzione dei clienti al nuovo schema senza downtime.'],
 ['deep','I requisiti sono ambigui: decidi come gestire i conflitti di sincronizzazione.'],
 ['deep','La ricerca è lenta in produzione: trova il collo di bottiglia e ottimizza la query.'],
]

// Prompts as a main model writes them for subagents: context, lists, agent types.
const REALISTIC: readonly (readonly [Tier, string, string?, string?])[] = [
 ['light','Explore the codebase to understand how authentication works. Look at:\n1. Where the auth middleware is defined\n2. How sessions are stored\n3. Any JWT handling\nReport file paths and a brief summary. Do not modify any files.'],
 ['standard','You are working in /repo. Task: add input validation to the signup form (src/forms/Signup.tsx) using zod, following the pattern in Login.tsx. Write tests. When done, report what you changed.'],
 ['light','Context: our production app uses Next.js 15.\nTask: fix the typo "Recieve" in src/components/Footer.tsx.'],
 ['deep','Review the following PR for correctness, security and performance issues:\n\n```diff\n+ db.query(`SELECT * FROM users WHERE id = ${id}`)\n```'],
 ['light','Find where X is defined', 'Explore', 'Find symbol'],
 ['standard','Audit the auth flow for security issues and report', 'Explore', 'Security audit'],
 ['deep','Plan the implementation of the new export feature', 'Plan', 'Plan export'],
 ['standard','', 'general-purpose', ''],
 ['light','Check whether the `lodash` dependency is still used anywhere and report back.'],
 ['standard','Investigate why the CI job "lint" fails on main and fix the cause.'],
 ['light','List the open TODO comments in src/ grouped by file.'],
 ['deep','We need to decide between Redis and Postgres LISTEN/NOTIFY for the job queue. Compare the approaches and recommend one.'],
 ['standard','Add a `--json` output option to the `status` command.'],
 ['light','Sort the imports in src/index.ts and remove unused ones.'],
 ['deep','Integrate the results from the subagents above into a single migration plan.'],
 ['standard','Optimize the image loading in Gallery.tsx by adding lazy loading.'],
]

test('rates 55 English and Italian task statements into the right tier', () => {
  const wrong = PROMPTS.filter(([tier, prompt]) => classify({ prompt }).tier !== tier).map(([tier, prompt]) => `${tier}: ${prompt}`)
  expect(PROMPTS.length).toBeGreaterThanOrEqual(40)
  expect(PROMPTS.filter(([, prompt]) => /[àèéìòù]|\b(il|la|dei|della|che|per)\b/.test(prompt)).length).toBeGreaterThanOrEqual(12)
  expect(wrong).toEqual([])
})

test('rates realistic subagent prompts, agent types included', () => {
  const wrong = REALISTIC.filter(([tier, prompt, subagentType, description]) => classify({ prompt, subagentType, description }).tier !== tier).map(([tier, prompt]) => `${tier}: ${prompt}`)
  expect(wrong).toEqual([])
})

test('Explore reads (never deep), Plan designs, and the reasons and flags say why', () => {
  const explore = classify({ prompt: 'Find where the session cookie is set', subagentType: 'Explore' })
  expect(explore.tier).toBe('light')
  expect(explore.signals).toContain('Explore agent')
  expect(classify({ prompt: 'Audit the auth flow for security issues', subagentType: 'Explore' }).tier).toBe('standard')
  expect(classify({ prompt: 'Plan the export feature', subagentType: 'Plan' })).toEqual(expect.objectContaining({ tier: 'deep', tag: 'Plan', isDeepCategory: true }))
  expect(classify({ prompt: 'Design the architecture of the sync engine' })).toEqual(expect.objectContaining({ tag: 'design', isDeepCategory: true, isBorderline: false }))
  expect(classify({ prompt: '' })).toEqual(expect.objectContaining({ tier: 'standard', tag: 'default', isBorderline: true }))
  expect(classify({ prompt: 'Update the config' })).toEqual(expect.objectContaining({ tier: 'standard', tag: 'edit', isBorderline: true }))
})

test('a deep task is well scoped only when it is one narrow subject in a few files', () => {
  expect(classify({ prompt: 'Fix the race condition in src/queue/worker.ts where two workers claim the same job.' }).isScoped).toBe(true)
  expect(classify({ prompt: 'Find the memory leak in the image cache and fix it' }).isScoped).toBe(true)
  expect(classify({ prompt: 'Design the architecture of the cache layer' }).isScoped).toBe(false)
  expect(classify({ prompt: 'Rotate the JWT signing keys and re-encrypt the stored tokens' }).isScoped).toBe(false)
  expect(classify({ prompt: 'Fix the deadlock across all 9 services' }).isScoped).toBe(false)
})

test('a learned rule wins over the word rules; keywords skip filler words', () => {
  const keywords = keywordsOf('Add archived column migration', 'Add a migration that adds a nullable archived_at column to the projects table.')
  expect(keywords).toEqual(['column', 'migration', 'archived'])
  const rule = { id: 'r1', keywords, tier: 'light' as const, example: 'Add archived column migration', createdAt: 1 }
  expect(classify({ prompt: 'Add a migration for the archived column on users' }).tier).toBe('standard')
  const learned = classify({ prompt: 'Add a migration for the archived column on users' }, [rule])
  expect(learned).toEqual(expect.objectContaining({ tier: 'light', tag: 'learned' }))
  expect(matchRule('rename the archived flag', [rule])).toBeUndefined()
  const newer = { ...rule, id: 'r2', tier: 'deep' as const, createdAt: 2 }
  expect(matchRule('archived column migration', [rule, newer])?.id).toBe('r2')
})

test('reads the small model\'s one-word reply', () => {
  expect(tierFromReply('deep')).toBe('deep')
  expect(tierFromReply(' Light.')).toBe('light')
  expect(tierFromReply('light or deep')).toBeUndefined()
  expect(tierFromReply('no idea')).toBeUndefined()
})
