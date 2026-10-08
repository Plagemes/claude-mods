import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, Register, RenderSurface } from 'claude-code'

import type { HttpClientExchange, HttpClientHistoryEntry } from '../types'
import {
  asHistory,
  credentialProblem,
  formatBody,
  formatBytes,
  parseRequest,
  redactHeaders,
  redactRequest,
  statusLine,
  toCommandLine,
  toCurl,
  utf8Bytes,
} from './request'
import type { Request } from './request'
import { paneFailure } from './shared/render-safe'

const PANE = 'http'
const STORE_KEY = 'history'
const MAX_HISTORY = 20
const DEFAULT_TIMEOUT_S = 30
const MAX_TIMEOUT_S = 300
const MAX_KEPT_CHARS = 200_000
const MAX_SHOWN_CHARS = 60_000
const MAX_SENT_CHARS = 20_000
const MAX_STORED_BODY = 4_000
const USAGE = 'Usage: /http [METHOD] <url> [body] [-H "Name: value"]… [-d body]  ·  /http history  ·  /http history clear'

const exchangeAtom = atom({ plugin: 'http-client', key: 'exchange' } as const, null)
const viewAtom = atom({ plugin: 'http-client', key: 'view' } as const, 'response')
const headersAtom = atom({ plugin: 'http-client', key: 'showHeaders' } as const, false)
const historyAtom = atom({ plugin: 'http-client', key: 'history' } as const, [])

type Settings = { timeoutMs: number }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const statusColor = (status: number): string => (status < 300 ? 'success' : status < 400 ? 'suggestion' : status < 500 ? 'warning' : 'error')

const agoText = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

const contentTypeOf = (headers: Record<string, string>): string => (headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''

/** `GET https://x → 200 OK · 143 ms · 1.2 kB · application/json` */
const summary = (exchange: HttpClientExchange): string => {
  const head = `${exchange.request.method} ${redactRequest(exchange.request).request.url}`
  const { response } = exchange
  if (response === undefined) return `${head} → ${exchange.phase === 'failed' ? `failed: ${exchange.error ?? 'no response'}` : 'sending…'}`
  const type = contentTypeOf(response.headers)
  return `${head} → ${statusLine(response.status)} · ${response.ms} ms · ${formatBytes(response.bytes)}${type === '' ? '' : ` · ${type}`}`
}

/** What "Send to Claude" submits: the exchange with secrets masked and the body capped. */
const messageForClaude = (exchange: HttpClientExchange): string => {
  const { request, response } = exchange
  const shown = redactRequest(request).request
  const lines = [`I sent this request with /http: \`${shown.method} ${shown.url}\``]
  const requestHeaders = Object.entries(shown.headers)
  if (requestHeaders.length > 0) lines.push('', 'Request headers:', ...requestHeaders.map(([name, value]) => `- ${name}: ${value}`))
  if (shown.body !== undefined) lines.push('', 'Request body:', '```', shown.body.slice(0, MAX_SENT_CHARS), '```')
  if (response === undefined) {
    lines.push('', `It failed: ${exchange.error ?? 'no response'}.`)
  } else {
    lines.push('', `Response: ${statusLine(response.status)} in ${response.ms} ms, ${formatBytes(response.bytes)}.`, '', 'Response headers:')
    lines.push(...Object.entries(redactHeaders(response.headers)).map(([name, value]) => `- ${name}: ${value}`))
    const body = formatBody(response.text, response.headers['content-type'])
    if (body.kind === 'json' || body.kind === 'code' || body.kind === 'markdown') {
      const isCut = response.isCut || body.text.length > MAX_SENT_CHARS
      const fence = body.kind === 'json' ? 'json' : body.kind === 'markdown' ? 'markdown' : (body.language ?? '')
      lines.push('', `Response body${isCut ? ` (first ${MAX_SENT_CHARS} characters)` : ''}:`, `\`\`\`${fence}`, body.text.slice(0, MAX_SENT_CHARS), '```')
    } else {
      lines.push('', body.kind === 'empty' ? 'The body is empty.' : 'The body is binary (not included).')
    }
  }
  lines.push('', 'Keep this in mind for what we do next, and point out briefly anything that looks wrong.')
  return lines.join('\n')
}

/** `$.http.fetch` that rejects once `ms` pass without an answer. */
function fetchWithin($: EngineInterface, request: Request, ms: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)))
    $.http
      .fetch(request.url, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) })
      .then(
        response => {
          timer.cancel()
          resolve(response)
        },
        (error: unknown) => {
          timer.cancel()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
  })
}

async function loadHistory($: EngineInterface): Promise<HttpClientHistoryEntry[]> {
  try {
    return asHistory(await $.store.get(STORE_KEY), MAX_HISTORY)
  } catch {
    return []
  }
}

/** Puts the exchange at the top of the stored history, secrets masked and the body capped. */
async function remember($: EngineInterface, exchange: HttpClientExchange): Promise<void> {
  const { request: masked, isRedacted } = redactRequest(exchange.request)
  const body = masked.body === undefined ? {} : { body: masked.body.slice(0, MAX_STORED_BODY) }
  const entry: HttpClientHistoryEntry = {
    request: { method: masked.method, url: masked.url, headers: masked.headers, ...body },
    at: exchange.startedAt,
    ...(exchange.response === undefined ? {} : { status: exchange.response.status, ms: exchange.response.ms }),
    ...(exchange.error === undefined ? {} : { error: exchange.error }),
    isRedacted: isRedacted || (exchange.request.body?.length ?? 0) > MAX_STORED_BODY,
  }
  const history = [entry, ...(await loadHistory($))].slice(0, MAX_HISTORY)
  await update($, historyAtom, () => history)
  try {
    await $.store.set(STORE_KEY, history)
  } catch (error) {
    $.ui.log(`http-client: could not save the history: ${errorText(error)}`, { to: 'debug' })
  }
}

/** Sends a request, keeps the pane in step with it, and records it. */
async function send($: EngineInterface, settings: Settings, request: Request): Promise<HttpClientExchange> {
  const startedAt = await $.clock.now()
  const id = startedAt + Math.random()
  await update($, exchangeAtom, () => ({ id, request, phase: 'sending', startedAt }))
  await update($, viewAtom, () => 'response')
  let exchange: HttpClientExchange
  try {
    const response = await fetchWithin($, request, settings.timeoutMs)
    const isCut = response.text.length > MAX_KEPT_CHARS
    exchange = {
      id,
      request,
      phase: 'done',
      startedAt,
      response: {
        status: response.status,
        headers: response.headers,
        text: isCut ? response.text.slice(0, MAX_KEPT_CHARS) : response.text,
        bytes: utf8Bytes(response.text),
        ms: Math.max(0, Math.round((await $.clock.now()) - startedAt)),
        isCut,
      },
    }
  } catch (error) {
    exchange = { id, request, phase: 'failed', startedAt, error: errorText(error) }
  }
  await update($, exchangeAtom, current => (current?.id === id ? exchange : current))
  await remember($, exchange)
  return exchange
}

async function resend($: EngineInterface, settings: Settings, request: Request): Promise<void> {
  const problem = credentialProblem(request)
  if (problem !== undefined) {
    $.ui.toast(problem)
    return
  }
  const exchange = await send($, settings, request)
  $.ui.toast(summary(exchange))
}

async function copyCurl($: EngineInterface, request: Request, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: toCurl(request), surface })
  $.ui.toast(copied.isCopied ? 'curl command copied' : `Could not copy (${copied.reason})`)
}

async function sendToClaude($: EngineInterface, exchange: HttpClientExchange): Promise<void> {
  await $.prompt.submit({ text: messageForClaude(exchange), asUser: true })
}

async function editInPrompt($: EngineInterface, entry: HttpClientHistoryEntry): Promise<void> {
  const filled = await $.prompt.fill({ text: toCommandLine(entry.request) })
  $.ui.toast(filled.isFilled ? 'In your prompt: edit it and press Enter' : 'The prompt box is not available right now')
}

async function clearHistory($: EngineInterface): Promise<void> {
  await update($, historyAtom, () => [])
  await $.store.delete(STORE_KEY).catch(() => undefined)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'HTTP', focus: true, rows: 30 }).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    timeoutMs: Math.min(MAX_TIMEOUT_S, Math.max(1, Number(options.timeoutSeconds) || DEFAULT_TIMEOUT_S)) * 1000,
  }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'http',
      description: 'Send an HTTP request and see the formatted response in a pane',
      argumentHint: '[METHOD] <url> [body] [-H "K: V"] | history',
    })
    const history = await loadHistory($)
    if (history.length > 0) await update($, historyAtom, () => history)
    return next(e)
  })

  on('command.run', { command: 'http' }, async ($, e) => {
    const args = e.args.trim()
    if (args === '') {
      if ((await read($, exchangeAtom)) === null) await update($, viewAtom, () => 'history')
      await openPane($)
      return { text: USAGE }
    }
    const historyCommand = /^history(?:\s+(clear))?$/i.exec(args)
    if (historyCommand !== null) {
      if (historyCommand[1] !== undefined) {
        await clearHistory($)
        return { text: 'History cleared.' }
      }
      const history = await loadHistory($)
      await update($, historyAtom, () => history)
      await update($, viewAtom, () => 'history')
      await openPane($)
      return { text: history.length === 0 ? 'No requests yet.' : `${history.length} recent request${history.length === 1 ? '' : 's'}.` }
    }
    const parsed = parseRequest(args)
    if ('error' in parsed) return { text: `Could not read that: ${parsed.error}\n${USAGE}` }
    const problem = credentialProblem(parsed.request)
    if (problem !== undefined) return { text: problem }
    await openPane($)
    return { text: summary(await send($, settings, parsed.request)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Markdown } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const exchange = await read($, exchangeAtom)

    if (view === 'history' || exchange === null) {
      const history = await read($, historyAtom)
      const now = await $.clock.now()
      return (
        <Box flexDirection="column" gap={1}>
          <Box gap={1}>
            <Text bold>History</Text>
            <Text dimColor>{history.length === 0 ? 'no requests yet' : `last ${history.length}, newest first`}</Text>
          </Box>
          {history.length === 0 && <Text dimColor>{USAGE}</Text>}
          {history.map((entry, index) => (
            <Box key={`entry:${index}`} flexDirection="column">
              <Box gap={1}>
                <Text bold color="suggestion">{entry.request.method}</Text>
                <Text wrap="truncate-end">{entry.request.url}</Text>
              </Box>
              <Box gap={1}>
                {entry.status === undefined ? (
                  <Text color="error" wrap="truncate-end">{`failed: ${entry.error ?? 'no response'}`}</Text>
                ) : (
                  <Text color={statusColor(entry.status)}>{statusLine(entry.status)}</Text>
                )}
                <Text dimColor>{`${entry.ms === undefined ? '' : `${entry.ms} ms · `}${agoText(now - entry.at)}`}</Text>
                {!entry.isRedacted && (
                  <Button key={`send:${index}`} label="send" plain dimColor onPress={() => void resend($, settings, entry.request)} />
                )}
                <Button key={`edit:${index}`} label="edit" plain dimColor onPress={() => void editInPrompt($, entry)} />
              </Box>
            </Box>
          ))}
          <Box gap={1}>
            {exchange !== null && <Button key="back" label="Back to response" hotkey="b" onPress={() => void update($, viewAtom, () => 'response')} />}
            {history.length > 0 && <Button key="clear" label="Clear history" onPress={() => void clearHistory($)} />}
            <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      )
    }

    const { request, response } = exchange
    const showHeaders = await read($, headersAtom)
    const shownUrl = redactRequest(request).request.url
    const body = response === undefined ? undefined : formatBody(response.text, response.headers['content-type'])
    const headerRows = (headers: Record<string, string>) =>
      Object.entries(redactHeaders(headers)).map(([name, value]) => <Text wrap="truncate-end">{`${name}: ${value}`}</Text>)

    const bodyView = () => {
      if (response === undefined || body === undefined) return null
      if (body.kind === 'empty') return <Text dimColor>(empty body)</Text>
      if (body.kind === 'binary') return <Text dimColor>{`Binary body (${formatBytes(response.bytes)}), not shown.`}</Text>
      const isCut = response.isCut || body.text.length > MAX_SHOWN_CHARS
      const text = body.text.slice(0, MAX_SHOWN_CHARS)
      return (
        <Box flexDirection="column">
          {body.kind === 'markdown' ? <Markdown key="body" text={text} /> : <Code source={text} {...(body.language === undefined ? {} : { language: body.language })} />}
          {isCut && <Text dimColor>{`Showing the first ${MAX_SHOWN_CHARS / 1000}k characters of ${formatBytes(response.bytes)}.`}</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold color="suggestion">{request.method}</Text>
            <Text wrap="truncate-end">{shownUrl}</Text>
          </Box>
          {exchange.phase === 'sending' && <Text dimColor>Sending…</Text>}
          {exchange.phase === 'failed' && <Text color="error">{`Failed: ${exchange.error ?? 'no response'}`}</Text>}
          {response !== undefined && (
            <Box gap={1} flexWrap="wrap">
              <Text bold color={statusColor(response.status)}>{statusLine(response.status)}</Text>
              <Text dimColor>
                {`${response.ms} ms · ${formatBytes(response.bytes)}${contentTypeOf(response.headers) === '' ? '' : ` · ${contentTypeOf(response.headers)}`}`}
              </Text>
            </Box>
          )}
        </Box>
        <Box gap={1} flexWrap="wrap">
          {response !== undefined && (
            <Button
              key="headers"
              label={`${showHeaders ? '▾' : '▸'} Headers (${Object.keys(response.headers).length})`}
              hotkey="h"
              onPress={() => void update($, headersAtom, shown => !shown)}
            />
          )}
          <Button key="curl" label="Copy as curl" hotkey="c" onPress={press => void copyCurl($, request, press.surface)} />
          {exchange.phase !== 'sending' && (
            <Button key="claude" label="Send to Claude" hotkey="s" variant="primary" onPress={() => void sendToClaude($, exchange)} />
          )}
          {exchange.phase !== 'sending' && <Button key="repeat" label="Repeat" hotkey="r" onPress={() => void send($, settings, request)} />}
          <Button key="history" label="History" hotkey="y" onPress={() => void update($, viewAtom, () => 'history')} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        {showHeaders && response !== undefined && (
          <Box key="header-list" flexDirection="column">
            <Text bold dimColor>Request</Text>
            {headerRows(request.headers)}
            {Object.keys(request.headers).length === 0 && <Text dimColor>(no headers)</Text>}
            <Text bold dimColor>Response</Text>
            {headerRows(response.headers)}
          </Box>
        )}
        {bodyView()}
      </Box>
    )
  }).catch(async ($, e, next) =>
    next.error.kind === 're-entry'
      ? next(e)
      : paneFailure($.ui.resolve(e), { title: 'http-client', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }),
  )
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
