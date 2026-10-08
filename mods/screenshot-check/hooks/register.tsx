import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ScreenshotCheckCapture as Capture, ScreenshotCheckShot as Shot, ScreenshotCheckView as View } from '../types'
import { CAPTURE_SCRIPT, NOT_UI_PATH, UI_FILE, VIEWPORTS, captureNote, cellsFor, cliArgs, parseCapture, stampOf, thumbSvg } from './capture'
import type { ViewName } from './capture'
import { candidatePorts, pageUrl, portsFromPackage } from './server'

const PANE = 'screenshots'
const SHOTS_DIR = '.claude/screenshots'
const GITIGNORE = '# Screenshots taken by screenshot-check.\n*\n'
const PROBE_TIMEOUT_MS = 1500
const CAPTURE_TIMEOUT_MS = 120_000
const RM_TIMEOUT_MS = 10_000
const DEFAULT_DELAY_SECONDS = 5
const DEFAULT_KEEP = 10
const MAX_IMAGE_ROWS = 40
const SIDE_BY_SIDE_COLUMNS = 100
const EDIT_TOOLS = /^(?:Edit|MultiEdit|Write)$/
const REVIEW_ASK =
  'Look at both screenshots and review the page: layout, spacing, overflow, alignment, contrast, and anything broken at the mobile width. List what is wrong, then fix it.'

const view = atom({ plugin: 'screenshot-check', key: 'view' } as const, null)
const shown = atom({ plugin: 'screenshot-check', key: 'shown' } as const, 'both')

type Settings = { auto: boolean; delayMs: number; baseUrl: string; fullPage: boolean; keep: number }
/** This load's auto mode: the UI files edited since the last capture, and its timer. */
type Memory = { edited: Set<string>; timer: Timer | undefined; isBusy: boolean; firstEditAt: number }

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.exists(path).catch(() => false)
}

async function projectRoot($: EngineInterface): Promise<string> {
  return (await $.session.cwd()).replace(/[\\/]+$/, '')
}

/**
 * The first local dev server that answers, the project's own port first. A closed port refuses at once; one still
 * busy when the probe gives up is listening (Next.js and friends compile a page on its first request), so it counts
 * when no port answered in time.
 */
async function findDevServer($: EngineInterface, root: string): Promise<string | undefined> {
  const packageJson = await $.fs.read(`${root}/package.json`).catch(() => undefined)
  const ports = candidatePorts(portsFromPackage(typeof packageJson === 'string' ? packageJson : undefined))
  const givenUp = $.clock.sleep(PROBE_TIMEOUT_MS).then(() => 'busy' as const)
  const probe = (port: number) =>
    Promise.race([$.http.fetch(`http://localhost:${port}/`).then(() => 'up' as const, () => 'closed' as const), givenUp])
  const answers = await Promise.all(ports.map(probe))
  const index = answers.includes('up') ? answers.indexOf('up') : answers.indexOf('busy')
  return index === -1 ? undefined : `http://localhost:${ports[index]}/`
}

/** The page to capture: the argument against `baseUrl` or the running dev server. */
async function targetUrl($: EngineInterface, input: string, settings: Settings): Promise<string | undefined> {
  const text = input.trim()
  if (settings.baseUrl !== '') return pageUrl(text, settings.baseUrl)
  const needsServer = text === '' || text.startsWith('/')
  return pageUrl(text, needsServer ? await findDevServer($, await projectRoot($)) : undefined)
}

function failure(stderr: string, url: string): string {
  if (/Executable doesn't exist|playwright install/i.test(stderr)) return "Playwright's Chromium is not installed: run npx playwright install chromium"
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(stderr)) return `Nothing answers at ${url}: is the dev server running?`
  const line = stderr
    .split('\n')
    .map(text => text.trim())
    .find(text => text !== '' && !/^at\s|^=+$|^npm (?:warn|notice)/i.test(text))
  return line ?? 'The browser failed without saying why.'
}

/** Keeps the newest `keep` captures in the folder. */
async function rotate($: EngineInterface, dir: string, keep: number): Promise<void> {
  const files = (await $.fs.list(dir).catch(() => [])).map(entry => entry.name).filter(name => /\.png$/.test(name))
  const stamps = [...new Set(files.map(name => name.replace(/-(?:desktop|mobile)\.png$/, '')))].sort().reverse()
  const old = new Set(stamps.slice(keep))
  const doomed = files.filter(name => old.has(name.replace(/-(?:desktop|mobile)\.png$/, ''))).map(name => `${dir}/${name}`)
  if (doomed.length === 0) return
  await $.process.run(['rm', '-f', '--', ...doomed], { timeoutMs: RM_TIMEOUT_MS }).catch(() => undefined)
}

/** Shoots with the project's Playwright (errors and thumbnails), else `npx playwright screenshot` per view. */
async function shoot($: EngineInterface, root: string, dir: string, url: string, at: number, settings: Settings): Promise<Capture | string> {
  const stamp = stampOf(at)
  const hasPlaywright = (await exists($, `${root}/node_modules/playwright/package.json`)) || (await exists($, `${root}/node_modules/@playwright/test/package.json`))
  try {
    if (hasPlaywright) {
      const run = await $.process.run(['node', '-e', CAPTURE_SCRIPT, url, dir, stamp, settings.fullPage ? '1' : '0'], { cwd: root, timeoutMs: CAPTURE_TIMEOUT_MS })
      const parsed = run.exitCode === 0 ? parseCapture(run.stdout) : undefined
      return parsed === undefined ? failure(run.stderr, url) : { ...parsed, url, at, runner: 'project' }
    }
    const shots: Shot[] = []
    for (const name of ['desktop', 'mobile'] as ViewName[]) {
      const file = `${dir}/${stamp}-${name}.png`
      const run = await $.process.run(['npx', '--yes', 'playwright', ...cliArgs(url, file, name, settings.fullPage)], { cwd: root, timeoutMs: CAPTURE_TIMEOUT_MS })
      if (run.exitCode !== 0) return failure(`${run.stderr}\n${run.stdout}`, url)
      shots.push({ name, file, ...VIEWPORTS[name], thumb: null })
    }
    return { url, at, runner: 'cli', status: null, title: '', consoleErrors: [], pageErrors: [], shots }
  } catch (error) {
    const text = String(error)
    if (/ENOENT/.test(text)) return 'Node.js (node, npx) is not installed: screenshots need Playwright.'
    if (/still running/.test(text)) return `The browser did not finish within ${CAPTURE_TIMEOUT_MS / 1000} s.`
    return text
  }
}

/** Takes the screenshots and shows them; answers the capture or why it failed. */
async function capture($: EngineInterface, url: string, reason: string, settings: Settings): Promise<Capture | string> {
  const root = await projectRoot($)
  const dir = `${root}/${SHOTS_DIR}`
  const at = await $.clock.now()
  await update($, view, () => ({ phase: 'capturing' as const, url, reason, capture: null, error: null }))
  if (!(await exists($, `${dir}/.gitignore`))) await $.fs.write(`${dir}/.gitignore`, GITIGNORE)
  const result = await shoot($, root, dir, url, at, settings)
  if (typeof result === 'string') {
    await update($, view, () => ({ phase: 'error' as const, url, reason, capture: null, error: result }))
    return result
  }
  await update($, view, () => ({ phase: 'ready' as const, url, reason, capture: result, error: null }))
  await rotate($, dir, settings.keep)
  await publishShots($, result, reason)
  return result
}

// ── mods-hub: screenshots on the bus, builds that make a capture pointless ──────────────────────────

/** This mod's version, from its manifest, for the hub's list of who is on the bus. */
async function ownVersion($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Says hello to mods-hub when it is installed. */
async function greetHub($: EngineInterface): Promise<void> {
  if ((await hubMode($)) === undefined) return
  await hubHello($, { version: await ownVersion($), publishes: ['screenshot.taken'], consumes: ['build.result'] })
}

/** Each screenshot of a capture on the hub's bus as `screenshot.taken` (path, page, size, why it was taken). */
async function publishShots($: EngineInterface, taken: Capture, purpose: string): Promise<void> {
  for (const shot of taken.shots) {
    await hubPublish($, { topic: 'screenshot.taken', data: { path: shot.file, url: taken.url, width: shot.width, height: shot.height, purpose } })
  }
}

/** The tool of a build that failed after `since` (mods-hub's `build.result`): a capture now would show its error page. */
async function failedBuildSince($: EngineInterface, since: number): Promise<string | undefined> {
  try {
    const event = await $.mods.latest({ topic: 'build.result' })
    const data = event?.data as { outcome?: unknown; tool?: unknown } | undefined
    return event !== null && event.at >= since && data !== undefined && data.outcome !== 'passed' ? String(data.tool ?? 'the build') : undefined
  } catch {
    return undefined
  }
}

async function note($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (error) {
    $.ui.log(`screenshot-check: could not leave the note: ${String(error)}`, { to: 'debug' })
  }
}

/** After UI edits settle: capture the running dev server and leave Claude a note; silent when none runs. */
async function autoCapture($: EngineInterface, settings: Settings, memory: Memory): Promise<void> {
  if (memory.isBusy || memory.edited.size === 0) return
  const files = [...memory.edited].map(path => path.split(/[\\/]/).pop() ?? path)
  memory.edited.clear()
  memory.isBusy = true
  try {
    // With mods-hub: a build that failed since these edits (quick-commands, dev-server-pane...) leaves nothing worth a screenshot.
    const failed = await failedBuildSince($, memory.firstEditAt)
    if (failed !== undefined) {
      await hubNotify($, { level: 'info', title: `📸 No screenshots: ${failed} failed after your edits`, topic: 'build.result' })
      return
    }
    const url = await targetUrl($, '', settings)
    if (url === undefined) return
    const result = await capture($, url, `after your edits to ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` and ${files.length - 4} more` : ''}`, settings)
    if (typeof result === 'string') return
    await note($, captureNote(result, `After your edits to ${files.slice(0, 4).join(', ')}`))
    await hubNotify($, { level: 'info', title: `📸 Screenshots of ${url} updated`, topic: 'screenshot.taken' })
  } finally {
    memory.isBusy = false
  }
}

async function askReview($: EngineInterface): Promise<void> {
  const current = await read($, view)
  if (current?.capture === null || current?.capture === undefined) return
  await $.prompt.submit({ text: `${captureNote(current.capture, 'For review')}\n\n${REVIEW_ASK}` })
}

async function retake($: EngineInterface, settings: Settings): Promise<void> {
  const current = await read($, view)
  if (current === null || current.phase === 'capturing') return
  const result = await capture($, current.url, 'retaken', settings)
  if (typeof result !== 'string') await note($, captureNote(result, 'Retaken by the user'))
}

export const register: Register = (on, options) => {
  const delay = Number(options.delaySeconds)
  const keep = Number(options.keep)
  const settings: Settings = {
    auto: options.auto === true,
    delayMs: (delay > 0 ? delay : DEFAULT_DELAY_SECONDS) * 1000,
    baseUrl: typeof options.baseUrl === 'string' ? options.baseUrl.trim() : '',
    fullPage: options.fullPage === true,
    keep: Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP,
  }
  const memory: Memory = { edited: new Set(), timer: undefined, isBusy: false, firstEditAt: 0 }

  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'screenshot',
      description: 'Screenshot the page at desktop and mobile widths and show it to Claude',
      argumentHint: '[url or /path]',
    })
    afterStart($, 'screenshot-check', () => greetHub($))
    return next(e)
  })

  on('command.run', { command: 'screenshot' }, async ($, e) => {
    const url = await targetUrl($, e.args, settings)
    if (url === undefined) {
      return {
        text:
          e.args.trim() === '' || e.args.trim().startsWith('/')
            ? 'No dev server answers on the usual ports (5173, 3000, 4321, 8080 …). Start it, give a URL (/screenshot http://localhost:3000), or set baseUrl.'
            : `"${e.args.trim()}" is not an http(s) URL.`,
      }
    }
    await $.ui.open({ id: PANE, title: 'Screenshots' })
    const result = await capture($, url, 'on request', settings)
    if (typeof result === 'string') return { text: result }
    const root = await projectRoot($)
    const files = result.shots.map(shot => shot.file.replace(`${root}/`, '')).join(', ')
    return { text: `Captured ${url} at desktop and mobile widths: ${files}`, context: [captureNote(result, 'On the user\'s request')] }
  })

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (!settings.auto || ran.deny !== undefined || ran.isError === true || !UI_FILE.test(path) || NOT_UI_PATH.test(path)) return ran
    if (memory.edited.size === 0) memory.firstEditAt = await $.clock.now()
    memory.edited.add(path)
    memory.timer?.cancel()
    memory.timer = $.clock.after(settings.delayMs, () => {
      memory.timer = undefined
      void autoCapture($, settings, memory).catch(() => undefined)
    })
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Only the terminal opens image files; the others draw SVG, with the shot's thumbnail inside.
    const Image = 'Image' in elements && e.surface === 'terminal' ? elements.Image : undefined
    const Svg = 'Svg' in elements && e.surface !== 'terminal' ? elements.Svg : undefined
    const current = await read($, view)
    const which = await read($, shown)
    if (current === null) return <Text dimColor>Run /screenshot [url] to capture the page here.</Text>

    const header = (
      <Box key="title" flexDirection="row" justifyContent="space-between" gap={1}>
        <Text bold wrap="truncate-end">
          Screenshots · {current.url}
        </Text>
        {current.phase !== 'capturing' && <Button key="retake" label="Retake" hotkey="r" plain dimColor onPress={() => void retake($, settings)} />}
      </Box>
    )
    if (current.phase === 'capturing') {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text color="suggestion">Capturing at desktop and mobile widths…</Text>
        </Box>
      )
    }
    if (current.capture === null) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box key="error">
            <Text color="error">{current.error ?? 'The capture failed.'}</Text>
          </Box>
        </Box>
      )
    }

    const result = current.capture
    const shots = result.shots.filter(shot => which === 'both' || shot.name === which)
    const columns = e.props.bodyColumns
    const isSideBySide = which === 'both' && columns >= SIDE_BY_SIDE_COLUMNS
    const widthFor = (shot: Shot) => (isSideBySide ? Math.floor((shot.name === 'desktop' ? 0.68 : 0.28) * columns) : columns - 2)
    const errors = [...result.pageErrors, ...result.consoleErrors]
    const facts = [
      result.status === null ? null : `HTTP ${result.status}`,
      result.title === '' ? null : result.title,
      result.runner === 'cli' ? 'console not watched (no Playwright in the project)' : `${errors.length} error${errors.length === 1 ? '' : 's'} in the console`,
    ].filter(fact => fact !== null)

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box key="facts" flexDirection="column">
          <Text dimColor wrap="truncate-end">
            {facts.join(' · ')} · {current.reason}
          </Text>
          {errors.slice(0, 3).map((error, index) => (
            <Box key={`console:${index}`}>
              <Text color="error" wrap="truncate-end">
                ✗ {error}
              </Text>
            </Box>
          ))}
        </Box>
        <Box key="views" flexDirection="row" gap={2}>
          {(['both', 'desktop', 'mobile'] as const).map(name => (
            <Button
              key={`show:${name}`}
              label={name === 'both' ? 'Both' : `${name[0]?.toUpperCase()}${name.slice(1)} ${VIEWPORTS[name].width}px`}
              plain
              dimColor={which !== name}
              onPress={() => void update($, shown, () => name)}
            />
          ))}
        </Box>
        <Box key="shots" flexDirection={isSideBySide ? 'row' : 'column'} gap={2}>
          {shots.map(shot => {
            const cells = cellsFor(shot.width, shot.height, widthFor(shot), MAX_IMAGE_ROWS)
            const alt = `${shot.name} screenshot of ${result.url}`
            return (
              <Box key={`shot:${shot.name}`} flexDirection="column">
                <Text bold>
                  {shot.name === 'desktop' ? 'Desktop' : 'Mobile'} · {String(shot.width)}×{String(shot.height)}
                </Text>
                {Image !== undefined ? (
                  <Image key={`image:${shot.name}`} source={{ file: shot.file, format: 'png' }} columns={cells.columns} rows={cells.rows} alt={alt} />
                ) : Svg !== undefined && shot.thumb !== null ? (
                  <Svg source={thumbSvg(shot.thumb.base64, shot.thumb.width, shot.thumb.height)} alt={alt} width={shot.thumb.width} height={shot.thumb.height} />
                ) : null}
                <Text dimColor wrap="truncate-start">
                  {shot.file}
                </Text>
              </Box>
            )
          })}
        </Box>
        <Box key="actions" flexDirection="row" gap={2} flexWrap="wrap">
          <Button key="review" label="Ask Claude to review" hotkey="a" variant="primary" onPress={() => void askReview($)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
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
