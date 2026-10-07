import { mentionsSecret } from './rules'
import type { RuleId } from './rules'

/** One line of code that uses cryptography in a weak way. */
export type Hit = {
  rule: RuleId
  /** From 1, in the text that was scanned. */
  line: number
  /** The line, trimmed and cut short. */
  code: string
  /** What is specific about it: `bcrypt cost 8`. */
  detail?: string
}

export const ALLOW_MARKER = 'crypto-guard: allow'

const MAX_CODE_CHARS = 110
const MAX_LINE_CHARS = 2000
const FILE_PATTERN = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kts?|scala|swift|php|cs|rs|dart|lua|c|cc|cpp|cxx|h|hpp|m|mm|ipynb|vue|svelte)$/i
const TEST_PATTERN = /(?:^|[/\\])(?:tests?|__tests__|specs?|fixtures?|mocks?|e2e)[/\\]|\.(?:test|spec)\.[a-z]+$|_test\.(?:go|py|rb)$|(?:Test|Tests|IT)\.(?:java|kt)$/i

/** Code files worth scanning: no docs, no tests (a deliberately weak setup in a test is not a vulnerability). */
export const isScannedFile = (path: string): boolean => FILE_PATTERN.test(path) && !TEST_PATTERN.test(path)

const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|--|;|%)/

const BLOCK_OPENERS = ['"""', "'''", '/*'] as const

/** The first block opener on a line: Python triple quotes anywhere, `/*` only as the first thing on the line. */
const firstOpener = (line: string): { at: number; closer: string } | undefined => {
  const found = BLOCK_OPENERS.map(opener => ({ at: line.indexOf(opener), closer: opener === '/*' ? '*/' : opener }))
    .filter(({ at, closer }) => at !== -1 && (closer !== '*/' || line.slice(0, at).trim() === ''))
    .sort((a, b) => a.at - b.at)
  return found[0]
}

/** The lines with block comments and docstrings blanked: prose in them is not code. */
export const withoutBlocks = (lines: readonly string[]): string[] => {
  const out: string[] = []
  let closer = ''
  for (const line of lines) {
    let rest = line
    let kept = ''
    for (;;) {
      if (closer !== '') {
        const end = rest.indexOf(closer)
        if (end === -1) break
        rest = rest.slice(end + closer.length)
        closer = ''
      }
      const opener = firstOpener(rest)
      if (opener === undefined) {
        kept += rest
        break
      }
      kept += rest.slice(0, opener.at)
      rest = rest.slice(opener.at + opener.closer.length)
      closer = opener.closer
    }
    out.push(kept)
  }
  return out
}

const WEAK_HASH: readonly RegExp[] = [
  /\bcreateHash\s*\(\s*['"`](?:md5|sha-?1)['"`]/i,
  /\bhashlib\.(?:md5|sha1)\s*\(/,
  /\bhashlib\.new\s*\(\s*['"](?:md5|sha-?1)['"]/i,
  /\bMessageDigest\.getInstance\s*\(\s*"(?:MD5|SHA-?1)"/i,
  /(?<![\w.$])(?:md5|sha1)\s*\(/,
  /\bDigest::(?:MD5|SHA1)\b/,
  /\b(?:MD5|SHA1)(?:CryptoServiceProvider|Managed)?\.Create\s*\(|\bnew\s+(?:MD5|SHA1)(?:CryptoServiceProvider|Managed)\b/,
  /\b(?:md5|sha1)\.(?:New|Sum)\s*\(/,
  /\b(?:md5::compute|Md5::new|Sha1::new|Sha1::digest)/,
  /\bcrypto\.subtle\.digest\s*\(\s*['"]SHA-?1['"]/i,
  /\bCC_(?:MD5|SHA1)\b/,
  /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"](?:md5|js-md5|blueimp-md5|spark-md5|sha1|js-sha1|crypto-js\/(?:md5|sha1))['"]/,
]
const NOT_FOR_SECURITY = /usedforsecurity\s*=\s*False/

const RANDOM_CALL =
  /\bMath\.random\s*\(|\brandom\.(?:random|randint|randrange|choice|choices|getrandbits|sample|shuffle|uniform)\s*\(|\bmt_rand\s*\(|(?<![\w.$])rand\s*\(|\buniqid\s*\(|\bnew\s+Random\s*\(|\bThreadLocalRandom\b|\bRandom\.(?:rand|new)\b|\barc4random\b/
const GO_RAND_CALL = /\brand\.(?:Int|Intn|Int31|Int31n|Int63|Int63n|Float64|Uint32|Uint64|Read|Seed)\s*\(/

const ECB_MODE = /\bMODE_ECB\b|\bmodes\.ECB\b|\bCipherMode\.ECB\b|MCRYPT_MODE_ECB|\/ECB\/|[a-z0-9]-ecb\b|\bECB\s*\(\)/i
const JAVA_DEFAULT_ECB = /\bCipher\.getInstance\s*\(\s*"(?:AES|DES|DESede)"\s*\)/

const STATIC_IV: readonly RegExp[] = [
  /\bcreateCipheriv\s*\(\s*[^,()]+,\s*[^,()]+,\s*(?:['"`]|Buffer\.from\s*\(\s*['"`]|Buffer\.alloc\s*\(\s*\d+\s*,)/,
  /\b(?:iv|nonce|init_?vector|initialization_?vector)\b['"]?\s*(?::\s*[\w<>[\]]+\s*)?(?::=|=|:)\s*(?:b?['"`](?=[^'"`%{$])|Buffer\.from\s*\(\s*['"`]|Buffer\.alloc\s*\(\s*\d+\s*,|bytes\s*\(\s*\d+\s*\)|bytearray\s*\(\s*\d+\s*\)|\[\]byte\s*\(\s*"|\[\]byte\s*\{\s*0x|new\s+Uint8Array\s*\(\s*\[|new\s+byte\s*\[\s*\]\s*\{)/i,
  /\bMODE_(?:CBC|CFB|OFB|CTR|GCM)\s*,\s*b?['"]/,
  /\bnew\s+IvParameterSpec\s*\(\s*(?:"|new\s+byte\s*\[\s*\d+\s*\]\s*\))/,
  /\bGCMParameterSpec\s*\(\s*\d+\s*,\s*(?:"[^"]*"\.getBytes|new\s+byte\s*\[)/,
]

const WEAK_CIPHER: readonly RegExp[] = [
  /\bcreateCipher\s*\(/,
  /\bcreateCipheriv\s*\(\s*['"`](?:des|des-ede3?|des3|rc4|rc2|bf|blowfish)[-'"`]/i,
  /\bCipher\.getInstance\s*\(\s*"(?:DES|DESede|RC4|ARCFOUR|Blowfish)/i,
  /\b(?:DES|DES3|ARC4|ARC2|Blowfish)\.new\s*\(/,
  /\bdes\.New(?:TripleDES)?Cipher\b|\brc4\.NewCipher\b/,
  /\bMCRYPT_(?:DES|3DES|RC4)\b/,
  /\bnew\s+(?:DES|TripleDES|RC2)CryptoServiceProvider\b|\bDES\.Create\s*\(/,
]

const MIN_BCRYPT_COST = 10
const BCRYPT_NAMED = /\b(?:rounds|cost|salt_?rounds|work_?factor|log_?rounds)\b['"]?\s*(?:=>|[:=])\s*(\d{1,2})\b/i
const BCRYPT_SETTING = /\b(?:salt_?rounds|bcrypt_?(?:rounds|cost)|BCRYPT_(?:ROUNDS|COST|SALT_ROUNDS))\b\s*[:=]\s*(\d{1,2})\b/i
const BCRYPT_POSITIONAL: readonly RegExp[] = [
  /\bgen_?salt(?:Sync)?\s*\(\s*(\d{1,2})\s*\)/i,
  /\bBCryptPasswordEncoder\s*\(\s*(\d{1,2})\b/,
  /\bGenerateFromPassword\s*\([^,()]+(?:\([^()]*\))?[^,()]*,\s*(\d{1,2})\s*\)/,
  /\bbcrypt\w*\.(?:hash|hashSync|create|hashpw|HashPassword)\s*\([^()]*?,\s*(\d{1,2})\s*[,)]/i,
]

/** The bcrypt cost a line sets when it is below the minimum, or undefined. */
const lowBcryptCost = (line: string): number | undefined => {
  const mentionsBcrypt = /bcrypt|PASSWORD_BCRYPT/i.test(line)
  const candidates = [BCRYPT_SETTING.exec(line)?.[1], mentionsBcrypt ? BCRYPT_NAMED.exec(line)?.[1] : undefined, ...(mentionsBcrypt ? BCRYPT_POSITIONAL.map(pattern => pattern.exec(line)?.[1]) : [])]
  const cost = candidates.find(found => found !== undefined)
  if (/\bbcrypt\.MinCost\b/.test(line)) return 4
  return cost !== undefined && Number(cost) < MIN_BCRYPT_COST && Number(cost) > 0 ? Number(cost) : undefined
}

const JWT_UNSIGNED: readonly RegExp[] = [
  /\balg(?:orithm)?['"]?\s*[:=]\s*['"]none['"]/i,
  /\balgorithms\b['"]?\s*[:=]\s*\[[^\]]*['"]none['"]/i,
  /\bAlgorithm\.none\s*\(/,
  /\bverify_signature['"]?\s*[:=]\s*False\b/i,
]
const TLS_UNVERIFIED: readonly RegExp[] = [
  /\bverify\s*=\s*False\b/,
  /\bssl\s*=\s*False\b/,
  /\b(?:CERT_NONE|_create_unverified_context)\b/,
  /\bcheck_hostname\s*=\s*False\b/,
  /\brejectUnauthorized['"]?\s*:\s*false\b/,
  /NODE_TLS_REJECT_UNAUTHORIZED['"]?\s*(?:=|,)\s*['"]?0/,
  /\bstrictSSL\s*:\s*false\b/,
  /\bInsecureSkipVerify\s*:\s*true\b/,
  /CURLOPT_SSL_VERIFY(?:PEER|HOST)['"]?\s*[,=>]+\s*(?:false|0)\b/i,
  /\bVERIFY_NONE\b/,
  /\bDangerousAcceptAnyServerCertificateValidator\b/,
]

type Context = { usesMathRand: boolean }

const anyOf = (patterns: readonly RegExp[], line: string): boolean => patterns.some(pattern => pattern.test(line))

/** The rule a line breaks and a detail about it, or undefined. `window` is the line and the two before it. */
const judge = (line: string, window: string, context: Context): { rule: RuleId; detail?: string } | undefined => {
  if (anyOf(WEAK_HASH, line) && !NOT_FOR_SECURITY.test(line)) return { rule: 'weak-hash' }
  if (anyOf(WEAK_CIPHER, line)) return { rule: 'weak-cipher' }
  if (ECB_MODE.test(line) || JAVA_DEFAULT_ECB.test(line)) return { rule: 'ecb-mode' }
  if (anyOf(STATIC_IV, line)) return { rule: 'static-iv' }
  const cost = lowBcryptCost(line)
  if (cost !== undefined) return { rule: 'bcrypt-cost', detail: `bcrypt cost ${cost}` }
  if (anyOf(JWT_UNSIGNED, line) || (/\bjwt\b/i.test(line) && /\bverify\s*=\s*False\b/.test(line))) return { rule: 'jwt-unsigned' }
  if (anyOf(TLS_UNVERIFIED, line)) return { rule: 'tls-verification' }
  if ((RANDOM_CALL.test(line) || (context.usesMathRand && GO_RAND_CALL.test(line))) && mentionsSecret(window)) return { rule: 'predictable-random' }
  return undefined
}

const trim = (code: string): string => {
  const line = code.trim()
  return line.length > MAX_CODE_CHARS ? `${line.slice(0, MAX_CODE_CHARS - 1)}…` : line
}

/** Every line of `text` that uses cryptography in a weak way. */
export const hitsIn = (text: string): Hit[] => {
  const lines = text.split('\n')
  const code = withoutBlocks(lines)
  const context: Context = { usesMathRand: /["']math\/rand["']/.test(text) && !/["']crypto\/rand["']/.test(text) }
  const hits: Hit[] = []
  lines.forEach((raw, index) => {
    const own = code[index] as string
    if (raw.length > MAX_LINE_CHARS || own.trim() === '' || COMMENT_LINE.test(own)) return
    if (raw.includes(ALLOW_MARKER) || (lines[index - 1] ?? '').includes(ALLOW_MARKER)) return
    const line = own.replace(/\s(?:\/\/|#)\s.*$/, '')
    const window = code.slice(Math.max(0, index - 2), index + 1).join(' ')
    const verdict = judge(line, window, context)
    if (verdict !== undefined) hits.push({ ...verdict, line: index + 1, code: trim(raw) })
  })
  return hits
}

const keyOf = (hit: Hit): string => `${hit.rule}|${hit.code.replace(/\s+/g, '')}`

/** The weak spots `after` has that `before` does not: a line that was already there is not a new decision. */
export const findWeakCrypto = (before: string, after: string): Hit[] => {
  const known = new Map<string, number>()
  for (const hit of hitsIn(before)) known.set(keyOf(hit), (known.get(keyOf(hit)) ?? 0) + 1)
  return hitsIn(after).filter(hit => {
    const left = known.get(keyOf(hit)) ?? 0
    if (left > 0) {
      known.set(keyOf(hit), left - 1)
      return false
    }
    return true
  })
}
