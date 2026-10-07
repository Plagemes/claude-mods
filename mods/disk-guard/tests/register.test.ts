import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatSize, isHeavyWrite, parseDf, shortage } from '../hooks/disk'

const dfOutput = (availableKb: number, usedPercent: number, totalKb = 100 * 1024 * 1024) =>
  `Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/nvme0n1p2 ${totalKb} ${totalKb - availableKb} ${availableKb} ${usedPercent}% /home\n`
const GB = 1024 * 1024
const FULL_DISK = dfOutput(Math.round(1.4 * GB), 99)
const ROOMY_DISK = dfOutput(60 * GB, 40)

type Df = { stdout: string; exitCode?: number } | 'missing'

/** The engine under the plugin: df answers `reading`, Bash answers `reply`. Records the df calls and the toasts. */
const world = (on: On, reading: Df, reply: { text?: string; isError?: true } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const runs: { argv: readonly string[]; cwd: string | undefined }[] = []
  const toasts: string[] = []
  const state = { reading }
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    if (state.reading === 'missing') return { deny: 'failed to start: ENOENT' }
    return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...state.reading } }
  })
  on('tool.call', () => ({ result: 'out', text: 'ok', ...reply }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, runs, toasts, state }
}

test('warns before an install when the disk is nearly full: a note for Claude and a toast', async ($, on) => {
  const { runs, toasts } = world(on, { stdout: FULL_DISK })

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm install' })

  expect(runs).toEqual([{ argv: ['df', '-Pk', '.'], cwd: '/work/app' }])
  const [note] = ran.context ?? []
  expect(note).toContain('only 1.4 GB free of 100.0 GB on /home (99% used)')
  expect(note).toContain('`npm install` writes a lot')
  expect(note).toContain('du -sh node_modules')
  expect(note).toContain('docker system df')
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('disk nearly full: only 1.4 GB free')
  expect(toasts[0]).toContain('docker system df')
})

test('says nothing when there is room, and does not look at commands that write little', async ($, on) => {
  const { runs, toasts } = world(on, { stdout: ROOMY_DISK })

  const roomy = await $.tool.call({ tool: 'Bash', command: 'cargo build --release' })
  const light = await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  expect(roomy.context).toBeUndefined()
  expect(light.context).toBeUndefined()
  expect(runs).toHaveLength(1) // only the build was worth a look
  expect(toasts).toEqual([])
})

test('a disk that is over 95% used is flagged even with gigabytes free', async ($, on) => {
  world(on, { stdout: dfOutput(30 * GB, 97, 1000 * GB) })

  const ran = await $.tool.call({ tool: 'Bash', command: 'docker pull postgres:16' })

  expect(ran.context?.[0]).toContain('only 30.0 GB free of 1000.0 GB on /home (97% used)')
})

test('reuses a reading for a minute and toasts once per reading, but still notes every heavy command', async ($, on) => {
  const { clock, runs, toasts } = world(on, { stdout: FULL_DISK })

  await $.tool.call({ tool: 'Bash', command: 'npm ci' })
  await clock.advance(30_000)
  const second = await $.tool.call({ tool: 'Bash', command: 'git clone https://github.com/a/b.git' })
  expect(runs).toHaveLength(1)
  expect(toasts).toHaveLength(1)
  expect(second.context).toHaveLength(1)

  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'pip install requests' })
  expect(runs).toHaveLength(2)
  expect(toasts).toHaveLength(2)
})

test('the options set the thresholds', { options: { minFreeGb: 80, maxUsedPercent: 100 } }, async ($, on) => {
  world(on, { stdout: ROOMY_DISK })

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm install' })

  expect(ran.context?.[0]).toContain('only 60.0 GB free')
})

test('a command that fails because the disk is full gets a note even when it was not looked at', async ($, on) => {
  const { toasts } = world(on, { stdout: FULL_DISK }, { isError: true, text: 'Exit code 1\ntar: write error: No space left on device' })

  const ran = await $.tool.call({ tool: 'Bash', command: 'tar xzf big.tar.gz' })

  expect(ran.isError).toBe(true)
  expect(ran.context?.[0]).toContain('the command failed because the disk is full (only 1.4 GB free')
  expect(toasts[0]).toContain('disk full: only 1.4 GB free')
})

test('a machine without df, or a df that fails, is no problem and is not asked again', async ($, on) => {
  const { runs } = world(on, 'missing')

  const first = await $.tool.call({ tool: 'Bash', command: 'npm install' })
  const second = await $.tool.call({ tool: 'Bash', command: 'npm install' })

  expect(first.isError).toBeUndefined()
  expect(first.context).toBeUndefined()
  expect(second.context).toBeUndefined()
  expect(runs).toHaveLength(1)
})

test('output that is not df output is ignored', async ($, on) => {
  world(on, { stdout: 'df: cannot read table of mounted file systems\n' })

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm install' })

  expect(ran.context).toBeUndefined()
})

test('isHeavyWrite knows installs, builds, pulls and clones, and not the rest', () => {
  const heavy = [
    'npm install',
    'pnpm i --frozen-lockfile',
    'yarn',
    'yarn add react',
    'npm run build',
    'pip3 install -r requirements.txt',
    'uv sync',
    'cargo build --release',
    'cargo +nightly test',
    'go mod download',
    'bundle install',
    'docker build -t app .',
    'docker compose pull',
    'docker compose up --build',
    'git clone https://github.com/a/b.git',
    'sudo apt-get install -y build-essential',
    'brew install node',
    './gradlew build',
    'dotnet publish -c Release',
  ]
  const light = ['ls', 'git status', 'git commit -m fix', 'npm test', 'cat package.json', 'docker ps', 'cargo --version']
  expect(heavy.filter(command => !isHeavyWrite(command))).toEqual([])
  expect(light.filter(command => isHeavyWrite(command))).toEqual([])
})

test('parseDf reads the last line of POSIX df and formatSize picks the unit', () => {
  expect(parseDf(FULL_DISK)).toEqual({ totalKb: 100 * GB, availableKb: Math.round(1.4 * GB), usedPercent: 99, mount: '/home' })
  expect(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\nmy disk 100 50 50 50% /Volumes/My Disk\n')?.mount).toBe('/Volumes/My Disk')
  expect(parseDf('nonsense')).toBeUndefined()
  expect([formatSize(300 * 1024), formatSize(1.5 * GB), formatSize(2.5 * 1024 * GB)]).toEqual(['300 MB', '1.5 GB', '2.5 TB'])
  expect(shortage({ totalKb: 10 * GB, availableKb: 3 * GB, usedPercent: 70, mount: '/' }, 2, 95)).toBeUndefined()
})
