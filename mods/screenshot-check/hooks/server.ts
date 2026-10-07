/** Ports dev servers listen on by default, most common first (Vite, Next/CRA/Rails, Astro, Angular, Django, Flask…). */
export const DEV_PORTS = [5173, 3000, 4321, 8080, 4200, 8000, 5000, 3001, 8081, 4000, 5174, 8888]

/** Ports a project's `dev`/`start`/`serve` scripts name with `--port N`, `-p N` or `PORT=N`. */
export const portsFromPackage = (packageJson: string | undefined): number[] => {
  if (packageJson === undefined) return []
  try {
    const parsed: unknown = JSON.parse(packageJson)
    const scripts = typeof parsed === 'object' && parsed !== null && 'scripts' in parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts : {}
    const ports: number[] = []
    for (const name of ['dev', 'start', 'serve', 'preview']) {
      const script = (scripts as Record<string, unknown>)[name]
      if (typeof script !== 'string') continue
      for (const match of script.matchAll(/(?:--port[= ]|-p\s+|PORT=)(\d{2,5})\b/g)) ports.push(Number(match[1]))
    }
    return [...new Set(ports)]
  } catch {
    return []
  }
}

/** Ports to probe, the project's own first. */
export const candidatePorts = (fromPackage: readonly number[]): number[] => [...new Set([...fromPackage, ...DEV_PORTS])]

/**
 * The page to open: a full http(s) URL, `localhost:3000/x`, or a path (`/pricing`)
 * on the dev server. Undefined when it is none of these.
 */
export const pageUrl = (input: string, devServer: string | undefined): string | undefined => {
  const text = input.trim()
  if (text === '') return devServer
  if (text.startsWith('/')) return devServer === undefined ? undefined : new URL(text, devServer).toString()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  try {
    const url = new URL(withScheme)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}
