/** The cap a person set with `/edit-limit <n>` for this session; null while the mod setting applies. */
export type EditLimitOverride = number | null

declare module 'claude-code' {
  interface PluginState {
    'edit-limit': { override: EditLimitOverride }
  }
}
