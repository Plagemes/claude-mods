export type Category = 'analytics' | 'advertising' | 'session-replay' | 'error-tracking'

export type Tracker = {
  /** The name used in messages and in the approved list. */
  id: string
  name: string
  category: Category
  /** Other words that name it in the approved list. */
  aliases?: readonly string[]
  /** Package names (npm and PyPI, lower case); an entry ending in `/` is a whole scope (`@segment/`). */
  packages?: readonly string[]
  /** Python module names, when they differ from the package. */
  imports?: readonly string[]
  /** Script and API URLs that load or feed it. */
  urls?: readonly RegExp[]
}

const host = (name: string): RegExp => new RegExp(`(?<![\\w-])${name.replace(/\./g, '\\.')}(?![\\w-])`, 'i')

export const TRACKERS: readonly Tracker[] = [
  {
    id: 'google-analytics', name: 'Google Analytics / Tag Manager', category: 'analytics',
    aliases: ['ga', 'ga4', 'gtag', 'gtm', 'google-tag-manager', 'googleanalytics'],
    packages: ['react-ga', 'react-ga4', 'ga-gtag', 'universal-analytics', 'vue-gtag', 'vue-gtag-next', 'react-gtm-module', '@gtm-support/vue-gtm', '@analytics/google-analytics', '@analytics/google-tag-manager', 'gatsby-plugin-google-gtag', 'gatsby-plugin-google-analytics', 'gatsby-plugin-google-tagmanager', 'angular-google-analytics', 'ngx-google-analytics', 'ga-4-react'],
    urls: [host('googletagmanager.com'), host('google-analytics.com'), host('analytics.google.com')],
  },
  {
    id: 'google-ads', name: 'Google Ads / DoubleClick', category: 'advertising', aliases: ['adsense', 'doubleclick'],
    urls: [host('googleadservices.com'), host('googlesyndication.com'), host('doubleclick.net')],
  },
  {
    id: 'segment', name: 'Segment', category: 'analytics', aliases: ['twilio-segment'],
    packages: ['@segment/', 'analytics-node', 'analytics-python', 'segment-analytics-python'],
    urls: [host('cdn.segment.com'), host('api.segment.io'), host('cdn.segment.io')],
  },
  {
    id: 'mixpanel', name: 'Mixpanel', category: 'analytics',
    packages: ['mixpanel', 'mixpanel-browser', '@mixpanel/'], imports: ['mixpanel'],
    urls: [host('cdn.mxpnl.com'), host('mixpanel.com')],
  },
  {
    id: 'amplitude', name: 'Amplitude', category: 'analytics',
    packages: ['amplitude-js', '@amplitude/', 'amplitude-analytics', 'amplitude'], imports: ['amplitude'],
    urls: [host('amplitude.com')],
  },
  {
    id: 'hotjar', name: 'Hotjar', category: 'session-replay',
    packages: ['@hotjar/browser', 'react-hotjar', 'vue-hotjar'],
    urls: [host('hotjar.com'), host('hotjar.io')],
  },
  {
    id: 'fullstory', name: 'FullStory', category: 'session-replay',
    packages: ['@fullstory/'], urls: [host('fullstory.com')],
  },
  {
    id: 'posthog', name: 'PostHog', category: 'analytics',
    packages: ['posthog', 'posthog-js', 'posthog-node', 'posthog-react-native', 'posthog-js-lite', '@posthog/'], imports: ['posthog'],
    urls: [host('posthog.com')],
  },
  {
    id: 'facebook-pixel', name: 'Facebook (Meta) Pixel', category: 'advertising', aliases: ['facebook', 'meta-pixel', 'fbq', 'meta'],
    packages: ['react-facebook-pixel', 'facebook-nodejs-business-sdk'],
    urls: [/(?<![\w-])connect\.facebook\.net\/[^"'\s)]*fbevents\.js/i, /(?<![\w-])facebook\.com\/tr[?/]/i],
  },
  {
    id: 'tiktok-pixel', name: 'TikTok Pixel', category: 'advertising', aliases: ['tiktok', 'ttq'],
    packages: ['tiktok-pixel', 'react-tiktok-pixel'], urls: [host('analytics.tiktok.com'), host('business-api.tiktok.com')],
  },
  {
    id: 'clarity', name: 'Microsoft Clarity', category: 'session-replay', aliases: ['ms-clarity', 'microsoft-clarity'],
    packages: ['@microsoft/clarity', 'clarity-js'], urls: [host('clarity.ms')],
  },
  {
    id: 'heap', name: 'Heap', category: 'analytics',
    packages: ['@heap/', 'heap-api'], urls: [host('heapanalytics.com')],
  },
  {
    id: 'hubspot-tracking', name: 'HubSpot tracking', category: 'analytics', aliases: ['hubspot'],
    urls: [host('js.hs-scripts.com'), host('js.hs-analytics.net'), host('js.usemessages.com')],
  },
  {
    id: 'linkedin-insight', name: 'LinkedIn Insight Tag', category: 'advertising', aliases: ['linkedin'],
    packages: ['react-linkedin-insight'], urls: [host('snap.licdn.com'), host('px.ads.linkedin.com')],
  },
  {
    id: 'twitter-pixel', name: 'X (Twitter) Pixel', category: 'advertising', aliases: ['twitter', 'x-pixel'],
    urls: [host('static.ads-twitter.com'), host('analytics.twitter.com')],
  },
  {
    id: 'pinterest-tag', name: 'Pinterest Tag', category: 'advertising', aliases: ['pinterest'],
    urls: [/(?<![\w-])s\.pinimg\.com\/ct\/core\.js/i, host('ct.pinterest.com')],
  },
  {
    id: 'snap-pixel', name: 'Snap Pixel', category: 'advertising', aliases: ['snapchat'], urls: [host('sc-static.net')],
  },
  {
    id: 'plausible', name: 'Plausible', category: 'analytics',
    packages: ['plausible-tracker', 'next-plausible', '@plausible-analytics/'], urls: [/(?<![\w-])plausible\.io\/js\//i],
  },
  { id: 'fathom', name: 'Fathom', category: 'analytics', packages: ['fathom-client'], urls: [host('cdn.usefathom.com')] },
  {
    id: 'matomo', name: 'Matomo', category: 'analytics', aliases: ['piwik'],
    packages: ['matomo-tracker', '@datapunt/matomo-tracker-js', '@jonkoops/matomo-tracker'],
    urls: [host('cdn.matomo.cloud'), /(?<![\w-])(?:matomo|piwik)\.(?:js|php)(?![\w-])/i],
  },
  {
    id: 'logrocket', name: 'LogRocket', category: 'session-replay',
    packages: ['logrocket', 'logrocket-react'], urls: [host('cdn.logrocket.io'), host('cdn.lr-ingest.io'), host('cdn.lr-in.com')],
  },
  { id: 'smartlook', name: 'Smartlook', category: 'session-replay', packages: ['smartlook-client'], urls: [host('smartlook.com')] },
  { id: 'mouseflow', name: 'Mouseflow', category: 'session-replay', urls: [host('cdn.mouseflow.com')] },
  { id: 'crazyegg', name: 'Crazy Egg', category: 'session-replay', urls: [host('script.crazyegg.com')] },
  {
    id: 'rudderstack', name: 'RudderStack', category: 'analytics',
    packages: ['@rudderstack/', 'rudder-sdk-js'], urls: [host('cdn.rudderlabs.com')],
  },
  {
    id: 'sentry', name: 'Sentry', category: 'error-tracking',
    packages: ['@sentry/', 'sentry-sdk', 'raven', 'raven-js'], imports: ['sentry_sdk'], urls: [host('sentry-cdn.com')],
  },
  { id: 'bugsnag', name: 'Bugsnag', category: 'error-tracking', packages: ['@bugsnag/', 'bugsnag'], imports: ['bugsnag'] },
  { id: 'rollbar', name: 'Rollbar', category: 'error-tracking', packages: ['rollbar'], imports: ['rollbar'], urls: [host('cdn.rollbar.com')] },
]

/** The tracker a package belongs to, by exact name or scope. */
export const trackerOfPackage = (name: string): Tracker | undefined => {
  const lower = name.toLowerCase()
  return TRACKERS.find(tracker => (tracker.packages ?? []).some(entry => (entry.endsWith('/') ? lower.startsWith(entry) : lower === entry)))
}

/** Does `approved` (lower-case words) cover this tracker, by name, alias, scope or one of its packages? */
export const isApproved = (tracker: Tracker, approved: ReadonlySet<string>): boolean =>
  approved.has(tracker.id) ||
  (tracker.aliases ?? []).some(alias => approved.has(alias)) ||
  (tracker.packages ?? []).some(entry => approved.has(entry.replace(/\/$/, ''))) ||
  [...approved].some(word => trackerOfPackage(word) === tracker)
