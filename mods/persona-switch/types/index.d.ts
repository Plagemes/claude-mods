/** A persona's name as `/persona` takes it: lowercase, words joined by `-`. */
export type PersonaName = string

declare module 'claude-code' {
  interface PluginState {
    'persona-switch': { active: PersonaName | null }
  }
}
