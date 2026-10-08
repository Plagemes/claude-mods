import type { EngineInterface, PluginOptions, Register, TurnCompleteReason } from 'claude-code'

import { redactText } from './shared/secrets'

const MOD = 'webhook-notify'
const SUMMARY_CHARS = 200
const DEFAULT_MIN_SECONDS = 60
const TOOLS_SHOWN = 6
const GIT_TIMEOUT_MS = 2_000
const DISCORD_COLORS = { finished: 0x2eb67d, error: 0xe01e5a, refusal: 0xecb22e } as const
const NTFY_TAGS = { finished: 'white_check_mark', error: 'warning', refusal: 'no_entry' } as const
const KINDS = ['slack', 'discord', 'teams', 'ntfy', 'generic'] as const
const CHANNEL_ID = 'webhook'
/** How often the notices mods-hub queued for the `webhook` channel are collected. */
const DRAIN_MS = 5_000
const NOTICE_BODY_CHARS = 1_000
/** A notice the webhook refused this many collections in a row is given up, so it cannot hold back the ones behind it. */
const MAX_TRIES = 5
/** Ids of posted notices remembered for deduplication. */
const POSTED_KEEP = 200
const LEVEL_GLYPHS = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌', critical: '🚨' } as const
const LEVEL_COLORS = { info: 0x36c5f0, success: 0x2eb67d, warning: 0xecb22e, error: 0xe01e5a, critical: 0xe01e5a } as const
const LEVEL_NTFY_TAGS = { info: 'information_source', success: 'white_check_mark', warning: 'warning', error: 'x', critical: 'rotating_light' } as const
const LEVEL_NTFY_PRIORITY = { info: 3, success: 3, warning: 3, error: 4, critical: 5 } as const

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
/** A notification mods-hub queued for this channel. */
type Notice = Awaited<ReturnType<EngineInterface['mods']['drain']>>[number]
/**
 * The hub's notices on their way to the webhook: the collecting timer, the last notice handled (the next drain
 * acknowledges up to it), the ids already posted (a notice comes back until acknowledged), whether a collection is
 * running, how often the oldest waiting notice failed, and whether the last delivery to the webhook failed.
 */
type Courier = { timer?: { cancel: () => void }; cursor: string | null; posted: string[]; isBusy: boolean; failures: number; isFailing: boolean }

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
  // Masked first: the answer leaves the machine, and a cut must not leave half a secret behind.
  const plain = redactText(answer.replace(/```[\s\S]*?```/g, ' ')).text.replace(/\s+/g, ' ').trim()
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

/** ntfy's JSON publishing: POST to the server root with the topic in the body, so titles keep their UTF-8. */
function ntfyTarget(url: string): { root: string; topic: string } {
  const target = new URL(url)
  const segments = target.pathname.split('/').filter(Boolean)
  const topic = segments.pop() ?? ''
  target.pathname = `/${segments.join('/')}`
  return { root: target.toString(), topic }
}

/** Builds the POST each service expects for a notification mods-hub routed here. */
function buildNoticeDelivery(url: string, kind: Kind, notice: Notice): Delivery {
  const json = { 'content-type': 'application/json' }
  const title = `${LEVEL_GLYPHS[notice.level]} ${notice.title}`
  const body = redactText(notice.body ?? '').text.slice(0, NOTICE_BODY_CHARS)
  const link = notice.url !== undefined && URL.canParse(notice.url) ? notice.url : undefined

  if (kind === 'slack') {
    const text = `*${escapeSlack(title)}*${body === '' ? '' : `\n>${escapeSlack(body)}`}${link === undefined ? '' : `\n<${link}|Open>`}`
    return { url, headers: json, body: JSON.stringify({ text }) }
  }
  if (kind === 'discord') {
    const embed = { title: title.slice(0, 256), color: LEVEL_COLORS[notice.level], ...(body === '' ? {} : { description: body }), ...(link === undefined ? {} : { url: link }) }
    return { url, headers: json, body: JSON.stringify({ username: 'Claude Code', embeds: [embed], allowed_mentions: { parse: [] } }) }
  }
  if (kind === 'teams') {
    const blocks = [
      { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
      ...(body === '' ? [] : [{ type: 'TextBlock', text: body, wrap: true }]),
    ]
    const card = {
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: blocks,
      ...(link === undefined ? {} : { actions: [{ type: 'Action.OpenUrl', title: 'Open', url: link }] }),
    }
    const attachment = { contentType: 'application/vnd.microsoft.card.adaptive', content: card }
    return { url, headers: json, body: JSON.stringify({ type: 'message', attachments: [attachment] }) }
  }
  if (kind === 'ntfy') {
    const { root, topic } = ntfyTarget(url)
    const message = {
      topic,
      title: notice.title,
      message: body === '' ? notice.title : body,
      tags: [LEVEL_NTFY_TAGS[notice.level]],
      priority: LEVEL_NTFY_PRIORITY[notice.level],
      ...(link === undefined ? {} : { click: link }),
    }
    return { url: root, headers: json, body: JSON.stringify(message) }
  }
  const generic = { source: 'claude-code', event: 'notification', level: notice.level, title: notice.title, body: body === '' ? null : body, url: link ?? null, topic: notice.topic ?? null }
  return { url, headers: json, body: JSON.stringify(generic) }
}

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
    const { root, topic } = ntfyTarget(url)
    const message = `${report.summary}\n\n⏱ ${duration} · ${tools}`
    const body = { topic, title: title.replace(/^\S+\s/, ''), message, tags: [NTFY_TAGS[report.outcome]] }
    return { url: root, headers: json, body: JSON.stringify(body) }
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

/**
 * A webhook URL is a credential (Slack and Discord put the token in its path): an error text that echoes it, or its
 * root (ntfy), shows `[webhook]` instead. Applied to every line shown in a toast, the hub's channel list or /notify-test.
 */
function hideUrl(text: string, url: string): string {
  const secrets = [url, ...(URL.canParse(url) ? [new URL(url).pathname] : [])].filter(secret => secret.length > 1)
  return secrets.reduce((out, secret) => out.split(secret).join('[webhook]'), text)
}

/** Posts what `build` makes; resolves a one-line outcome for the person. */
async function post($: EngineInterface, kind: Kind, build: () => Delivery): Promise<{ ok: boolean; line: string }> {
  let url = ''
  try {
    const delivery = build()
    url = delivery.url
    const response = await $.http.fetch(delivery.url, { method: 'POST', headers: delivery.headers, body: delivery.body })
    const detail = response.ok ? `${response.status} OK` : `HTTP ${response.status} ${response.text.slice(0, 120).trim()}`.trim()
    return { ok: response.ok, line: hideUrl(`${kind} webhook answered ${detail}`, url) }
  } catch (error) {
    return { ok: false, line: hideUrl(`${kind} webhook failed: ${error instanceof Error ? error.message : String(error)}`, url) }
  }
}

/** Posts the report; resolves a one-line outcome for the person. */
function deliver($: EngineInterface, settings: Settings, report: Report): Promise<{ ok: boolean; line: string }> {
  const kind = detectKind(settings.url, settings.kind)
  return post($, kind, () => buildDelivery(settings.url, kind, report))
}

const isHttpUrl = (url: string): boolean => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)

/** Tells the hub's Channels list when deliveries start or stop failing; a no-op without the hub. */
async function reportStatus($: EngineInterface, courier: Courier, isFailing: boolean, line: string): Promise<void> {
  if (courier.isFailing === isFailing) return
  courier.isFailing = isFailing
  try {
    await $.mods.channelStatus({ id: CHANNEL_ID, status: isFailing ? 'error' : 'connected', ...(isFailing ? { detail: line } : {}) })
  } catch {
    // No hub, or this channel is not registered (no webhook URL).
  }
}

async function notifyTurn($: EngineInterface, settings: Settings, courier: Courier, partial: Omit<Report, 'project' | 'branch'>): Promise<void> {
  const sent = await deliver($, settings, { ...(await projectOf($)), ...partial })
  if (!sent.ok) $.ui.toast(`📭 ${MOD}: ${sent.line}`)
  await reportStatus($, courier, !sent.ok, sent.line)
}

/**
 * Posts what mods-hub queued for the webhook channel (a pull channel: the hub never calls this mod), at least once:
 * the cursor acknowledges only notices the webhook took (or gave up after MAX_TRIES refusals), so a notice whose post
 * failed, or that the process died on, comes back on the next collection; ids already posted are skipped. One
 * collection at a time.
 */
async function drain($: EngineInterface, settings: Settings, courier: Courier): Promise<void> {
  if (courier.isBusy) return
  courier.isBusy = true
  try {
    const kind = detectKind(settings.url, settings.kind)
    for (const notice of await $.mods.drain({ channel: CHANNEL_ID, after: courier.cursor })) {
      if (!courier.posted.includes(notice.id)) {
        const sent = await post($, kind, () => buildNoticeDelivery(settings.url, kind, notice))
        await reportStatus($, courier, !sent.ok, sent.line)
        if (!sent.ok) {
          courier.failures += 1
          if (courier.failures < MAX_TRIES) return
        }
        courier.posted = [...courier.posted, notice.id].slice(-POSTED_KEEP)
      }
      courier.failures = 0
      courier.cursor = notice.id
    }
  } catch {
    // The hub went away: the next tick finds out again.
  } finally {
    courier.isBusy = false
  }
}

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * With mods-hub installed: says hello, registers the `webhook` channel (for the team, or for you alone when the
 * webhook is an ntfy topic) and starts collecting what the hub queued for it. Without the hub nothing happens.
 */
async function connectHub($: EngineInterface, settings: Settings, courier: Courier): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: [], consumes: [] })
  const isConfigured = isHttpUrl(settings.url)
  const status = settings.url === '' ? 'unconfigured' : isConfigured ? 'connected' : 'error'
  try {
    await $.mods.registerChannel({
      id: CHANNEL_ID,
      title: 'Webhook',
      audience: detectKind(settings.url, settings.kind) === 'ntfy' ? 'me' : 'team',
      delivery: 'pull',
      status,
      ...(status === 'connected' ? {} : { detail: status === 'error' ? '"webhookUrl" is not an http(s) URL' : 'set the "webhookUrl" option' }),
    })
  } catch {
    return
  }
  courier.timer?.cancel()
  courier.timer = isConfigured ? $.clock.every(DRAIN_MS, () => void drain($, settings, courier)) : undefined
}

async function sendTest($: EngineInterface, settings: Settings): Promise<string> {
  if (!settings.url) {
    return `${MOD}: no webhook URL yet. Set the plugin's "webhookUrl" option (/plugin → webhook-notify), then run /notify-test again.`
  }
  if (!isHttpUrl(settings.url)) {
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
  const courier: Courier = { cursor: null, posted: [], isBusy: false, failures: 0, isFailing: false }
  let tools: Record<string, number> = {}

  on('session.start', async ($, e, next) => {
    await registerCommand($, { name: 'notify-test', description: 'Send a test message to your webhook-notify webhook' })
    // Waits until session.start has returned (afterStart): with every mod installed, waiting on the hub here ran
    // session.start past its 10 s budget.
    afterStart($, 'webhook-notify', () => connectHub($, settings, courier))

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
      $.clock.after(0, () => void notifyTurn($, settings, courier, partial))
    }

    return result
  })
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}

// #region @vendored shared/hub-client.ts sha256:6b153e2e759f: edit the source, then run `node scripts/sync-shared.mjs`.
// mods-hub client (docs/MOD_CONTRACT.md): uses the hub when it is installed, keeps working when it is not.

type HubMods = EngineInterface['mods']

/** Publishes an event on the hub's bus; false when there is no hub or it refused the event. */
async function hubPublish($: EngineInterface, input: Parameters<HubMods['publish']>[0]): Promise<boolean> {
  try {
    await $.mods.publish(input)
    return true
  } catch {
    return false
  }
}

/**
 * Routes a notification through the hub (channels, silent, night, presence), or shows it as a toast when there is
 * no hub: `title — body`, for `fallback.timeoutMs` when given (the toast's own option).
 */
async function hubNotify($: EngineInterface, input: Parameters<HubMods['notify']>[0], fallback: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await $.mods.notify(input)
  } catch {
    const text = input.body === undefined || input.body === '' ? input.title : `${input.title} — ${input.body}`
    if (fallback.timeoutMs === undefined) $.ui.toast(text)
    else $.ui.toast(text, { timeoutMs: fallback.timeoutMs })
  }
}

/** The global mode (presence, silent, night, interaction), or undefined when there is no hub. */
async function hubMode($: EngineInterface): Promise<Awaited<ReturnType<HubMods['mode']>> | undefined> {
  try {
    return await $.mods.mode()
  } catch {
    return undefined
  }
}

/** Announces this mod to the hub, with its panel tab when it has one; call once from `session.start`. */
async function hubHello($: EngineInterface, hello: Parameters<HubMods['hello']>[0], tab?: Parameters<HubMods['registerTab']>[0]): Promise<boolean> {
  try {
    await $.mods.hello(hello)
    if (tab !== undefined) await $.mods.registerTab(tab)
    return true
  } catch {
    return false
  }
}

/** Opens the shared panel on this mod's tab; false when there is no hub (open your own pane then). */
async function hubShowTab($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await $.mods.showTab({ id })).isPlaced
  } catch {
    return false
  }
}

/**
 * Stops, pauses or resumes the automatic work (`control.stop` / `control.pause` / `control.resume`) in this session
 * or, with `scope: 'all'`, in every session; false when there is no hub (stop what you run yourself then).
 */
async function hubStop($: EngineInterface, input: Parameters<HubMods['stop']>[0]): Promise<boolean> {
  try {
    await $.mods.stop(input)
    return true
  } catch {
    return false
  }
}

/** Puts a fact on the hub's blackboard as `<this mod>.<name>`; false when there is no hub or it refused the fact. */
async function hubShareFact($: EngineInterface, input: Parameters<HubMods['share']>[0]): Promise<boolean> {
  try {
    await $.mods.share(input)
    return true
  } catch {
    return false
  }
}

/** A fact from the hub's blackboard by its full key (`stack-detector.stack`); undefined when there is no hub or no such fact. */
async function hubReadFact($: EngineInterface, key: string): Promise<Awaited<ReturnType<HubMods['read']>> | undefined> {
  try {
    return (await $.mods.read({ key })) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether the shared panel shows tab `id` now; read while drawing, it subscribes the drawing. */
async function hubTabIs($: EngineInterface, id: string): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'mods-hub', key: 'tab' })
  return value === id
}
/**
 * Runs a mod's start-up work (the hub hello, a first scan, loading what it keeps) once `session.start` has returned,
 * after a short delay staggered by the mod's name (0.15–1.35 s), so ~200 mods sharing one hooks worker do not all wait
 * on the hub, a process or the disk inside the session.start chain (`ran past its 10s budget`). A failure is logged
 * to the debug log. Call it from `session.start` in place of `await work()`; never await the hub there
 * (scripts/check-startup.mjs).
 */
function afterStart($: EngineInterface, mod: string, work: () => Promise<unknown>): void {
  let hash = 7
  for (let i = 0; i < mod.length; i += 1) hash = (hash * 31 + mod.charCodeAt(i)) % 1_200
  $.clock.after(150 + hash, () => {
    void work().catch(error => $.ui.log(`${mod}: start-up work failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' }))
  })
}
// #endregion @vendored shared/hub-client.ts
