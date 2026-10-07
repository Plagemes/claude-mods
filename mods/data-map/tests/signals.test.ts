import { expect, test } from 'claude-code/testing'

import { buildPrompt, classifyGrepOutput, countHits, documentOf, evidenceOf, extractTable, fallbackTable, gitGrepArgs } from '../hooks/signals'
import { SHOP_GIT_GREP } from './fixtures'

const signalsAt = (hits: ReturnType<typeof classifyGrepOutput>, where: string) =>
  hits
    .filter(hit => `${hit.file}:${hit.line}` === where)
    .map(hit => hit.signal)
    .sort()

test('classifies each matching line: data items, stores and third parties', () => {
  const hits = classifyGrepOutput(SHOP_GIT_GREP)
  expect(signalsAt(hits, 'src/models/user.js:3')).toEqual(['database'])
  expect(signalsAt(hits, 'src/models/user.js:10')).toEqual(['postal address'])
  expect(signalsAt(hits, 'src/models/user.js:9')).toEqual(['date of birth'])
  expect(signalsAt(hits, 'src/routes/signup.js:11')).toEqual(['IP address', 'credentials', 'email address', 'name'])
  expect(signalsAt(hits, 'src/routes/signup.js:12')).toEqual(['IP address', 'email address', 'logs'])
  expect(signalsAt(hits, 'src/routes/signup.js:15')).toEqual(['cookies and device IDs'])
  expect(signalsAt(hits, 'src/routes/checkout.js:5')).toEqual(['Stripe', 'email address'])
  expect(signalsAt(hits, 'web/consent.js:2')).toEqual(['browser storage'])
  // Logging the coordinates keeps them in the logs.
  expect(signalsAt(hits, 'web/consent.js:5')).toEqual(['location', 'logs'])
  expect(signalsAt(hits, 'prisma/schema.prisma:1')).toEqual(['database'])
  expect(signalsAt(hits, 'package.json:9')).toEqual(['SendGrid'])
  // console.log of nothing personal is not a store of personal data.
  expect(signalsAt(hits, 'src/lib/logger.js:3')).toEqual([])
  expect(countHits(hits)).toEqual({ hits: hits.length, files: 9, items: 9, stores: 3, thirdParties: 4 })
})

test('the git grep search excludes tests, docs and lockfiles and names every signal', () => {
  const args = gitGrepArgs()
  expect(args.slice(0, 6)).toEqual(['grep', '-n', '-I', '-i', '--no-color', '-E'])
  expect(args).toContain(':(exclude,glob)**/tests/**')
  expect(args).toContain(':(exclude,glob)docs/**')
  expect(args).toContain(':(exclude,glob)**/package-lock.json')
  expect(args).toContain('e-?mail')
  expect(args).toContain('stripe')
})

test('evidence and prompt group the hits; a table is pulled out of a fenced or chatty reply', () => {
  const hits = classifyGrepOutput(SHOP_GIT_GREP)
  const evidence = evidenceOf(hits)
  expect(evidence).toContain('## Personal data in the code (where it is collected or modelled)')
  expect(evidence).toContain('[email address] src/models/user.js:4: email: { type: String, required: true, unique: true },')
  expect(evidence).toContain('## Third parties it may be sent to')
  expect(evidenceOf(hits, 300)).toContain('(…evidence cut)')
  expect(buildPrompt('shop-app', evidence)).toContain('| Data item | Collected at | Stored in | Sent to | Legal basis hint |')

  const table = '| Data item | Collected at | Stored in | Sent to | Legal basis hint |\n| --- | --- | --- | --- | --- |\n| Email | src/models/user.js:4 | MongoDB | SendGrid | contract |'
  expect(extractTable(`Here is the map:\n\n\`\`\`markdown\n${table}\n\`\`\``)).toBe(table)
  expect(extractTable(`${table}\n\n## Gaps to check\n- retention`)).toBe(`${table}\n\n## Gaps to check\n- retention`)
  expect(extractTable('I cannot help with that.')).toBeUndefined()
})

test('without the model, a table from the scan: stores and third parties seen in the same files', () => {
  const hits = classifyGrepOutput(SHOP_GIT_GREP)
  const table = fallbackTable(hits)
  expect(table).toContain(
    '| email address | prisma/schema.prisma:3, src/lib/mail.js:4, src/lib/mail.js:5 | database, logs | SendGrid, Stripe, PostHog | contract (account) or consent (marketing) |',
  )
  expect(table).toContain('| location | web/consent.js:5 | browser storage, logs | unclear | consent |')
  expect(table).not.toContain('payment details')
  expect(table).toContain('- Third parties found anywhere in the code: Sentry, Stripe, SendGrid, PostHog.')
  const document = documentOf('shop-app', '2026-10-07', table, hits, true)
  expect(document).toStartWith('# Personal data map: shop-app\n\n_Generated 2026-10-07 by the data-map mod')
  expect(document).toContain('organised without the model')
  expect(document).toContain('- `src/routes/signup.js:12` logs: `logger.info(\'new signup ${email} from ${req.ip}\')`')
})
