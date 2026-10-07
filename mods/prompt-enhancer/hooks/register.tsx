import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, ModelCompleteResult, Register, RenderElement } from 'claude-code'

import type { Enhancement } from '../types'

const PANE = 'prompt-enhancer'
const COMMAND = 'enhance'
const DEFAULT_MODEL = 'sonnet'
const MAX_TOKENS = 2048
const TIMEOUT_MS = 60_000
const MAX_LISTED_ENTRIES = 40
/** Directories the top-level listing leaves out: generated, vendored or private to tools. */
const IGNORED_ENTRIES = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__', '.git', '.venv', 'venv'])

const SYSTEM = `You rewrite a developer's rough draft into a precise, well-scoped request for Claude Code, an AI coding agent that works inside their repository.

Rules:
- Keep the author's intent, voice and every concrete detail (file names, error messages, identifiers, numbers). Never invent requirements, files or facts that neither the draft nor the project context supports.
- State the goal plainly in the first sentence.
- Add scope: what to change and, where the draft implies it, what to leave alone.
- Add acceptance criteria when they follow from the draft (tests that must pass, behaviour to keep, no public API change).
- Where the draft is ambiguous, state the most reasonable assumption in one short line instead of asking questions.
- Use the project context only to name the right tools and conventions (the test runner, the framework).
- Be concise: usually 3 to 10 lines; a short bullet list is fine. No headings, no preamble, no sign-off.
- Answer in the language of the draft.

Reply with the rewritten prompt and nothing else.`

const enhancement = atom({ plugin: 'prompt-enhancer', key: 'enhancement' } as const, {
  status: 'idle',
  original: '',
  enhanced: '',
})

/** Root files that name a stack on their own. */
const MARKER_FILES: Record<string, string> = {
  'package.json': 'Node.js',
  'tsconfig.json': 'TypeScript',
  'pyproject.toml': 'Python',
  'requirements.txt': 'Python',
  'setup.py': 'Python',
  'go.mod': 'Go',
  'Cargo.toml': 'Rust',
  Gemfile: 'Ruby',
  'composer.json': 'PHP',
  'pom.xml': 'Java (Maven)',
  'build.gradle': 'JVM (Gradle)',
  'build.gradle.kts': 'Kotlin (Gradle)',
  'mix.exs': 'Elixir',
  'Package.swift': 'Swift',
  'pubspec.yaml': 'Dart/Flutter',
  Dockerfile: 'Docker',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'Yarn',
  'bun.lockb': 'Bun',
  'bun.lock': 'Bun',
}

/** package.json dependencies worth naming. */
const NODE_PACKAGES: Record<string, string> = {
  typescript: 'TypeScript',
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit',
  '@angular/core': 'Angular',
  express: 'Express',
  '@nestjs/core': 'NestJS',
  fastify: 'Fastify',
  vitest: 'Vitest',
  jest: 'Jest',
  '@playwright/test': 'Playwright',
  tailwindcss: 'Tailwind CSS',
  prisma: 'Prisma',
}

const settings = { model: DEFAULT_MODEL, includeContext: true }
let running: AbortController | undefined

type ProjectContext = { name: string; stack: string[]; entries: string[]; testScript?: string }

const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? path

/** Reads the stack off the root listing and package.json; tolerant of anything missing or malformed. */
const detectStack = (entries: readonly FsEntry[], packageJson: unknown): { stack: string[]; testScript?: string } => {
  const names = new Set(entries.map(entry => entry.name))
  const found = Object.entries(MARKER_FILES)
    .filter(([file]) => names.has(file))
    .map(([, tech]) => tech)
  if ([...names].some(name => name.endsWith('.tf'))) found.push('Terraform')
  if ([...names].some(name => name.endsWith('.csproj') || name.endsWith('.sln'))) found.push('.NET')
  let testScript: string | undefined
  if (typeof packageJson === 'object' && packageJson !== null) {
    const pkg = packageJson as Record<string, unknown>
    const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) }
    found.push(...Object.entries(NODE_PACKAGES).filter(([dep]) => dep in deps).map(([, tech]) => tech))
    const test = (pkg.scripts as Record<string, unknown> | undefined)?.test
    if (typeof test === 'string') testScript = test
  }
  return { stack: [...new Set(found)], testScript }
}

const describeFailure = (result: Exclude<ModelCompleteResult, { isAnswered: true }>): string =>
  result.reason === 'api-error'
    ? `the API answered ${result.status ?? 'nothing'} (${result.error})`
    : result.reason === 'empty-reply'
      ? 'the model replied with no text'
      : 'it was cancelled or timed out'

/** The reply as a prompt: no wrapping code fence, no "Here is…" line. */
const cleanReply = (text: string): string => {
  let cleaned = text.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(cleaned)
  if (fenced?.[1] !== undefined) cleaned = fenced[1].trim()
  return cleaned.replace(/^(here(?:'s| is)|rewritten|enhanced)[^\n]*:\s*\n+/i, '').trim()
}

const contextBlock = (context: ProjectContext): string =>
  [
    '<project>',
    `name: ${context.name}`,
    context.stack.length > 0 ? `stack: ${context.stack.join(', ')}` : undefined,
    context.testScript === undefined ? undefined : `test script: ${context.testScript}`,
    context.entries.length > 0 ? `top level: ${context.entries.join(', ')}` : undefined,
    '</project>',
  ]
    .filter(line => line !== undefined)
    .join('\n')

async function projectContext($: EngineInterface): Promise<ProjectContext | undefined> {
  try {
    const root = await $.session.root()
    const listed = await $.fs.list(root)
    const hasPackage = listed.some(entry => entry.name === 'package.json')
    const packageJson: unknown = hasPackage
      ? await $.fs
          .read(`${root.replace(/[\\/]+$/, '')}/package.json`)
          .then(text => JSON.parse(text) as unknown)
          .catch(() => undefined)
      : undefined
    const entries = listed
      .filter(entry => !IGNORED_ENTRIES.has(entry.name) && !entry.name.startsWith('.'))
      .map(entry => (entry.kind === 'dir' ? `${entry.name}/` : entry.name))
      .sort()
      .slice(0, MAX_LISTED_ENTRIES)
    return { name: baseName(root), entries, ...detectStack(listed, packageJson) }
  } catch (error) {
    $.ui.log(`prompt-enhancer: no project context: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

async function enhance($: EngineInterface, draft: string): Promise<void> {
  running?.abort()
  const controller = new AbortController()
  running = controller
  const context = settings.includeContext ? await projectContext($) : undefined
  const stack = context?.stack
  await update($, enhancement, (): Enhancement => ({ status: 'working', original: draft, enhanced: '', model: settings.model, stack }))
  const prompt = [context === undefined ? undefined : contextBlock(context), `<draft>\n${draft}\n</draft>`]
    .filter(part => part !== undefined)
    .join('\n\n')
  let result: ModelCompleteResult
  try {
    result = await $.model.complete(
      { model: settings.model, system: SYSTEM, prompt, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS },
      { signal: controller.signal },
    )
  } catch (error) {
    if (running !== controller) return
    await update($, enhancement, (current): Enhancement => ({ ...current, status: 'failed', error: String(error) }))
    return
  }
  if (running !== controller) return
  running = undefined
  const enhanced = result.isAnswered ? cleanReply(result.text) : ''
  await update($, enhancement, (current): Enhancement =>
    result.isAnswered && enhanced !== ''
      ? { ...current, status: 'done', enhanced }
      : { ...current, status: 'failed', error: result.isAnswered ? 'the model replied with no text' : describeFailure(result) },
  )
}

async function useDraft($: EngineInterface): Promise<void> {
  const { enhanced } = await read($, enhancement)
  const filled = await $.prompt.fill({ text: enhanced, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.toast(`prompt-enhancer: the prompt box could not take it${filled.refusal === 'dialog' ? ' while a dialog is open' : ''}`)
    return
  }
  await $.ui.close({ id: PANE })
}

async function sendDraft($: EngineInterface): Promise<void> {
  const { enhanced } = await read($, enhancement)
  await $.ui.close({ id: PANE })
  await $.prompt.submit({ text: enhanced, asUser: true })
}

async function cancel($: EngineInterface): Promise<void> {
  running?.abort()
  running = undefined
  await update($, enhancement, (current): Enhancement => ({ ...current, status: 'failed', error: 'cancelled' }))
}

export const register: Register = (on, options) => {
  settings.model = typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : DEFAULT_MODEL
  settings.includeContext = options.includeContext !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Rewrite a draft prompt into a precise, well-scoped request',
      argumentHint: '<draft> (or leave empty to use the prompt box)',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const draft = e.args.trim() === '' ? (await $.prompt.read()).text.trim() : e.args.trim()
    if (draft === '') {
      return { text: 'prompt-enhancer: nothing to enhance. Type /enhance followed by your draft.' }
    }
    await update($, enhancement, (): Enhancement => ({ status: 'working', original: draft, enhanced: '', model: settings.model }))
    const opened = await $.ui.open({ id: PANE, title: 'Enhance prompt', focus: true })
    // Out of the command's own dispatch, so the prompt stays free while the model writes.
    $.clock.after(1, () => void enhance($, draft))
    return {
      text: opened.isPlaced
        ? `prompt-enhancer: rewriting with ${settings.model}…`
        : `prompt-enhancer: rewriting with ${settings.model}; the pane waits for room (${opened.reason}).`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, enhancement)

    if (state.status === 'idle') {
      return <Text dimColor>Run /enhance followed by a draft to rewrite it here.</Text>
    }

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Enhance prompt</Text>
        <Text dimColor>{state.model ?? settings.model}</Text>
      </Box>
    )
    const original = (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>
          Original
        </Text>
        <Text dimColor>{state.original}</Text>
      </Box>
    )

    let body: RenderElement
    let actions: RenderElement
    if (state.status === 'working') {
      body = <Text color="claude">✻ Rewriting your draft…</Text>
      actions = (
        <Button key="cancel" hotkey="x" onPress={() => void cancel($)}>
          Cancel
        </Button>
      )
    } else if (state.status === 'failed') {
      body = <Text color="error">✗ No rewrite: {state.error ?? 'unknown error'}.</Text>
      actions = (
        <Box flexDirection="row" gap={1}>
          <Button key="retry" variant="primary" hotkey="r" onPress={() => void enhance($, state.original)}>
            Retry
          </Button>
          <Button key="close" role="dismiss" hotkey="x" onPress={() => void $.ui.close({ id: PANE })}>
            Close
          </Button>
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column">
          <Text bold color="claude">
            Enhanced
          </Text>
          <Box borderStyle="round" borderColor="claude" paddingX={1}>
            <Text>{state.enhanced}</Text>
          </Box>
        </Box>
      )
      actions = (
        <Box flexDirection="row" gap={1}>
          <Button key="use" variant="primary" hotkey="u" autoFocus onPress={() => void useDraft($)}>
            Use
          </Button>
          <Button key="send" hotkey="s" onPress={() => void sendDraft($)}>
            Send
          </Button>
          <Button key="retry" hotkey="r" onPress={() => void enhance($, state.original)}>
            Retry
          </Button>
          <Button key="copy" hotkey="c" onPress={press => void $.ui.copy({ text: state.enhanced, surface: press.surface })}>
            Copy
          </Button>
          <Button key="discard" role="dismiss" hotkey="x" onPress={() => void $.ui.close({ id: PANE })}>
            Discard
          </Button>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {original}
        <Box marginTop={1}>{body}</Box>
        <Box marginTop={1}>{actions}</Box>
        {state.stack !== undefined && state.stack.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>Project context: {state.stack.join(' · ')}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
