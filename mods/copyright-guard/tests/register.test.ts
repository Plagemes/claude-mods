import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { holderOf, isForeign, mergeProject, noticesIn, parseLicenseText, parsePackageJson } from '../hooks/notices'

const MIT_LICENSE = [
  'MIT License',
  '',
  'Copyright (c) 2026 Plagemes',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
].join('\n')
const FACEBOOK_HEADER = '// Copyright (c) 2015-present, Facebook, Inc.\n// All rights reserved.\n'
const APACHE_HEADER = '/*\n * Licensed under the Apache License, Version 2.0 (the "License");\n */\n'

/** A project on a virtual disk (absolute path → text) where every tool call succeeds. */
const world = (on: On, files: Record<string, string>) => {
  const toasts: string[] = []
  mock.clock(on)
  on('session.root', () => ({ value: '/repo' }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { toasts }
}

const MIT_PROJECT = { '/repo/LICENSE': MIT_LICENSE }

test('notes a foreign copyright header in a new file, and toasts', async ($, on) => {
  const { toasts } = world(on, MIT_PROJECT)

  const ran = await $.tool.call({ tool: 'Write', file_path: '/repo/src/vendor-ish.ts', content: `${FACEBOOK_HEADER}export const x = 1\n` })

  const [note] = ran.context ?? []
  expect(note).toContain('/repo/src/vendor-ish.ts')
  expect(note).toContain('Copyright (c) 2015-present, Facebook, Inc.')
  expect(note).toContain('(MIT, © Plagemes)')
  expect(note).toContain('check that its license lets you use it here')
  expect(toasts).toEqual(['other license in vendor-ish.ts: // Copyright (c) 2015-present, Facebook, Inc.'])
})

test('notes a different license in an edit, naming the license line', async ($, on) => {
  world(on, MIT_PROJECT)

  const ran = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: '// todo', new_string: `${APACHE_HEADER}export {}` })

  expect(ran.context?.[0]).toContain('Licensed under the Apache License, Version 2.0')
})

test('says nothing for the project\'s own holder and license', async ($, on) => {
  const { toasts } = world(on, MIT_PROJECT)

  const ran = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/own.ts',
    content: '// Copyright (c) 2026 Plagemes. All rights reserved.\n// SPDX-License-Identifier: MIT\nexport {}\n',
  })

  expect(ran.context).toBeUndefined()
  expect(toasts).toEqual([])
})

test('does not flag a notice the file already had', async ($, on) => {
  const { toasts } = world(on, { ...MIT_PROJECT, '/repo/src/old.ts': `${FACEBOOK_HEADER}export const x = 1\n` })

  const rewritten = await $.tool.call({ tool: 'Write', file_path: '/repo/src/old.ts', content: `${FACEBOOK_HEADER}export const x = 2\n` })
  const edited = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/old.ts',
    old_string: '// All rights reserved.\nexport const x = 1',
    new_string: '// All rights reserved.\nexport const x = 3',
  })

  expect(rewritten.context).toBeUndefined()
  expect(edited.context).toBeUndefined()
  expect(toasts).toEqual([])
})

test('reads the license and author from package.json when there is no LICENSE', async ($, on) => {
  world(on, { '/repo/package.json': JSON.stringify({ name: '@acme/app', license: 'Apache-2.0', author: 'Ana Lopez <ana@acme.test>' }) })

  const own = await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: '// Copyright 2024 Ana Lopez\n// Licensed under the Apache License, Version 2.0\n' })
  const foreign = await $.tool.call({ tool: 'Write', file_path: '/repo/b.ts', content: '// SPDX-License-Identifier: GPL-3.0-or-later\n' })

  expect(own.context).toBeUndefined()
  expect(foreign.context?.[0]).toContain('SPDX-License-Identifier: GPL-3.0-or-later')
  expect(foreign.context?.[0]).toContain('(Apache, © Ana Lopez, acme)')
})

test('with no LICENSE and no package.json it still asks about a notice, saying so', async ($, on) => {
  world(on, {})

  const ran = await $.tool.call({ tool: 'Write', file_path: '/repo/a.py', content: '# Copyright (c) 2019 Someone Else\nprint(1)\n' })

  expect(ran.context?.[0]).toContain('(no license found)')
  expect(ran.context?.[0]).toContain('Copyright (c) 2019 Someone Else')
})

test('leaves license files, vendored code and failed writes alone', async ($, on) => {
  const { toasts } = world(on, MIT_PROJECT)

  const license = await $.tool.call({ tool: 'Write', file_path: '/repo/LICENSE', content: FACEBOOK_HEADER })
  const vendored = await $.tool.call({ tool: 'Write', file_path: '/repo/node_modules/x/index.js', content: FACEBOOK_HEADER })
  const third = await $.tool.call({ tool: 'Write', file_path: '/repo/third_party/lib.c', content: FACEBOOK_HEADER })

  expect([license.context, vendored.context, third.context]).toEqual([undefined, undefined, undefined])
  expect(toasts).toEqual([])
})

test('a failed edit is not commented on', async ($, on) => {
  const toasts: string[] = []
  mock.clock(on)
  on('session.root', () => ({ value: '/repo' }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('tool.call', () => ({ result: 'no match', isError: true, text: 'String to replace not found' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const ran = await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: FACEBOOK_HEADER })

  expect(ran.isError).toBe(true)
  expect(ran.context).toBeUndefined()
  expect(toasts).toEqual([])
})

test('the allow option lists holders and licenses that are fine here', { options: { allow: 'Facebook, Apache-2.0' } }, async ($, on) => {
  world(on, MIT_PROJECT)

  const ran = await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: `${FACEBOOK_HEADER}${APACHE_HEADER}` })

  expect(ran.context).toBeUndefined()
})

test('holderOf pulls the name out of the usual copyright lines', () => {
  expect(holderOf('Copyright (c) 2015-2020 Foo Bar, Inc. All rights reserved.')).toBe('Foo Bar, Inc')
  expect(holderOf(' * Copyright © 2019 Jane Doe <jane@doe.test> (https://doe.test) */')).toBe('Jane Doe')
  expect(holderOf('# (c) 2021, 2022 The Contributors')).toBe('The Contributors')
  expect(holderOf('Copyright [yyyy] [name of copyright owner]')).toBeUndefined()
  expect(holderOf('we respect copyright law')).toBeUndefined()
})

test('noticesIn skips lines that were already there and prose that only mentions copyright', () => {
  const found = noticesIn({
    added: '// Copyright (c) 2020 A\n// copyright law applies\n// SPDX-License-Identifier: MIT OR Apache-2.0\nconst x = 1',
    before: '// Copyright (c) 2020 A',
  })
  expect(found).toEqual([{ text: '// SPDX-License-Identifier: MIT OR Apache-2.0', kind: 'license', families: ['MIT', 'Apache'] }])

  const alone = noticesIn({ added: 'All rights reserved.', before: '' })
  expect(alone).toEqual([{ text: 'All rights reserved.', kind: 'reserved', families: [] }])
})

test('isForeign compares holders by the words that name them, and licenses by family', () => {
  const project = mergeProject([parseLicenseText(MIT_LICENSE), parsePackageJson('{"license":"MIT","author":"Alex Gorbatiuk"}')], [])

  const notice = (text: string) => noticesIn({ added: text, before: '' })[0]!
  expect(isForeign(notice('Copyright (c) 2026 Plagemes contributors'), project)).toBe(false)
  expect(isForeign(notice('Copyright (c) 2026 Alexander Gorbatiuk'), project)).toBe(false)
  expect(isForeign(notice('Copyright (c) 2026 The Authors'), project)).toBe(false)
  expect(isForeign(notice('Copyright (c) 2026'), project)).toBe(false)
  expect(isForeign(notice('Copyright (c) 2026 Globex Corporation'), project)).toBe(true)
  expect(isForeign(notice('SPDX-License-Identifier: MIT'), project)).toBe(false)
  expect(isForeign(notice('GNU General Public License as published by the Free Software Foundation'), project)).toBe(true)
  expect(isForeign(notice('Licensed under the Business Source License'), project)).toBe(true)
})

test('an MPL LICENSE is read as MPL, not as the GPL family it lists as secondary licenses', () => {
  const mpl = [
    'Mozilla Public License Version 2.0',
    '==================================',
    '1.12. "Secondary License"',
    '    means either the GNU General Public License, Version 2.0, the GNU',
    '    Lesser General Public License, Version 2.1, the GNU Affero General',
    '    Public License, Version 3.0, or any later versions of those licenses.',
  ].join('\n')
  const project = mergeProject([parseLicenseText(mpl)], [])

  expect([...project.families]).toEqual(['MPL'])
  expect(isForeign(noticesIn({ added: '// SPDX-License-Identifier: MPL-2.0', before: '' })[0]!, project)).toBe(false)
  expect(parseLicenseText('GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007').families).toEqual(new Set(['LGPL']))
})

test('a footer the app shows is not a pasted header', async ($, on) => {
  const { toasts } = world(on, { '/repo/package.json': JSON.stringify({ name: 'my-site', private: true }) })

  const footer = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/src/Footer.tsx',
    content: [
      'export const Footer = () => (',
      '  <footer>',
      '    <p>© 2024 Acme Inc. All rights reserved.</p>',
      '    <p>© {year} Acme</p>',
      '  </footer>',
      ')',
      "const copyright = `Copyright © ${new Date().getFullYear()} Acme, Inc.`",
      'const label = "© 2024 Acme"',
    ].join('\n'),
  })
  const header = await $.tool.call({ tool: 'Write', file_path: '/repo/src/vendor.js', content: FACEBOOK_HEADER })

  expect(footer.context).toBeUndefined()
  expect(header.context?.[0]).toContain('Copyright (c) 2015-present, Facebook, Inc.')
  expect(toasts).toHaveLength(1)
})
