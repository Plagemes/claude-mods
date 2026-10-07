export type Listener = { pid: number; name: string }

/** `lsof -Fpc` output: a `p<pid>` line, then `c<command>`, for each process. */
export function parseLsof(stdout: string): Listener[] {
  const found: Listener[] = []
  let pid: number | undefined
  for (const row of stdout.split('\n')) {
    if (row.startsWith('p')) pid = Number(row.slice(1))
    else if (row.startsWith('c') && pid !== undefined && Number.isFinite(pid)) found.push({ pid, name: row.slice(1) })
  }
  return found
}

/** `ss -ltnpH` output: `LISTEN 0 511 *:3000 *:* users:(("node",pid=4821,fd=19))`. */
export function parseSs(stdout: string): Listener[] {
  const found: Listener[] = []
  for (const match of stdout.matchAll(/\(\("([^"]+)",pid=(\d+)/g)) found.push({ name: match[1] as string, pid: Number(match[2]) })
  return found
}

/** Each process once, whichever way it was found (a process may listen on IPv4 and IPv6). */
export function unique(listeners: readonly Listener[]): Listener[] {
  const seen = new Set<number>()
  return listeners.filter(({ pid }) => !seen.has(pid) && seen.add(pid))
}
