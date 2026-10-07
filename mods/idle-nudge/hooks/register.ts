import type { EngineInterface, Register } from 'claude-code'

const DEFAULT_IDLE_MINUTES = 20
const TICK_MS = 60_000
const MS_PER_MINUTE = 60_000
const GIT_TIMEOUT_MS = 5_000
const TOAST_MS = 30_000

/** Files with uncommitted changes (untracked ones included); 0 outside a git repository or on any failure. */
const countChangedFiles = async ($: EngineInterface): Promise<number> => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'status', '--porcelain'], {
      timeoutMs: GIT_TIMEOUT_MS,
    })

    return exitCode === 0 ? stdout.split('\n').filter(line => line.trim() !== '').length : 0
  } catch {
    return 0
  }
}

export const register: Register = (on, options) => {
  const idleMs =
    (typeof options.idleMinutes === 'number' && options.idleMinutes > 0
      ? options.idleMinutes
      : DEFAULT_IDLE_MINUTES) * MS_PER_MINUTE

  let lastActiveAt: number | undefined
  let isWorking = false
  let hasNudged = false
  let isChecking = false

  on('session.start', async ($, e, next) => {
    lastActiveAt = await $.clock.now()

    $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        lastActiveAt ??= now

        if (isWorking || hasNudged || isChecking || now - lastActiveAt < idleMs) {
          return
        }

        isChecking = true
        try {
          const files = await countChangedFiles($)

          if (files > 0) {
            hasNudged = true
            const minutes = Math.floor((now - lastActiveAt) / MS_PER_MINUTE)
            $.ui.toast(
              `idle-nudge: you have ${files} uncommitted ${files === 1 ? 'file' : 'files'} (idle ${minutes} min)`,
              { timeoutMs: TOAST_MS },
            )
          }
        } finally {
          isChecking = false
        }
      })()
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    hasNudged = false
    lastActiveAt = await $.clock.now()

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    lastActiveAt = await $.clock.now()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isWorking = false
      lastActiveAt = await $.clock.now()
    }

    return next(e)
  })
}
