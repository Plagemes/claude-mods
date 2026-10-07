import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NPM_OUTDATED, PIP_OUTDATED } from './fixtures'

const PANE_PROPS = { title: 'Outdated', isFocused: false, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const REQUEST_2_88_0 = JSON.stringify({ name: 'request', version: '2.88.0', deprecated: 'request has been deprecated, see https://github.com/request/request/issues/3142' })

type World = { runs: (readonly string[])[]; fetched: string[]; toasts: string[]; submitted: string[]; copies: string[]; clock: ReturnType<typeof mock.clock> }

/** A project at /repo with a package-lock.json, a pyproject.toml and a .venv with pip; cargo is missing. */
const world = (on: On, files: string[] = ['package.json', 'package-lock.json', 'pyproject.toml', '.venv', 'Cargo.toml'], hasVenv = true): World => {
  const state: World = { runs: [], fetched: [], toasts: [], submitted: [], copies: [], clock: mock.clock(on) }
  const paths = new Set(hasVenv ? ['/repo/.venv/bin/python', '/repo/.venv/bin/pip'] : [])
  mock.env(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({ value: files.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.exists', ($, e) => ({ value: paths.has(e.path) }))
  on('fs.read', ($, e) => (e.path === '/repo/pyproject.toml' ? { value: '[project]\ndependencies = ["requests>=2.25", "flask"]\n' } : { deny: 'ENOENT' }))
  on('process.run', ($, e) => {
    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'git') return answer('/repo\n')
    state.runs.push(e.argv)
    if (e.argv[0] === 'npm') return answer(NPM_OUTDATED, 1)
    if (e.argv[1] === '-m') return answer(PIP_OUTDATED)
    if (e.argv[0] === 'cargo') return { value: { exitCode: 101, stdout: '', stderr: 'error: no such command: `outdated`', isStdoutTruncated: false, isStderrTruncated: false } }
    return answer('')
  })
  on('http.fetch', ($, e) => {
    state.fetched.push(e.url)
    const text = e.url === 'https://registry.npmjs.org/request/2.88.0' ? REQUEST_2_88_0 : '{"name":"x"}'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    state.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('prompt.submit', ($, e) => {
    state.submitted.push(e.text)
    return { text: e.text }
  })
  return state
}

const outdated = ($: Engine) =>
  $.command.run({ command: 'outdated', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'outdated-deps', surface, component: 'Pane', requestId: 'outdated', props: PANE_PROPS })

test('/outdated runs each manager in the background and flags deprecated versions', async ($, on) => {
  const state = world(on)
  expect((await outdated($)).text).toBe('Checking npm outdated, pip list, cargo outdated…')
  await state.clock.advance(0)
  expect(state.runs).toEqual([
    ['npm', 'outdated', '--json', '--long'],
    ['/repo/.venv/bin/python', '-m', 'pip', 'list', '--outdated', '--format=json'],
    ['cargo', 'outdated', '--root-deps-only', '--format', 'json'],
  ])
  expect(state.fetched).toContain('https://registry.npmjs.org/request/2.88.0')
  expect(state.fetched).toContain('https://registry.npmjs.org/@types%2fnode/18.0.0')
  expect(state.toasts.at(-1)).toBe('14 outdated: 8 major · 4 minor · 2 patch · 1 deprecated')
})

test('the pane lists packages riskiest first on every surface, with copyable commands and a safe-upgrade button', async ($, on) => {
  const state = world(on)
  await outdated($)
  await state.clock.advance(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const summary = (await ui.find({ key: 'summary' }))?.text ?? ''
    expect(summary).toContain('14 outdated · 8 major · 4 minor · 2 patch · 1 deprecated')
    expect(summary).toContain('cargo outdated: cargo-outdated is not installed (cargo install cargo-outdated)')
    const express = (await ui.find({ key: 'row:npm:express' }))?.text ?? ''
    expect(express).toContain('4.17.1')
    expect(express).toContain('5.2.1')
    expect(express).toContain('MAJOR')
    expect(express).toContain('minor to 4.22.3')
    expect((await ui.find({ key: 'row:npm:request' }))?.text).toContain('deprecated: request has been deprecated')
    expect((await ui.find({ key: 'row:pip:urllib3' }))?.text).toContain('indirect')
    const table = (await ui.find({ key: 'table' }))?.text ?? ''
    expect(table.indexOf('react')).toBeLessThan(table.indexOf('debug'))
    expect(table.indexOf('debug')).toBeLessThan(table.indexOf('ms '))
    await ui.press({ key: 'copy:npm:react' })
    expect(state.copies.at(-1)).toBe('npm install react@19.3.0')
    await ui.unmount()
  }

  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'upgrade' }))?.text).toContain('Upgrade all patch/minor (8)')
  await ui.press({ key: 'upgrade' })
  await ui.unmount()
  await state.clock.advance(1)
  expect(state.submitted[0]).toContain('- express 4.17.1 → 4.22.3 (minor): `npm install express@4.22.3`')
  expect(state.submitted[0]).toContain('- requests 2.25.1 → 2.34.2 (minor)')
  expect(state.submitted[0]).not.toContain('urllib3')
})

test('says when there is nothing to check, and when a Python project has no virtualenv', async ($, on) => {
  world(on, ['README.md'])
  expect((await outdated($)).text).toBe('Nothing to check here: no package.json, Python project, Cargo.toml or go.mod.')
})

test('a Python project without a virtualenv explains pip list needs one', async ($, on) => {
  const state = world(on, ['requirements.txt'], false)
  expect((await outdated($)).text).toBe('Checking pip list…')
  await state.clock.advance(0)
  expect(state.runs).toEqual([])
  expect(state.toasts.at(-1)).toBe('Nothing could be checked: No virtualenv found (.venv, venv, env): pip list checks the project\'s own environment.')
  const ui = await mountPane($, 'desktop')
  const summary = (await ui.find({ key: 'summary' }))?.text ?? ''
  expect(summary).toContain('Nothing could be checked')
  expect(summary).toContain('pip list: No virtualenv found (.venv, venv, env)')
  await ui.unmount()
})
