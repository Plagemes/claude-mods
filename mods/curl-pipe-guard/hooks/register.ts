import type { Register } from 'claude-code'

import { findPipeToShell, hostOf } from './pipes'

export const register: Register = (on, options) => {
  const trustedHosts = String(options.allowedHosts ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(host => host !== '')

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const found = findPipeToShell(e.command)
    if (found === undefined) return next(e)

    const hosts = found.urls.map(hostOf)
    if (hosts.length > 0 && hosts.every(host => host !== undefined && trustedHosts.includes(host))) return next(e)

    const url = found.urls[0] ?? '<url>'
    return {
      deny: `curl-pipe-guard: a download is being run as code by ${found.interpreter} before anyone has read it. Instead: curl -fsSLo script.sh ${url}, inspect it (less script.sh), then run it with bash script.sh.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'curl-pipe-guard: its check failed, so the command was blocked.' }))
}
