import { isHelpText } from './inbound'

/** What an owner's WhatsApp message asks for. Anything that is not a command is a `prompt` for Claude. */
export type PhoneCommand =
  | { kind: 'status' }
  | { kind: 'sessions' }
  | { kind: 'help' }
  | { kind: 'digest' }
  | { kind: 'cost' }
  | { kind: 'report' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'away' }
  | { kind: 'here' }
  | { kind: 'interact'; isOn: boolean }
  | { kind: 'night' }
  | { kind: 'stop' }
  | { kind: 'stopAll' }
  | { kind: 'queue'; task: string }
  | { kind: 'slash'; command: string; args: string }
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'retry' }
  | { kind: 'prompt'; text: string }

export type ParsedCommand = {
  command: PhoneCommand
  /** The command is risky and needs the PIN, when one is set. */
  needsPin: boolean
  /** The PIN was given in the message (and removed from it). */
  hasPin: boolean
}

/** Commands that act on every session or run a slash command need the PIN when one is set. */
const RISKY: ReadonlySet<PhoneCommand['kind']> = new Set(['stopAll', 'slash'])

const WORDS: readonly [PhoneCommand['kind'], readonly string[]][] = [
  ['stopAll', ['stop all', 'stopall', 'ferma tutto', 'ferma tutti', 'stop tutto', 'basta tutto']],
  ['stop', ['stop', 'ferma', 'fermati', 'basta', 'interrompi', 'abort']],
  ['status', ['status', 'stato', 'state', 'come va', 'a che punto sei', 'update']],
  ['sessions', ['sessions', 'sessioni', 'list', 'lista']],
  ['help', ['help', 'aiuto', 'comandi', 'commands', '?', 'menu']],
  ['digest', ['digest', 'riepilogo', 'riassunto', 'summary']],
  ['cost', ['cost', 'costs', 'costo', 'costi', 'spesa', 'budget']],
  ['report', ['report', 'grafico', 'grafici', 'chart', 'charts', 'resoconto']],
  ['pause', ['pause', 'pausa', 'mute', 'silenzia', 'zitto']],
  ['resume', ['resume', 'riprendi', 'unmute', 'riattiva']],
  ['away', ['away', 'via', 'fuori', 'sono via', 'esco']],
  ['here', ['here', 'qui', 'sono qui', 'back', 'tornato', 'rientrato']],
  ['night', ['night', 'night mode', 'notte', 'buonanotte', 'modalità notte']],
  ['approve', ['approve', 'approva', 'ok', 'sì', 'si', 'yes', 'y', 'go', 'vai', '👍']],
  ['reject', ['reject', 'rifiuta', 'no', 'n', 'nope', '❌']],
  ['retry', ['retry', 'riprova', 'ancora', '🔁']],
]

const INTERACT = /^(?:interact|interaction|interazione|interagisci)\s+(on|off|sì|si|no|attiva|disattiva)$/
const QUEUE = /^(?:queue|coda|accoda|metti in coda|later|dopo)\s*[:-]?\s+([\s\S]+)$/i
const SLASH = /^\/([A-Za-z0-9][\w:-]*)(?:\s+([\s\S]*))?$/

const normalize = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[.!¡¿]+$/u, '')
    .replace(/\s+/g, ' ')

/** Removes the PIN from the message when given as its own word (`1234`, `pin 1234`, `pin:1234`). */
export const takePin = (text: string, pin: string): { text: string; hasPin: boolean } => {
  if (pin === '') return { text, hasPin: false }
  const escaped = pin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:^|\\s)(?:pin\\s*[:=]?\\s*)?${escaped}(?=\\s|$)`, 'i')
  if (!pattern.test(text)) return { text, hasPin: false }
  return { text: text.replace(pattern, ' ').replace(/\s+/g, ' ').trim(), hasPin: true }
}

/** Reads an owner's message (tags already removed) as a command, in English or Italian. */
export const parseCommand = (raw: string, pin = ''): ParsedCommand => {
  const { text, hasPin } = takePin(raw.trim(), pin)
  const command = commandOf(text)
  return { command, needsPin: RISKY.has(command.kind) && pin !== '', hasPin }
}

const commandOf = (text: string): PhoneCommand => {
  // "/help" and "/aiuto" are the bridge's help, never a slash command run in a session.
  if (isHelpText(text)) return { kind: 'help' }
  const slash = SLASH.exec(text)
  if (slash !== null) return { kind: 'slash', command: slash[1] ?? '', args: (slash[2] ?? '').trim() }
  const queue = QUEUE.exec(text)
  if (queue !== null && (queue[1] ?? '').trim() !== '') return { kind: 'queue', task: (queue[1] ?? '').trim() }
  const word = normalize(text)
  const interact = INTERACT.exec(word)
  if (interact !== null) return { kind: 'interact', isOn: ['on', 'sì', 'si', 'attiva'].includes(interact[1] ?? '') }
  if (word === 'silent' || word === 'silenzio' || word === 'silent mode') return { kind: 'interact', isOn: false }
  for (const [kind, words] of WORDS) {
    if (words.includes(word)) return { kind } as PhoneCommand
  }
  return { kind: 'prompt', text: text.trim() }
}

/** Reaction emoji the owner may use on a question or alert, and what each means. */
export const reactionMeaning = (emoji: string): 'approve' | 'reject' | 'pause' | 'retry' | undefined => {
  const base = emoji.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, '')
  if (base === '👍' || base === '✅' || base === '👌') return 'approve'
  if (base === '❌' || base === '👎' || base === '🚫') return 'reject'
  if (base === '⏸' || base === '✋') return 'pause'
  if (base === '🔁' || base === '🔄') return 'retry'
  return undefined
}

export const HELP_TEXT = [
  '🤖 *Claude on WhatsApp* — commands (EN/IT):',
  '• *status* / stato — what every session is doing',
  '• *sessions* / sessioni — live sessions and their tags',
  '• *stop* / ferma — stop the current turn · *STOP ALL* / ferma tutto',
  '• *pause* / pausa · *resume* / riprendi — notifications',
  '• *away* / via · *here* / qui — presence',
  '• *interact on|off* · *night* / notte — may Claude ask you things',
  '• *digest* / riepilogo · *cost* / costo · *report* / grafico',
  '• *queue <task>* / coda <task> — save a task for later',
  '• ask anything ("what are you doing?", "status of the build?"): answered right away, nothing runs',
  '• ask for work ("fix the failing test"): you confirm, then Claude runs it and posts the result here',
  '• start with *#label* or *@project* to pick a session, or reply to its message',
  '• react 👍 approve · ❌ reject · ⏸ pause · 🔁 retry on a question or alert',
  '• in a project group, members can just write their questions (or *help*, *status*, *report*, *digest*); only you can ask for work or steer',
].join('\n')
