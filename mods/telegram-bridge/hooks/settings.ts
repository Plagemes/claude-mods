/** The userConfig values, cleaned and clamped. */
export type Settings = {
  botToken: string
  ownerId: string
  extraChats: string[]
  quietHours: string
  awayMinutes: number
  notifyMode: 'away' | 'always' | 'off'
  interaction: 'auto' | 'on' | 'off'
  pin: string
  confirmPrompts: boolean
  remoteApprovals: boolean
  memberTriggers: string[]
  memberRate: number
  memberDailyCap: number
  shareCodeWithMembers: boolean
  maxMessageChars: number
  maxFileMb: number
  pollSeconds: number
}

const clampNumber = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.trim() : fallback)

const list = (value: unknown): string[] =>
  text(value)
    .split(/[,;\s]+/)
    .map(item => item.trim())
    .filter(item => item !== '')

/** A Telegram user or chat id: digits, with a minus for groups. */
export const idOf = (value: unknown): string => {
  const match = /^-?\d{3,20}$/.exec(text(value))
  return match === null ? '' : match[0]
}

export const readSettings = (options: Readonly<Record<string, unknown>>): Settings => {
  const mode = text(options.notifyMode, 'away')
  const interaction = text(options.interaction, 'auto')
  return {
    botToken: text(options.botToken),
    ownerId: idOf(options.ownerId),
    extraChats: list(options.allowedChats).map(idOf).filter(id => id !== ''),
    quietHours: text(options.quietHours, '23-8'),
    awayMinutes: clampNumber(options.awayMinutes, 1, 240, 10),
    notifyMode: mode === 'always' || mode === 'off' ? mode : 'away',
    interaction: interaction === 'on' || interaction === 'off' ? interaction : 'auto',
    pin: text(options.pin),
    confirmPrompts: options.confirmPrompts !== false,
    remoteApprovals: options.remoteApprovals !== false,
    memberTriggers: list(options.memberTrigger ?? '?,claude').map(trigger => trigger.toLowerCase()),
    memberRate: clampNumber(options.memberRate, 1, 60, 5),
    memberDailyCap: clampNumber(options.memberDailyCap, 1, 1000, 40),
    shareCodeWithMembers: options.shareCodeWithMembers === true,
    maxMessageChars: clampNumber(options.maxMessageChars, 200, 3800, 3000),
    maxFileMb: clampNumber(options.maxFileMb, 1, 49, 10),
    pollSeconds: clampNumber(options.pollSeconds, 0, 50, 10),
  }
}
