import type { EngineInterface, Register } from 'claude-code'

import { describeToken, parseToken, redactTokens } from './jwt'

const USAGE = 'Usage: /jwt <token>, or select a token with the mouse and run /jwt. The token is decoded here, locally: nothing is sent or stored.'
const NOT_A_TOKEN = 'That does not look like a JWT: expected header.payload.signature, each part base64url, the header a JSON object.'

async function selectedText($: EngineInterface): Promise<string> {
  try {
    return (await $.ui.selection())?.text ?? ''
  } catch {
    return ''
  }
}

async function decode($: EngineInterface, args: string): Promise<string> {
  const source = args.trim() === '' ? await selectedText($) : args
  if (source.trim() === '') return USAGE
  const token = parseToken(source)
  return token === undefined ? NOT_A_TOKEN : describeToken(token, await $.clock.now())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerCommand($, {
      name: 'jwt',
      description: 'Decode a JSON Web Token locally: header, claims, expiry and warnings',
      argumentHint: '<token> (or select one)',
    })
    return next(e)
  })

  on('command.run', { command: 'jwt' }, async ($, e) => ({ text: await decode($, e.args) }))

  // The conversation keeps a record of the command with its argument: the token is taken out of it before it is stored.
  on('session.append', { door: 'command' }, (_$, e, next) => {
    const isAboutJwt = e.message.content.some(block => block.type === 'text' && typeof block.text === 'string' && /jwt/i.test(block.text))
    if (!isAboutJwt) return next(e)
    const content = e.message.content.map(block => (block.type === 'text' && typeof block.text === 'string' ? { ...block, text: redactTokens(block.text) } : block))
    return next({ ...e, message: { ...e.message, content } })
  }).catch((_$, e, next) => next(e))
}

/** Registers a slash command. A refused name (Claude Code's own, or another mod's) is reported as a notice, never thrown, so the rest of session.start still runs. */
async function registerCommand($: EngineInterface, spec: Parameters<EngineInterface['command']['register']>[0]): Promise<boolean> {
  try {
    await $.command.register(spec)
    return true
  } catch (error) {
    $.ui.log(`${$.plugin.name}: /${spec.name} was not registered (${error instanceof Error ? error.message : String(error)}).`)
    return false
  }
}
