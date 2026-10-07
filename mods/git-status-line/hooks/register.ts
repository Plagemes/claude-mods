import type { EngineInterface, Register, Timer } from 'claude-code'

import { formatStatus } from './format'

// Anything that can change the working tree, the index or HEAD.
const GIT_AFFECTING_TOOLS = /^(?:Bash|Edit|Write|MultiEdit|NotebookEdit)$/
const GIT_TIMEOUT_MS = 5000

type Memo = {
  timer?: Timer
  shown?: string
}

type Settings = { debounceMs: number; showUntracked: boolean }

async function statusText($: EngineInterface, showUntracked: boolean): Promise<string | undefined> {
  const argv = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', ...(showUntracked ? [] : ['--untracked-files=no'])]
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: GIT_TIMEOUT_MS })
    return exitCode === 0 ? formatStatus(stdout) : undefined
  } catch {
    return undefined
  }
}

async function refresh($: EngineInterface, memo: Memo, settings: Settings): Promise<void> {
  const text = await statusText($, settings.showUntracked)
  if (text === memo.shown) return
  memo.shown = text
  $.ui.status(text)
}

/** Runs one refresh `delayMs` after the last request; a newer request replaces the pending one. */
function scheduleRefresh($: EngineInterface, memo: Memo, settings: Settings, delayMs: number): void {
  memo.timer?.cancel()
  memo.timer = $.clock.after(delayMs, () => {
    void refresh($, memo, settings)
  })
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    debounceMs: Math.max(0, Number(options.debounceMs ?? 600)),
    showUntracked: options.showUntracked !== false,
  }
  const memo: Memo = {}

  on('session.start', ($, e, next) => {
    scheduleRefresh($, memo, settings, 0)
    return next(e)
  })

  on('tool.call', { tool: GIT_AFFECTING_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    scheduleRefresh($, memo, settings, settings.debounceMs)
    return result
  })
}
