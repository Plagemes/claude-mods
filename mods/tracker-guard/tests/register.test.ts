import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { trackersAdded, trackersIn, trackersInstalledBy } from '../hooks/detect'
import { TRACKERS, isApproved, trackerOfPackage } from '../hooks/trackers'

/** The engine beneath the plugin: files on disk, and tool calls that run when nobody refuses them. */
const engine = (on: On, files: Record<string, string> = {}) => {
  const seen = { reached: 0 }
  on('tool.call', () => {
    seen.reached += 1
    return { result: 'ok' }
  })
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return seen
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const edit = ($: Engine, file_path: string, new_string: string, old_string = 'x') => $.tool.call({ tool: 'Edit', file_path, old_string, new_string })
const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const HTML_GA = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>'

test('denies installing a tracking package, naming it and how to approve it', async ($, on) => {
  const seen = engine(on)

  const result = await bash($, 'npm install mixpanel-browser')

  expect(seen.reached).toBe(0)
  expect(result.deny).toContain('tracker-guard: blocked. This install command adds Mixpanel (analytics), which is not on the approved list.')
  expect(result.deny).toContain('ask whether they want it')
  expect(result.deny).toContain('adding "mixpanel" to this mod\'s approved list or by writing TRACKER-OK')
})

test('catches the npm, pnpm, yarn, bun and pip families, and ignores everything else', async ($, on) => {
  const seen = engine(on)
  const blocked = ['pnpm add posthog-js', 'yarn add @segment/analytics-next', 'bun add @amplitude/analytics-browser', 'pip install mixpanel', 'python3 -m pip install posthog', 'uv add analytics-python', 'cd web && npm i react-ga4 && npm run build', 'npm install @hotjar/browser', 'npm i react-facebook-pixel']
  for (const command of blocked) expect((await bash($, command)).deny, command).toContain('tracker-guard')
  const fine = ['npm install react lodash', 'pip install requests', 'npm install -g mixpanel-cli-not-a-tracker', 'npm install', 'git commit -m "add mixpanel"', 'ls', 'echo posthog-js']
  for (const command of fine) expect((await bash($, command)).deny, command).toBeUndefined()
  expect(seen.reached).toBe(fine.length)
})

test('denies adding a tracker script to a page, by its URL', async ($, on) => {
  const seen = engine(on)

  const result = await edit($, '/repo/public/index.html', `<head>\n${HTML_GA}\n</head>`)

  expect(seen.reached).toBe(0)
  expect(result.deny).toContain('This edit to /repo/public/index.html adds Google Analytics / Tag Manager (analytics)')
  expect(result.deny).toContain('"google-analytics"')
})

test('denies the script URLs of the trackers it knows, in pages and in code', async ($, on) => {
  engine(on)
  const scripts: [string, string][] = [
    ['https://cdn.segment.com/analytics.js/v1/KEY/analytics.min.js', 'Segment'],
    ['https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js', 'Mixpanel'],
    ['https://cdn.amplitude.com/libs/analytics-browser-2.0.0-min.js.gz', 'Amplitude'],
    ['https://static.hotjar.com/c/hotjar-123.js?sv=6', 'Hotjar'],
    ['https://edge.fullstory.com/s/fs.js', 'FullStory'],
    ['https://us-assets.i.posthog.com/static/array.js', 'PostHog'],
    ['https://connect.facebook.net/en_US/fbevents.js', 'Facebook (Meta) Pixel'],
    ['https://analytics.tiktok.com/i18n/pixel/events.js', 'TikTok Pixel'],
    ['https://www.clarity.ms/tag/abc123', 'Microsoft Clarity'],
    ['https://cdn.heapanalytics.com/js/heap-1.js', 'Heap'],
    ['https://snap.licdn.com/li.lms-analytics/insight.min.js', 'LinkedIn Insight Tag'],
    ['https://plausible.io/js/script.js', 'Plausible'],
    ['https://cdn.usefathom.com/script.js', 'Fathom'],
    ['https://cdn.logrocket.io/LogRocket.min.js', 'LogRocket'],
    ['https://www.google-analytics.com/analytics.js', 'Google Analytics'],
    ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'Google Ads'],
  ]
  for (const [url, name] of scripts) {
    const result = await edit($, '/repo/src/App.tsx', `const s = document.createElement('script'); s.src = '${url}'`)
    expect(result.deny, url).toContain(name)
  }
})

test('denies tracker SDKs added to a manifest or imported in code', async ($, on) => {
  engine(on)

  expect((await edit($, '/repo/package.json', '  "dependencies": {\n    "react": "^18",\n    "mixpanel-browser": "^2.45.0"\n  }')).deny).toContain('Mixpanel')
  expect((await edit($, '/repo/requirements.txt', 'flask==3.0\nposthog>=3.0\n')).deny).toContain('PostHog')
  expect((await edit($, '/repo/pyproject.toml', '[tool.poetry.dependencies]\namplitude-analytics = "^1.0"')).deny).toContain('Amplitude')
  expect((await edit($, '/repo/pyproject.toml', 'dependencies = ["httpx", "mixpanel>=4"]')).deny).toContain('Mixpanel')
  expect((await edit($, '/repo/src/track.ts', "import mixpanel from 'mixpanel-browser'\nmixpanel.init('x')")).deny).toContain('Mixpanel')
  expect((await edit($, '/repo/src/track.js', "const { PostHog } = require('posthog-node')")).deny).toContain('PostHog')
  expect((await edit($, '/repo/src/track.ts', "const m = await import('@segment/analytics-next')")).deny).toContain('Segment')
  expect((await edit($, '/repo/track.py', 'import posthog\nposthog.capture("x")')).deny).toContain('PostHog')
  expect((await edit($, '/repo/track.py', 'from mixpanel import Mixpanel')).deny).toContain('Mixpanel')
})

test('a Write is judged against the file it replaces, so a tracker that was already there is not a new decision', async ($, on) => {
  const seen = engine(on, { '/repo/index.html': `<html>${HTML_GA}</html>` })

  const kept = await $.tool.call({ tool: 'Write', file_path: '/repo/index.html', content: `<html>${HTML_GA}<p>hello</p></html>` })
  const added = await $.tool.call({ tool: 'Write', file_path: '/repo/new.html', content: `<html>${HTML_GA}</html>` })

  expect(kept.deny).toBeUndefined()
  expect(added.deny).toContain('Google Analytics')
  expect(seen.reached).toBe(1)
})

test('docs and data files that merely mention a tracker are left alone', async ($, on) => {
  engine(on)

  for (const path of ['/repo/README.md', '/repo/docs/analytics.md', '/repo/notes.txt', '/repo/data.json', '/repo/yarn.lock', '/repo/package-lock.json']) {
    expect((await edit($, path, 'See https://posthog.com/docs and mixpanel-browser')).deny, path).toBeUndefined()
  }
})

test('error tracking such as Sentry is allowed unless the setting says otherwise', async ($, on) => {
  engine(on)

  expect((await bash($, 'npm install @sentry/node')).deny).toBeUndefined()
  expect((await bash($, 'pip install sentry-sdk bugsnag rollbar')).deny).toBeUndefined()
  expect((await edit($, '/repo/src/app.ts', "import * as Sentry from '@sentry/browser'")).deny).toBeUndefined()
})

test('with blockErrorTracking on, Sentry is treated like analytics', { options: { blockErrorTracking: true } }, async ($, on) => {
  engine(on)

  const result = await bash($, 'npm install @sentry/node')

  expect(result.deny).toContain('Sentry (error-tracking)')
})

test('approved trackers may be added: by name, alias or package', { options: { approved: 'PostHog, gtag, @segment/analytics-next' } }, async ($, on) => {
  const seen = engine(on)

  expect((await bash($, 'npm install posthog-js')).deny).toBeUndefined()
  expect((await edit($, '/repo/index.html', HTML_GA)).deny).toBeUndefined()
  expect((await bash($, 'npm install @segment/analytics-next')).deny).toBeUndefined()
  expect((await bash($, 'npm install mixpanel-browser')).deny).toContain('Mixpanel')
  expect(seen.reached).toBe(3)
})

test('the approval word in the latest prompt allows it for that prompt, and only a person can say it', async ($, on) => {
  engine(on)

  await say($, 'add mixpanel please, TRACKER-OK')
  expect((await bash($, 'npm install mixpanel-browser')).deny).toBeUndefined()
  expect((await edit($, '/repo/index.html', HTML_GA)).deny).toBeUndefined()

  await say($, 'thanks, now something else')
  expect((await bash($, 'npm install mixpanel-browser')).deny).toContain('tracker-guard')

  await $.prompt.submit({ text: 'TRACKER-OK', wait: false, origin: { kind: 'task-notification' } })
  expect((await bash($, 'npm install mixpanel-browser')).deny).toContain('tracker-guard')
})

test('the approval word is configurable and can be turned off', { options: { allowWord: '' } }, async ($, on) => {
  engine(on)

  await say($, 'TRACKER-OK')
  const result = await bash($, 'npm install mixpanel-browser')

  expect(result.deny).toContain('tracker-guard: blocked')
  expect(result.deny).not.toContain('TRACKER-OK')
})

test('detection helpers', () => {
  expect(trackersInstalledBy('npm i -g mixpanel-browser').map(t => t.id)).toEqual(['mixpanel'])
  expect(trackersInstalledBy('npm install ./mixpanel-browser').map(t => t.id)).toEqual([])
  expect(trackersInstalledBy('pip install -r requirements.txt').map(t => t.id)).toEqual([])
  expect(trackersInstalledBy('pip install "Mixpanel[extra]>=4" PostHog').map(t => t.id)).toEqual(['mixpanel', 'posthog'])
  expect(trackersIn('/r/index.html', 'no scripts here')).toEqual([])
  expect(trackersAdded('/r/a.html', HTML_GA, `${HTML_GA}\n<script src="https://static.hotjar.com/c/h.js"></script>`).map(t => t.id)).toEqual(['hotjar'])
  expect(trackerOfPackage('@Segment/Analytics-Next')?.id).toBe('segment')
  expect(trackerOfPackage('segment-not-really')).toBeUndefined()
  const mixpanel = TRACKERS.find(t => t.id === 'mixpanel')
  if (mixpanel === undefined) throw new Error('missing tracker')
  expect(isApproved(mixpanel, new Set(['mixpanel-browser']))).toBe(true)
  expect(isApproved(mixpanel, new Set(['posthog']))).toBe(false)
})

test('every tracker has a unique id, a name and some way to be recognised', () => {
  expect(new Set(TRACKERS.map(t => t.id)).size).toBe(TRACKERS.length)
  for (const tracker of TRACKERS) {
    expect(tracker.name.length, tracker.id).toBeGreaterThan(2)
    expect((tracker.packages ?? []).length + (tracker.urls ?? []).length, tracker.id).toBeGreaterThan(0)
  }
})

test('regression: options before the subcommand and pnpm -w do not hide an install', async ($, on) => {
  const seen = engine(on)
  const blocked = ['pnpm --filter web add posthog-js', 'pnpm -F web add posthog-js', 'pnpm add -w posthog-js', 'npm -w web install posthog-js', 'yarn workspace web add posthog-js']
  for (const command of blocked) expect((await bash($, command)).deny, command).toContain('tracker-guard: blocked')
  expect(seen.reached).toBe(0)

  for (const command of ['pnpm --filter web add react', 'pnpm -r build', 'yarn workspace web add zod']) expect((await bash($, command)).deny, command).toBeUndefined()
  expect(seen.reached).toBe(3)
})
