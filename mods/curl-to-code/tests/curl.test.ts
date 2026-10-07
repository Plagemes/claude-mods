import { describe, expect, test } from 'claude-code/testing'

import { parseCurl, tokenize } from '../hooks/curl'
import type { CurlRequest } from '../hooks/curl'
import { emit, plainJson, quote } from '../hooks/emit'

const parse = (command: string): CurlRequest => {
  const result = parseCurl(command)
  if (!result.ok) throw new Error(result.error)
  return result.request
}

describe('tokenize', () => {
  test('resolves quotes, escapes and line continuations like a shell', () => {
    const { words } = tokenize(`curl -H 'A: b c' -d "x\\"y" it\\'s \\\n  --url=$'tab\\there'`)
    expect(words.map(word => word.text)).toEqual(['curl', '-H', 'A: b c', '-d', 'x"y', "it's", '--url=tab\there'])
  })

  test('stops at a pipe or redirect and flags shell variables', () => {
    const { words } = tokenize('curl -H "Authorization: Bearer $TOKEN" https://x.io 2>&1 | jq .')
    expect(words.map(word => word.text)).toEqual(['curl', '-H', 'Authorization: Bearer $TOKEN', 'https://x.io'])
    expect(words[2]?.isExpanded).toBe(true)
    expect(words[3]?.isExpanded).toBe(false)
  })

  test('reports an unterminated quote', () => {
    expect(tokenize(`curl 'oops`).error).toContain('never closed')
  })
})

describe('parseCurl', () => {
  test('a bare URL is a GET without a scheme added when present, http:// when missing', () => {
    expect(parse('curl https://api.example.com/users')).toMatchObject({ method: 'GET', url: 'https://api.example.com/users', headers: [] })
    expect(parse('curl localhost:3000/health').url).toBe('http://localhost:3000/health')
  })

  test('-X, -H, -d and --data-raw become method, headers and a joined body', () => {
    const request = parse(`curl -X PUT https://x.io/a -H 'Accept: text/plain' -H 'X-Id:7' -d a=1 --data-raw b=2`)
    expect(request.method).toBe('PUT')
    expect(request.headers).toEqual([
      { name: 'Accept', value: 'text/plain' },
      { name: 'X-Id', value: '7' },
      { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    ])
    expect(request.body).toEqual({ kind: 'text', text: 'a=1&b=2' })
  })

  test('data without -X means POST, and --json adds the JSON headers', () => {
    const request = parse(`curl https://x.io --json '{"a":1}'`)
    expect(request.method).toBe('POST')
    expect(request.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Accept', value: 'application/json' },
    ])
    expect(request.body).toEqual({ kind: 'text', text: '{"a":1}' })
  })

  test('short options cluster and take attached values: -sSLk -XPOST', () => {
    const request = parse('curl -sSLk -XPOST https://x.io')
    expect(request.method).toBe('POST')
    expect(request.isInsecure).toBe(true)
  })

  test('-u, -A, -b, -e, -m, -I and --compressed are understood', () => {
    const request = parse(`curl -I --compressed -u ann:s3cret -A 'bot/1' -b 'k=v' -e https://ref.io -m 2.5 https://x.io`)
    expect(request.method).toBe('HEAD')
    expect(request.auth).toEqual({ user: 'ann', password: 's3cret' })
    expect(request.timeoutSeconds).toBe(2.5)
    expect(request.headers.map(row => row.name)).toEqual(['User-Agent', 'Cookie', 'Referer'])
    expect(request.notes).toEqual([])
  })

  test('-F builds multipart parts, with files, filenames and types, and drops a hand-written Content-Type', () => {
    const request = parse(`curl https://x.io/up -H 'Content-Type: multipart/form-data' -F name=Ada -F 'pic=@./me.png;type=image/png;filename=a.png'`)
    expect(request.method).toBe('POST')
    expect(request.headers).toEqual([])
    expect(request.body).toEqual({
      kind: 'form',
      parts: [
        { name: 'name', value: 'Ada', isFile: false, filename: undefined, type: undefined },
        { name: 'pic', value: './me.png', isFile: true, filename: 'a.png', type: 'image/png' },
      ],
    })
  })

  test('-G moves the data into the query string; -d @file is a file body', () => {
    expect(parse('curl -G https://x.io/s -d q=1 -d page=2').url).toBe('https://x.io/s?q=1&page=2')
    expect(parse('curl https://x.io --data-binary @payload.bin').body).toEqual({ kind: 'file', path: 'payload.bin' })
    expect(parse('curl -T up.txt https://x.io')).toMatchObject({ method: 'PUT', body: { kind: 'file', path: 'up.txt' } })
  })

  test('--data-urlencode encodes the value, with or without a name', () => {
    expect(parse(`curl https://x.io --data-urlencode 'q=a b&c' --data-urlencode 'x y'`).body).toEqual({ kind: 'text', text: 'q=a%20b%26c&x%20y' })
  })

  test('skips the values of options it ignores and says so', () => {
    const request = parse('curl -o out.txt --retry 3 --connect-timeout 5 -s https://x.io')
    expect(request.url).toBe('https://x.io')
    expect(request.notes).toEqual(['ignored: --output out.txt', 'ignored: --retry 3', 'ignored: --connect-timeout 5'])
  })

  test('warns about shell variables and extra URLs', () => {
    const request = parse(`curl https://a.io https://b.io -H "Authorization: Bearer $API_TOKEN"`)
    expect(request.notes).toEqual(['1 more URL ignored: one request is generated', 'shell variables stay literal text ($API_TOKEN): read them from your environment'])
  })

  test('tolerates a prompt, a leading curl path and a missing URL', () => {
    expect(parse('$ /usr/bin/curl https://x.io').url).toBe('https://x.io')
    expect(parseCurl('curl -X POST')).toEqual({ ok: false, error: 'no URL found in the curl command' })
  })
})

const JSON_POST = `curl -X POST https://api.example.com/v1/items -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' -d '{"name":"Ada","tags":["a","b"],"ok":true,"n":null,"nested":{"x":1}}'`

describe('emit', () => {
  test('fetch: a GET is one line, a JSON POST uses JSON.stringify and keeps the headers', () => {
    expect(emit(parse('curl https://x.io'), 'fetch').code).toBe(
      "const response = await fetch('https://x.io');\n\nconsole.log(response.status, await response.text());",
    )
    expect(emit(parse(JSON_POST), 'fetch').code).toBe(
      [
        "const response = await fetch('https://api.example.com/v1/items', {",
        "  method: 'POST',",
        '  headers: {',
        "    'Content-Type': 'application/json',",
        "    'Authorization': 'Bearer abc',",
        '  },',
        '  body: JSON.stringify({',
        "    name: 'Ada',",
        "    tags: ['a', 'b'],",
        '    ok: true,',
        '    n: null,',
        '    nested: {',
        '      x: 1,',
        '    },',
        '  }),',
        '});',
        '',
        'console.log(response.status, await response.text());',
      ].join('\n'),
    )
  })

  test('fetch: basic auth, timeout, files and forms', () => {
    const code = emit(parse(`curl -u ann:pw -m 3 -F a=1 -F 'f=@./x.txt;type=text/plain' https://x.io`), 'fetch').code
    expect(code).toContain("import { readFile } from 'node:fs/promises';")
    expect(code).toContain("form.append('a', '1');")
    expect(code).toContain("form.append('f', new Blob([await readFile('./x.txt')], { type: 'text/plain' }), 'x.txt');")
    expect(code).toContain("'Authorization': 'Basic ' + btoa('ann:pw'),")
    expect(code).toContain('signal: AbortSignal.timeout(3000),')
    expect(code).toContain('body: form,')
  })

  test('axios: GET shortcut and a configured POST', () => {
    expect(emit(parse('curl https://x.io/a'), 'axios').code).toBe(
      "import axios from 'axios';\n\nconst response = await axios.get('https://x.io/a');\n\nconsole.log(response.status, response.data);",
    )
    const code = emit(parse(`${JSON_POST} -u ann:pw -k`), 'axios').code
    expect(code).toContain("import https from 'node:https';")
    expect(code).toContain("method: 'post',")
    expect(code).toContain("auth: { username: 'ann', password: 'pw' },")
    expect(code).toContain('httpsAgent: new https.Agent({ rejectUnauthorized: false }),')
    expect(code).toContain("      x: 1,")
  })

  test('python: json= for a JSON body (and no Content-Type header), data= otherwise, True/False/None', () => {
    expect(emit(parse(JSON_POST), 'python').code).toBe(
      [
        'import requests',
        '',
        'response = requests.post(',
        "    'https://api.example.com/v1/items',",
        '    headers={',
        "        'Authorization': 'Bearer abc',",
        '    },',
        '    json={',
        "        'name': 'Ada',",
        "        'tags': ['a', 'b'],",
        "        'ok': True,",
        "        'n': None,",
        "        'nested': {",
        "            'x': 1,",
        '        },',
        '    },',
        ')',
        '',
        'print(response.status_code)',
        'print(response.text)',
      ].join('\n'),
    )
    const form = emit(parse(`curl -d 'a=1&b=2' -u ann:pw -k -m 5 https://x.io`), 'python').code
    expect(form).toContain("data='a=1&b=2',")
    expect(form).toContain("'Content-Type': 'application/x-www-form-urlencoded',")
    expect(form).toContain("auth=('ann', 'pw'),")
    expect(form).toContain('timeout=5,')
    expect(form).toContain('verify=False,')
  })

  test('python: files, and methods requests has no helper for', () => {
    const upload = emit(parse(`curl -F a=1 -F 'f=@./x.txt;type=text/plain' https://x.io`), 'python').code
    expect(upload).toContain("'a': (None, '1'),")
    expect(upload).toContain("'f': ('x.txt', open('./x.txt', 'rb'), 'text/plain'),")
    expect(emit(parse('curl -X PURGE https://x.io'), 'python').code).toContain("response = requests.request('PURGE', 'https://x.io')")
    expect(emit(parse('curl -X PURGE https://x.io -H "A: b"'), 'python').code).toContain("requests.request(\n    'PURGE',\n    'https://x.io',\n    headers={")
  })

  test('go: a complete program with the imports it needs', () => {
    expect(emit(parse(`curl -X POST https://x.io/a -H 'X-Id: 7' -d '{"a":"b"}'`), 'go').code).toBe(
      [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"io"',
        '\t"net/http"',
        '\t"strings"',
        ')',
        '',
        'func main() {',
        '\tpayload := strings.NewReader(`{"a":"b"}`)',
        '\treq, err := http.NewRequest("POST", "https://x.io/a", payload)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\treq.Header.Set("X-Id", "7")',
        '\treq.Header.Set("Content-Type", "application/x-www-form-urlencoded")',
        '',
        '\tclient := http.DefaultClient',
        '\tresp, err := client.Do(req)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tdefer resp.Body.Close()',
        '',
        '\tout, err := io.ReadAll(resp.Body)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tfmt.Println(resp.StatusCode, string(out))',
        '}',
      ].join('\n'),
    )
  })

  test('go: auth, timeout, insecure TLS, Host and multipart', () => {
    const code = emit(parse(`curl -u a:b -k -m 2.5 -H 'Host: api.internal' -F a=1 -F f=@./x.txt https://x.io`), 'go').code
    for (const part of [
      '\t"bytes"', '\t"crypto/tls"', '\t"mime/multipart"', '\t"os"', '\t"time"',
      'req.SetBasicAuth("a", "b")', 'req.Host = "api.internal"', 'Timeout: 2500 * time.Millisecond,',
      'InsecureSkipVerify: true', 'writer.WriteField("a", "1")', 'writer.CreateFormFile("f", "x.txt")',
      'req.Header.Set("Content-Type", writer.FormDataContentType())',
    ]) {
      expect(code).toContain(part)
    }
  })

  test('collects the parser notes and the ones the language adds', () => {
    const { notes } = emit(parse(`curl -o out -F 'f=@x;type=image/png' https://x.io`), 'go')
    expect(notes).toEqual(['ignored: --output out', 'Go: CreateFormFile sends files as application/octet-stream; ;type= was dropped'])
  })
})

describe('literals', () => {
  test('quote picks a quote that needs the fewest escapes and escapes control characters', () => {
    expect(quote("it's")).toBe(`"it's"`)
    expect(quote(`say "hi" it's`)).toBe(`'say "hi" it\\'s'`)
    expect(quote('a\\b\nc\u0001')).toBe("'a\\\\b\\nc\\x01'")
  })

  test('plainJson only accepts JSON that survives being printed again', () => {
    expect(plainJson('{ "a": [1, 2], "b": "x y" }')).toEqual({ a: [1, 2], b: 'x y' })
    expect(plainJson('{"big": 12345678901234567890}')).toBeUndefined()
    expect(plainJson('{"a":1,"a":2}')).toBeUndefined()
    expect(plainJson('{"u":"\\u00e9"}')).toBeUndefined()
    expect(plainJson('42')).toBeUndefined()
    expect(plainJson('not json')).toBeUndefined()
  })

  test('a JSON body that would change when re-printed is sent as the original string', () => {
    const code = emit(parse(`curl -H 'Content-Type: application/json' -d '{"id": 12345678901234567890}' https://x.io`), 'python').code
    expect(code).toContain(`data='{"id": 12345678901234567890}',`)
    expect(code).toContain("'Content-Type': 'application/json',")
  })

  test('fetch leaves out a body it cannot send with GET, and says so (curl -X GET -d, Elasticsearch style)', () => {
    const emitted = emit(parse(`curl -X GET localhost:9200/_search -H 'Content-Type: application/json' -d '{"query":{"match_all":{}}}'`), 'fetch')
    expect(emitted.code).not.toContain('body:')
    expect(emitted.notes.join('\n')).toContain('fetch cannot send a body with GET')
    expect(emit(parse(`curl -X GET localhost:9200/_search -d '{"a":1}'`), 'python').code).toContain('data=')
  })
})
