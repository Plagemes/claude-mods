import type { PluginOptions } from 'claude-code'

import type { Language, Tone } from './compose'
import { parseAddress, parseRecipients } from './mail'
import { parseWeekday } from './schedule'
import type { Frequency, Schedule } from './schedule'
import { isKnownZone, systemZone } from './zones'

export type Provider = 'resend' | 'sendgrid' | 'smtp'

export type Settings = {
  provider: Provider
  resendApiKey: string
  sendgridApiKey: string
  smtpUrl: string
  smtpUser: string
  smtpPassword: string
  from: string
  replyTo: string
  /** Default recipients; a project can override them (`/digest recipients`). */
  recipients: string
  tone: Tone
  language: Language
  includeCost: boolean
  signature: string
  projectName: string
  journalDir: string
  zone: string
  schedule: Schedule
}

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value.trim() : fallback)
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback)

const SEND_AT = /^(\d{1,2}):(\d{2})$/

/** userConfig into settings. Every value has a default; the mod sends nothing until a provider and recipients are set. */
export function readSettings(options: PluginOptions): Settings {
  const sendAt = SEND_AT.exec(text(options.sendAt, '18:00'))
  const h = Number(sendAt?.[1] ?? 18)
  const mi = Number(sendAt?.[2] ?? 0)
  const zone = text(options.timezone, '')
  return {
    provider: oneOf(options.provider, ['resend', 'sendgrid', 'smtp'] as const, 'resend'),
    resendApiKey: text(options.resendApiKey, ''),
    sendgridApiKey: text(options.sendgridApiKey, ''),
    smtpUrl: text(options.smtpUrl, ''),
    smtpUser: text(options.smtpUser, ''),
    smtpPassword: typeof options.smtpPassword === 'string' ? options.smtpPassword : '',
    from: text(options.from, ''),
    replyTo: text(options.replyTo, ''),
    recipients: text(options.recipients, ''),
    tone: oneOf(options.tone, ['client', 'manager', 'technical'] as const, 'client'),
    language: oneOf(options.language, ['en', 'it'] as const, 'en'),
    includeCost: flag(options.includeCost, false),
    signature: typeof options.signature === 'string' ? options.signature.trim() : '',
    projectName: text(options.projectName, ''),
    journalDir: text(options.journalDir, '.claude/journal').replace(/^\/+|\/+$/g, '') || '.claude/journal',
    zone: zone !== '' && isKnownZone(zone) ? zone : systemZone(),
    schedule: {
      frequency: oneOf<Frequency>(options.frequency, ['off', 'daily', 'weekly', 'both'], 'off'),
      sendAt: h <= 23 && mi <= 59 ? { h, mi } : { h: 18, mi: 0 },
      weeklyDay: parseWeekday(text(options.weeklyDay, 'fri'), 5),
      skipWeekends: flag(options.skipWeekends, true),
    },
  }
}

/** The secrets a provider message must never echo. */
export const secretsOf = (settings: Settings): string[] => [settings.resendApiKey, settings.sendgridApiKey, settings.smtpPassword].filter(secret => secret !== '')

export type Readiness = { isReady: boolean; problem: string }

/** Whether the chosen provider has what it needs, and what is missing when it does not. */
export function readiness(settings: Settings, recipients: string): Readiness {
  if (parseAddress(settings.from) === undefined) return { isReady: false, problem: 'Set the sender address (`from`), for example "Acme Studio <digest@acme.com>".' }
  if (settings.provider === 'resend' && settings.resendApiKey === '') return { isReady: false, problem: 'Set the Resend API key (`resendApiKey`).' }
  if (settings.provider === 'sendgrid' && settings.sendgridApiKey === '') return { isReady: false, problem: 'Set the SendGrid API key (`sendgridApiKey`).' }
  if (settings.provider === 'smtp' && !/^smtps?:\/\/[^\s/]+/i.test(settings.smtpUrl)) return { isReady: false, problem: 'Set the SMTP address (`smtpUrl`), for example smtps://smtp.example.com:465.' }
  if (parseRecipients(recipients).valid.length === 0) return { isReady: false, problem: 'No recipients yet: `/digest recipients ana@client.com, boss@acme.com`.' }
  return { isReady: true, problem: '' }
}
