import type { DataMapHit as Hit } from '../types'

export type { Hit }

/** A signal: what it means, a loose ERE for `git grep -i` to find candidates, and the exact test applied to each line. */
export type Signal = { name: string; kind: Hit['kind']; grep: string; match: RegExp; basis?: string }

/** Personal data items, with a first guess at the GDPR legal basis for processing them. */
export const DATA_ITEMS: readonly Signal[] = [
  { name: 'email address', kind: 'data', grep: 'e-?mail', match: /e-?mail/i, basis: 'contract (account) or consent (marketing)' },
  {
    name: 'name',
    kind: 'data',
    grep: '(first|last|full|middle|given|family|display|user|customer)[_ -]?name',
    match: /\b(?:first|last|full|middle|given|family|display|user|customer)[_ -]?name\b|(?:first|last|full|middle|given|family|display|user|customer)Name/i,
    basis: 'contract',
  },
  { name: 'phone number', kind: 'data', grep: 'phone|mobile_?number|msisdn', match: /phone|mobile_?number|msisdn/i, basis: 'contract or consent' },
  {
    name: 'postal address',
    kind: 'data',
    grep: 'street|postal_?code|post_?code|zip_?code|billing_?address|shipping_?address|home_?address|address_?line',
    match: /street|postal_?code|post_?code|zip_?code|(?:billing|shipping|home)_?address|address_?line/i,
    basis: 'contract (delivery, billing)',
  },
  { name: 'date of birth', kind: 'data', grep: 'birth|dob', match: /birth|\bdob\b/i, basis: 'contract or legal obligation (age checks)' },
  { name: 'gender', kind: 'data', grep: 'gender', match: /gender/i, basis: 'consent' },
  {
    name: 'government ID',
    kind: 'data',
    grep: 'ssn|social_?security|passport|national_?id|tax_?id|driver_?licen',
    match: /\bssn\b|social_?security|passport|national_?id|tax_?id|driver_?licen/i,
    basis: 'legal obligation',
  },
  {
    name: 'IP address',
    kind: 'data',
    grep: 'ip_?address|remote_?addr|x-forwarded-for|req\\.ip|client_?ip',
    match: /\bip_?address|ipAddress|remote_?addr|x-forwarded-for|\breq\.ip\b|client_?ip/i,
    basis: 'legitimate interests (security, fraud)',
  },
  {
    name: 'location',
    kind: 'data',
    grep: 'latitude|longitude|geolocation|geo_?ip|lat_?lng',
    match: /latitude|longitude|geolocation|geo_?ip|lat_?lng/i,
    basis: 'consent',
  },
  {
    name: 'cookies and device IDs',
    kind: 'data',
    grep: 'document\\.cookie|set-cookie|res\\.cookie|setcookie|cookies\\.set|device_?id|user_?agent',
    match: /document\.cookie|set-cookie|res\.cookie\(|setcookie|cookies\.set|device_?id|user_?agent/i,
    basis: 'consent (non-essential cookies) or legitimate interests',
  },
  {
    name: 'payment details',
    kind: 'data',
    grep: 'card_?number|credit_?card|iban|cvv|cvc|payment_?method',
    match: /card_?number|credit_?card|\biban\b|\bcvv\b|\bcvc\b|payment_?method/i,
    basis: 'contract',
  },
  { name: 'credentials', kind: 'data', grep: 'password|passwd', match: /password|passwd/i, basis: 'contract' },
]

/** Where data is kept. Logging only counts on a line that also names a data item. */
export const STORES: readonly Signal[] = [
  {
    name: 'database',
    kind: 'storage',
    grep: 'create table|new schema|mongoose|sequelize|@entity|@column|create_table|pgtable|mysqltable|sqlitetable|models\\.model|db\\.model|^model ',
    match: /create table|new Schema\(|mongoose\.(?:Schema|model)|sequelize\.define|@Entity\(|@Column\(|create_table|pgTable\(|mysqlTable\(|sqliteTable\(|models\.Model|db\.Model|^\s*model\s+\w+\s*\{/i,
  },
  { name: 'browser storage', kind: 'storage', grep: 'localstorage|sessionstorage|indexeddb', match: /localStorage|sessionStorage|indexedDB/i },
  { name: 'cache', kind: 'storage', grep: 'redis|memcache', match: /redis|memcache/i },
  { name: 'object storage', kind: 'storage', grep: 'putobject|s3client|upload_?file|blob_?storage|storage\\.bucket', match: /putObject|S3Client|upload_?file|blob_?storage|storage\.bucket/i },
  { name: 'logs', kind: 'storage', grep: 'console\\.log|logger\\.|logging\\.', match: /console\.log|logger\.\w+\(|logging\.\w+\(/i },
]

/** Third parties personal data may be sent to, by the names their SDKs and APIs use. */
export const THIRD_PARTIES: readonly Signal[] = [
  { name: 'Google Analytics', kind: 'third-party', grep: 'gtag|google-analytics|googletagmanager', match: /gtag\(|google-analytics|googletagmanager/i },
  { name: 'Segment', kind: 'third-party', grep: 'segment|analytics\\.(track|identify)', match: /@segment\/|analytics-node|analytics\.(?:track|identify)\(/i },
  { name: 'Mixpanel', kind: 'third-party', grep: 'mixpanel', match: /mixpanel/i },
  { name: 'Amplitude', kind: 'third-party', grep: 'amplitude', match: /amplitude/i },
  { name: 'PostHog', kind: 'third-party', grep: 'posthog', match: /posthog/i },
  { name: 'Hotjar', kind: 'third-party', grep: 'hotjar', match: /hotjar/i },
  { name: 'FullStory', kind: 'third-party', grep: 'fullstory', match: /fullstory/i },
  { name: 'LogRocket', kind: 'third-party', grep: 'logrocket', match: /logrocket/i },
  { name: 'Sentry', kind: 'third-party', grep: 'sentry', match: /sentry/i },
  { name: 'Datadog', kind: 'third-party', grep: 'datadog', match: /datadog/i },
  { name: 'Bugsnag', kind: 'third-party', grep: 'bugsnag', match: /bugsnag/i },
  { name: 'SendGrid', kind: 'third-party', grep: 'sendgrid', match: /sendgrid/i },
  { name: 'Mailgun', kind: 'third-party', grep: 'mailgun', match: /mailgun/i },
  { name: 'Postmark', kind: 'third-party', grep: 'postmark', match: /postmark/i },
  { name: 'Resend', kind: 'third-party', grep: 'resend', match: /\bresend\b|new Resend\(/i },
  { name: 'Amazon SES', kind: 'third-party', grep: 'sesclient|ses\\.send|client-ses', match: /SESClient|ses\.send|client-ses/i },
  { name: 'SMTP', kind: 'third-party', grep: 'nodemailer|smtplib', match: /nodemailer|smtplib/i },
  { name: 'Twilio', kind: 'third-party', grep: 'twilio', match: /twilio/i },
  { name: 'Stripe', kind: 'third-party', grep: 'stripe', match: /stripe/i },
  { name: 'PayPal', kind: 'third-party', grep: 'paypal|braintree', match: /paypal|braintree/i },
  { name: 'HubSpot', kind: 'third-party', grep: 'hubspot', match: /hubspot/i },
  { name: 'Intercom', kind: 'third-party', grep: 'intercom', match: /intercom/i },
  { name: 'Mailchimp', kind: 'third-party', grep: 'mailchimp', match: /mailchimp/i },
  { name: 'Salesforce', kind: 'third-party', grep: 'salesforce', match: /salesforce/i },
  { name: 'Zendesk', kind: 'third-party', grep: 'zendesk', match: /zendesk/i },
  { name: 'Auth0', kind: 'third-party', grep: 'auth0', match: /auth0/i },
  { name: 'Firebase', kind: 'third-party', grep: 'firebase', match: /firebase/i },
  { name: 'Meta Pixel', kind: 'third-party', grep: 'fbq\\(|facebook\\.net', match: /fbq\(|connect\.facebook\.net/i },
  { name: 'OpenAI', kind: 'third-party', grep: 'openai', match: /openai/i },
  { name: 'Anthropic', kind: 'third-party', grep: 'anthropic', match: /@anthropic-ai|anthropic\./i },
]

export const SIGNALS: readonly Signal[] = [...DATA_ITEMS, ...STORES, ...THIRD_PARTIES]

/** Paths never scanned: lockfiles, tests and fixtures, docs (where the map itself is written), built and vendored code. */
export const EXCLUDED_PATHS = [
  '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'go.sum', '*.min.js', '*.map', '*.svg', '*.snap', '*.md',
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '*.test.*', '*.spec.*', '*_test.*', '**/fixtures/**',
  '**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**', '**/coverage/**', 'docs/**', '.claude/**',
  // Secrets live here: their lines would end up in the prompt and in the saved document.
  '.env', '.env.*', '*.pem', '*.key',
]

const MAX_LINE = 180
const MAX_PER_SIGNAL = 40
/** `password: "hunter2"`, `STRIPE_SECRET_KEY = 'sk_live_…'`: a hard-coded secret's value is kept out of the evidence. */
const SECRET_VALUE = /((?:secret|token|passw(?:or)?d|pwd|api_?key|private_?key|access_?key)\w*["'`]?\s*(?:=>|[:=])\s*)(["'`])[^"'`]{4,}\2/gi

/** A line as evidence: hard-coded secret values masked. */
export const redactSecrets = (text: string): string => text.replace(SECRET_VALUE, (_, head: string, quote: string) => `${head}${quote}…${quote}`)

/** `git grep` arguments that find candidate lines for every signal, case-insensitively, in tracked text files. */
export const gitGrepArgs = (): string[] => [
  'grep', '-n', '-I', '-i', '--no-color', '-E',
  ...SIGNALS.flatMap(signal => ['-e', signal.grep]),
  '--', '.', ...EXCLUDED_PATHS.map(path => `:(exclude,glob)${path.startsWith('**/') || path.includes('/') ? path : `**/${path}`}`),
]

/** The same search with plain `grep -r`, for a folder that is not a git repository. */
export const grepArgs = (): string[] => [
  'grep', '-r', '-n', '-I', '-i', '-E',
  ...['node_modules', 'vendor', 'dist', 'build', 'coverage', 'docs', 'test', 'tests', '__tests__', 'fixtures', '.git', '.claude', '.venv'].map(dir => `--exclude-dir=${dir}`),
  ...['*.lock', 'package-lock.json', 'pnpm-lock.yaml', '*.min.js', '*.map', '*.md', '*.test.*', '*.spec.*', '.env', '.env.*', '*.pem', '*.key'].map(glob => `--exclude=${glob}`),
  ...SIGNALS.flatMap(signal => ['-e', signal.grep]),
  '.',
]

/** `path:line:text` lines as hits, each matched against every signal's exact test; at most 40 hits per signal. */
export const classifyGrepOutput = (output: string): Hit[] => {
  const hits: Hit[] = []
  const perSignal = new Map<string, number>()
  for (const raw of output.split(/\r?\n/)) {
    const match = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(raw)
    if (match === null) continue
    const [, file = '', line = '0', content = ''] = match
    const shown = redactSecrets(content.trim())
    const text = shown.length > MAX_LINE ? `${shown.slice(0, MAX_LINE - 1)}…` : shown
    const items = DATA_ITEMS.filter(signal => signal.match.test(content))
    for (const signal of SIGNALS) {
      if (!signal.match.test(content)) continue
      if (signal.name === 'logs' && items.length === 0) continue
      const count = perSignal.get(signal.name) ?? 0
      if (count >= MAX_PER_SIGNAL) continue
      perSignal.set(signal.name, count + 1)
      hits.push({ signal: signal.name, kind: signal.kind, file, line: Number(line), text })
    }
  }
  return hits
}

export const countHits = (hits: readonly Hit[]): { hits: number; files: number; items: number; stores: number; thirdParties: number } => {
  const names = (kind: Hit['kind']) => new Set(hits.filter(hit => hit.kind === kind).map(hit => hit.signal)).size
  return { hits: hits.length, files: new Set(hits.map(hit => hit.file)).size, items: names('data'), stores: names('storage'), thirdParties: names('third-party') }
}

const KIND_TITLES: Record<Hit['kind'], string> = {
  data: 'Personal data in the code (where it is collected or modelled)',
  storage: 'Where data is stored',
  'third-party': 'Third parties it may be sent to',
}

/** The hits as compact evidence for the model, grouped by kind and signal, cut at `maxChars`. */
export const evidenceOf = (hits: readonly Hit[], maxChars = 40_000): string => {
  const sections: string[] = []
  for (const kind of ['data', 'storage', 'third-party'] as const) {
    const ofKind = hits.filter(hit => hit.kind === kind)
    if (ofKind.length === 0) continue
    sections.push(`## ${KIND_TITLES[kind]}`, ...ofKind.map(hit => `[${hit.signal}] ${hit.file}:${hit.line}: ${hit.text}`), '')
  }
  const text = sections.join('\n')
  return text.length > maxChars ? `${text.slice(0, text.lastIndexOf('\n', maxChars))}\n(…evidence cut)` : text
}

export const SYSTEM_PROMPT =
  'You are a privacy engineer helping a team start a GDPR record of processing from their source code. ' +
  'You are given lines found by a keyword scan, grouped as personal data, storage and third parties. Keyword hits can be false positives: ' +
  'ignore lines that are clearly not about people\'s data. Never invent files or services that are not in the evidence.'

export const buildPrompt = (project: string, evidence: string): string =>
  [
    `Project: ${project}`,
    '',
    evidence,
    '',
    'Write a Markdown table with exactly these columns: | Data item | Collected at | Stored in | Sent to | Legal basis hint |',
    '- One row per kind of personal data the evidence supports (merge synonyms: email and e-mail are one row).',
    '- "Collected at": up to three file:line references from the evidence, most telling first.',
    '- "Stored in" and "Sent to": the stores and third parties that plausibly receive that item, judged from the same files or obvious flows; write "unclear" when the evidence does not say.',
    '- "Legal basis hint": the likely GDPR Art. 6 basis (contract, consent, legitimate interests, legal obligation) and a few words of why.',
    'After the table, add "## Gaps to check" with at most five short bullets (consent for analytics or cookies, retention, data sent abroad, logs that may hold personal data).',
    'Answer with the table first and nothing before it.',
  ].join('\n')

/** The model's answer from its first table row on, with any code fence around it removed; undefined when it holds no table. */
export const extractTable = (reply: string): string | undefined => {
  const text = reply.replace(/^```(?:markdown|md)?\s*\n/m, '').replace(/\n```\s*$/m, '')
  const start = text.search(/^\|.*\|\s*$/m)
  return start === -1 ? undefined : text.slice(start).trim()
}

const BASIS = new Map(DATA_ITEMS.map(signal => [signal.name, signal.basis ?? 'unclear']))
const cell = (text: string): string => text.replace(/\|/g, '\\|')

/** The table built without the model: per data item its first references, and the stores and third parties in the same files. */
export const fallbackTable = (hits: readonly Hit[]): string => {
  const rows = DATA_ITEMS.filter(item => hits.some(hit => hit.signal === item.name)).map(item => {
    const ofItem = hits.filter(hit => hit.signal === item.name)
    const files = new Set(ofItem.map(hit => hit.file))
    const near = (kind: Hit['kind']) => [...new Set(hits.filter(hit => hit.kind === kind && files.has(hit.file)).map(hit => hit.signal))]
    const stores = near('storage')
    const parties = near('third-party')
    const refs = ofItem.slice(0, 3).map(hit => `${hit.file}:${hit.line}`)
    return `| ${item.name} | ${cell(refs.join(', '))} | ${stores.join(', ') || 'unclear'} | ${parties.join(', ') || 'unclear'} | ${cell(BASIS.get(item.name) ?? 'unclear')} |`
  })
  const parties = [...new Set(hits.filter(hit => hit.kind === 'third-party').map(hit => hit.signal))]
  return [
    '| Data item | Collected at | Stored in | Sent to | Legal basis hint |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Gaps to check',
    '- This table was built from keyword matches alone: confirm each row by reading the code.',
    ...(parties.length > 0 ? [`- Third parties found anywhere in the code: ${parties.join(', ')}. Check what each receives and where it is hosted.`] : []),
    '- Write down how long each item is kept, and where consent is asked for.',
  ].join('\n')
}

/** The docs/data-map.md document: the table, how it was made, and the raw evidence. */
export const documentOf = (project: string, date: string, markdown: string, hits: readonly Hit[], isFallback: boolean): string =>
  [
    `# Personal data map: ${project}`,
    '',
    `_Generated ${date} by the data-map mod from a keyword scan of the code (${hits.length} matches in ${new Set(hits.map(hit => hit.file)).size} files)` +
      `${isFallback ? ', organised without the model' : ''}. A head start for a GDPR record of processing, not legal advice: check every row._`,
    '',
    markdown,
    '',
    '## Evidence',
    '',
    ...hits.map(hit => `- \`${hit.file}:${hit.line}\` ${hit.signal}: \`${hit.text.replace(/`/g, "'")}\``),
    '',
  ].join('\n')
