import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parsePeekArgs, resolvePath } from '../hooks/args'
import { parseCsv, sniffDelimiter, typeOfText } from '../hooks/table'

type File = { text: string; size?: number; lines?: number }

const CWD = '/work'
const ORDERS = [
  'id,name,price,paid,created,note',
  '1,"Smith, Ann",19.99,true,2024-01-05T10:00:00Z,"first',
  'order"',
  '2,Bob,5,false,2024-01-06 11:30:00,',
  '3,"Cy ""CJ"" Jones",7.5,yes,2024-02-01T00:00:00Z,NULL',
  '',
].join('\n')

/** The machine beneath the plugin: files by absolute path, head and wc answering like the real ones. */
const machine = (on: On, files: Record<string, File>) => {
  const commands: string[][] = []
  const registered: string[] = []
  mock.env(on, { HOME: '/home/ann' })
  on('session.cwd', () => ({ value: CWD }))
  on('fs.stat', (_$, e) => {
    const file = files[e.path]
    return file === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: file.size ?? file.text.length, mtimeMs: 0, isLink: false } }
  })
  on('process.run', (_$, e) => {
    commands.push([...e.argv])
    const file = files[e.argv.at(-1) ?? '']
    const stdout = file === undefined ? '' : e.argv[0] === 'head' ? file.text.slice(0, Number(e.argv[2])) : `  ${file.lines ?? 0} ${e.argv.at(-1)}\n`
    return { value: { exitCode: file === undefined ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
  return { commands, registered }
}

const peek = ($: Engine, args: string) =>
  $.command.run({ command: 'peek', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('a small CSV is read whole: columns, inferred types, empty share and the first rows', async ($, on) => {
  machine(on, { '/work/orders.csv': { text: ORDERS } })

  const { text } = await peek($, 'orders.csv')

  expect(text).toContain('**orders.csv** · 182 B · 3 rows · 6 columns · CSV, delimiter `,` · header row')
  expect(text).toContain('The whole file was read.')
  expect(text).toContain('| 1 | `id` | int | 0% | 1 |')
  expect(text).toContain('| 2 | `name` | string | 0% | Smith, Ann |')
  expect(text).toContain('| 3 | `price` | float | 0% | 19.99 |')
  expect(text).toContain('| 4 | `paid` | bool | 0% | true |')
  expect(text).toContain('| 5 | `created` | datetime | 0% | 2024-01-05T10:00:00Z |')
  expect(text).toContain('| 6 | `note` | string | 67% | first ⏎ order |')
  expect(text).toContain('| 3 | Cy "CJ" Jones | 7.5 | yes | 2024-02-01T00:00:00Z | NULL |')
})

test('a huge file costs one head and one wc: the half record at the cut is left out and rows are counted from the line count', async ($, on) => {
  const text = 'id;city;visits\n1;Oslo;10\n2;Bergen;20\n3;Trond'
  const { commands } = machine(on, { '/data/big.csv': { text, size: 412 * 1024 * 1024, lines: 5_120_331 } })

  const result = await peek($, '/data/big.csv 2')

  expect(commands).toEqual([
    ['head', '-c', '65536', '/data/big.csv'],
    ['wc', '-l', '/data/big.csv'],
  ])
  expect(result.text).toContain('**/data/big.csv** · 412.0 MB · ~5,120,330 rows · 3 columns · CSV, delimiter `;` · header row')
  expect(result.text).toContain('Types come from the first 2 rows (64 KB); the rest of the file was not read.')
  expect(result.text).toContain('| 2 | Bergen | 20 |')
  expect(result.text).not.toContain('Trond')
  expect(result.text).toContain('First 2 rows')
})

test('JSON Lines: columns are the union of the keys, nested values are typed, bad lines are counted', async ($, on) => {
  const lines = [
    '{"id":1,"user":{"name":"a"},"tags":["x"],"ok":true,"at":"2024-03-01T10:00:00Z","score":1.5}',
    '{"id":2,"ok":false,"score":2,"extra":null}',
    'not json',
    '{"id":3,"at":"2024-03-02","score":3}',
  ].join('\n')
  machine(on, { '/work/events.jsonl': { text: `${lines}\n` } })

  const { text } = await peek($, 'events.jsonl 3')

  expect(text).toContain('JSON Lines')
  expect(text).toContain('1 line(s) in the sample were not JSON objects.')
  expect(text).toContain('| 1 | `id` | int | 0% | 1 |')
  expect(text).toContain('| 2 | `user` | object | 67% | {"name":"a"} |')
  expect(text).toContain('| 3 | `tags` | array | 67% | ["x"] |')
  expect(text).toContain('| 5 | `at` | datetime | 33% |')
  expect(text).toContain('| 6 | `score` | float | 0% | 1.5 |')
  expect(text).toContain('| 7 | `extra` | empty | 100% |')
})

test('JSON Lines without a telling extension is recognised by its content', async ($, on) => {
  machine(on, { '/work/dump.log': { text: '{"a":1}\n{"a":2}\n' } })
  expect((await peek($, 'dump.log')).text).toContain('JSON Lines')
})

test('files with no header row keep their first row as data', async ($, on) => {
  machine(on, { '/work/m.tsv': { text: '1\t2.5\t2024-01-01\n2\t3.5\t2024-01-02\n' } })

  const { text } = await peek($, 'm.tsv')

  expect(text).toContain('TSV, delimiter tab · no header row')
  expect(text).toContain('| 1 | `col1` | int | 0% | 1 |')
  expect(text).toContain('| 3 | `col3` | date | 0% | 2024-01-01 |')
})

test('wide files list every column but show only the first ten in the sample rows', async ($, on) => {
  const header = Array.from({ length: 14 }, (_, index) => `c${index + 1}`).join(',')
  machine(on, { '/work/wide.csv': { text: `${header}\n${Array.from({ length: 14 }, (_, index) => index).join(',')}\n` } })

  const { text } = await peek($, 'wide.csv')

  expect(text).toContain('| 14 | `c14` | int | 0% | 13 |')
  expect(text).toContain('First 1 rows (first 10 columns)')
  expect(text).toContain('| c1 | c2 | c3 | c4 | c5 | c6 | c7 | c8 | c9 | c10 | … |')
})

test('paths: quoted, relative, home-relative, rows argument; and the plain-words errors', async ($, on) => {
  machine(on, {
    '/work/my data.csv': { text: 'a,b\n1,2\n' },
    '/home/ann/x.csv': { text: 'a,b\n1,2\n' },
    '/work/bin.csv': { text: 'a\u0000b' },
    '/work/empty.csv': { text: '' },
  })

  expect((await peek($, '"my data.csv" 1')).text).toContain('**my data.csv**')
  expect((await peek($, '~/x.csv')).text).toContain('**~/x.csv**')
  expect((await peek($, '@my data.csv')).text).toContain('**my data.csv**')
  expect((await peek($, 'nope.csv')).text).toBe('Cannot find nope.csv.')
  expect((await peek($, 'bin.csv')).text).toBe('bin.csv does not look like a text file.')
  expect((await peek($, 'empty.csv')).text).toBe('empty.csv has no readable rows in its first 64 KB.')
  expect((await peek($, '')).text).toContain('Usage: /peek <path> [rows]')
})

test('the argument parser and path resolver', () => {
  expect(parsePeekArgs('data.csv')).toEqual({ path: 'data.csv', rows: undefined })
  expect(parsePeekArgs('data.csv 12')).toEqual({ path: 'data.csv', rows: 12 })
  expect(parsePeekArgs("'my data.csv' 7")).toEqual({ path: 'my data.csv', rows: 7 })
  expect(parsePeekArgs('my data.csv')).toEqual({ path: 'my data.csv', rows: undefined })
  expect(parsePeekArgs('@src/x.csv')).toEqual({ path: 'src/x.csv', rows: undefined })
  expect(parsePeekArgs('  ')).toBeUndefined()
  expect(resolvePath('./a.csv', '/work/', undefined)).toBe('/work/a.csv')
  expect(resolvePath('/abs/a.csv', '/work', undefined)).toBe('/abs/a.csv')
  expect(resolvePath('~/a.csv', '/work', '/home/ann/')).toBe('/home/ann/a.csv')
})

test('a full read of a big CSV, TSV or JSONL file is refused and /peek suggested', async ($, on) => {
  machine(on, { '/work/big.csv': { text: '', size: 3 * 1024 * 1024 }, '/work/small.csv': { text: 'a\n', size: 200 * 1024 }, '/work/big.ts': { text: '', size: 3 * 1024 * 1024 } })

  const denied = await $.tool.call({ tool: 'Read', file_path: '/work/big.csv' })
  expect(denied.deny).toContain('csv-peek: /work/big.csv is 3.0 MB, too big to read whole.')
  expect(denied.deny).toContain('offset and limit')
  expect(denied.deny).toContain('/peek /work/big.csv')

  expect((await $.tool.call({ tool: 'Read', file_path: '/work/big.csv', limit: 50 })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/work/small.csv' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/work/big.ts' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/work/missing.csv' })).deny).toBeUndefined()
})

test('the guard threshold is configurable and can be switched off', { options: { maxReadKb: 100 } }, async ($, on) => {
  machine(on, { '/work/a.jsonl': { text: '', size: 150 * 1024 } })
  expect((await $.tool.call({ tool: 'Read', file_path: '/work/a.jsonl' })).deny).toContain('150 KB')
})

test('maxReadKb 0 turns the guard off', { options: { maxReadKb: 0 } }, async ($, on) => {
  machine(on, { '/work/a.csv': { text: '', size: 90 * 1024 * 1024 } })
  expect((await $.tool.call({ tool: 'Read', file_path: '/work/a.csv' })).deny).toBeUndefined()
})

test('registers /peek when the session starts', async ($, on) => {
  const { registered } = machine(on, {})
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['peek'])
})

test('delimiters are sniffed, quotes and doubled quotes parsed, values typed', () => {
  expect(sniffDelimiter('a;b;c\n1;2;3\n')).toBe(';')
  expect(sniffDelimiter('a|b\n1|2\n')).toBe('|')
  expect(sniffDelimiter('"a,b";c\n"x,y";z\n')).toBe(';')
  expect(sniffDelimiter('just words\n')).toBe(',')
  expect(parseCsv('a,"b ""q"" c"\r\n"x\ny",z', ',').rows).toEqual([['a', 'b "q" c'], ['x\ny', 'z']])
  expect(parseCsv('a,"open', ',').isLastOpen).toBe(true)
  const types = ['42', '-3', '007', '1.5', '1e9', 'true', 'No', '2024-01-02', '2024-01-02 10:00', '3/4/2024', 'abc', ''].map(typeOfText)
  expect(types).toEqual(['int', 'int', 'string', 'float', 'float', 'bool', 'bool', 'date', 'datetime', 'date', 'string', 'string'])
})
