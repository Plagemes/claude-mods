// Lockfiles written by npm 10, pnpm 10, yarn 1.22 and 4, Poetry 2.4, uv, cargo 1.97 and go 1.24 for a demo project,
// trimmed to a few packages each. The npm one gains a workspace package and its link, as npm writes them.

export const PACKAGE_LOCK_V3 = String.raw`{
  "name": "demo-app",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "demo-app",
      "version": "1.0.0",
      "dependencies": {
        "@sindresorhus/slugify": "1.1.0",
        "express": "4.17.1",
        "lodash": "4.17.15",
        "request": "2.88.2"
      },
      "devDependencies": {
        "@types/node": "18.0.0",
        "minimist": "1.2.0"
      }
    },
    "node_modules/@sindresorhus/slugify": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/@sindresorhus/slugify/-/slugify-1.1.0.tgz",
      "integrity": "sha512-ujZRbmmizX26yS/HnB3P9QNlNa4+UvHh+rIse3RbOXLp8yl6n1TxB4t7NHggtVgS8QmmOtzXo48kCxZGACpkPw==",
      "license": "MIT",
      "dependencies": {
        "@sindresorhus/transliterate": "^0.1.1",
        "escape-string-regexp": "^4.0.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/@sindresorhus/transliterate": {
      "version": "0.1.2",
      "resolved": "https://registry.npmjs.org/@sindresorhus/transliterate/-/transliterate-0.1.2.tgz",
      "integrity": "sha512-5/kmIOY9FF32nicXH+5yLNTX4NJ4atl7jRgqAJuIn/iyDFXBktOKDxCvyGE/EzmF4ngSUvjXxQUQlQiZ5lfw+w==",
      "license": "MIT",
      "dependencies": {
        "escape-string-regexp": "^2.0.0",
        "lodash.deburr": "^4.1.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/@sindresorhus/transliterate/node_modules/escape-string-regexp": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-2.0.0.tgz",
      "integrity": "sha512-UpzcLCXolUWcNu5HtVMHYdXJjArjsF9C0aNnquZYY4uW/Vu0miy5YoWvbV345HauVvcAUnpRuhMMcqTcGOY2+w==",
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/escape-string-regexp": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-4.0.0.tgz",
      "integrity": "sha512-TtpcNJ3XAzx3Gq8sWRzJaVajRs0uVxA2YAkdb1jm2YkPz4G6egUFAyA3n5vtEIZefPk5Wa4UXbKuS5fKkJWdgA==",
      "license": "MIT",
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/@types/node": {
      "version": "18.0.0",
      "resolved": "https://registry.npmjs.org/@types/node/-/node-18.0.0.tgz",
      "integrity": "sha512-cHlGmko4gWLVI27cGJntjs/Sj8th9aYwplmZFwmmgYQQvL5NUsgVJG7OddLvNfLqYS31KFN0s3qlaD9qCaxACA==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/minimist": {
      "version": "1.2.0",
      "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.0.tgz",
      "integrity": "sha512-7Wl+Jz+IGWuSdgsQEJ4JunV0si/iMhg42MnQQG6h1R6TNeVenp4U9x5CC5v/gYqz/fENLQITAWXidNtVL0NNbw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/express": {
      "version": "4.17.1",
      "resolved": "https://registry.npmjs.org/express/-/express-4.17.1.tgz",
      "integrity": "sha512-mHJ9O79RqluphRrcw2X/GTh3k9tVv8YcoyY4Kkh4WDMUYKRZUq0h1o0w2rrrxBqM7VoeUVqgb27xlEMXTnYt4g==",
      "license": "MIT",
      "dependencies": {
        "accepts": "~1.3.7",
        "array-flatten": "1.1.1",
        "body-parser": "1.19.0",
        "content-disposition": "0.5.3",
        "content-type": "~1.0.4",
        "cookie": "0.4.0",
        "cookie-signature": "1.0.6",
        "debug": "2.6.9",
        "depd": "~1.1.2",
        "encodeurl": "~1.0.2",
        "escape-html": "~1.0.3",
        "etag": "~1.8.1",
        "finalhandler": "~1.1.2",
        "fresh": "0.5.2",
        "merge-descriptors": "1.0.1",
        "methods": "~1.1.2",
        "on-finished": "~2.3.0",
        "parseurl": "~1.3.3",
        "path-to-regexp": "0.1.7",
        "proxy-addr": "~2.0.5",
        "qs": "6.7.0",
        "range-parser": "~1.2.1",
        "safe-buffer": "5.1.2",
        "send": "0.17.1",
        "serve-static": "1.14.1",
        "setprototypeof": "1.1.1",
        "statuses": "~1.5.0",
        "type-is": "~1.6.18",
        "utils-merge": "1.0.1",
        "vary": "~1.1.2"
      },
      "engines": {
        "node": ">= 0.10.0"
      }
    },
    "node_modules/lodash": {
      "version": "4.17.15",
      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz",
      "integrity": "sha512-8xOcRHvCjnocdS5cpwXQXVzmmh5e5+saE2QGoeQmbKmRS6J3VQppPOIt0MnmE+4xlZoumy0GPG0D0MVIQbNA1A==",
      "license": "MIT"
    },
    "node_modules/request": {
      "version": "2.88.2",
      "resolved": "https://registry.npmjs.org/request/-/request-2.88.2.tgz",
      "integrity": "sha512-MsvtOrfG9ZcrOwAW+Qi+F6HbD0CWXEh9ou77uOb7FM2WPhwT7smM833PzanhJLsgXjN89Ir6V2PczXNnMpwKhw==",
      "deprecated": "request has been deprecated, see https://github.com/request/request/issues/3142",
      "license": "Apache-2.0",
      "dependencies": {
        "aws-sign2": "~0.7.0",
        "aws4": "^1.8.0",
        "caseless": "~0.12.0",
        "combined-stream": "~1.0.6",
        "extend": "~3.0.2",
        "forever-agent": "~0.6.1",
        "form-data": "~2.3.2",
        "har-validator": "~5.1.3",
        "http-signature": "~1.2.0",
        "is-typedarray": "~1.0.0",
        "isstream": "~0.1.2",
        "json-stringify-safe": "~5.0.1",
        "mime-types": "~2.1.19",
        "oauth-sign": "~0.9.0",
        "performance-now": "^2.1.0",
        "qs": "~6.5.2",
        "safe-buffer": "^5.1.2",
        "tough-cookie": "~2.5.0",
        "tunnel-agent": "^0.6.0",
        "uuid": "^3.3.2"
      },
      "engines": {
        "node": ">= 6"
      }
    },
    "node_modules/accepts": {
      "version": "1.3.8",
      "resolved": "https://registry.npmjs.org/accepts/-/accepts-1.3.8.tgz",
      "integrity": "sha512-PYAthTa2m2VKxuvSD3DPC/Gy+U+sOA1LAuT8mkmRuvw+NACSaeXEQ+NHcVF7rONl6qcaxV3Uuemwawk+7+SJLw==",
      "license": "MIT",
      "dependencies": {
        "mime-types": "~2.1.34",
        "negotiator": "0.6.3"
      },
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/@demo/util": {
      "resolved": "packages/util",
      "link": true
    },
    "packages/util": {
      "name": "@demo/util",
      "version": "0.1.0",
      "license": "MIT"
    }
  }
}
`

export const PNPM_LOCK_V9 = String.raw`lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@sindresorhus/slugify':
        specifier: 1.1.0
        version: 1.1.0
      express:
        specifier: 4.17.1
        version: 4.17.1
      lodash:
        specifier: 4.17.15
        version: 4.17.15
      request:
        specifier: 2.88.2
        version: 2.88.2
    devDependencies:
      '@types/node':
        specifier: 18.0.0
        version: 18.0.0
      minimist:
        specifier: 1.2.0
        version: 1.2.0

packages:

  '@sindresorhus/slugify@1.1.0':
    resolution: {integrity: sha512-ujZRbmmizX26yS/HnB3P9QNlNa4+UvHh+rIse3RbOXLp8yl6n1TxB4t7NHggtVgS8QmmOtzXo48kCxZGACpkPw==}
    engines: {node: '>=10'}

  '@sindresorhus/transliterate@0.1.2':
    resolution: {integrity: sha512-5/kmIOY9FF32nicXH+5yLNTX4NJ4atl7jRgqAJuIn/iyDFXBktOKDxCvyGE/EzmF4ngSUvjXxQUQlQiZ5lfw+w==}
    engines: {node: '>=10'}

  '@types/node@18.0.0':
    resolution: {integrity: sha512-cHlGmko4gWLVI27cGJntjs/Sj8th9aYwplmZFwmmgYQQvL5NUsgVJG7OddLvNfLqYS31KFN0s3qlaD9qCaxACA==}

  body-parser@1.19.0:
    resolution: {integrity: sha512-dhEPs72UPbDnAQJ9ZKMNTP6ptJaionhP5cBb541nXPlW60Jepo9RV/a4fX4XWW9CuFNK22krhrj1+rgzifNCsw==}
    engines: {node: '>= 0.8'}

  escape-string-regexp@2.0.0:
    resolution: {integrity: sha512-UpzcLCXolUWcNu5HtVMHYdXJjArjsF9C0aNnquZYY4uW/Vu0miy5YoWvbV345HauVvcAUnpRuhMMcqTcGOY2+w==}
    engines: {node: '>=8'}

  escape-string-regexp@4.0.0:
    resolution: {integrity: sha512-TtpcNJ3XAzx3Gq8sWRzJaVajRs0uVxA2YAkdb1jm2YkPz4G6egUFAyA3n5vtEIZefPk5Wa4UXbKuS5fKkJWdgA==}
    engines: {node: '>=10'}

  express@4.17.1:
    resolution: {integrity: sha512-mHJ9O79RqluphRrcw2X/GTh3k9tVv8YcoyY4Kkh4WDMUYKRZUq0h1o0w2rrrxBqM7VoeUVqgb27xlEMXTnYt4g==}
    engines: {node: '>= 0.10.0'}

  lodash.deburr@4.1.0:
    resolution: {integrity: sha512-m/M1U1f3ddMCs6Hq2tAsYThTBDaAKFDX3dwDo97GEYzamXi9SqUpjWi/Rrj/gf3X2n8ktwgZrlP1z6E3v/IExQ==}

  lodash@4.17.15:
    resolution: {integrity: sha512-8xOcRHvCjnocdS5cpwXQXVzmmh5e5+saE2QGoeQmbKmRS6J3VQppPOIt0MnmE+4xlZoumy0GPG0D0MVIQbNA1A==}

  minimist@1.2.0:
    resolution: {integrity: sha512-7Wl+Jz+IGWuSdgsQEJ4JunV0si/iMhg42MnQQG6h1R6TNeVenp4U9x5CC5v/gYqz/fENLQITAWXidNtVL0NNbw==}

snapshots:

  '@sindresorhus/slugify@1.1.0':
    dependencies:
      '@sindresorhus/transliterate': 0.1.2
      escape-string-regexp: 4.0.0

  '@sindresorhus/transliterate@0.1.2':
    dependencies:
      escape-string-regexp: 2.0.0
      lodash.deburr: 4.1.0

  '@types/node@18.0.0': {}

  body-parser@1.19.0:
    dependencies:
      bytes: 3.1.0
      content-type: 1.0.5
      debug: 2.6.9
      depd: 1.1.2
      http-errors: 1.7.2
      iconv-lite: 0.4.24
      on-finished: 2.3.0
      qs: 6.7.0
      raw-body: 2.4.0
      type-is: 1.6.18
    transitivePeerDependencies:
      - supports-color

  escape-string-regexp@2.0.0: {}

  escape-string-regexp@4.0.0: {}

  express@4.17.1:
    dependencies:
      accepts: 1.3.8
      array-flatten: 1.1.1
      body-parser: 1.19.0
      content-disposition: 0.5.3
      content-type: 1.0.5
      cookie: 0.4.0
      cookie-signature: 1.0.6
      debug: 2.6.9
      depd: 1.1.2
      encodeurl: 1.0.2
      escape-html: 1.0.3
      etag: 1.8.1
      finalhandler: 1.1.2
      fresh: 0.5.2
      merge-descriptors: 1.0.1
      methods: 1.1.2
      on-finished: 2.3.0
      parseurl: 1.3.3
      path-to-regexp: 0.1.7
      proxy-addr: 2.0.8
      qs: 6.7.0
      range-parser: 1.2.1
      safe-buffer: 5.1.2
      send: 0.17.1
      serve-static: 1.14.1
      setprototypeof: 1.1.1
      statuses: 1.5.0
      type-is: 1.6.18
      utils-merge: 1.0.1
      vary: 1.1.2
    transitivePeerDependencies:
      - supports-color

  lodash.deburr@4.1.0: {}

  lodash@4.17.15: {}

  minimist@1.2.0: {}
`

export const YARN_LOCK_V1 = String.raw`# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@sindresorhus/slugify@1.1.0":
  version "1.1.0"
  resolved "https://registry.yarnpkg.com/@sindresorhus/slugify/-/slugify-1.1.0.tgz#2f195365d9b953384305b62664b44b4036c49430"
  integrity sha512-ujZRbmmizX26yS/HnB3P9QNlNa4+UvHh+rIse3RbOXLp8yl6n1TxB4t7NHggtVgS8QmmOtzXo48kCxZGACpkPw==
  dependencies:
    "@sindresorhus/transliterate" "^0.1.1"
    escape-string-regexp "^4.0.0"

"@sindresorhus/transliterate@^0.1.1":
  version "0.1.2"
  resolved "https://registry.yarnpkg.com/@sindresorhus/transliterate/-/transliterate-0.1.2.tgz#ffce368271d153550e87de81486004f2637425af"
  integrity sha512-5/kmIOY9FF32nicXH+5yLNTX4NJ4atl7jRgqAJuIn/iyDFXBktOKDxCvyGE/EzmF4ngSUvjXxQUQlQiZ5lfw+w==
  dependencies:
    escape-string-regexp "^2.0.0"
    lodash.deburr "^4.1.0"

"@types/node@18.0.0":
  version "18.0.0"
  resolved "https://registry.yarnpkg.com/@types/node/-/node-18.0.0.tgz#67c7b724e1bcdd7a8821ce0d5ee184d3b4dd525a"
  integrity sha512-cHlGmko4gWLVI27cGJntjs/Sj8th9aYwplmZFwmmgYQQvL5NUsgVJG7OddLvNfLqYS31KFN0s3qlaD9qCaxACA==

accepts@~1.3.7:
  version "1.3.8"
  resolved "https://registry.yarnpkg.com/accepts/-/accepts-1.3.8.tgz#0bf0be125b67014adcb0b0921e62db7bffe16b2e"
  integrity sha512-PYAthTa2m2VKxuvSD3DPC/Gy+U+sOA1LAuT8mkmRuvw+NACSaeXEQ+NHcVF7rONl6qcaxV3Uuemwawk+7+SJLw==
  dependencies:
    mime-types "~2.1.34"
    negotiator "0.6.3"

escape-string-regexp@^2.0.0:
  version "2.0.0"
  resolved "https://registry.yarnpkg.com/escape-string-regexp/-/escape-string-regexp-2.0.0.tgz#a30304e99daa32e23b2fd20f51babd07cffca344"
  integrity sha512-UpzcLCXolUWcNu5HtVMHYdXJjArjsF9C0aNnquZYY4uW/Vu0miy5YoWvbV345HauVvcAUnpRuhMMcqTcGOY2+w==

escape-string-regexp@^4.0.0:
  version "4.0.0"
  resolved "https://registry.yarnpkg.com/escape-string-regexp/-/escape-string-regexp-4.0.0.tgz#14ba83a5d373e3d311e5afca29cf5bfad965bf34"
  integrity sha512-TtpcNJ3XAzx3Gq8sWRzJaVajRs0uVxA2YAkdb1jm2YkPz4G6egUFAyA3n5vtEIZefPk5Wa4UXbKuS5fKkJWdgA==

lodash.deburr@^4.1.0:
  version "4.1.0"
  resolved "https://registry.yarnpkg.com/lodash.deburr/-/lodash.deburr-4.1.0.tgz#ddb1bbb3ef07458c0177ba07de14422cb033ff9b"
  integrity sha512-m/M1U1f3ddMCs6Hq2tAsYThTBDaAKFDX3dwDo97GEYzamXi9SqUpjWi/Rrj/gf3X2n8ktwgZrlP1z6E3v/IExQ==

lodash@4.17.15:
  version "4.17.15"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.15.tgz#b447f6670a0455bbfeedd11392eff330ea097548"
  integrity sha512-8xOcRHvCjnocdS5cpwXQXVzmmh5e5+saE2QGoeQmbKmRS6J3VQppPOIt0MnmE+4xlZoumy0GPG0D0MVIQbNA1A==

minimist@1.2.0:
  version "1.2.0"
  resolved "https://registry.yarnpkg.com/minimist/-/minimist-1.2.0.tgz#a35008b20f41383eec1fb914f4cd5df79a264284"
  integrity sha512-7Wl+Jz+IGWuSdgsQEJ4JunV0si/iMhg42MnQQG6h1R6TNeVenp4U9x5CC5v/gYqz/fENLQITAWXidNtVL0NNbw==
`

export const YARN_LOCK_BERRY = String.raw`# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 10
  cacheKey: 10c0

"@sindresorhus/slugify@npm:1.1.0":
  version: 1.1.0
  resolution: "@sindresorhus/slugify@npm:1.1.0"
  dependencies:
    "@sindresorhus/transliterate": "npm:^0.1.1"
    escape-string-regexp: "npm:^4.0.0"
  checksum: 10c0/3af19819c6b2c880a3629f0ed4386383b46d05a8efa7a71d647990a005480f8d6dd3f0348dbf4d37083278de7fb73151aba5fa0ad877b29e77233bb2cdd4e177
  languageName: node
  linkType: hard

"@sindresorhus/transliterate@npm:^0.1.1":
  version: 0.1.2
  resolution: "@sindresorhus/transliterate@npm:0.1.2"
  dependencies:
    escape-string-regexp: "npm:^2.0.0"
    lodash.deburr: "npm:^4.1.0"
  checksum: 10c0/cc5afdcc0eab23c784d5383b3ddf2d15c736f48a404d5fbed6f1db78784e8429f41d1db664f6e68cc81eb73bf769a15ba6afeb176bc4f845b9a5186a40519491
  languageName: node
  linkType: hard

"@types/node@npm:18.0.0":
  version: 18.0.0
  resolution: "@types/node@npm:18.0.0"
  checksum: 10c0/1481061b322bc72544944cd038cc1b037b013336fb63775638d48231a3e9ddf5f99af6f8719b970ccfff60701d86afd0cecfc27cd7ccf78c845f53079dc78ed4
  languageName: node
  linkType: hard

"demo-app@workspace:.":
  version: 0.0.0-use.local
  resolution: "demo-app@workspace:."
  dependencies:
    "@sindresorhus/slugify": "npm:1.1.0"
    "@types/node": "npm:18.0.0"
    express: "npm:4.17.1"
    lodash: "npm:4.17.15"
    minimist: "npm:1.2.0"
    request: "npm:2.88.2"
  languageName: unknown
  linkType: soft

"escape-string-regexp@npm:^2.0.0":
  version: 2.0.0
  resolution: "escape-string-regexp@npm:2.0.0"
  checksum: 10c0/2530479fe8db57eace5e8646c9c2a9c80fa279614986d16dcc6bcaceb63ae77f05a851ba6c43756d816c61d7f4534baf56e3c705e3e0d884818a46808811c507
  languageName: node
  linkType: hard

"escape-string-regexp@npm:^4.0.0":
  version: 4.0.0
  resolution: "escape-string-regexp@npm:4.0.0"
  checksum: 10c0/9497d4dd307d845bd7f75180d8188bb17ea8c151c1edbf6b6717c100e104d629dc2dfb687686181b0f4b7d732c7dfdc4d5e7a8ff72de1b0ca283a75bbb3a9cd9
  languageName: node
  linkType: hard

"lodash.deburr@npm:^4.1.0":
  version: 4.1.0
  resolution: "lodash.deburr@npm:4.1.0"
  checksum: 10c0/30c068e9c3b21d65d260887a8849fa7b94692f868adcc4527136c296b4e71ced7149f58e0f37154d3c56d7950cc605ad3e10b2ee0baedf5638af0befc5013ebc
  languageName: node
  linkType: hard

"lodash@npm:4.17.15":
  version: 4.17.15
  resolution: "lodash@npm:4.17.15"
  checksum: 10c0/c029ab298357d007252d5802348f1deb343099ba734ae6e6776a908e4995db5b8ed4ae51ff83a2937a1f6e3c41a0c8941eb941926e1a7f2ddfc3d235ec1e8aa7
  languageName: node
  linkType: hard

"minimist@npm:1.2.0":
  version: 1.2.0
  resolution: "minimist@npm:1.2.0"
  checksum: 10c0/0c9e882a4d31d217e12223a2881a2cc76a4659c20893c82c92b9355bace60b4a4d52d5fb412755212674765c4dd471e19de85458a400029fdd5d96cb18054aee
  languageName: node
  linkType: hard
`

export const PACKAGE_JSON = String.raw`{ "name": "demo-app", "version": "1.0.0", "private": true,
  "dependencies": { "express": "4.17.1", "lodash": "4.17.15", "@sindresorhus/slugify": "1.1.0", "request": "2.88.2" },
  "devDependencies": { "minimist": "1.2.0", "@types/node": "18.0.0" } }
`

export const POETRY_LOCK = String.raw`# This file is automatically @generated by Poetry 2.4.3 and should not be changed by hand.

[[package]]
name = "django"
version = "3.2"
description = "A high-level Python Web framework that encourages rapid development and clean, pragmatic design."
optional = false
python-versions = ">=3.6"
groups = ["main"]
files = [
    {file = "Django-3.2-py3-none-any.whl", hash = "sha256:0604e84c4fb698a5e53e5857b5aea945b2f19a18f25f10b8748dbdf935788927"},
]

[package.dependencies]
asgiref = ">=3.3.2,<4"
pytz = "*"
sqlparse = ">=0.2.2"

[package.extras]
argon2 = ["argon2-cffi (>=19.1.0)"]
bcrypt = ["bcrypt"]

[[package]]
name = "idna"
version = "2.10"
description = "Internationalized Domain Names in Applications (IDNA)"
optional = false
python-versions = ">=2.7, !=3.0.*, !=3.1.*, !=3.2.*, !=3.3.*"
groups = ["main"]
files = [
    {file = "idna-2.10-py2.py3-none-any.whl", hash = "sha256:b97d804b1e9b523befed77c48dacec60e6dcb0b5391d57af6a65a312a90648c0"},
]

[[package]]
name = "iniconfig"
version = "2.3.1"
description = "brain-dead simple config-ini parsing"
optional = false
python-versions = ">=3.10"
groups = ["dev"]
files = [
    {file = "iniconfig-2.3.1-py3-none-any.whl", hash = "sha256:9121e2c1fdb355232495be3194c8dfe87ccc2d5dee45947b78e68f499790d7a7"},
]

[[package]]
name = "pytest"
version = "8.4.2"
description = "pytest: simple powerful testing with Python"
optional = false
python-versions = ">=3.9"
groups = ["dev"]
files = [
    {file = "pytest-8.4.2-py3-none-any.whl", hash = "sha256:872f880de3fc3a5bdc88a11b39c9710c3497a547cfa9320bc3c5e62fbf272e79"},
]

[package.dependencies]
colorama = {version = ">=0.4", markers = "sys_platform == \"win32\""}
exceptiongroup = {version = ">=1", markers = "python_version < \"3.11\""}
iniconfig = ">=1"
packaging = ">=20"
pluggy = ">=1.5,<2"
pygments = ">=2.7.2"
tomli = {version = ">=1", markers = "python_version < \"3.11\""}

[package.extras]
dev = ["argcomplete", "attrs (>=19.2)", "hypothesis (>=3.56)", "mock", "requests", "setuptools", "xmlschema"]

[[package]]
name = "requests"
version = "2.25.1"
description = "Python HTTP for Humans."
optional = false
python-versions = ">=2.7, !=3.0.*, !=3.1.*, !=3.2.*, !=3.3.*, !=3.4.*"
groups = ["main"]
files = [
    {file = "requests-2.25.1-py2.py3-none-any.whl", hash = "sha256:c210084e36a42ae6b9219e00e48287def368a26d03a048ddad7bfee44f75871e"},
]

[package.dependencies]
certifi = ">=2017.4.17"
chardet = ">=3.0.2,<5"
idna = ">=2.5,<3"
urllib3 = ">=1.21.1,<1.27"

[package.extras]
security = ["cryptography (>=1.3.4)", "pyOpenSSL (>=0.14)"]
socks = ["PySocks (>=1.5.6,!=1.5.7)", "win-inet-pton ; sys_platform == \"win32\" and python_version == \"2.7\""]

[metadata]
lock-version = "2.1"
python-versions = "^3.10"
content-hash = "1f8d5feade855580e4da6d7bc1f00f78a8450a4c0d5bacbc75c18968175515f3"
`

export const UV_LOCK = String.raw`version = 1
revision = 3
requires-python = ">=3.13"

[[package]]
name = "certifi"
version = "2026.7.22"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/a3/c2/24167ea9858356b47a87a50d39908bfdb72ceeefe0041586e704e5376b3a/certifi-2026.7.22.tar.gz", hash = "sha256:741e2c3b351ddf169a738da9f2c048608ff7f2c5cc02f1ebc6b118bb090d5d55", size = 138112, upload-time = "2026-07-22T03:35:12.644Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/0b/a7/71ac2cff56fec219ed242bb11b8efb69fcc4bec75db06fb7bfe35de520e6/certifi-2026.7.22-py3-none-any.whl", hash = "sha256:62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775", size = 136983, upload-time = "2026-07-22T03:35:11.276Z" },
]

[[package]]
name = "chardet"
version = "4.0.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/ee/2d/9cdc2b527e127b4c9db64b86647d567985940ac3698eeabc7ffaccb4ea61/chardet-4.0.0.tar.gz", hash = "sha256:0d6f53a15db4120f2b08c94f11e7d93d2c911ee118b6b30a04ec3ee8310179fa", size = 1907771, upload-time = "2020-12-10T19:35:33.971Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/19/c7/fa589626997dd07bd87d9269342ccb74b1720384a4d739a1872bd84fbe68/chardet-4.0.0-py2.py3-none-any.whl", hash = "sha256:f864054d66fd9118f2e67044ac8981a54775ec5b67aed0441892edb553d21da5", size = 178743, upload-time = "2020-12-10T19:35:32.469Z" },
]

[[package]]
name = "colorama"
version = "0.4.6"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/d8/53/6f443c9a4a8358a93a6792e2acffb9d9d5cb0a5cfd8802644b7b1c9a02e4/colorama-0.4.6.tar.gz", hash = "sha256:08695f5cb7ed6e0531a20572697297273c47b8cae5a63ffc6d6ed5c201be6e44", size = 27697, upload-time = "2022-10-25T02:36:22.414Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/d1/d6/3965ed04c63042e047cb6a3e6ed1a63a35087b6a609aa3a15ed8ac56c221/colorama-0.4.6-py2.py3-none-any.whl", hash = "sha256:4f1d9991f5acc0ca119f9d443620b77f9d6b33703e51011c16baf57afb285fc6", size = 25335, upload-time = "2022-10-25T02:36:20.889Z" },
]

[[package]]
name = "demo-py"
version = "0.1.0"
source = { virtual = "." }
dependencies = [
    { name = "jinja2" },
    { name = "markupsafe" },
    { name = "requests" },
]

[package.dev-dependencies]
dev = [
    { name = "pytest" },
]

[package.metadata]
requires-dist = [
    { name = "jinja2", specifier = "==2.11.2" },
    { name = "markupsafe", specifier = "<2.1" },
    { name = "requests", specifier = "==2.25.1" },
]

[package.metadata.requires-dev]
dev = [{ name = "pytest", specifier = ">=9.1.1" }]

[[package]]
name = "idna"
version = "2.10"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/ea/b7/e0e3c1c467636186c39925827be42f16fee389dc404ac29e930e9136be70/idna-2.10.tar.gz", hash = "sha256:b307872f855b18632ce0c21c5e45be78c0ea7ae4c15c828c20788b26921eb3f6", size = 175616, upload-time = "2020-06-27T23:45:05.21Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/a2/38/928ddce2273eaa564f6f50de919327bf3a00f091b5baba8dfa9460f3a8a8/idna-2.10-py2.py3-none-any.whl", hash = "sha256:b97d804b1e9b523befed77c48dacec60e6dcb0b5391d57af6a65a312a90648c0", size = 58811, upload-time = "2020-06-27T23:45:03.457Z" },
]

[[package]]
name = "iniconfig"
version = "2.3.1"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/01/e1/2069291243c926a2ff1cd706c7f3eeb9b62144bf60f77c9fb9ff2fb26bd3/iniconfig-2.3.1.tar.gz", hash = "sha256:67f4b9c50da0dedf52af349e7749a80a9057a5031199791b906c3bb3ae878960", size = 21209, upload-time = "2026-10-06T22:48:38.076Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/56/43/4ca9e49d27a1fcf6bece6f6aec0ea46bb9112489b93d4b688fb415457bdb/iniconfig-2.3.1-py3-none-any.whl", hash = "sha256:9121e2c1fdb355232495be3194c8dfe87ccc2d5dee45947b78e68f499790d7a7", size = 7552, upload-time = "2026-10-06T22:48:36.959Z" },
]

[[package]]
name = "jinja2"
version = "2.11.2"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "markupsafe" },
]
sdist = { url = "https://files.pythonhosted.org/packages/64/a7/45e11eebf2f15bf987c3bc11d37dcc838d9dc81250e67e4c5968f6008b6c/Jinja2-2.11.2.tar.gz", hash = "sha256:89aab215427ef59c34ad58735269eb58b1a5808103067f7bb9d5836c651b3bb0", size = 257594, upload-time = "2020-04-13T16:16:46.75Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/30/9e/f663a2aa66a09d838042ae1a2c5659828bb9b41ea3a6efa20a20fd92b121/Jinja2-2.11.2-py2.py3-none-any.whl", hash = "sha256:f0a4641d3cf955324a89c04f3d94663aa4d638abe8f733ecd3582848e1c37035", size = 125774, upload-time = "2020-04-13T16:16:44.917Z" },
]

[[package]]
name = "markupsafe"
version = "2.0.1"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/bf/10/ff66fea6d1788c458663a84d88787bae15d45daa16f6b3ef33322a51fc7e/MarkupSafe-2.0.1.tar.gz", hash = "sha256:594c67807fb16238b30c44bdf74f36c02cdf22d1c8cda91ef8a0ed8dabf5620a", size = 18596, upload-time = "2021-05-18T17:18:22.856Z" }

[[package]]
name = "packaging"
version = "26.3"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/7d/fa/3944b40b07da9ce895c0e6303a5ab7d53da063554f534556b134a54d6093/packaging-26.3.tar.gz", hash = "sha256:94edc256424af38762eb31306eed28beb9f0efc50a8837492c9d6fd6004aed79", size = 313412, upload-time = "2026-08-04T18:15:28.737Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/63/34/ba1c580383c9eada3711951fef0795c80b829a078d72188184bcab9dd527/packaging-26.3-py3-none-any.whl", hash = "sha256:d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c", size = 129956, upload-time = "2026-08-04T18:15:27.159Z" },
]

[[package]]
name = "pluggy"
version = "1.6.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/f9/e2/3e91f31a7d2b083fe6ef3fa267035b518369d9511ffab804f839851d2779/pluggy-1.6.0.tar.gz", hash = "sha256:7dcc130b76258d33b90f61b658791dede3486c3e6bfb003ee5c9bfb396dd22f3", size = 69412, upload-time = "2025-05-15T12:30:07.975Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/54/20/4d324d65cc6d9205fabedc306948156824eb9f0ee1633355a8f7ec5c66bf/pluggy-1.6.0-py3-none-any.whl", hash = "sha256:e920276dd6813095e9377c0bc5566d94c932c33b27a3e3945d8389c374dd4746", size = 20538, upload-time = "2025-05-15T12:30:06.134Z" },
]

[[package]]
name = "pygments"
version = "2.21.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/49/2e/ced460408999b33da6b31b0021b0f37d329e202d4169aeb164493778f25b/pygments-2.21.0.tar.gz", hash = "sha256:610ca751c9bc2492b38eb9a38a7fbc93edbbb2d7182edaf34e66ae493dee5c8c", size = 5005329, upload-time = "2026-08-17T08:02:48.824Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/71/46/17f022dd3e953bf20a04a028a21ec746d942f8d2af30fa0f124fa0e6a684/pygments-2.21.0-py3-none-any.whl", hash = "sha256:2363c69b61c4a97c838da3b130dcd6468f4848992b21a82f2a63ec34377137d9", size = 1250147, upload-time = "2026-08-17T08:02:44.912Z" },
]

[[package]]
name = "pytest"
version = "9.1.1"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "colorama", marker = "sys_platform == 'win32'" },
    { name = "iniconfig" },
    { name = "packaging" },
    { name = "pluggy" },
    { name = "pygments" },
]
sdist = { url = "https://files.pythonhosted.org/packages/e4/47/b9efed96c114afcfa3c9d3fe98a76a1d14c74a9e266d397cf6eb64be5e01/pytest-9.1.1.tar.gz", hash = "sha256:1088fbde8f2b49d95a549a195707afa7a76a3ce9bcadc26b6d71f0ffda5fe313", size = 1636369, upload-time = "2026-06-19T10:58:32.857Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/24/25/1de2678b631f5a49215c6c96fff41ba892b0a34df68d6d80292b1b48aa7f/pytest-9.1.1-py3-none-any.whl", hash = "sha256:37a86b45efb9a47a61a36449063e8e18d0cab3161329fc099eb21783169c4f0c", size = 386536, upload-time = "2026-06-19T10:58:31.347Z" },
]

[[package]]
name = "requests"
version = "2.25.1"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "certifi" },
    { name = "chardet" },
    { name = "idna" },
    { name = "urllib3" },
]
sdist = { url = "https://files.pythonhosted.org/packages/6b/47/c14abc08432ab22dc18b9892252efaf005ab44066de871e72a38d6af464b/requests-2.25.1.tar.gz", hash = "sha256:27973dd4a904a4f13b263a19c866c13b92a39ed1c964655f025f3f8d3d75b804", size = 102161, upload-time = "2020-12-16T19:38:36.779Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/29/c1/24814557f1d22c56d50280771a17307e6bf87b70727d975fd6b2ce6b014a/requests-2.25.1-py2.py3-none-any.whl", hash = "sha256:c210084e36a42ae6b9219e00e48287def368a26d03a048ddad7bfee44f75871e", size = 61216, upload-time = "2020-12-16T19:38:34.329Z" },
]

[[package]]
name = "urllib3"
version = "1.26.20"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/e4/e8/6ff5e6bc22095cfc59b6ea711b687e2b7ed4bdb373f7eeec370a97d7392f/urllib3-1.26.20.tar.gz", hash = "sha256:40c2dc0c681e47eb8f90e7e27bf6ff7df2e677421fd46756da1161c39ca70d32", size = 307380, upload-time = "2024-08-29T15:43:11.37Z" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/33/cf/8435d5a7159e2a9c83a95896ed596f68cf798005fe107cc655b5c5c14704/urllib3-1.26.20-py2.py3-none-any.whl", hash = "sha256:0ed14ccfbf1c30a9072c7ca157e4319b70d65f623e91e7b32fadb2853431016e", size = 144225, upload-time = "2024-08-29T15:43:08.921Z" },
]
`

export const CARGO_LOCK = String.raw`# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 4

[[package]]
name = "demo-rs"
version = "0.1.0"
dependencies = [
 "serde",
 "time",
]

[[package]]
name = "libc"
version = "0.2.190"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "ce5d3ddc6d3fa000eb1536d85e147bfe31aacaba692ed6a876f95cb7c855be78"

[[package]]
name = "proc-macro2"
version = "1.0.107"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "985e7ec9bb745e6ce6535b544d84d6cd6f7ad8bd711c398938ae983b91a766d9"
dependencies = [
 "unicode-ident",
]

[[package]]
name = "quote"
version = "1.0.47"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "1fbf4db142a473a8d80c26bbf18454ed458bf8d26c8219c331daecfdbd079001"
dependencies = [
 "proc-macro2",
]

[[package]]
name = "serde"
version = "1.0.229"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "4148590afebada386688f18773da617792bf2ef03ffc1e4cbd2b1d45b023e0ba"
dependencies = [
 "serde_core",
 "serde_derive",
]

[[package]]
name = "serde_core"
version = "1.0.229"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "67dca2c9c51e58a4791a4b1ed58308b39c64224d349a935ab5039aa360942a48"
dependencies = [
 "serde_derive",
]

[[package]]
name = "serde_derive"
version = "1.0.229"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "e7a5d71263a5a7d47b41f6b3f06ba276f10cc18b0931f1799f710578e2309348"
dependencies = [
 "proc-macro2",
 "quote",
 "syn",
]

[[package]]
name = "syn"
version = "3.0.6"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "8593e8e72159ed2257d083c7a454a85cbf854f37a0966d8d483aff8c8a3ebcee"
dependencies = [
 "proc-macro2",
 "quote",
 "unicode-ident",
]

[[package]]
name = "time"
version = "0.1.45"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "1b797afad3f312d1c66a56d11d0316f916356d11bd158fbc6ca6389ff6bf805a"
dependencies = [
 "libc",
 "wasi",
 "winapi",
]

[[package]]
name = "unicode-ident"
version = "1.0.26"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "d245f478577f809a851594d02313b640fb437e0bb33866753cff937863096954"

[[package]]
name = "wasi"
version = "0.10.0+wasi-snapshot-preview1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "1a143597ca7c7793eff794def352d41792a93c481eb1042423ff7ff72ba2c31f"

[[package]]
name = "winapi"
version = "0.3.9"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "5c839a674fcd7a98952e593242ea400abe93992746761e38641405d28b00f419"
dependencies = [
 "winapi-i686-pc-windows-gnu",
 "winapi-x86_64-pc-windows-gnu",
]

[[package]]
name = "winapi-i686-pc-windows-gnu"
version = "0.4.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "ac3b87c63620426dd9b991e5ce0329eff545bccbbb34f3be09ff6fb6ab51b7b6"

[[package]]
name = "winapi-x86_64-pc-windows-gnu"
version = "0.4.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "712e227841d057c1ee1cd2fb22fa7e5a5461ae8e48fa2ca79ec42cfc1931183f"
`

export const GO_MOD = String.raw`module example.com/demo

go 1.22

require (
	github.com/gin-gonic/gin v1.7.0
	github.com/google/uuid v1.3.0
	golang.org/x/text v0.3.7
)

require (
	github.com/gin-contrib/sse v0.1.0 // indirect
	github.com/go-playground/locales v0.13.0 // indirect
	github.com/go-playground/universal-translator v0.17.0 // indirect
	github.com/go-playground/validator/v10 v10.4.1 // indirect
	github.com/golang/protobuf v1.3.3 // indirect
	github.com/json-iterator/go v1.1.9 // indirect
	github.com/leodido/go-urn v1.2.0 // indirect
	github.com/mattn/go-isatty v0.0.12 // indirect
	github.com/modern-go/concurrent v0.0.0-20180228061459-e0a39a4cb421 // indirect
	github.com/modern-go/reflect2 v0.0.0-20180701023420-4b7aa43c6742 // indirect
	github.com/ugorji/go/codec v1.1.7 // indirect
	golang.org/x/crypto v0.0.0-20200622213623-75b288015ac9 // indirect
	golang.org/x/sys v0.0.0-20200116001909-b77594299b42 // indirect
	gopkg.in/yaml.v2 v2.2.8 // indirect
)
`

export const GO_SUM = String.raw`github.com/davecgh/go-spew v1.1.0/go.mod h1:J7Y8YcW2NihsgmVo/mv3lAwl/skON4iLHjSsI+c5H38=
github.com/davecgh/go-spew v1.1.1 h1:vj9j/u1bqnvCEfJOwUhtlOARqs3+rkHYY13jYWTU97c=
github.com/davecgh/go-spew v1.1.1/go.mod h1:J7Y8YcW2NihsgmVo/mv3lAwl/skON4iLHjSsI+c5H38=
github.com/gin-contrib/sse v0.1.0 h1:Y/yl/+YNO8GZSjAhjMsSuLt29uWRFHdHYUb5lYOV9qE=
github.com/gin-contrib/sse v0.1.0/go.mod h1:RHrZQHXnP2xjPF+u1gW/2HnVO7nvIa9PG3Gm+fLHvGI=
github.com/gin-gonic/gin v1.7.0 h1:jGB9xAJQ12AIGNB4HguylppmDK1Am9ppF7XnGXXJuoU=
github.com/gin-gonic/gin v1.7.0/go.mod h1:jD2toBW3GZUr5UMcdrwQA10I7RuaFOl/SGeDjXkfUtY=
github.com/go-playground/assert/v2 v2.0.1 h1:MsBgLAaY856+nPRTKrp3/OZK38U/wa0CcBYNjji3q3A=
github.com/go-playground/assert/v2 v2.0.1/go.mod h1:VDjEfimB/XKnb+ZQfWdccd7VUvScMdVu0Titje2rxJ4=
github.com/go-playground/locales v0.13.0 h1:HyWk6mgj5qFqCT5fjGBuRArbVDfE4hi8+e8ceBS/t7Q=
github.com/go-playground/locales v0.13.0/go.mod h1:taPMhCMXrRLJO55olJkUXHZBHCxTMfnGwq/HNwmWNS8=
github.com/go-playground/universal-translator v0.17.0 h1:icxd5fm+REJzpZx7ZfpaD876Lmtgy7VtROAbHHXk8no=
github.com/go-playground/universal-translator v0.17.0/go.mod h1:UkSxE5sNxxRwHyU+Scu5vgOQjsIJAF8j9muTVoKLVtA=
github.com/go-playground/validator/v10 v10.4.1 h1:pH2c5ADXtd66mxoE0Zm9SUhxE20r7aM3F26W0hOn+GE=
github.com/go-playground/validator/v10 v10.4.1/go.mod h1:nlOn6nFhuKACm19sB/8EGNn9GlaMV7XkbRSipzJ0Ii4=
github.com/golang/protobuf v1.3.3 h1:gyjaxf+svBWX08ZjK86iN9geUJF0H6gp2IRKX6Nf6/I=
github.com/golang/protobuf v1.3.3/go.mod h1:vzj43D7+SQXF/4pzW/hwtAqwc6iTitCiVSaWz5lYuqw=
github.com/google/gofuzz v1.0.0/go.mod h1:dBl0BpW6vV/+mYPU4Po3pmUjxk6FQPldtuIdl/M65Eg=
github.com/google/uuid v1.3.0 h1:t6JiXgmwXMjEs8VusXIJk2BXHsn+wx8BZdTaoZ5fu7I=
github.com/google/uuid v1.3.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=
github.com/json-iterator/go v1.1.9 h1:9yzud/Ht36ygwatGx56VwCZtlI/2AD15T1X2sjSuGns=
github.com/json-iterator/go v1.1.9/go.mod h1:KdQUCv79m/52Kvf8AW2vK1V8akMuk1QjK/uOdHXbAo4=
github.com/leodido/go-urn v1.2.0 h1:hpXL4XnriNwQ/ABnpepYM/1vCLWNDfUNts8dX3xTG6Y=
github.com/leodido/go-urn v1.2.0/go.mod h1:+8+nEpDfqqsY+g338gtMEUOtuK+4dEMhiQEgxpxOKII=
github.com/mattn/go-isatty v0.0.12 h1:wuysRhFDzyxgEmMf5xjvJ2M9dZoWAXNNr5LSBS7uHXY=
github.com/mattn/go-isatty v0.0.12/go.mod h1:cbi8OIDigv2wuxKPP5vlRcQ1OAZbq2CE4Kysco4FUpU=
github.com/modern-go/concurrent v0.0.0-20180228061459-e0a39a4cb421 h1:ZqeYNhU3OHLH3mGKHDcjJRFFRrJa6eAM5H+CtDdOsPc=
github.com/modern-go/concurrent v0.0.0-20180228061459-e0a39a4cb421/go.mod h1:6dJC0mAP4ikYIbvyc7fijjWJddQyLn8Ig3JB5CqoB9Q=
github.com/modern-go/reflect2 v0.0.0-20180701023420-4b7aa43c6742 h1:Esafd1046DLDQ0W1YjYsBW+p8U2u7vzgW2SQVmlNazg=
github.com/modern-go/reflect2 v0.0.0-20180701023420-4b7aa43c6742/go.mod h1:bx2lNnkwVCuqBIxFjflWJWanXIb3RllmbCylyMrvgv0=
github.com/pmezard/go-difflib v1.0.0 h1:4DBwDE0NGyQoBHbLQYPwSUPoCMWR5BEzIk/f1lZbAQM=
github.com/pmezard/go-difflib v1.0.0/go.mod h1:iKH77koFhYxTK1pcRnkKkqfTogsbg7gZNVY4sRDYZ/4=
github.com/stretchr/objx v0.1.0/go.mod h1:HFkY916IF+rwdDfMAkV7OtwuqBVzrE8GR6GFx+wExME=
github.com/stretchr/testify v1.3.0/go.mod h1:M5WIy9Dh21IEIfnGCwXGc5bZfKNJtfHm1UVUgZn+9EI=
github.com/stretchr/testify v1.4.0 h1:2E4SXV/wtOkTonXsotYi4li6zVWxYlZuYNCXe9XRJyk=
github.com/stretchr/testify v1.4.0/go.mod h1:j7eGeouHqKxXV5pUuKE4zz7dFj8WfuZ+81PSLYec5m4=
github.com/ugorji/go v1.1.7/go.mod h1:kZn38zHttfInRq0xu/PH0az30d+z6vm202qpg1oXVMw=
github.com/ugorji/go/codec v1.1.7 h1:2SvQaVZ1ouYrrKKwoSk2pzd4A9evlKJb9oTL+OaLUSs=
github.com/ugorji/go/codec v1.1.7/go.mod h1:Ax+UKWsSmolVDwsd+7N3ZtXu+yMGCf907BLYF3GoBXY=
golang.org/x/crypto v0.0.0-20190308221718-c2843e01d9a2/go.mod h1:djNgcEr1/C05ACkg1iLfiJU5Ep61QUkGW8qpdssI0+w=
golang.org/x/crypto v0.0.0-20200622213623-75b288015ac9 h1:psW17arqaxU48Z5kZ0CQnkZWQJsqcURM6tKiBApRjXI=
golang.org/x/crypto v0.0.0-20200622213623-75b288015ac9/go.mod h1:LzIPMQfyMNhhGPhUkYOs5KpL4U8rLKemX1yGLhDgUto=
golang.org/x/net v0.0.0-20190404232315-eb5bcb51f2a3/go.mod h1:t9HGtf8HONx5eT2rtn7q6eTqICYqUVnKs3thJo3Qplg=
golang.org/x/sys v0.0.0-20190215142949-d0b11bdaac8a/go.mod h1:STP8DvDyc/dI5b8T5hshtkjS+E42TnysNCUPdjciGhY=
golang.org/x/sys v0.0.0-20190412213103-97732733099d/go.mod h1:h1NjWce9XRLGQEsW7wpKNCjG9DtNlClVuFLEZdDNbEs=
golang.org/x/sys v0.0.0-20200116001909-b77594299b42 h1:vEOn+mP2zCOVzKckCZy6YsCtDblrpj/w7B9nxGNELpg=
golang.org/x/sys v0.0.0-20200116001909-b77594299b42/go.mod h1:h1NjWce9XRLGQEsW7wpKNCjG9DtNlClVuFLEZdDNbEs=
golang.org/x/text v0.3.0/go.mod h1:NqM8EUOU14njkJ3fqMW+pc6Ldnwhi/IjpwHt7yyuwOQ=
golang.org/x/text v0.3.2/go.mod h1:bEr9sfX3Q8Zfm5fL9x+3itogRgK3+ptLWKqgva+5dAk=
golang.org/x/text v0.3.7 h1:olpwvP2KacW1ZWvsR7uQhoyTYvKAupfQrRGBFM352Gk=
golang.org/x/text v0.3.7/go.mod h1:u+2+/6zg+i71rQMx5EYifcz6MCKuco9NR6JIITiCfzQ=
golang.org/x/tools v0.0.0-20180917221912-90fa682c2a6e/go.mod h1:n7NCudcB/nEzxVGmLbDWY5pfWTLqBcC2KZ6jyYvM4mQ=
gopkg.in/check.v1 v0.0.0-20161208181325-20d25e280405 h1:yhCVgyC4o1eVCa2tZl7eS0r+SDo693bJlVdllGtEeKM=
gopkg.in/check.v1 v0.0.0-20161208181325-20d25e280405/go.mod h1:Co6ibVJAznAaIkqp8huTwlJQCZ016jof/cbN4VW5Yz0=
gopkg.in/yaml.v2 v2.2.2/go.mod h1:hI93XBmqTisBFMUTm0b8Fm+jr3Dg1NNxqwp+5A1VGuI=
gopkg.in/yaml.v2 v2.2.8 h1:obN1ZagJSUGI0Ek/LBmuj4SNLPfIny3KsKFopxRdj10=
gopkg.in/yaml.v2 v2.2.8/go.mod h1:hI93XBmqTisBFMUTm0b8Fm+jr3Dg1NNxqwp+5A1VGuI=
`

