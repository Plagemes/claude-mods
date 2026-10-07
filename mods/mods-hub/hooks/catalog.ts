// The standard events' runtime schemas: the same shapes `ModsEventMap` declares (types/index.d.ts), checked
// at `$.mods.publish` so a typo in a payload is refused where it is made, not three mods later. Pure.

/**
 * A field's type in a tiny notation: `string`, `number`, `boolean`, `string[]`, `number|null`,
 * `'a'|'b'` (one of the literals); a trailing `?` makes it optional.
 */
type FieldSpec = string

export const TOPICS: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = {
  'test.result': { runner: 'string', outcome: "'passed'|'failed'|'error'", passed: 'number|null', failed: 'number|null', durationMs: 'number?', command: 'string?', failures: 'string[]?' },
  'build.result': { tool: 'string', outcome: "'passed'|'failed'|'error'", durationMs: 'number?', command: 'string?', errors: 'number?' },
  'lint.result': { tool: 'string', errors: 'number', warnings: 'number', files: 'string[]?' },
  'typecheck.result': { tool: 'string', errors: 'number', files: 'string[]?' },
  'cost.update': { turnUsd: 'number', sessionUsd: 'number', model: 'string', tokens: 'number', isEstimate: 'boolean' },
  'budget.threshold': { kind: "'usd'|'tokens'", scope: "'session'|'day'|'week'|'month'", used: 'number', limit: 'number', percent: 'number' },
  'context.pressure': { percent: 'number', tokens: 'number', window: 'number' },
  'ci.result': { provider: 'string', workflow: 'string', outcome: "'passed'|'failed'|'cancelled'", branch: 'string?', url: 'string?', durationMs: 'number?' },
  'deploy.started': { target: 'string', environment: 'string', version: 'string?', url: 'string?' },
  'deploy.finished': { target: 'string', environment: 'string', version: 'string?', url: 'string?', durationMs: 'number?' },
  'deploy.failed': { target: 'string', environment: 'string', reason: 'string', url: 'string?' },
  'git.commit': { sha: 'string', message: 'string', branch: 'string', files: 'number' },
  'git.push': { remote: 'string', branch: 'string', isForce: 'boolean' },
  'pr.opened': { url: 'string', title: 'string', branch: 'string' },
  'decision.recorded': { title: 'string', summary: 'string?', path: 'string?', status: 'string?' },
  'lesson.learned': { lesson: 'string', context: 'string?', path: 'string?' },
  'error.repeated': { signature: 'string', count: 'number', tool: 'string', command: 'string?' },
  'tool.failed': { tool: 'string', summary: 'string', command: 'string?' },
  'risk.blocked': { guard: 'string', tool: 'string', reason: 'string', severity: "'low'|'medium'|'high'", command: 'string?', path: 'string?' },
  'secret.detected': { kind: 'string', where: "'edit'|'result'|'prompt'|'command'", action: "'blocked'|'redacted'|'warned'", path: 'string?' },
  'agent.routed': { agentType: 'string', tier: "'light'|'standard'|'deep'", model: 'string', reason: 'string', agentId: 'string?' },
  'agent.finished': { agentType: 'string', outcome: "'ok'|'failed'", durationMs: 'number', agentId: 'string?', usd: 'number?' },
  'turn.finished': { durationMs: 'number', tools: 'number', isAborted: 'boolean' },
  'session.started': { project: 'string', cwd: 'string', branch: 'string?' },
  'session.ended': { durationMs: 'number', turns: 'number', usd: 'number?' },
  'session.idle': { since: 'number', reason: "'activity'|'timer'|'manual'|'channel'" },
  'session.away': { since: 'number', reason: "'activity'|'timer'|'manual'|'channel'" },
  'session.back': { since: 'number', reason: "'activity'|'timer'|'manual'|'channel'", awayMs: 'number' },
  'mod.recommended': { name: 'string', reason: 'string', score: 'number?' },
  'mod.installed': { name: 'string', version: 'string' },
  'screenshot.taken': { path: 'string', url: 'string?', width: 'number?', height: 'number?', purpose: 'string?' },
  'issue.drafted': { title: 'string', body: 'string?', url: 'string?', labels: 'string[]?' },
  'task.queued': { id: 'string', title: 'string' },
  'task.started': { id: 'string', title: 'string' },
  'task.finished': { id: 'string', title: 'string', outcome: "'ok'|'failed'|'cancelled'" },
  'approval.requested': { id: 'string', question: 'string', tool: 'string?' },
  'approval.answered': { id: 'string', answer: "'allow'|'deny'", by: 'string' },
  'channel.inbound': { channel: 'string', from: 'string', text: 'string', isOwner: 'boolean' },
  'focus.started': { minutes: 'number', label: 'string?' },
  'focus.ended': { minutes: 'number', isCompleted: 'boolean' },
  'notification.sent': { level: "'info'|'success'|'warning'|'error'|'critical'", title: 'string', source: 'string', targets: 'string[]', held: 'boolean' },
}

/** A mod's own topic: `x.<mod>.<name>`, lowercase words joined by dots, dashes or underscores. */
const CUSTOM_TOPIC = /^x\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_PAYLOAD_CHARS = 16_000

const typeOk = (value: unknown, type: string): boolean => {
  if (type === 'null') return value === null
  if (type === 'string[]') return Array.isArray(value) && value.every(item => typeof item === 'string')
  if (type.startsWith("'")) return typeof value === 'string' && type.split('|').some(literal => literal === `'${value}'`)
  return typeof value === type && (type !== 'number' || Number.isFinite(value))
}

const fieldOk = (value: unknown, spec: string): boolean => {
  const isOptional = spec.endsWith('?')
  const types = isOptional ? spec.slice(0, -1) : spec
  if (value === undefined) return isOptional
  // A literal union is one type; `number|null` is two.
  return types.startsWith("'") ? typeOk(value, types) : types.split('|').some(type => typeOk(value, type))
}

/** Why a publish is refused, or undefined when topic and payload are fine. */
export function problemWith(topic: string, data: unknown): string | undefined {
  let size: number
  try {
    size = JSON.stringify(data ?? null).length
  } catch {
    return 'its data is not JSON'
  }
  if (size > MAX_PAYLOAD_CHARS) return `its data is ${size} characters; the bus carries at most ${MAX_PAYLOAD_CHARS}`
  const schema = TOPICS[topic]
  if (schema === undefined) {
    return CUSTOM_TOPIC.test(topic) ? undefined : `"${topic}" is not a standard topic; publish your own as x.<mod>.<name>`
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return `${topic} takes an object`
  const record = data as Record<string, unknown>
  for (const [field, spec] of Object.entries(schema)) {
    if (!fieldOk(record[field], spec)) return `${topic}.${field} must be ${spec.replace(/\?$/, ' (optional)')}`
  }
  return undefined
}

/** Whether a topic matches a subscription pattern: exact, or a prefix ending in `.` (`deploy.`), or `*`. */
export const topicMatches = (topic: string, pattern: string): boolean =>
  pattern === '*' || pattern === topic || (pattern.endsWith('.') && topic.startsWith(pattern))
