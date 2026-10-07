/** Hosts the person allowed for this session with /allow-host, on top of the configured list. */
export type UrlAllowlistExtraHosts = string[]

declare module 'claude-code' {
  interface PluginState {
    'url-allowlist': { extra: UrlAllowlistExtraHosts }
  }
}
