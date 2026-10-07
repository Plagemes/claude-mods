import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LighthouseRunResult as Result, LighthouseRunView as View } from '../types'
import { CATEGORY_IDS, CATEGORY_SHORT, band, deltaText, fixPrompt, gaugeSvg, parseReport } from './report'
import { candidatePorts, pageUrl, portsFromPackage } from './server'

const PANE = 'lighthouse'
const HISTORY_KEY = 'history'
const HISTORY_SIZE = 30
const PROBE_TIMEOUT_MS = 1500
const DEFAULT_TIMEOUT_SECONDS = 180
const MAX_TIMEOUT_SECONDS = 600
const LIGHTHOUSE_PACKAGE = 'lighthouse@12'
const SKIPPED_AUDITS = 'screenshot-thumbnails,final-screenshot,full-page-screenshot'
const CATEGORY_TITLE: Record<string, string> = { performance: 'Performance', accessibility: 'Accessibility', 'best-practices': 'Best practices', seo: 'SEO' }
const PLAYWRIGHT_CACHES = ['.cache/ms-playwright', 'Library/Caches/ms-playwright', 'AppData/Local/ms-playwright']
const CHROMIUM_BINARIES = ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe']

const view = atom({ plugin: 'lighthouse-run', key: 'view' } as const, null)

type FormFactor = 'mobile' | 'desktop'
type Settings = { formFactor: FormFactor; timeoutMs: number }
type History = Record<string, { scores: Record<string, number | null>; at: number }>

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => false)
}

async function projectRoot($: EngineInterface): Promise<string> {
  return (await $.session.cwd()).replace(/[\\/]+$/, '')
}

/** The first local dev server that answers, the project's own port first. */
async function findDevServer($: EngineInterface, root: string): Promise<string | undefined> {
  const packageJson = await $.fs.read(`${root}/package.json`).catch(() => undefined)
  const ports = candidatePorts(portsFromPackage(typeof packageJson === 'string' ? packageJson : undefined))
  const probe = async (port: number): Promise<boolean> => {
    try {
      await $.http.fetch(`http://localhost:${port}/`)
      return true
    } catch {
      return false
    }
  }
  const answers = await Promise.race([Promise.all(ports.map(probe)), $.clock.sleep(PROBE_TIMEOUT_MS).then(() => [] as boolean[])])
  const index = answers.indexOf(true)
  return index === -1 ? undefined : `http://localhost:${ports[index]}/`
}

/** A Chrome for Lighthouse: CHROME_PATH, else the newest Chromium Playwright downloaded, else Lighthouse's own search. */
async function findChrome($: EngineInterface): Promise<string | undefined> {
  const configured = (await $.env.get('CHROME_PATH').catch(() => undefined))?.trim()
  if (configured !== undefined && configured !== '') return configured
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? (await $.env.get('USERPROFILE').catch(() => undefined)) ?? ''
  const browsers = (await $.env.get('PLAYWRIGHT_BROWSERS_PATH').catch(() => undefined))?.trim()
  const roots = [...(browsers !== undefined && browsers !== '' && browsers !== '0' ? [browsers] : []), ...PLAYWRIGHT_CACHES.map(cache => `${home}/${cache}`)]
  for (const root of roots) {
    const entries = await $.fs.list(root).catch(() => [])
    const builds = entries
      .map(entry => entry.name)
      .filter(name => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const build of builds) {
      for (const binary of CHROMIUM_BINARIES) {
        if (await exists($, `${root}/${build}/${binary}`)) return `${root}/${build}/${binary}`
      }
    }
  }
  return undefined
}

/** Plain words for the ways a run fails. */
function failure(stderr: string, url: string): string {
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|FAILED_DOCUMENT_REQUEST/i.test(stderr)) return `Nothing answers at ${url}: is the server running?`
  if (/No Chrome installations found|debugging port|Unable to connect to Chrome|CHROME_PATH/i.test(stderr)) {
    return 'Chrome could not start. Set CHROME_PATH, or install a browser with: npx playwright install chromium'
  }
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^at\s|^npm (?:warn|notice)/i.test(line))
  return lines.at(-1) ?? 'Lighthouse failed without saying why.'
}

/** Runs Lighthouse and puts the result, with the change since the last run on the same page, in the pane. */
async function audit($: EngineInterface, url: string, formFactor: FormFactor, settings: Settings): Promise<void> {
  const root = await projectRoot($)
  const startedAt = await $.clock.now()
  await update($, view, () => ({ phase: 'running' as const, url, formFactor, startedAt, result: null, previous: null, previousAt: null, error: null }))
  const local = `${root}/node_modules/.bin/lighthouse`
  const command = (await exists($, local)) ? [local] : ['npx', '--yes', LIGHTHOUSE_PACKAGE]
  const chrome = await findChrome($)
  // Chrome refuses to run as root (containers, CI) unless sandboxing is off.
  const isRoot = (await $.env.get('USER').catch(() => undefined)) === 'root' || (await $.env.get('HOME').catch(() => undefined)) === '/root'
  const argv = [
    ...command,
    url,
    '--output=json',
    '--output-path=stdout',
    '--quiet',
    `--chrome-flags=--headless=new${isRoot ? ' --no-sandbox' : ''}`,
    `--only-categories=${CATEGORY_IDS.join(',')}`,
    `--skip-audits=${SKIPPED_AUDITS}`,
    ...(formFactor === 'desktop' ? ['--preset=desktop'] : []),
  ]

  let outcome: Result | { error: string }
  try {
    const run = await $.process.run(argv, { cwd: root, timeoutMs: settings.timeoutMs, env: chrome === undefined ? {} : { CHROME_PATH: chrome } })
    outcome =
      run.exitCode !== 0 ? { error: failure(run.stderr, url) } : run.isStdoutTruncated ? { error: 'The report was larger than 4 MiB and was cut off.' } : parseReport(run.stdout)
  } catch (error) {
    const text = String(error)
    outcome = {
      error: /ENOENT/.test(text)
        ? 'npx is not installed: Lighthouse needs Node.js.'
        : /still running/.test(text)
          ? `Lighthouse did not finish within ${settings.timeoutMs / 1000} s.`
          : text,
    }
  }
  if ('error' in outcome) {
    const error = outcome.error
    await update($, view, (latest: View | null) => (latest?.startedAt === startedAt ? { ...latest, phase: 'error' as const, error } : latest))
    $.ui.toast(`Lighthouse failed: ${error}`)
    return
  }

  const result = outcome
  const history = ((await $.store.get(HISTORY_KEY).catch(() => undefined)) ?? {}) as History
  const key = `${formFactor} ${result.url}`
  const before = history[key]
  const kept = Object.entries({ ...history, [key]: { scores: result.scores, at: startedAt } })
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, HISTORY_SIZE)
  await $.store.set(HISTORY_KEY, Object.fromEntries(kept)).catch(() => undefined)
  await update($, view, (latest: View | null) =>
    latest?.startedAt === startedAt ? { ...latest, phase: 'ready' as const, result, previous: before?.scores ?? null, previousAt: before?.at ?? null } : latest,
  )
  $.ui.toast(`Lighthouse ${formFactor}: ${CATEGORY_IDS.map(id => `${CATEGORY_SHORT[id]} ${result.scores[id] ?? '?'}`).join(' · ')}`)
}

/** `/lighthouse [url] [mobile|desktop]`: resolves the page, opens the pane and starts the run. */
async function start($: EngineInterface, args: string, settings: Settings): Promise<string> {
  const current = await read($, view)
  if (current?.phase === 'running') return `Lighthouse is already running on ${current.url}.`
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const formFactor: FormFactor = words.includes('desktop') ? 'desktop' : words.includes('mobile') ? 'mobile' : settings.formFactor
  const target = words.filter(word => word !== 'desktop' && word !== 'mobile').join('')
  const needsServer = target === '' || target.startsWith('/')
  const devServer = needsServer ? await findDevServer($, await projectRoot($)) : undefined
  const url = pageUrl(target, devServer)
  if (url === undefined) {
    return needsServer
      ? 'No dev server answers on the usual ports (5173, 3000, 4321, 8080 …). Start it, or give a URL: /lighthouse http://localhost:3000'
      : `"${target}" is not an http(s) URL.`
  }
  await $.ui.open({ id: PANE, title: 'Lighthouse' })
  $.clock.after(0, () => void audit($, url, formFactor, settings).catch(() => undefined))
  return `Running Lighthouse (${formFactor}) on ${url}: scores appear in the Lighthouse pane in 20–60 s.`
}

async function askClaude($: EngineInterface): Promise<void> {
  const current = await read($, view)
  if (current?.result === null || current?.result === undefined || current.result.audits.length === 0) return
  await $.prompt.submit({ text: fixPrompt(current.result) })
  $.ui.toast('Sent the top issues to Claude')
}

export const register: Register = (on, options) => {
  const seconds = Number(options.timeoutSeconds)
  const settings: Settings = {
    formFactor: options.formFactor === 'desktop' ? 'desktop' : 'mobile',
    timeoutMs: Math.min(seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lighthouse',
      description: 'Run Lighthouse on a page and show performance, a11y, SEO and best-practice scores',
      argumentHint: '[url or /path] [mobile|desktop]',
    })
    return next(e)
  })

  on('command.run', { command: 'lighthouse' }, async ($, e) => ({ text: await start($, e.args, settings) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Every table carries an Svg at run time, but the terminal draws it as an empty box: ask the surface.
    const Svg = 'Svg' in elements && e.surface !== 'terminal' ? elements.Svg : undefined
    const current = await read($, view)
    if (current === null) return <Text dimColor>Run /lighthouse [url] [mobile|desktop] to audit a page.</Text>
    const other: FormFactor = current.formFactor === 'mobile' ? 'desktop' : 'mobile'
    const header = (
      <Box key="title" flexDirection="row" justifyContent="space-between" gap={1}>
        <Text bold wrap="truncate-end">
          Lighthouse · {current.url} · {current.formFactor}
        </Text>
        {current.phase !== 'running' && (
          <Button key="rerun" label="Re-run" hotkey="r" plain dimColor onPress={() => void audit($, current.url, current.formFactor, settings)} />
        )}
      </Box>
    )
    if (current.phase === 'running') {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text color="suggestion">Auditing the page in headless Chrome… this takes 20–60 s (longer the first time npx fetches Lighthouse).</Text>
        </Box>
      )
    }
    if (current.phase === 'error' || current.result === null) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box key="error">
            <Text color="error">{current.error ?? 'Lighthouse failed.'}</Text>
          </Box>
        </Box>
      )
    }

    const result = current.result
    const tiles = CATEGORY_IDS.map(id => {
      const score = result.scores[id] ?? null
      const delta = current.previous === null ? 'first run' : deltaText(score, current.previous[id])
      const deltaColor = delta.startsWith('+') ? 'success' : delta.startsWith('−') ? 'error' : undefined
      return (
        <Box key={`score:${id}`} flexDirection="column" alignItems="center" width={Svg === undefined ? 13 : undefined}>
          {Svg !== undefined ? (
            <Svg source={gaugeSvg(score, CATEGORY_TITLE[id] ?? id)} alt={`${CATEGORY_TITLE[id] ?? id}: ${score ?? 'no score'}`} width={96} height={112} />
          ) : (
            <Box borderStyle="round" borderColor={band(score)} width={11} justifyContent="center" flexDirection="column" alignItems="center">
              <Text bold color={band(score)}>
                {String(score ?? '?')}
              </Text>
              <Text dimColor>{CATEGORY_SHORT[id] ?? id}</Text>
            </Box>
          )}
          <Text color={deltaColor} dimColor={deltaColor === undefined}>
            {delta}
          </Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box key="scores" flexDirection="row" flexWrap="wrap" gap={1}>
          {tiles}
        </Box>
        {result.metrics.length > 0 && (
          <Box key="metrics" flexDirection="row" flexWrap="wrap" columnGap={2}>
            {result.metrics.map(metric => (
              <Text>
                <Text dimColor>{metric.label} </Text>
                <Text color={band(metric.score === null ? null : Math.round(metric.score * 100))}>{metric.value}</Text>
              </Text>
            ))}
          </Box>
        )}
        <Box key="audits" flexDirection="column">
          <Text bold>{result.audits.length === 0 ? '✓ No failing audits worth fixing' : 'Top issues'}</Text>
          {result.audits.map((item, index) => (
            <Box key={`audit:${item.id}`} flexDirection="column" paddingLeft={1}>
              <Text>
                <Text dimColor>{`${index + 1}. `}</Text>
                <Text>{item.title.replace(/`/g, '')}</Text>
                {item.displayValue !== null && <Text color="warning"> · {item.displayValue}</Text>}
                {item.savingsMs !== null && <Text color="warning"> · ~{(item.savingsMs / 1000).toFixed(1)} s</Text>}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'   '}
                {CATEGORY_TITLE[item.category] ?? item.category}
                {item.items.length > 0 ? ` · ${item.items[0]}${item.items.length > 1 ? ` +${item.items.length - 1}` : ''}` : ''}
              </Text>
            </Box>
          ))}
        </Box>
        {result.warnings.length > 0 && (
          <Box key="warnings">
            <Text color="warning" wrap="truncate-end">
              ⚠ {result.warnings[0]}
            </Text>
          </Box>
        )}
        <Box key="actions" flexDirection="row" gap={2} flexWrap="wrap">
          {result.audits.length > 0 && (
            <Button key="ask" label="Ask Claude to fix top issues" hotkey="a" variant="primary" onPress={() => void askClaude($)} />
          )}
          <Button key="other" label={`Run ${other}`} hotkey="m" onPress={() => void audit($, current.url, other, settings)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
        <Text dimColor>
          Lighthouse {result.version}
          {current.previousAt === null ? '' : ' · changes since the last run of this page'}
        </Text>
      </Box>
    )
  })
}
