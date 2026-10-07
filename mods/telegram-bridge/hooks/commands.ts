/** What an owner's message asks for. Anything that is not a command is a `prompt` for Claude. */
export type PhoneCommand =
  | { kind: 'status' }
  | { kind: 'sessions' }
  | { kind: 'help' }
  | { kind: 'cost' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'away' }
  | { kind: 'here' }
  | { kind: 'interact'; value: 'on' | 'off' | 'auto' }
  | { kind: 'night'; isOn: boolean }
  /** Silent: `null` until switched off, 0 off, otherwise for that many minutes. */
  | { kind: 'silent'; minutes: number | null }
  | { kind: 'stop' }
  | { kind: 'stopAll' }
  | { kind: 'queue'; task: string }
  | { kind: 'slash'; command: string }
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'prompt'; text: string }

export type ParsedCommand = {
  command: PhoneCommand
  /** The command is risky and needs the PIN, when one is set. */
  needsPin: boolean
  /** The PIN was given in the message (and removed from it). */
  hasPin: boolean
}

/** Commands that act on every session need the PIN when one is set. */
const RISKY: ReadonlySet<PhoneCommand['kind']> = new Set(['stopAll'])

const WORDS: readonly [PhoneCommand['kind'], readonly string[]][] = [
  ['stopAll', ['stop all', 'stopall', 'ferma tutto', 'ferma tutti', 'stop tutto', 'basta tutto']],
  ['stop', ['stop', 'ferma', 'fermati', 'basta', 'interrompi', 'abort']],
  ['status', ['status', 'stato', 'state', 'come va', 'a che punto sei', 'update']],
  ['sessions', ['sessions', 'sessioni', 'list', 'lista']],
  ['help', ['help', 'aiuto', 'comandi', 'commands', '?', 'menu', 'start']],
  ['cost', ['cost', 'costs', 'costo', 'costi', 'spesa', 'budget']],
  ['pause', ['pause', 'pausa', 'mute', 'silenzia', 'zitto']],
  ['resume', ['resume', 'riprendi', 'unmute', 'riattiva']],
  ['away', ['away', 'via', 'fuori', 'sono via', 'esco']],
  ['here', ['here', 'qui', 'sono qui', 'back', 'tornato', 'rientrato']],
  ['night', ['night', 'night mode', 'notte', 'buonanotte', 'modalità notte']],
  ['approve', ['approve', 'approva', 'ok', 'sì', 'si', 'yes', 'y', 'go', 'vai', 'run', 'esegui', '👍']],
  ['reject', ['reject', 'rifiuta', 'no', 'n', 'nope', 'cancel', 'annulla', '❌']],
]

const INTERACT = /^(?:interact|interaction|interazione|interagisci)\s+(on|off|auto|sì|si|no|attiva|disattiva)$/
const NIGHT = /^(?:night|notte|night mode|modalità notte)\s+(on|off|sì|si|no|attiva|disattiva)$/
const SILENT = /^(?:silent|silence|silenzio)(?:\s+(off|\d{1,4}))?$/
const QUEUE = /^(?:queue|coda|accoda|metti in coda|later|dopo)\s*[:-]?\s+([\s\S]+)$/i
const SLASH = /^\/([A-Za-z0-9][\w:-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/

const ON_WORDS: ReadonlySet<string> = new Set(['on', 'sì', 'si', 'attiva'])

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
  const slash = SLASH.exec(text)
  if (slash !== null) {
    // A bot command typed from the menu (`/status`, `/stop@my_bot now`) is the plain word; any other slash is refused.
    const asWord = commandOf([(slash[1] ?? '').toLowerCase(), (slash[2] ?? '').trim()].join(' ').trim())
    return asWord.kind === 'prompt' ? { kind: 'slash', command: slash[1] ?? '' } : asWord
  }
  const queue = QUEUE.exec(text)
  if (queue !== null && (queue[1] ?? '').trim() !== '') return { kind: 'queue', task: (queue[1] ?? '').trim() }
  const word = normalize(text)
  const interact = INTERACT.exec(word)
  if (interact !== null) return { kind: 'interact', value: interact[1] === 'auto' ? 'auto' : ON_WORDS.has(interact[1] ?? '') ? 'on' : 'off' }
  const night = NIGHT.exec(word)
  if (night !== null) return { kind: 'night', isOn: ON_WORDS.has(night[1] ?? '') }
  const silent = SILENT.exec(word)
  if (silent !== null) return { kind: 'silent', minutes: silent[1] === 'off' ? 0 : silent[1] === undefined ? null : Number(silent[1]) }
  for (const [kind, words] of WORDS) {
    if (words.includes(word)) return (kind === 'night' ? { kind, isOn: true } : { kind }) as PhoneCommand
  }
  return { kind: 'prompt', text: text.trim() }
}

export const helpText = (platform: string): string =>
  [
    `*Claude on ${platform}* — commands (EN/IT):`,
    '• *status* / stato — what every session is doing',
    '• *sessions* / sessioni — live sessions and their tags',
    '• *stop* / ferma — stop the current turn · *stop all* / ferma tutto',
    '• *pause* / pausa · *resume* / riprendi — mute this channel',
    '• *away* / via · *here* / qui — presence',
    '• *interact on|off|auto* — may Claude ask you things · *silent [min|off]* / silenzio · *night [on|off]* / notte',
    '• *cost* / costo — what the live sessions spent',
    '• *queue <task>* / coda <task> — save a task for later',
    '• anything else becomes a prompt; start with *#label* or *@project* to pick a session, or reply to its message',
  ].join('\n')
