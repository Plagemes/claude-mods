/**
 * Signals from mods-hub's bus: what happened in the session (tests failed, CI failed) says which mods would
 * help, beyond what the project's files and the prompts say. Pure: the hooks file reads the events.
 */

/** One event as `$.mods.recent` returns it (only what the advisor reads). */
export type Signal = { topic: string; data: unknown; at: number }

/** A mod worth suggesting because of a signal, and why, in the words of "New for you". */
export type SignalPick = { name: string; reason: string }

type Outcome = { outcome?: unknown; failed?: unknown; branch?: unknown; workflow?: unknown }

type Rule = { topic: string; mods: readonly string[]; reason: (data: Outcome) => string | undefined }

/** First rule first: a mod is suggested for the first signal that names it. */
const RULES: readonly Rule[] = [
  {
    topic: 'test.result',
    mods: ['test-watch', 'flaky-detector', 'regression-guard'],
    reason: data =>
      data.outcome === 'error'
        ? 'your tests could not run'
        : data.outcome === 'failed'
          ? typeof data.failed === 'number' && data.failed > 0 ? `${data.failed} test${data.failed === 1 ? '' : 's'} failed` : 'your tests failed'
          : undefined,
  },
  {
    topic: 'ci.result',
    mods: ['issue-drafter', 'ci-watch'],
    reason: data =>
      data.outcome === 'failed' ? `CI failed${typeof data.branch === 'string' && data.branch !== '' ? ` on ${data.branch}` : ''}` : undefined,
  },
]

/** The topics whose events the advisor reads; `mod.installed` only refreshes what is installed. */
export const SIGNAL_TOPICS: readonly string[] = ['mod.installed', ...RULES.map(rule => rule.topic)]

/** The mods the signals point at, newest signal's reason kept per mod, minus `excluded` (installed, dismissed, shown). */
export function signalPicks(signals: readonly Signal[], excluded: ReadonlySet<string>): SignalPick[] {
  const picks = new Map<string, string>()
  for (const signal of [...signals].sort((a, b) => b.at - a.at)) {
    const rule = RULES.find(one => one.topic === signal.topic)
    const reason = rule?.reason((signal.data ?? {}) as Outcome)
    if (rule === undefined || reason === undefined) continue
    for (const name of rule.mods) if (!excluded.has(name) && !picks.has(name)) picks.set(name, reason)
  }
  return [...picks].map(([name, reason]) => ({ name, reason }))
}

/** Whether a mod was installed or removed since the advisor last looked (refresh the installed list then). */
export const hasInstallSignal = (signals: readonly Signal[]): boolean => signals.some(signal => signal.topic === 'mod.installed')
