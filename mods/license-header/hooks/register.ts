import type { Register } from 'claude-code'

type Style = 'slash' | 'hash' | 'dash' | 'block' | 'html' | 'percent'
type Settings = { license: string; holder: string; year: string; custom: string }

const EXTENSIONS_BY_STYLE: Record<Style, string> = {
  slash: 'js jsx ts tsx mjs cjs mts cts java kt kts scala go rs c h cc cpp cxx hpp cs swift dart php groovy zig sol proto scss less',
  hash: 'py rb sh bash zsh pl r yml yaml toml tf ex exs cr nim jl ps1 gd',
  dash: 'lua sql hs elm',
  block: 'css',
  html: 'html htm xml vue svelte',
  percent: 'tex erl',
}
const STYLE_BY_EXTENSION = new Map<string, Style>(
  Object.entries(EXTENSIONS_BY_STYLE).flatMap(([style, list]) => list.split(' ').map(extension => [extension, style as Style] as const)),
)

const LINE_PREFIX: Record<'slash' | 'hash' | 'dash' | 'percent', string> = { slash: '//', hash: '#', dash: '--', percent: '%' }
const VENDORED = /(^|[\\/])(node_modules|vendor|\.git)[\\/]/
const HAS_NOTICE = /SPDX-License-Identifier|Copyright|\(c\)\s+\d{4}|Licensed under/i
const NOTICE_SEARCH_LINES = 15
// First lines that must stay first: a shebang, PHP's opening tag, an XML declaration.
const KEEP_FIRST = /^(?:#!|<\?php|<\?xml)/
// PHP outside `<?php` is output: a template (`welcome.blade.php`, a page that opens with HTML) would print a `//` header.
const PHP_CODE_FIRST = /^(?:#![^\n]*\n)?<\?php(?![^\n]*\?>)/

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const styleOf = (path: string): Style | undefined => {
  const name = path.split(/[\\/]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? STYLE_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) : undefined
}

const headerLines = ({ license, holder, year, custom }: Settings): string[] => {
  if (custom !== '') {
    return custom
      .replace(/\\n/g, '\n')
      .replaceAll('{license}', license)
      .replaceAll('{holder}', holder)
      .replaceAll('{year}', year)
      .split('\n')
      .map(line => line.trimEnd())
  }
  return [...(holder === '' ? [] : [`Copyright (c) ${year} ${holder}`]), `SPDX-License-Identifier: ${license}`]
}

const comment = (style: Style, lines: string[]): string => {
  if (style === 'block') return ['/*', ...lines.map(line => ` * ${line.replaceAll('*/', '* /')}`.trimEnd()), ' */'].join('\n')
  if (style === 'html') return ['<!--', ...lines.map(line => `  ${line}`.trimEnd()), '-->'].join('\n')
  return lines.map(line => `${LINE_PREFIX[style]} ${line}`.trimEnd()).join('\n')
}

// PHP has no `//` outside its tag, so its header goes after `<?php`, like a shebang's goes after `#!`.
const withHeader = (content: string, block: string): string => {
  const [first = '', ...rest] = content.split('\n')
  return KEEP_FIRST.test(first) ? [first, block, '', ...rest].join('\n') : `${block}\n\n${content}`
}

export const register: Register = (on, options) => {
  const configured = { license: text(options.license) || 'MIT', holder: text(options.holder), year: text(options.year), custom: text(options.header) }

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const style = styleOf(e.file_path)
    const isPhpTemplate = /\.php$/i.test(e.file_path) && !PHP_CODE_FIRST.test(e.content)
    const isCandidate =
      style !== undefined &&
      !isPhpTemplate &&
      !VENDORED.test(e.file_path) &&
      e.content.trim() !== '' &&
      !HAS_NOTICE.test(e.content.split('\n', NOTICE_SEARCH_LINES).join('\n'))
    if (!isCandidate) return next(e)

    // Only files that do not exist yet; when that cannot be told, leave the write alone.
    const isNew = await $.fs.exists(e.file_path).then(
      exists => !exists,
      () => false,
    )
    if (!isNew) return next(e)

    const year = configured.year || String(new Date(await $.clock.now()).getUTCFullYear())
    const block = comment(style, headerLines({ ...configured, year }))
    const ran = await next({ ...e, content: withHeader(e.content, block) })
    if (ran.deny !== undefined || ran.isError === true) return ran

    $.ui.toast(`license-header: added to ${e.file_path.split(/[\\/]/).at(-1)}`)
    return { ...ran, context: [...(ran.context ?? []), 'license-header: a license header was added at the top of the new file.'] }
  })
}
