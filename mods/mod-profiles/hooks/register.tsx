import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, Register } from 'claude-code'

import type { ModProfile, ModProfilesCurrent, ModProfilesNotice } from '../types'
import { argv, claudeBinary, parseOutcome } from './cli'
import {
  MAX_PROFILES,
  ago,
  changeLabel,
  matches,
  names,
  nameOf,
  parseInstalled,
  parseRequest,
  planFor,
  plural,
  profileNameProblem,
  profileOf,
  readProfiles,
} from './profiles'
import type { Plan } from './profiles'

type Dollar = EngineInterface
/** The userConfig values this load runs with. */
type Settings = { shouldReload: boolean }

const PANE = 'mod-profiles'
const PANE_TITLE = 'Mod Profiles'
const PANE_ROWS = 18
const COMMAND = 'profile-mods'
const ARGUMENT_HINT = '[save|use|delete <name> | list]'
const PROFILES_KEY = 'profiles'
const ACTIVE_KEY = 'active'
const LIST_TIMEOUT_MS = 30_000
const CHANGE_TIMEOUT_MS = 60_000
const USE_HOTKEYS = '123456789'
const TONE_COLOR: Record<ModProfilesNotice['tone'], string> = { success: 'success', error: 'error', info: 'suggestion' }
const TONE_GLYPH: Record<ModProfilesNotice['tone'], string> = { success: '✓', error: '✗', info: '•' }

const profilesState = atom({ plugin: 'mod-profiles', key: 'profiles' } as const, {})
const activeState = atom({ plugin: 'mod-profiles', key: 'active' } as const, null)
const currentState = atom({ plugin: 'mod-profiles', key: 'current' } as const, null)
const viewState = atom({ plugin: 'mod-profiles', key: 'view' } as const, { selected: null, confirming: null })
const busyState = atom({ plugin: 'mod-profiles', key: 'busy' } as const, null)
const noticeState = atom({ plugin: 'mod-profiles', key: 'notice' } as const, null)

/** The action in flight: one at a time, since each rewrites the plugin settings. */
const running: { action: string | null } = { action: null }

const describe = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^[\w-]+: \$\.[\w.]+: /, '')
const success = (text: string): ModProfilesNotice => ({ tone: 'success', text })
const failure = (text: string): ModProfilesNotice => ({ tone: 'error', text })
const info = (text: string): ModProfilesNotice => ({ tone: 'info', text })
const said = (notice: ModProfilesNotice): string => `${TONE_GLYPH[notice.tone]} ${notice.text}`

async function claudeBin($: Dollar): Promise<string> {
  try {
    return claudeBinary(await $.env.get('CLAUDE_CODE_EXECPATH'))
  } catch {
    return claudeBinary(undefined)
  }
}

/** Lists the installed plugins for the pane and the actions; never rejects. */
async function listPlugins($: Dollar): Promise<ModProfilesCurrent> {
  let current: ModProfilesCurrent
  try {
    const listed = await $.process.run(argv.list(await claudeBin($)), { timeoutMs: LIST_TIMEOUT_MS })
    if (listed.exitCode !== 0) throw new Error(parseOutcome(listed).message)
    current = { isKnown: true, plugins: parseInstalled(listed.stdout), listedAt: await $.clock.now() }
  } catch (error) {
    current = { isKnown: false, error: describe(error) }
  }
  await update($, currentState, () => current)

  return current
}

/** The saved profiles and the active one, from $.store into the pane's state. */
async function loadProfiles($: Dollar): Promise<Record<string, ModProfile>> {
  const profiles = readProfiles(await $.store.get(PROFILES_KEY))
  const active = await $.store.get(ACTIVE_KEY)
  await update($, profilesState, () => profiles)
  await update($, activeState, () => (typeof active === 'string' && profiles[active] !== undefined ? active : null))

  return profiles
}

async function storeProfiles($: Dollar, profiles: Record<string, ModProfile>, active: string | null): Promise<void> {
  await $.store.set(PROFILES_KEY, profiles)
  if (active === null) await $.store.delete(ACTIVE_KEY)
  else await $.store.set(ACTIVE_KEY, active)
  await update($, profilesState, () => profiles)
  await update($, activeState, () => active)
}

async function saveProfile($: Dollar, name: string): Promise<ModProfilesNotice> {
  const problem = profileNameProblem(name)
  if (problem !== undefined) return failure(problem)
  const profiles = await loadProfiles($)
  const isNew = profiles[name] === undefined
  if (isNew && Object.keys(profiles).length >= MAX_PROFILES) return failure(`You have ${MAX_PROFILES} profiles already: delete one first.`)
  const current = await listPlugins($)
  if (!current.isKnown) return failure(`Could not list your plugins: ${current.error}`)

  const profile = profileOf(current.plugins, await $.clock.now())
  await storeProfiles($, { ...profiles, [name]: profile }, name)
  const off = profile.disabled.length === 0
    ? ''
    : ` (${plural(profile.disabled.length, 'disabled plugin')} ${profile.disabled.length === 1 ? 'stays' : 'stay'} off when you use it)`

  return success(`${isNew ? 'Saved' : 'Updated'} profile ${name}: ${plural(profile.enabled.length, 'enabled plugin')}${off}.`)
}

async function reloadPlugins($: Dollar): Promise<void> {
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    $.ui.toast('Run /reload-plugins to apply the profile')
  }
}

async function applyPlan($: Dollar, plan: Plan): Promise<{ done: string[]; failed: string[] }> {
  const bin = await claudeBin($)
  const done: string[] = []
  const failed: string[] = []
  const changes = [...plan.enable.map(change => ({ ...change, action: 'enable' as const })), ...plan.disable.map(change => ({ ...change, action: 'disable' as const }))]
  for (const change of changes) {
    try {
      const outcome = parseOutcome(await $.process.run(argv[change.action](bin, change.id, change.scope), { timeoutMs: CHANGE_TIMEOUT_MS }))
      if (outcome.isOk) done.push(change.id)
      else failed.push(`${change.action} ${nameOf(change.id)} (${outcome.message})`)
    } catch (error) {
      failed.push(`${change.action} ${nameOf(change.id)} (${describe(error)})`)
    }
  }

  return { done, failed }
}

async function useProfile($: Dollar, settings: Settings, name: string): Promise<ModProfilesNotice> {
  const profiles = await loadProfiles($)
  const profile = profiles[name]
  if (profile === undefined) {
    const saved = Object.keys(profiles).sort()
    return failure(`There is no profile named ${name}.${saved.length === 0 ? ` Save one with /${COMMAND} save ${name}.` : ` Saved: ${saved.join(', ')}.`}`)
  }
  const current = await listPlugins($)
  if (!current.isKnown) return failure(`Could not list your plugins: ${current.error}`)

  const plan = planFor(profile, current.plugins)
  const missing = plan.missing.length === 0 ? '' : ` Not installed, so left out: ${names(plan.missing)}.`
  if (matches(plan)) {
    await storeProfiles($, profiles, name)
    return info(`Profile ${name} already matches your plugins.${missing}`)
  }

  const { done, failed } = await applyPlan($, plan)
  await storeProfiles($, profiles, name)
  await listPlugins($)
  const enabled = plan.enable.filter(change => done.includes(change.id)).map(change => change.id)
  const disabled = plan.disable.filter(change => done.includes(change.id)).map(change => change.id)
  if (done.length === 0) return failure(`Could not switch to ${name}: ${failed.join('; ')}.`)

  if (settings.shouldReload) $.clock.after(0, () => void reloadPlugins($))
  const changed = [enabled.length > 0 ? `enabled ${names(enabled)}` : '', disabled.length > 0 ? `disabled ${names(disabled)}` : '']
    .filter(part => part !== '')
    .join('; ')
  const failures = failed.length === 0 ? '' : ` Could not ${failed.join('; ')}.`
  const reload = settings.shouldReload ? ' Reloading plugins…' : ' Run /reload-plugins to apply.'

  return (failed.length > 0 ? failure : success)(`Switched to ${name}: ${changed}.${failures}${missing}${reload}`)
}

async function deleteProfile($: Dollar, name: string): Promise<ModProfilesNotice> {
  const profiles = await loadProfiles($)
  if (profiles[name] === undefined) return failure(`There is no profile named ${name}.`)
  const rest = Object.fromEntries(Object.entries(profiles).filter(([key]) => key !== name))
  const active = await read($, activeState)
  await storeProfiles($, rest, active === name ? null : active)
  await update($, viewState, view => ({ selected: view.selected === name ? null : view.selected, confirming: null }))

  return success(`Deleted profile ${name}.`)
}

/** Runs one action at a time from the pane, drawing it busy and then its outcome. */
async function perform($: Dollar, settings: Settings, action: 'save' | 'use' | 'delete', name: string): Promise<void> {
  if (running.action !== null) {
    await update($, noticeState, () => info(`${running.action} is still running.`))
    return
  }
  const verb = action === 'save' ? 'Saving' : action === 'use' ? 'Switching to' : 'Deleting'
  running.action = `${verb} ${name}`
  let notice: ModProfilesNotice
  try {
    await update($, busyState, () => `${verb} ${name}…`)
    await update($, noticeState, () => null)
    notice = action === 'save' ? await saveProfile($, name) : action === 'use' ? await useProfile($, settings, name) : await deleteProfile($, name)
  } catch (error) {
    notice = failure(`${verb} ${name} failed: ${describe(error)}`)
  } finally {
    running.action = null
  }
  await update($, busyState, () => null)
  await update($, noticeState, () => notice)
}

async function listText($: Dollar): Promise<string> {
  const profiles = await loadProfiles($)
  const active = await read($, activeState)
  const current = await listPlugins($)
  const now = await $.clock.now()
  const entries = Object.entries(profiles).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return `◆ No profiles yet. Save the mods you have on now with /${COMMAND} save <name>.`
  const lines = entries.map(([name, profile]) => {
    const change = current.isKnown ? ` · ${changeLabel(planFor(profile, current.plugins))}` : ''
    return `${name === active ? '●' : '○'} ${name}: ${plural(profile.enabled.length, 'plugin')} on · saved ${ago(now - profile.savedAt)}${change}`
  })

  return [`◆ ${plural(entries.length, 'profile')}${active === null ? '' : ` · active: ${active}`}`, ...lines].join('\n')
}

async function openPane($: Dollar): Promise<CommandRunResult> {
  await loadProfiles($)
  await update($, viewState, () => ({ selected: null, confirming: null }))
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true, rows: PANE_ROWS })
  if (!opened.isPlaced) return { text: await listText($) }
  $.clock.after(0, () => void listPlugins($))

  return { text: '◆ Opened your mod profiles.' }
}

export const register: Register = (on, options) => {
  const settings: Settings = { shouldReload: options.autoReload !== false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'profile-mods',
      description: 'Save the mods you have on as a profile, and switch between profiles',
      argumentHint: ARGUMENT_HINT,
    })

    return next(e)
  })

  on('command.run', { command: 'profile-mods' }, async ($, e) => {
    const request = parseRequest(e.args)
    switch (request.kind) {
      case 'open':
        return openPane($)
      case 'list':
        return { text: await listText($) }
      case 'save':
        return { text: said(await saveProfile($, request.name)) }
      case 'use':
        return { text: said(await useProfile($, settings, request.name)) }
      case 'delete':
        return { text: said(await deleteProfile($, request.name)) }
      case 'usage':
        return { text: `✗ ${request.reason} Usage: /${COMMAND} ${ARGUMENT_HINT}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [profiles, active, current, view, busy, notice, now] = await Promise.all([
      read($, profilesState),
      read($, activeState),
      read($, currentState),
      read($, viewState),
      read($, busyState),
      read($, noticeState),
      $.clock.now(),
    ])
    const entries = Object.entries(profiles).sort(([a], [b]) => a.localeCompare(b))
    const isIdle = busy === null
    const setView = (change: Partial<typeof view>) => update($, viewState, was => ({ ...was, ...change }))

    const saveField = e.surface === 'mobile' ? null : (() => {
      const { Input } = $.ui.resolve(e)
      return (
        <Input
          key="save-name"
          label="Save current as"
          placeholder="work, personal, demo…"
          submitLabel="save"
          onSubmit={name => perform($, settings, 'save', name.trim().toLowerCase())}
        />
      )
    })()

    const nowLine = current === null
      ? <Text dimColor>Reading your plugins…</Text>
      : current.isKnown
        ? (
          <Text dimColor wrap="truncate-end">
            Now: {plural(current.plugins.filter(plugin => plugin.isEnabled).length, 'plugin')} on · {current.plugins.filter(plugin => !plugin.isEnabled).length} off
          </Text>
        )
        : <Text color="warning" wrap="wrap">▲ Could not list your plugins: {current.error}</Text>

    const drawProfile = ([name, profile]: [string, ModProfile], index: number) => {
      const plan = current?.isKnown === true ? planFor(profile, current.plugins) : undefined
      const isActive = name === active
      const hotkey = USE_HOTKEYS[index]
      const isConfirming = view.confirming === name
      const details = plan === undefined ? [] : [
        plan.enable.length > 0 ? `Enables ${names(plan.enable.map(change => change.id))}` : '',
        plan.disable.length > 0 ? `Disables ${names(plan.disable.map(change => change.id))}` : '',
        plan.missing.length > 0 ? `Not installed: ${names(plan.missing)}` : '',
        plan.untouched.length > 0 ? `Left as they are (installed since it was saved): ${names(plan.untouched)}` : '',
      ].filter(line => line !== '')

      return (
        <Box key={`profile:${name}`} flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text color={isActive ? 'success' : 'inactive'}>{isActive ? '●' : '○'}</Text>
            <Button key={`open:${name}`} label={name} plain onPress={() => setView({ selected: view.selected === name ? null : name, confirming: null })} />
            <Text dimColor>{plural(profile.enabled.length, 'plugin')} on · saved {ago(now - profile.savedAt)}</Text>
            {plan === undefined ? null : <Text color={matches(plan) ? 'success' : 'warning'}>{changeLabel(plan)}</Text>}
            {isIdle && !isConfirming ? (
              <Button
                key={`use:${name}`}
                label="Use"
                plain
                variant="primary"
                {...(hotkey === undefined ? {} : { hotkey })}
                onPress={() => perform($, settings, 'use', name)}
              />
            ) : null}
            {isIdle && !isConfirming ? <Button key={`delete:${name}`} label="Delete" plain onPress={() => setView({ confirming: name })} /> : null}
            {isIdle && isConfirming ? (
              <Button key={`confirm:${name}`} label={`Delete ${name}?`} plain variant="primary" onPress={() => perform($, settings, 'delete', name)} />
            ) : null}
            {isIdle && isConfirming ? <Button key={`cancel:${name}`} label="Keep it" plain onPress={() => setView({ confirming: null })} /> : null}
          </Box>
          {view.selected === name ? (
            <Box flexDirection="column" paddingLeft={2}>
              {details.length === 0 ? <Text dimColor>Using it changes nothing now.</Text> : details.map(line => <Text dimColor wrap="wrap">{line}</Text>)}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
          <Text bold color="claude">🧩 Mod Profiles</Text>
          <Text dimColor>{plural(entries.length, 'profile')}{active === null ? '' : ` · active: ${active}`}</Text>
        </Box>
        {nowLine}
        {saveField}
        {busy === null ? null : <Text color="suggestion">⟳ {busy}</Text>}
        {notice === null ? null : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text color={TONE_COLOR[notice.tone]} wrap="wrap">{said(notice)}</Text>
            <Button key="dismiss" label="Dismiss" plain hotkey="d" onPress={() => update($, noticeState, () => null)} />
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {entries.length === 0
            ? <Text dimColor wrap="wrap">No profiles yet. Type a name above and press Enter to save the plugins you have on now.</Text>
            : entries.map(drawProfile)}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          <Button key="refresh" label="Refresh" plain hotkey="r" onPress={() => listPlugins($)} />
          <Button key="close" label="Close" plain hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
