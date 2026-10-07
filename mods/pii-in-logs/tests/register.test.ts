import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findPii, isScannedFile, maskLine } from '../hooks/scan'

/** The engine beneath the plugin: files on disk, tool calls recorded, toasts recorded. */
const engine = (on: On, files: Record<string, string> = {}) => {
  const seen = { reached: 0, toasts: [] as string[] }
  on('tool.call', () => {
    seen.reached += 1
    return { result: 'ok' }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: 'ENOENT' }))
  return seen
}

const edit = ($: Engine, file_path: string, new_string: string, old_string = 'x') => $.tool.call({ tool: 'Edit', file_path, old_string, new_string })
const reasons = (code: string, before = ''): string[][] => findPii(before, code).map(finding => finding.reasons)

test('in warn mode lets the edit through, tells Claude what prints what, and toasts', async ($, on) => {
  const seen = engine(on)

  const result = await edit($, '/repo/src/login.ts', 'console.log("login", email, password)')

  expect(seen.reached).toBe(1)
  expect(result.context?.[0]).toContain('pii-in-logs: this edit added a log statement to /repo/src/login.ts')
  expect(result.context?.[0]).toContain('- console.log("login", email, password)  (prints email, password)')
  expect(result.context?.[0]).toContain('a hash')
  expect(result.context?.[0]).toContain('pii-in-logs: allow')
  expect(seen.toasts).toEqual(['1 log statement in login.ts may print personal data or secrets'])
})

test('in block mode refuses the edit before it runs', { options: { mode: 'block' } }, async ($, on) => {
  const seen = engine(on)

  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/app.py',
    content: 'import logging\n\ndef login(user):\n    logging.info("user logged in: %s", user)\n',
  })

  expect(seen.reached).toBe(0)
  expect(result.deny).toContain('pii-in-logs: blocked, /repo/app.py would log personal data or secrets')
  expect(result.deny).toContain('line 4: logging.info("user logged in: %s", user)  (prints user (the whole object))')
})

test('a Write is judged against the file it replaces: statements that were already there are not new', async ($, on) => {
  const seen = engine(on, { '/repo/old.js': 'console.log(token)\nconsole.log("ok")\n' })

  const kept = await $.tool.call({ tool: 'Write', file_path: '/repo/old.js', content: 'console.log(token)\nconsole.log("ok")\nconst a = 1\n' })
  const added = await $.tool.call({ tool: 'Write', file_path: '/repo/old.js', content: 'console.log(token)\nconsole.log(token)\n' })

  expect(kept.context).toBeUndefined()
  expect(added.context?.[0]).toContain('line 2: console.log(token)')
  expect(seen.toasts).toHaveLength(1)
})

test('MultiEdit and NotebookEdit are scanned too, and tests, docs and other files are not', async ($, on) => {
  engine(on)

  const multi = (await $.tool.call({
    tool: 'MultiEdit',
    file_path: '/repo/a.go',
    edits: [{ old_string: 'a', new_string: 'fmt.Println("pw", password)' }],
  } as never)) as { context?: readonly string[] }
  const notebook = await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', new_source: 'print(api_key)' })

  expect(multi.context?.[0]).toContain('(prints password)')
  expect(notebook.context?.[0]).toContain('(prints api_key)')
  for (const path of ['/repo/src/login.test.ts', '/repo/tests/test_login.py', '/repo/docs/guide.md', '/repo/login_test.go', '/repo/__tests__/a.js', '/repo/fixtures/x.js', '/repo/data.json']) {
    expect((await edit($, path, 'console.log(password)')).context, path).toBeUndefined()
  }
})

test('the allow marker silences one statement, on its line or the line above', async ($, on) => {
  engine(on)

  const same = await edit($, '/repo/a.ts', 'console.log(user.email) // pii-in-logs: allow')
  const above = await edit($, '/repo/a.ts', '// pii-in-logs: allow, audit log\nlogger.info(user.email)')
  const other = await edit($, '/repo/a.ts', '// pii-in-logs: allow\nconst x = 1\nlogger.info(user.email)')

  expect(same.context).toBeUndefined()
  expect(above.context).toBeUndefined()
  expect(other.context).toBeDefined()
})

test('finds logging calls in every language it knows', () => {
  const flagged = [
    'console.log(password)',
    'console.error("failed", err, req.body)',
    'logger.info({ email }, "signup")',
    'this.logger.warn(`bad token ${token}`)',
    'log.debug("user=%s", user)',
    'print(f"hello {user.email}")',
    'print("pw: %s" % password)',
    'logging.error("x", extra={"phone": phone})',
    'puts "token: #{token}"',
    'Rails.logger.info(user.ssn)',
    'fmt.Printf("token=%s\\n", token)',
    'log.Println(creditCard)',
    'slog.Info("login", "email", email)',
    'System.out.println("pw " + password);',
    'logger.info("card {}", creditCardNumber);',
    'Log.d(TAG, "email " + email)',
    'Timber.d("phone %s", phone)',
    'println("password=$password")',
    'error_log($password);',
    'var_dump($user);',
    'println!("{password}");',
    'tracing::info!(email = %email, "login");',
    'NSLog("%@", password)',
    'Console.WriteLine($"mail {user.Email}");',
    'echo "token: $TOKEN"',
    'console.log(req.headers)',
    "console.log(request.body['card_number'])",
    'console.log(process.env.API_KEY)',
    'console.log(this.user)',
    'logger.debug(JSON.stringify(user))',
    'console.log(dateOfBirth)',
  ]
  for (const code of flagged) expect(findPii('', code).length, code).toBe(1)
})

test('leaves alone what only mentions a sensitive word, or prints a harmless attribute', () => {
  const fine = [
    'console.log("Enter your password:")',
    'console.log("token expired, please sign in again")',
    'logger.info("user created", user.id)',
    'logger.info("signup", { userId: user.id, name: user.name })',
    'console.log(password.length)',
    'console.log(tokens.length, tokenCount, maxTokens, usage.inputTokens)',
    'console.log(emailVerified, isEmailValid, hasPassword)',
    'logger.info({ password: "***" })',
    "print('password=' + '*' * len(password))",
    'print("password", password="[redacted]")',
    'console.log(passwordField, emailInput, tokenType)',
    'console.log(emailRegex.test(value))',
    'console.log(token_type, expires_in)',
    'print("elapsed time with profiling =", elapsed_profile)',
    'console.log(nodeProfile, cacheAccount)',
    'const email = user.email // not a log call',
    'elogger.info(password)',
    'blog.print(token)',
    'obj.print(password)',
    '// console.log(password)',
    '# print(password)',
    'x = "console.log(password)"',
    'console.log(`built ${tokenizer.name}`)',
    'println!("{}", count)',
  ]
  for (const code of fine) expect(findPii('', code), code).toEqual([])
})

test('multi-line calls are read to their closing parenthesis, and only new calls count', () => {
  const call = 'logger.info(\n  "login",\n  { user: user.id,\n    token },\n)\n'
  expect(findPii('', call)).toEqual([{ line: 1, call: 'logger.info( "login", { user: user.id, token }, )', reasons: ['token'] }])
  expect(findPii(call, call + 'const x = 1\n')).toEqual([])
  expect(findPii('console.log(email)\n', 'console.log(email)\nconsole.log(email)\n')).toHaveLength(1)
  expect(findPii('console.log(  email )', 'console.log(email)')).toEqual([])
})

test('reasons name what is printed, once each, and at most three', () => {
  expect(reasons('console.log(user)')).toEqual([['user (the whole object)']])
  expect(reasons('console.log(userProfile, updated_account)')).toEqual([['userProfile (the whole object)', 'updated_account (the whole object)']])
  expect(reasons('console.log(currentUser, req.body)')).toEqual([['currentUser (the whole object)', 'req.body (the whole request body)']])
  expect(reasons('console.log(user.email, user.email, user.phone, user.password, user.ssn)')).toEqual([['user.email', 'user.phone', 'user.password']])
  expect(reasons('console.log(apiKey, API_KEY, api_key)')).toEqual([['apiKey', 'API_KEY', 'api_key']])
})

test('a big file is scanned in a blink, and minified lines are skipped', () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => `const value${i} = compute(a.b.c.d, "text ${i}"); console.log("step", value${i})`)
  const started = Date.now()
  expect(findPii('', lines.join('\n'))).toEqual([])
  expect(findPii('', `${'a.'.repeat(5000)}b;console.log(password)`)).toEqual([])
  expect(Date.now() - started).toBeLessThan(2000)
})

test('docstrings and block comments are prose, not code', () => {
  expect(findPii('', 'def f():\n    \"\"\"Example:\n\n        print(password)\n    \"\"\"\n    return 1\n')).toEqual([])
  expect(findPii('', '/**\n * console.log(token)\n */\nfunction f() {}\n')).toEqual([])
  expect(findPii('', "'''print(password)'''\nprint(email)")).toEqual([{ line: 2, call: 'print(email)', reasons: ['email'] }])
  expect(findPii('', 'const glob = "src/**/*.js"\nconsole.log(email)').length).toBe(1)
  expect(findPii('', '/* a */ console.log(email)').length).toBe(1)
})

test('maskLine blanks strings and cuts comments', () => {
  expect(maskLine('x = "a b" + \'c\' // note')).toBe('x = "   " + \' \' ')
  expect(maskLine('print(a)  # note')).toBe('print(a)  ')
  expect(maskLine('this.#secret = 1')).toBe('this.#secret = 1')
  expect(maskLine('s = "say \\"hi\\" // not a comment"')).toBe(`s = "${' '.repeat(27)}"`)
})

test('isScannedFile: code files only, tests excluded', () => {
  for (const path of ['/r/a.ts', '/r/a.tsx', '/r/a.py', '/r/a.go', '/r/A.java', '/r/a.rs', '/r/a.sh', '/r/Main.kt', '/r/a.ipynb']) expect(isScannedFile(path), path).toBe(true)
  for (const path of ['/r/a.md', '/r/a.json', '/r/a.test.ts', '/r/a.spec.js', '/r/test/a.py', '/r/tests/a.py', '/r/a_test.go', '/r/UserTest.java']) expect(isScannedFile(path), path).toBe(false)
})
