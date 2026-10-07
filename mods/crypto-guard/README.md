# crypto-guard
> Flags weak cryptography: MD5 or SHA1 for passwords, Math.random for tokens, ECB mode, hard-coded IVs.

**Category:** Privacy & Compliance · **Version:** 1.0.0

## What it does
After every edit, crypto-guard reads the lines the edit added and flags the classic cryptography mistakes, in JavaScript and TypeScript, Python, Java and Kotlin, Go, PHP, Ruby, C#, Rust and more. Claude gets a note naming each line, what is wrong with it and what to use instead.

| Flagged | Examples |
| --- | --- |
| MD5 or SHA-1 | `createHash('md5')`, `hashlib.sha1(...)`, `MessageDigest.getInstance("MD5")`, `md5($password)`, `md5.Sum` |
| Predictable randomness for secrets | `Math.random()`, `random.randint`, `mt_rand`, `new Random()` where the line (or the two before it) names a token, secret, password, OTP, nonce, salt, CSRF value, API key, session or reset code, UUID |
| ECB mode | `aes-256-ecb`, `AES.MODE_ECB`, `AES/ECB/...`, `Cipher.getInstance("AES")` (ECB by default in Java) |
| Fixed IV or nonce | `iv = b'0000...'`, `createCipheriv(..., key, '1234567890123456')`, `Buffer.alloc(16, 0)`, `new IvParameterSpec(new byte[16])` |
| Broken ciphers | DES, 3DES, RC4, `crypto.createCipher` |
| Low bcrypt cost | `bcrypt.hash(pw, 8)`, `saltRounds = 8`, `gensalt(rounds=6)`, `bcrypt.MinCost`, `'cost' => 7` (below 10) |
| Unsigned JWTs | `alg: 'none'`, `algorithms: [..., 'none']`, `verify_signature: False`, `Algorithm.none()` |
| TLS verification off | `verify=False`, `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `InsecureSkipVerify: true`, `CURLOPT_SSL_VERIFYPEER false` |

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install crypto-guard@claude-mods
```

## Usage
Nothing to run. In the default warn mode the edit goes through, you get a toast, and Claude sees:

```
crypto-guard: this edit added weak cryptography to src/auth.ts:
- const hash = crypto.createHash('md5').update(password).digest('hex')
  -> MD5 or SHA-1. Both are broken for anything security-related: use SHA-256 or better for integrity and
     signatures, and bcrypt, scrypt or Argon2 for passwords. For a plain non-security checksum it is fine: mark the line.
If a line is intended (a checksum that is not a security control, a test vector), put "crypto-guard: allow" in a comment on it.
```

In block mode the edit is refused until the line is fixed. `crypto-guard: allow` in a comment on the line, or the line above, silences it (an ETag or a cache key made with MD5 is not a vulnerability).

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | string | `warn` | `warn` lets the edit through and tells Claude; `block` refuses it. |

## How it works
- A `tool.call` hook on `Edit`, `MultiEdit`, `Write` and `NotebookEdit` compares the weak lines in the new text with those in the text it replaces (for a `Write`, the file on disk), so only lines an edit adds are judged. Comments and docstrings are skipped, and so are tests, fixtures, docs and data files.
- The rules are regular expressions over single lines (the random-number rule also reads the two lines before). They look at what the code says, not at what it does.
- Limits: it cannot know that `iv` is filled with random bytes later, that a hash is only used as a cache key, or that a variable is called `token` but holds something else; the allow marker is there for those. It does not find weak cryptography in code it was not shown (dependencies, config files), and it does not check key sizes or PBKDF2 and scrypt parameters.
- With [mods-hub](https://github.com/plagemes/claude-mods/tree/main/mods/mods-hub) installed it publishes `lint.result` (`tool: crypto-guard`, the file, and how many findings) after each edit with findings, sends its warning through `notify` instead of a toast, and in block mode publishes the refusal as `errors`. Without the hub nothing changes; the mod stands alone.
