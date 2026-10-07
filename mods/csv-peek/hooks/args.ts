/** `/peek data.csv`, `/peek "my data.csv" 10`, `/peek @data/events.jsonl 20`. */
export const parsePeekArgs = (args: string): { path: string; rows: number | undefined } | undefined => {
  const text = args.trim()
  const quoted = /^(["'])(.+?)\1\s*(\d{1,3})?$/.exec(text)
  const tail = /^(.*\S)\s+(\d{1,3})$/.exec(text)
  const path = (quoted?.[2] ?? tail?.[1] ?? text).replace(/^@/, '').trim()
  const rows = quoted?.[3] ?? tail?.[2]
  return path === '' ? undefined : { path, rows: rows === undefined ? undefined : Number(rows) }
}

/** An absolute path for what the person typed: `~/x` from the home folder, a relative one from the working directory. */
export const resolvePath = (path: string, cwd: string, home: string | undefined): string => {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path
  if (path.startsWith('~/') && home !== undefined && home !== '') return `${home.replace(/\/+$/, '')}/${path.slice(2)}`
  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}
