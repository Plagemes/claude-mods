import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RULES, mentionsSecret } from '../hooks/rules'
import type { RuleId } from '../hooks/rules'
import { findWeakCrypto, hitsIn, isScannedFile } from '../hooks/scan'

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
const rulesOf = (code: string): RuleId[] => hitsIn(code).map(hit => hit.rule)

test('in warn mode lets the edit through, tells Claude what is weak and how to fix it, and toasts', async ($, on) => {
  const seen = engine(on)

  const result = await edit($, '/repo/src/auth.ts', "const hash = crypto.createHash('md5').update(password).digest('hex')")

  expect(seen.reached).toBe(1)
  expect(result.context?.[0]).toContain('crypto-guard: this edit added weak cryptography to /repo/src/auth.ts:')
  expect(result.context?.[0]).toContain("- const hash = crypto.createHash('md5').update(password).digest('hex')")
  expect(result.context?.[0]).toContain('-> MD5 or SHA-1. Both are broken for anything security-related: use SHA-256 or better')
  expect(result.context?.[0]).toContain('bcrypt, scrypt or Argon2 for passwords')
  expect(result.context?.[0]).toContain('crypto-guard: allow')
  expect(seen.toasts).toEqual(['weak cryptography in auth.ts: MD5 or SHA-1'])
})

test('in block mode refuses the edit before it runs, with line numbers for a Write', { options: { mode: 'block' } }, async ($, on) => {
  const seen = engine(on)

  const result = await $.tool.call({
    tool: 'Write',
    file_path: '/repo/app/token.py',
    content: 'import random\n\ndef make_token():\n    return "".join(random.choice("abc123") for _ in range(32))\n',
  })

  expect(seen.reached).toBe(0)
  expect(result.deny).toContain('crypto-guard: blocked, /repo/app/token.py would use weak cryptography:')
  expect(result.deny).toContain('- line 4: return "".join(random.choice("abc123") for _ in range(32))')
  expect(result.deny).toContain('-> a predictable random number for a secret.')
})

test('a Write is judged against the file it replaces: weak lines that were already there are not new', async ($, on) => {
  const seen = engine(on, { '/repo/old.js': "const a = createHash('md5')\n" })

  const kept = await $.tool.call({ tool: 'Write', file_path: '/repo/old.js', content: "const a = createHash('md5')\nconst b = 2\n" })
  const added = await $.tool.call({ tool: 'Write', file_path: '/repo/old.js', content: "const a = createHash('md5')\nconst b = createHash('sha1')\n" })

  expect(kept.context).toBeUndefined()
  expect(added.context?.[0]).toContain("line 2: const b = createHash('sha1')")
  expect(seen.toasts).toHaveLength(1)
})

test('MultiEdit and NotebookEdit are scanned; tests, docs and other files are not', async ($, on) => {
  engine(on)

  const multi = (await $.tool.call({
    tool: 'MultiEdit',
    file_path: '/repo/a.go',
    edits: [{ old_string: 'a', new_string: 'tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}' }],
  } as never)) as { context?: readonly string[] }
  const notebook = await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/repo/n.ipynb', new_source: 'requests.get(url, verify=False)' })

  expect(multi.context?.[0]).toContain('TLS certificate verification turned off')
  expect(notebook.context?.[0]).toContain('TLS certificate verification turned off')
  for (const path of ['/repo/src/a.test.ts', '/repo/tests/test_a.py', '/repo/docs/crypto.md', '/repo/a_test.go', '/repo/__tests__/a.js', '/repo/data.json']) {
    expect((await edit($, path, "createHash('md5')")).context, path).toBeUndefined()
  }
})

test('the allow marker silences a line, on it or on the line above', async ($, on) => {
  engine(on)

  expect((await edit($, '/repo/a.js', "const etag = createHash('md5') // crypto-guard: allow")).context).toBeUndefined()
  expect((await edit($, '/repo/a.js', "// crypto-guard: allow, ETag only\nconst etag = createHash('md5')")).context).toBeUndefined()
  expect((await edit($, '/repo/a.js', "// crypto-guard: allow\nconst x = 1\nconst etag = createHash('md5')")).context).toBeDefined()
})

test('MD5 and SHA-1', () => {
  const weak = [
    "const h = crypto.createHash('md5').update(password).digest('hex')",
    'crypto.createHash("sha1")',
    "createHash(`MD5`)",
    'hashlib.md5(password.encode()).hexdigest()',
    'digest = hashlib.sha1(data)',
    "hashlib.new('md5', b'x')",
    'MessageDigest md = MessageDigest.getInstance("MD5");',
    'MessageDigest.getInstance("SHA-1")',
    '$hash = md5($password);',
    'Digest::MD5.hexdigest(pw)',
    'sum := md5.Sum(data)',
    'h := sha1.New()',
    'using var md5 = MD5.Create();',
    "import md5 from 'md5'",
    "const sha1 = require('js-sha1')",
    'crypto.subtle.digest("SHA-1", data)',
    'let digest = Md5::new();',
  ]
  for (const code of weak) expect(rulesOf(code), code).toEqual(['weak-hash'])
  const fine = [
    "crypto.createHash('sha256')",
    'hashlib.sha256(data)',
    'hashlib.md5(data, usedforsecurity=False)',
    'const md5Sum = computeSum(x)',
    'utils.md5(value)',
    '// md5 is broken',
    'x = 1  # uses md5( here',
    "crypto.createHash('sha512')",
  ]
  for (const code of fine) expect(rulesOf(code), code).toEqual([])
})

test('predictable randomness, only where a secret is being made', () => {
  const weak = [
    'const token = Math.random().toString(36).slice(2)',
    'const sessionId = Math.floor(Math.random() * 1e9)',
    'otp = random.randint(100000, 999999)',
    "password = ''.join(random.choice(chars) for _ in range(12))",
    '$nonce = mt_rand();',
    'String resetToken = Long.toString(new Random().nextLong());',
    'const csrf = `${Date.now()}${Math.random()}`',
    'id = str(random.getrandbits(64))  # uuid for the account',
    'const apiKey = Math.random().toString(16)',
    "const token = [...Array(32)]\n  .map(() => Math.random().toString(36)[2])\n  .join('')",
  ]
  for (const code of weak) expect(rulesOf(code), code).toEqual(['predictable-random'])
  const fine = [
    'const delay = Math.random() * 1000',
    'const jitter = random.uniform(0.5, 1.5)',
    'items.map(item => ({ id: Math.random(), label: item }))',
    '<li key={Math.random()}>',
    'const pick = random.choice(options)',
    'const token = crypto.randomBytes(32).toString("hex")',
    'token = secrets.token_hex(16)',
    'nonce = random_bytes(16)',
    'const otp = crypto.randomInt(100000, 999999)',
  ]
  for (const code of fine) expect(rulesOf(code), code).toEqual([])
  expect(rulesOf('package main\nimport "math/rand"\nfunc f() int { secretNumber := rand.Intn(1000000); return secretNumber }')).toEqual(['predictable-random'])
  expect(rulesOf('package main\nimport "crypto/rand"\nfunc f() { token := make([]byte, 32); rand.Read(token) }')).toEqual([])
})

test('ECB mode and the Java default', () => {
  for (const code of [
    "crypto.createCipheriv('aes-256-ecb', key, null)",
    'cipher = AES.new(key, AES.MODE_ECB)',
    'Cipher.getInstance("AES/ECB/PKCS5Padding")',
    'Cipher.getInstance("AES")',
    'Cipher(algorithms.AES(key), modes.ECB())',
    'var mode = CipherMode.ECB;',
    'openssl_encrypt($data, "aes-128-ecb", $key)',
  ]) {
    expect(rulesOf(code), code).toEqual(['ecb-mode'])
  }
  for (const code of ["crypto.createCipheriv('aes-256-gcm', key, iv)", 'Cipher.getInstance("AES/GCM/NoPadding")', 'console.log("ECB is a bad mode")', 'AES.new(key, AES.MODE_GCM)']) {
    expect(rulesOf(code), code).toEqual([])
  }
})

test('fixed IVs and nonces', () => {
  for (const code of [
    "const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')",
    'const iv = Buffer.alloc(16, 0)',
    "iv = b'0123456789abcdef'",
    "crypto.createCipheriv('aes-256-cbc', key, '1234567890123456')",
    "cipher = AES.new(key, AES.MODE_CBC, b'0000000000000000')",
    'Cipher c = new IvParameterSpec(new byte[16]);',
    'iv := []byte("1234567890123456")',
    'iv = bytes(16)',
    "const params = { name: 'AES-GCM', iv: 'abc123' }",
    'new GCMParameterSpec(128, "fixed-nonce".getBytes())',
  ]) {
    expect(rulesOf(code), code).toEqual(['static-iv'])
  }
  for (const code of [
    'const iv = crypto.randomBytes(16)',
    'iv = os.urandom(16)',
    "nonce: ''",
    'const iv = Buffer.alloc(16)',
    'byte[] iv = new byte[16];',
    'const ivLength = 16',
    'iv = get_random_bytes(12)',
  ]) {
    expect(rulesOf(code), code).toEqual([])
  }
})

test('broken ciphers', () => {
  for (const code of ["crypto.createCipher('aes192', password)", "createCipheriv('des-ede3-cbc', key, iv)", 'Cipher.getInstance("DES/CBC/PKCS5Padding")', 'cipher = ARC4.new(key)', 'c, _ := rc4.NewCipher(key)', 'new TripleDESCryptoServiceProvider()']) {
    expect(rulesOf(code), code).toEqual(['weak-cipher'])
  }
  expect(rulesOf("crypto.createCipheriv('aes-256-gcm', key, iv)")).toEqual([])
})

test('low bcrypt cost', () => {
  const low: [string, string][] = [
    ['bcrypt.hash(password, 8)', 'bcrypt cost 8'],
    ['const salt = await bcrypt.genSalt(5)', 'bcrypt cost 5'],
    ['const saltRounds = 8', 'bcrypt cost 8'],
    ['salt = bcrypt.gensalt(rounds=6)', 'bcrypt cost 6'],
    ['BCrypt.hashpw(pw, BCrypt.gensalt(4))', 'bcrypt cost 4'],
    ['new BCryptPasswordEncoder(6)', 'bcrypt cost 6'],
    ['bcrypt.GenerateFromPassword([]byte(pw), 8)', 'bcrypt cost 8'],
    ['bcrypt.GenerateFromPassword(pw, bcrypt.MinCost)', 'bcrypt cost 4'],
    ["password_hash($p, PASSWORD_BCRYPT, ['cost' => 7])", 'bcrypt cost 7'],
    ['bcrypt.hashSync(pw, 4)', 'bcrypt cost 4'],
  ]
  for (const [code, detail] of low) {
    expect(hitsIn(code).map(hit => [hit.rule, hit.detail]), code).toEqual([['bcrypt-cost', detail]])
  }
  for (const code of ['bcrypt.hash(password, 10)', 'bcrypt.hash(password, 12)', 'bcrypt.hash(password, saltRounds)', 'const saltRounds = 12', 'BCRYPT_ROUNDS = 12', 'bcrypt.compare(pw, hash)', 'const retries = 3', 'const config = { rounds: 5 }', 'bcrypt.GenerateFromPassword(pw, bcrypt.DefaultCost)']) {
    expect(rulesOf(code), code).toEqual([])
  }
})

test('unsigned JWTs and switched-off TLS verification', () => {
  for (const code of [
    "jwt.sign(payload, null, { algorithm: 'none' })",
    "jwt.verify(token, key, { algorithms: ['HS256', 'none'] })",
    'jwt.decode(token, options={"verify_signature": False})',
    'payload = jwt.decode(token, verify=False)',
    '{"alg": "none", "typ": "JWT"}',
    'JWT.require(Algorithm.none())',
  ]) {
    expect(rulesOf(code), code).toEqual(['jwt-unsigned'])
  }
  for (const code of [
    'requests.get(url, verify=False)',
    'new https.Agent({ rejectUnauthorized: false })',
    "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'",
    'tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}',
    'curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);',
    'ctx.check_hostname = False',
    'ctx.verify_mode = ssl.CERT_NONE',
    'http.verify_mode = OpenSSL::SSL::VERIFY_NONE',
    'request({ url, strictSSL: false })',
  ]) {
    expect(rulesOf(code), code).toEqual(['tls-verification'])
  }
  for (const code of ["jwt.verify(token, key, { algorithms: ['HS256'] })", "const options = { algorithm: 'HS256' }", 'requests.get(url, verify=True)', 'requests.get(url, verify=ca_bundle)', 'new https.Agent({ rejectUnauthorized: true })']) {
    expect(rulesOf(code), code).toEqual([])
  }
})

test('docstrings and block comments are prose, not code', () => {
  expect(rulesOf('def f():\n    \"\"\"Do not use hashlib.md5(x) or verify=False.\n\n    CERT_NONE is bad.\n    \"\"\"\n    return 1\n')).toEqual([])
  expect(rulesOf('/**\n * createHash("md5")\n */\nfunction f() {}\n')).toEqual([])
  expect(rulesOf("'''md5(x)'''\nh = hashlib.md5(x)")).toEqual(['weak-hash'])
  expect(rulesOf('const glob = "src/**/*.js"\nconst h = createHash("md5")')).toEqual(['weak-hash'])
  expect(rulesOf('base = \'username="%s", nonce="%s"\'')).toEqual([])
})

test('findWeakCrypto compares as a multiset, so only added weak lines count', () => {
  const line = "const a = createHash('md5')"
  expect(findWeakCrypto(line, `${line}\nconst b = 1`)).toEqual([])
  expect(findWeakCrypto(line, `${line}\n${line}`).map(hit => hit.line)).toEqual([2])
  expect(findWeakCrypto("const a = createHash(  'md5' )", "const a = createHash('md5')")).toEqual([])
})

test('rules have wording, the word list reads names, files are filtered', () => {
  for (const rule of Object.values(RULES)) {
    expect(rule.title.length, rule.id).toBeGreaterThan(5)
    expect(rule.advice.length, rule.id).toBeGreaterThan(40)
  }
  expect(mentionsSecret('const apiKey = x')).toBe(true)
  expect(mentionsSecret('const API_KEY = x')).toBe(true)
  expect(mentionsSecret('const sessionId = x')).toBe(true)
  expect(mentionsSecret('const resetCode = x')).toBe(true)
  expect(mentionsSecret('const key = x, id = y, code = z, delay = 3')).toBe(false)
  expect(isScannedFile('/r/a.ts')).toBe(true)
  expect(isScannedFile('/r/Main.java')).toBe(true)
  expect(isScannedFile('/r/a.test.ts')).toBe(false)
  expect(isScannedFile('/r/README.md')).toBe(false)
})
