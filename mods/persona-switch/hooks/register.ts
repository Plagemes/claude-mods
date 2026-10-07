import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PersonaName } from '../types'

const COMMAND = 'persona'
const LIST_COMMAND = 'personas'
const SECTION_ID = 'persona-switch:persona'
const OFF = 'off'
const STORE_PREFIX = 'active:'
const MAX_CUSTOM_PROMPT_CHARS = 4000

type Persona = { label: string; summary: string; prompt: string; isCustom?: true }

const BUILT_IN: Record<PersonaName, Persona> = {
  reviewer: {
    label: 'Code reviewer',
    summary: 'Reviews before it writes: bugs, edge cases and missing tests first.',
    prompt: [
      '- Read the relevant code before changing it, and look for bugs, unhandled edge cases, unclear naming, missing tests and risky changes. Report them ordered by severity.',
      '- Be specific: cite the file and line, say why it matters, and propose the smallest fix.',
      "- Do not rewrite working code for taste; mark style remarks as optional nits.",
      '- When asked to implement, keep the change minimal and review your own diff before you finish.',
    ].join('\n'),
  },
  architect: {
    label: 'Software architect',
    summary: 'Thinks in systems: boundaries, data flow, trade-offs, then code.',
    prompt: [
      '- Think in systems: module boundaries, data flow, dependencies, failure modes, and how the code will need to evolve.',
      '- Before writing code for anything non-trivial, outline two or three options with their trade-offs (complexity, performance, operability, migration cost) and recommend one.',
      "- Prefer simple designs that fit the project's existing patterns; say when a change needs a migration, a design record or wider agreement.",
      '- Keep plans short; use a small ASCII diagram when it makes the structure clearer.',
    ].join('\n'),
  },
  teacher: {
    label: 'Teacher',
    summary: 'Explains what and why as it goes, at your level.',
    prompt: [
      '- Explain as you go: what you are doing, why, the concept behind it, and how the user could do it themselves next time.',
      "- Match the user's level; define jargon the first time it appears; use small, concrete examples.",
      '- When the user wants to learn, guide rather than do: give hints and let them try before you show the full answer.',
      '- End substantial answers with a two-line recap and one suggestion of what to explore next.',
    ].join('\n'),
  },
  'pair-programmer': {
    label: 'Pair programmer',
    summary: 'Small visible steps, checks in at decisions, keeps tests green.',
    prompt: [
      "- Work in small, visible steps: say in one sentence what you're about to do, then do it.",
      "- Check in at real decision points instead of making large assumptions; offer two options when the choice is the user's.",
      '- Keep the feedback loop tight: run the relevant tests or checks after each change.',
      '- Think aloud briefly about trade-offs, but keep momentum: no long essays.',
    ].join('\n'),
  },
  'security-auditor': {
    label: 'Security auditor',
    summary: "Reads every change with an attacker's eyes.",
    prompt: [
      "- Look at every change with an attacker's eyes: input validation, injection (SQL, shell, templates), authentication and authorization, secrets handling, SSRF, path traversal, unsafe deserialization and risky dependencies.",
      '- Report each finding with a severity, a concrete exploit scenario and the fix; keep confirmed issues apart from hardening suggestions.',
      '- Never weaken a security control to make something work, and never print, log or commit secrets.',
      '- Prefer well-known libraries and safe defaults over hand-rolled crypto, parsers or sanitizers.',
    ].join('\n'),
  },
  'product-minded': {
    label: 'Product-minded engineer',
    summary: 'Starts from the user problem and the smallest change that solves it.',
    prompt: [
      '- Start from the user problem: who is affected, what outcome they need, and how we will know it worked.',
      '- Question scope: propose the smallest change that delivers the value and flag gold-plating.',
      '- Care about the details users feel: copy, empty and error states, accessibility, perceived performance.',
      '- Mention rollout (feature flags), analytics and docs when the change warrants them.',
    ].join('\n'),
  },
}

const active = atom({ plugin: 'persona-switch', key: 'active' } as const, null)

let personas: Record<PersonaName, Persona> = { ...BUILT_IN }
let customError: string | undefined

const normalizeName = (name: string): PersonaName =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')

/** The personas a person declared in `customPersonas`, or why the JSON could not be used. */
const parseCustom = (raw: string): { found: Record<PersonaName, Persona>; error?: string } => {
  if (raw.trim() === '') return { found: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { found: {}, error: `customPersonas is not valid JSON (${String(error)})` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { found: {}, error: 'customPersonas must be a JSON object of name → persona' }
  }
  const found: Record<PersonaName, Persona> = {}
  const skipped: string[] = []
  for (const [rawName, value] of Object.entries(parsed)) {
    const name = normalizeName(rawName)
    const spec = typeof value === 'string' ? { prompt: value } : (value as Record<string, unknown> | null)
    const prompt = typeof spec?.prompt === 'string' ? spec.prompt.trim() : ''
    if (name === '' || name === OFF || prompt === '') {
      skipped.push(rawName)
      continue
    }
    found[name] = {
      label: typeof spec?.label === 'string' && spec.label.trim() !== '' ? spec.label.trim() : rawName.trim(),
      summary: typeof spec?.summary === 'string' ? spec.summary.trim() : 'Your own persona.',
      prompt: prompt.slice(0, MAX_CUSTOM_PROMPT_CHARS),
      isCustom: true,
    }
  }
  return {
    found,
    error: skipped.length === 0 ? undefined : `customPersonas: skipped ${skipped.join(', ')} (each needs a name and a prompt)`,
  }
}

const sectionText = (persona: Persona): string =>
  [
    `# Active persona: ${persona.label}`,
    'The user switched you into this persona with /persona. Work this way until they switch it off, while keeping every other instruction (tools, safety, project rules) in force.',
    '',
    persona.prompt,
  ].join('\n')

const listing = (current: PersonaName | null): string => {
  const width = Math.max(...Object.keys(personas).map(name => name.length))
  const rows = Object.entries(personas).map(
    ([name, persona]) =>
      `${name === current ? '●' : ' '} ${name.padEnd(width)}  ${persona.summary}${persona.isCustom ? ' (custom)' : ''}`,
  )
  return [
    'persona-switch: personas',
    ...rows,
    '',
    current === null ? 'No persona is on. /persona <name> switches one on.' : `/persona ${OFF} switches ${current} off.`,
  ].join('\n')
}

async function storeKey($: EngineInterface): Promise<string> {
  return `${STORE_PREFIX}${await $.session.root()}`
}

function showStatus($: EngineInterface, name: PersonaName | null): void {
  const persona = name === null ? undefined : personas[name]
  $.ui.status(persona === undefined ? undefined : `◆ ${persona.label}`)
}

async function activate($: EngineInterface, name: PersonaName | null): Promise<void> {
  await update($, active, () => name)
  showStatus($, name)
  try {
    const key = await storeKey($)
    if (name === null) await $.store.delete(key)
    else await $.store.set(key, name)
  } catch (error) {
    $.ui.log(`persona-switch: could not remember the persona for this project: ${String(error)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  const custom = parseCustom(typeof options.customPersonas === 'string' ? options.customPersonas : '')
  personas = { ...BUILT_IN, ...custom.found }
  customError = custom.error

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Switch Claude into a persona (reviewer, architect, teacher, …) or off',
      argumentHint: `<name>|${OFF}`,
    })
    await $.command.register({ name: LIST_COMMAND, description: 'List the personas /persona can switch to' })
    if (customError !== undefined) $.ui.toast(`persona-switch: ${customError}`)
    try {
      const saved = await $.store.get(await storeKey($))
      const name = typeof saved === 'string' && saved in personas ? saved : null
      await update($, active, () => name)
      showStatus($, name)
    } catch (error) {
      $.ui.log(`persona-switch: could not restore the persona: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const name = await read($, active)
    const persona = name === null ? undefined : personas[name]
    if (persona === undefined || e.traits.includes('bare')) return composed
    return {
      sections: [
        ...composed.sections.filter(section => section.id !== SECTION_ID),
        { id: SECTION_ID, text: sectionText(persona), scope: 'session' },
      ],
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const wanted = normalizeName(e.args)
    const current = await read($, active)
    if (wanted === '') {
      const persona = current === null ? undefined : personas[current]
      return {
        text:
          persona === undefined
            ? `persona-switch: no persona is on. Try /persona ${Object.keys(personas).join(', /persona ')}.`
            : `persona-switch: ${persona.label} (${current}) is on. /persona ${OFF} switches it off.`,
      }
    }
    if (wanted === OFF) {
      await activate($, null)
      return { text: 'persona-switch: persona off. Claude is back to its default way of working.' }
    }
    const persona = personas[wanted]
    if (persona === undefined) {
      return { text: `persona-switch: no persona "${wanted}". Choose one of: ${Object.keys(personas).join(', ')}.` }
    }
    await activate($, wanted)
    return { text: `persona-switch: ${persona.label} is on for this project. ${persona.summary}` }
  })

  on('command.run', { command: LIST_COMMAND }, async $ => ({ text: listing(await read($, active)) }))

  on('prompt.autocomplete', async ($, e, next) => {
    const match = /^\/persona\s+(\S*)$/.exec(e.text.slice(0, e.cursor))
    if (match === null) return next(e)
    const typed = (match[1] ?? '').toLowerCase()
    const mine = [...Object.keys(personas), OFF]
      .filter(name => name.startsWith(typed) && name !== typed)
      .map(name => ({ text: name, description: personas[name]?.summary ?? 'Switch the persona off' }))
    const below = await next(e)
    return { suggestions: [...mine, ...below.suggestions] }
  })
}
