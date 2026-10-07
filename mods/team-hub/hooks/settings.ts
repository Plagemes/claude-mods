import type { PluginOptions } from 'claude-code'

export type Settings = { injectConventions: boolean; notifyDrift: boolean }

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

export const readSettings = (options: PluginOptions): Settings => ({
  injectConventions: flag(options.injectConventions, true),
  notifyDrift: flag(options.notifyDrift, true),
})
