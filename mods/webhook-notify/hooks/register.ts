import type { EngineInterface, PluginOptions, Register, TurnCompleteReason } from 'claude-code'

const MOD = 'webhook-notify'
const SUMMARY_CHARS = 200
const DEFAULT_MIN_SECONDS = 60
const TOOLS_SHOWN = 6
const GIT_TIMEOUT_MS = 2_000
const DISCORD_COLORS = { finished: 0x2eb67d, error: 0xe01e5a, refusal: 0xecb22e } as const
const NTFY_TAGS = { finished: 'white_check_mark', error: 'warning', refusal: 'no_entry' } as const
const KINDS = ['slack', 'discord', 'teams', 'ntfy', 'generic'] as const

type Kind = (typeof KINDS)[number]
type Outcome = keyof typeof DISCORD_COLORS
type Settings = { url: string; kind: Kind | 'auto'; minDurationMs: number }
type Report = {
  project: string
  branch: string | undefined
  outcome: Outcome
  durationMs: number
  summary: string
  tools: Readonly<Record<string, number>>
}
type Delivery = { url: string; headers: Record<string, string>; body: string }

function readSettings(options: PluginOptions): Settings {
  const url = typeof options.webhookUrl === 'string' ? options.webhookUrl.trim() : ''
  const kind = KINDS.find(one => one === options.kind) ?? 'auto'
  const seconds = typeof options.minDurationSec === 'number' ? options.minDurationSec : DEFAULT_MIN_SECONDS

  return { url, kind, minDurationMs: Math.max(0, seconds) * 1000 }
}

/** Picks the payload format from the webhook's host when the setting says `auto`. */
function detectKind(url: string, kind: Settings['kind']): Kind {
  if (kind !== 'auto') return kind
  const host = URL.canParse(url) ? new URL(url).hostname : ''
  if (host === 'hooks.slack.com') return 'slack'
  if (/(^|\.)discord(app)?\.com$/.test(host) && url.includes('/api/webhooks/')) return 'discord'
  if (/(^|\.)(webhook\.office\.com|logic\.azure\.com|powerplatform\.com|powerautomate\.com)$/.test(host)) return 'teams'
  if (host === 'ntfy.sh' || host.startsWith('ntfy.')) return 'ntfy'
  return 'generic'
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatTools(tools: Report['tools']): string {
  const ranked = Object.entries(tools).sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return 'no tools'
  const shown = ranked.slice(0, TOOLS_SHOWN).map(([tool, count]) => `${tool} ×${count}`)
  const rest = ranked.length - TOOLS_SHOWN

  return rest > 0 ? `${shown.join(' · ')} · +${rest} more` : shown.join(' · ')
}

/** The answer's opening, as plain text: whitespace folded, code fences dropped, cut at SUMMARY_CHARS. */
function summarize(answer: string): string {
  const plain = answer.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  if (!plain) return '(no text in the final answer)'

  return plain.length > SUMMARY_CHARS ? `${plain.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : plain
}

function outcomeOf(reason: TurnCompleteReason): Outcome {
  return reason === 'error' ? 'error' : reason === 'refusal' ? 'refusal' : 'finished'
}

function titleOf(report: Report): string {
  const where = report.branch ? `${report.project} (${report.branch})` : report.project
  if (report.outcome === 'error') return `⚠️ Claude stopped on an error in ${where}`
  if (report.outcome === 'refusal') return `⛔ Claude declined a task in ${where}`
  return `✅ Claude finished in ${where}`
}

const escapeSlack = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Builds the POST each service expects for `report`. */
function buildDelivery(url: string, kind: Kind, report: Report): Delivery {
  const json = { 'content-type': 'application/json' }
  const title = titleOf(report)
  const duration = formatDuration(report.durationMs)
  const tools = formatTools(report.tools)

  if (kind === 'slack') {
    const text = `*${escapeSlack(title)}* · ${duration}\n>${escapeSlack(report.summary)}\n_${escapeSlack(tools)}_`
    return { url, headers: json, body: JSON.stringify({ text }) }
  }
  if (kind === 'discord') {
    const embed = {
      title: title.slice(0, 256),
      description: report.summary,
      color: DISCORD_COLORS[report.outcome],
      fields: [
        { name: 'Duration', value: duration, inline: true },
        { name: 'Tools', value: tools.slice(0, 1024), inline: true },
      ],
    }
    return { url, headers: json, body: JSON.stringify({ username: 'Claude Code', embeds: [embed], allowed_mentions: { parse: [] } }) }
  }
  if (kind === 'teams') {
    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
        { type: 'TextBlock', text: report.summary, wrap: true },
        { type: 'FactSet', facts: [{ title: 'Duration', value: duration }, { title: 'Tools', value: tools }] },
      ],
    }
    const attachment = { contentType: 'application/vnd.microsoft.card.adaptive', content: card }
    return { url, headers: json, body: JSON.stringify({ type: 'message', attachments: [attachment] }) }
  }
  if (kind === 'ntfy') {
    // ntfy's JSON publishing: POST to the server root with the topic in the body, so titles keep their UTF-8.
    const target = new URL(url)
    const segments = target.pathname.split('/').filter(Boolean)
    const topic = segments.pop() ?? ''
    target.pathname = `/${segments.join('/')}`
    const message = `${report.summary}\n\n⏱ ${duration} · ${tools}`
    const body = { topic, title: title.replace(/^\S+\s/, ''), message, tags: [NTFY_TAGS[report.outcome]] }
    return { url: target.toString(), headers: json, body: JSON.stringify(body) }
  }
  const generic = {
    source: 'claude-code',
    event: 'turn.complete',
    title,
    project: report.project,
    branch: report.branch ?? null,
    outcome: report.outcome,
    durationMs: report.durationMs,
    duration,
    summary: report.summary,
    tools: report.tools,
  }
  return { url, headers: json, body: JSON.stringify(generic) }
}

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

async function projectOf($: EngineInterface): Promise<Pick<Report, 'project' | 'branch'>> {
  const repo = await $.session.repo().catch(() => null)
  const project = baseName(repo?.root ?? (await $.session.root()))
  if (repo === null) return { project, branch: undefined }
  try {
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
    const branch = head.exitCode === 0 ? head.stdout.trim() : ''
    return { project, branch: branch && branch !== 'HEAD' ? branch : undefined }
  } catch {
    return { project, branch: undefined }
  }
}

/** Posts the report; resolves a one-line outcome for the person. */
async function deliver($: EngineInterface, settings: Settings, report: Report): Promise<{ ok: boolean; line: string }> {
  const kind = detectKind(settings.url, settings.kind)
  try {
    const delivery = buildDelivery(settings.url, kind, report)
    const response = await $.http.fetch(delivery.url, { method: 'POST', headers: delivery.headers, body: delivery.body })
    const detail = response.ok ? `${response.status} OK` : `HTTP ${response.status} ${response.text.slice(0, 120).trim()}`.trim()
    return { ok: response.ok, line: `${kind} webhook answered ${detail}` }
  } catch (error) {
    return { ok: false, line: `${kind} webhook failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function notifyTurn($: EngineInterface, settings: Settings, partial: Omit<Report, 'project' | 'branch'>): Promise<void> {
  const sent = await deliver($, settings, { ...(await projectOf($)), ...partial })
  if (!sent.ok) $.ui.toast(`📭 ${MOD}: ${sent.line}`)
}

async function sendTest($: EngineInterface, settings: Settings): Promise<string> {
  if (!settings.url) {
    return `${MOD}: no webhook URL yet. Set the plugin's "webhookUrl" option (/plugin → webhook-notify), then run /notify-test again.`
  }
  if (!URL.canParse(settings.url) || !/^https?:$/.test(new URL(settings.url).protocol)) {
    return `${MOD}: "webhookUrl" is not an http(s) URL.`
  }
  const report: Report = {
    ...(await projectOf($)),
    outcome: 'finished',
    durationMs: 0,
    summary: `Test notification from ${MOD}: if you can read this, long tasks will be announced here.`,
    tools: {},
  }
  const sent = await deliver($, settings, report)

  return `${sent.ok ? '📬' : '📭'} ${MOD}: ${sent.line}`
}

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  let tools: Record<string, number> = {}

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'notify-test', description: 'Send a test message to your webhook-notify webhook' })

    return next(e)
  })

  on('command.run', { command: 'notify-test' }, async $ => ({ text: await sendTest($, settings) }))

  on('turn.start', ($, e, next) => {
    tools = {}

    return next(e)
  })

  on('tool.call', ($, e, next) => {
    tools[e.tool] = (tools[e.tool] ?? 0) + 1

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const isWorthSending =
      settings.url !== '' && e.agentId === undefined && e.reason !== 'aborted' && e.durationMs >= settings.minDurationMs

    if (isWorthSending) {
      const partial = { outcome: outcomeOf(e.reason), durationMs: e.durationMs, summary: summarize(e.answer), tools: { ...tools } }
      $.clock.after(0, () => void notifyTurn($, settings, partial))
    }

    return result
  })
}
