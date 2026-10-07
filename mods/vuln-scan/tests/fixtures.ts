// Output of npm 10 audit, pnpm 10 audit, yarn 1.22 audit, yarn 4 npm audit and pip-audit 2.10 on a demo project
// (express 4.17.1, lodash 4.17.15, minimist 1.2.0, request; jinja2 2.11.2, requests 2.25.1), and cargo-audit 0.22 on a crate
// pinning time 0.1.45, trimmed to a few advisories.

export const NPM_AUDIT_V2 = String.raw`{
  "auditReportVersion": 2,
  "vulnerabilities": {
    "body-parser": {
      "name": "body-parser",
      "severity": "high",
      "isDirect": false,
      "via": [
        {
          "source": 1099520,
          "name": "body-parser",
          "dependency": "body-parser",
          "title": "body-parser vulnerable to denial of service when url encoding is enabled",
          "url": "https://github.com/advisories/GHSA-qwcr-r2fm-qrc7",
          "severity": "high",
          "cwe": [
            "CWE-405"
          ],
          "cvss": {
            "score": 7.5,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
          },
          "range": "<1.20.3"
        },
        {
          "source": 1123977,
          "name": "body-parser",
          "dependency": "body-parser",
          "title": "body-parser vulnerable to denial of service when invalid limit value silently disables size enforcement",
          "url": "https://github.com/advisories/GHSA-v422-hmwv-36x6",
          "severity": "low",
          "cwe": [
            "CWE-770"
          ],
          "cvss": {
            "score": 3.7,
            "vectorString": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L"
          },
          "range": "<1.20.6"
        },
        "qs"
      ],
      "effects": [
        "express"
      ],
      "range": "<=1.20.5",
      "nodes": [
        "node_modules/body-parser"
      ],
      "fixAvailable": {
        "name": "express",
        "version": "4.22.3",
        "isSemVerMajor": false
      }
    },
    "express": {
      "name": "express",
      "severity": "high",
      "isDirect": true,
      "via": [
        {
          "source": 1100530,
          "name": "express",
          "dependency": "express",
          "title": "express vulnerable to XSS via response.redirect()",
          "url": "https://github.com/advisories/GHSA-qw6h-vgh9-j6wx",
          "severity": "low",
          "cwe": [
            "CWE-79"
          ],
          "cvss": {
            "score": 5,
            "vectorString": "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:L"
          },
          "range": "<4.20.0"
        },
        {
          "source": 1111636,
          "name": "express",
          "dependency": "express",
          "title": "Express.js Open Redirect in malformed URLs",
          "url": "https://github.com/advisories/GHSA-rv95-896h-c2vc",
          "severity": "moderate",
          "cwe": [
            "CWE-601",
            "CWE-1286"
          ],
          "cvss": {
            "score": 6.1,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"
          },
          "range": "<4.19.2"
        },
        "body-parser",
        "cookie",
        "path-to-regexp",
        "qs",
        "send",
        "serve-static"
      ],
      "effects": [],
      "range": "<=4.21.2 || 5.0.0-alpha.1 - 5.0.0",
      "nodes": [
        "node_modules/express"
      ],
      "fixAvailable": {
        "name": "express",
        "version": "4.22.3",
        "isSemVerMajor": false
      }
    },
    "minimist": {
      "name": "minimist",
      "severity": "critical",
      "isDirect": true,
      "via": [
        {
          "source": 1096465,
          "name": "minimist",
          "dependency": "minimist",
          "title": "Prototype Pollution in minimist",
          "url": "https://github.com/advisories/GHSA-vh95-rmgr-6w4m",
          "severity": "moderate",
          "cwe": [
            "CWE-1321"
          ],
          "cvss": {
            "score": 5.6,
            "vectorString": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:L"
          },
          "range": ">=1.0.0 <1.2.3"
        },
        {
          "source": 1097678,
          "name": "minimist",
          "dependency": "minimist",
          "title": "Prototype Pollution in minimist",
          "url": "https://github.com/advisories/GHSA-xvch-5gv4-984h",
          "severity": "critical",
          "cwe": [
            "CWE-1321"
          ],
          "cvss": {
            "score": 9.8,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
          },
          "range": ">=1.0.0 <1.2.6"
        }
      ],
      "effects": [],
      "range": "1.0.0 - 1.2.5",
      "nodes": [
        "node_modules/minimist"
      ],
      "fixAvailable": {
        "name": "minimist",
        "version": "1.2.8",
        "isSemVerMajor": false
      }
    },
    "serve-static": {
      "name": "serve-static",
      "severity": "low",
      "isDirect": false,
      "via": [
        {
          "source": 1100528,
          "name": "serve-static",
          "dependency": "serve-static",
          "title": "serve-static vulnerable to template injection that can lead to XSS",
          "url": "https://github.com/advisories/GHSA-cm22-4g7w-348p",
          "severity": "low",
          "cwe": [
            "CWE-79"
          ],
          "cvss": {
            "score": 5,
            "vectorString": "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:L"
          },
          "range": "<1.16.0"
        },
        "send"
      ],
      "effects": [],
      "range": "<=1.16.0",
      "nodes": [
        "node_modules/serve-static"
      ],
      "fixAvailable": true
    },
    "qs": {
      "name": "qs",
      "severity": "high",
      "isDirect": false,
      "via": [
        {
          "source": 1104120,
          "name": "qs",
          "dependency": "qs",
          "title": "qs vulnerable to Prototype Pollution",
          "url": "https://github.com/advisories/GHSA-hrpp-h998-j3pp",
          "severity": "high",
          "cwe": [
            "CWE-1321"
          ],
          "cvss": {
            "score": 7.5,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
          },
          "range": ">=6.7.0 <6.7.3"
        },
        {
          "source": 1113161,
          "name": "qs",
          "dependency": "qs",
          "title": "qs's arrayLimit bypass in comma parsing allows denial of service",
          "url": "https://github.com/advisories/GHSA-w7fw-mjwx-w883",
          "severity": "low",
          "cwe": [
            "CWE-20"
          ],
          "cvss": {
            "score": 3.7,
            "vectorString": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L"
          },
          "range": ">=6.7.0 <=6.14.1"
        },
        {
          "source": 1113719,
          "name": "qs",
          "dependency": "qs",
          "title": "qs's arrayLimit bypass in its bracket notation allows DoS via memory exhaustion",
          "url": "https://github.com/advisories/GHSA-6rw7-vpxm-498p",
          "severity": "moderate",
          "cwe": [
            "CWE-20"
          ],
          "cvss": {
            "score": 3.7,
            "vectorString": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L"
          },
          "range": "<6.14.1"
        },
        {
          "source": 1158507,
          "name": "qs",
          "dependency": "qs",
          "title": "qs: Denial of Service via Attacker Controlled isBuffer",
          "url": "https://github.com/advisories/GHSA-4mjr-xmp4-gh2g",
          "severity": "moderate",
          "cwe": [
            "CWE-248",
            "CWE-703"
          ],
          "cvss": {
            "score": 5.3,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L"
          },
          "range": ">=2.2.5 <6.16.0"
        }
      ],
      "effects": [
        "body-parser",
        "express",
        "request"
      ],
      "range": "<=6.15.3",
      "nodes": [
        "node_modules/qs",
        "node_modules/request/node_modules/qs"
      ],
      "fixAvailable": false
    }
  },
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 3,
      "moderate": 2,
      "high": 5,
      "critical": 3,
      "total": 13
    },
    "dependencies": {
      "prod": 100,
      "dev": 2,
      "optional": 0,
      "peer": 0,
      "peerOptional": 0,
      "total": 101
    }
  }
}
`

export const NPM_ENOLOCK = String.raw`{
  "error": {
    "code": "ENOLOCK",
    "summary": "This command requires an existing lockfile.",
    "detail": "Try creating one first with: npm i --package-lock-only\nOriginal error: loadVirtual requires existing shrinkwrap file"
  }
}
`

export const PNPM_AUDIT = "{\n  \"actions\": [\n    {\n      \"action\": \"review\",\n      \"module\": \"minimist\",\n      \"resolves\": [\n        {\n          \"id\": 1096465,\n          \"path\": \".>minimist\",\n          \"dev\": false,\n          \"optional\": false,\n          \"bundled\": false\n        },\n        {\n          \"id\": 1097678,\n          \"path\": \".>minimist\",\n          \"dev\": false,\n          \"optional\": false,\n          \"bundled\": false\n        }\n      ]\n    }\n  ],\n  \"advisories\": {\n    \"1096465\": {\n      \"findings\": [\n        {\n          \"version\": \"1.2.0\",\n          \"paths\": [\n            \".>minimist\"\n          ]\n        }\n      ],\n      \"found_by\": null,\n      \"deleted\": null,\n      \"references\": \"- https://nvd.nist.gov/vuln/detail/CVE-2020-7598\\n- https://snyk.io/vuln/SNYK-JS-MINIMIST-559764\\n- http://lists.opensuse.\",\n      \"created\": \"2020-04-03T21:48:32.000Z\",\n      \"id\": 1096465,\n      \"npm_advisory_id\": null,\n      \"overview\": \"Affected versions of `minimist` are vulnerable to prototype pollution. Arguments are not properly sanitized, allowing an attacker to modify the prototype of `Ob\",\n      \"reported_by\": null,\n      \"title\": \"Prototype Pollution in minimist\",\n      \"metadata\": null,\n      \"cves\": [\n        \"CVE-2020-7598\"\n      ],\n      \"access\": \"public\",\n      \"severity\": \"moderate\",\n      \"module_name\": \"minimist\",\n      \"vulnerable_versions\": \">=1.0.0 <1.2.3\",\n      \"github_advisory_id\": \"GHSA-vh95-rmgr-6w4m\",\n      \"recommendation\": \"Upgrade to version 1.2.3 or later\",\n      \"patched_versions\": \">=1.2.3\",\n      \"updated\": \"2024-02-13T20:00:55.000Z\",\n      \"cvss\": {\n        \"score\": 5.6,\n        \"vectorString\": \"CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:L\"\n      },\n      \"cwe\": [\n        \"CWE-1321\"\n      ],\n      \"url\": \"https://github.com/advisories/GHSA-vh95-rmgr-6w4m\"\n    },\n    \"1097678\": {\n      \"findings\": [\n        {\n          \"version\": \"1.2.0\",\n          \"paths\": [\n            \".>minimist\"\n          ]\n        }\n      ],\n      \"found_by\": null,\n      \"deleted\": null,\n      \"references\": \"- https://nvd.nist.gov/vuln/detail/CVE-2021-44906\\n- https://github.com/substack/minimist/issues/164\\n- https://github.com\",\n      \"created\": \"2022-03-18T00:01:09.000Z\",\n      \"id\": 1097678,\n      \"npm_advisory_id\": null,\n      \"overview\": \"Minimist prior to 1.2.6 and 0.2.4 is vulnerable to Prototype Pollution via file `index.js`, function `setKey()` (lines 69-95).\",\n      \"reported_by\": null,\n      \"title\": \"Prototype Pollution in minimist\",\n      \"metadata\": null,\n      \"cves\": [\n        \"CVE-2021-44906\"\n      ],\n      \"access\": \"public\",\n      \"severity\": \"critical\",\n      \"module_name\": \"minimist\",\n      \"vulnerable_versions\": \">=1.0.0 <1.2.6\",\n      \"github_advisory_id\": \"GHSA-xvch-5gv4-984h\",\n      \"recommendation\": \"Upgrade to version 1.2.6 or later\",\n      \"patched_versions\": \">=1.2.6\",\n      \"updated\": \"2024-06-21T21:33:52.000Z\",\n      \"cvss\": {\n        \"score\": 9.8,\n        \"vectorString\": \"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H\"\n      },\n      \"cwe\": [\n        \"CWE-1321\"\n      ],\n      \"url\": \"https://github.com/advisories/GHSA-xvch-5gv4-984h\"\n    },\n    \"1106913\": {\n      \"findings\": [\n        {\n          \"version\": \"4.17.15\",\n          \"paths\": [\n            \".>lodash\"\n          ]\n        }\n      ],\n      \"found_by\": null,\n      \"deleted\": null,\n      \"references\": \"- https://nvd.nist.gov/vuln/detail/CVE-2021-23337\\n- https://github.com/lodash/lodash/commit/3469357cff396a26c363f8c1b5a9\",\n      \"created\": \"2021-05-06T16:05:51.000Z\",\n      \"id\": 1106913,\n      \"npm_advisory_id\": null,\n      \"overview\": \"`lodash` versions prior to 4.17.21 are vulnerable to Command Injection via the template function.\",\n      \"reported_by\": null,\n      \"title\": \"Command Injection in lodash\",\n      \"metadata\": null,\n      \"cves\": [\n        \"CVE-2021-23337\"\n      ],\n      \"access\": \"public\",\n      \"severity\": \"high\",\n      \"module_name\": \"lodash\",\n      \"vulnerable_versions\": \"<4.17.21\",\n      \"github_advisory_id\": \"GHSA-35jh-r3h4-6jhm\",\n      \"recommendation\": \"Upgrade to version 4.17.21 or later\",\n      \"patched_versions\": \">=4.17.21\",\n      \"updated\": \"2025-08-12T21:44:25.000Z\",\n      \"cvss\": {\n        \"score\": 7.2,\n        \"vectorString\": \"CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H\"\n      },\n      \"cwe\": [\n        \"CWE-77\",\n        \"CWE-94\"\n      ],\n      \"url\": \"https://github.com/advisories/GHSA-35jh-r3h4-6jhm\"\n    }\n  },\n  \"muted\": [],\n  \"metadata\": {\n    \"vulnerabilities\": {\n      \"info\": 0,\n      \"low\": 6,\n      \"moderate\": 12,\n      \"high\": 9,\n      \"critical\": 2\n    },\n    \"dependencies\": 105,\n    \"devDependencies\": 0,\n    \"optionalDependencies\": 0,\n    \"totalDependencies\": 105\n  }\n}\n"

export const YARN_CLASSIC_AUDIT = "{\"type\": \"auditAdvisory\", \"data\": {\"resolution\": {\"id\": 1096465, \"path\": \"minimist\", \"dev\": false, \"optional\": false, \"bundled\": false}, \"advisory\": {\"findings\": [{\"version\": \"1.2.0\", \"paths\": [\"minimist\"]}], \"found_by\": null, \"deleted\": null, \"references\": \"- https://nvd.nist.gov/vuln/detail/CVE-2020-7598\\n- https://snyk.io/vuln/SNYK-JS-\", \"created\": \"2020-04-03T21:48:32.000Z\", \"id\": 1096465, \"npm_advisory_id\": null, \"overview\": \"Affected versions of `minimist` are vulnerable to prototype pollution. Arguments are not properly sanitized, allowing an\", \"reported_by\": null, \"title\": \"Prototype Pollution in minimist\", \"metadata\": null, \"cves\": [\"CVE-2020-7598\"], \"access\": \"public\", \"severity\": \"moderate\", \"module_name\": \"minimist\", \"vulnerable_versions\": \">=1.0.0 <1.2.3\", \"github_advisory_id\": \"GHSA-vh95-rmgr-6w4m\", \"recommendation\": \"Upgrade to version 1.2.3 or later\", \"patched_versions\": \">=1.2.3\", \"updated\": \"2024-02-13T20:00:55.000Z\", \"cvss\": {\"score\": 5.6, \"vectorString\": \"CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:L\"}, \"cwe\": [\"CWE-1321\"], \"url\": \"https://github.com/advisories/GHSA-vh95-rmgr-6w4m\"}}}\n{\"type\": \"auditAdvisory\", \"data\": {\"resolution\": {\"id\": 1097678, \"path\": \"minimist\", \"dev\": false, \"optional\": false, \"bundled\": false}, \"advisory\": {\"findings\": [{\"version\": \"1.2.0\", \"paths\": [\"minimist\"]}], \"found_by\": null, \"deleted\": null, \"references\": \"- https://nvd.nist.gov/vuln/detail/CVE-2021-44906\\n- https://github.com/substack/\", \"created\": \"2022-03-18T00:01:09.000Z\", \"id\": 1097678, \"npm_advisory_id\": null, \"overview\": \"Minimist prior to 1.2.6 and 0.2.4 is vulnerable to Prototype Pollution via file `index.js`, function `setKey()` (lines 6\", \"reported_by\": null, \"title\": \"Prototype Pollution in minimist\", \"metadata\": null, \"cves\": [\"CVE-2021-44906\"], \"access\": \"public\", \"severity\": \"critical\", \"module_name\": \"minimist\", \"vulnerable_versions\": \">=1.0.0 <1.2.6\", \"github_advisory_id\": \"GHSA-xvch-5gv4-984h\", \"recommendation\": \"Upgrade to version 1.2.6 or later\", \"patched_versions\": \">=1.2.6\", \"updated\": \"2024-06-21T21:33:52.000Z\", \"cvss\": {\"score\": 9.8, \"vectorString\": \"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H\"}, \"cwe\": [\"CWE-1321\"], \"url\": \"https://github.com/advisories/GHSA-xvch-5gv4-984h\"}}}\n{\"type\": \"auditAdvisory\", \"data\": {\"resolution\": {\"id\": 1099520, \"path\": \"express>body-parser\", \"dev\": false, \"optional\": false, \"bundled\": false}, \"advisory\": {\"findings\": [{\"version\": \"1.19.0\", \"paths\": [\"express>body-parser\"]}], \"found_by\": null, \"deleted\": null, \"references\": \"- https://github.com/expressjs/body-parser/security/advisories/GHSA-qwcr-r2fm-qr\", \"created\": \"2024-09-10T15:52:39.000Z\", \"id\": 1099520, \"npm_advisory_id\": null, \"overview\": \"### Impact\\n\\nbody-parser <1.20.3 is vulnerable to denial of service when url encoding is enabled. A malicious actor using\", \"reported_by\": null, \"title\": \"body-parser vulnerable to denial of service when url encoding is enabled\", \"metadata\": null, \"cves\": [\"CVE-2024-45590\"], \"access\": \"public\", \"severity\": \"high\", \"module_name\": \"body-parser\", \"vulnerable_versions\": \"<1.20.3\", \"github_advisory_id\": \"GHSA-qwcr-r2fm-qrc7\", \"recommendation\": \"Upgrade to version 1.20.3 or later\", \"patched_versions\": \">=1.20.3\", \"updated\": \"2024-09-10T19:01:11.000Z\", \"cvss\": {\"score\": 7.5, \"vectorString\": \"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H\"}, \"cwe\": [\"CWE-405\"], \"url\": \"https://github.com/advisories/GHSA-qwcr-r2fm-qrc7\"}}}\n{\"type\": \"auditAdvisory\", \"data\": {\"resolution\": {\"id\": 1096465, \"path\": \"minimist\", \"dev\": false, \"optional\": false, \"bundled\": false}, \"advisory\": {\"findings\": [{\"version\": \"1.2.0\", \"paths\": [\"minimist\"]}], \"found_by\": null, \"deleted\": null, \"references\": \"- https://nvd.nist.gov/vuln/detail/CVE-2020-7598\\n- https://snyk.io/vuln/SNYK-JS-\", \"created\": \"2020-04-03T21:48:32.000Z\", \"id\": 1096465, \"npm_advisory_id\": null, \"overview\": \"Affected versions of `minimist` are vulnerable to prototype pollution. Arguments are not properly sanitized, allowing an\", \"reported_by\": null, \"title\": \"Prototype Pollution in minimist\", \"metadata\": null, \"cves\": [\"CVE-2020-7598\"], \"access\": \"public\", \"severity\": \"moderate\", \"module_name\": \"minimist\", \"vulnerable_versions\": \">=1.0.0 <1.2.3\", \"github_advisory_id\": \"GHSA-vh95-rmgr-6w4m\", \"recommendation\": \"Upgrade to version 1.2.3 or later\", \"patched_versions\": \">=1.2.3\", \"updated\": \"2024-02-13T20:00:55.000Z\", \"cvss\": {\"score\": 5.6, \"vectorString\": \"CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:L\"}, \"cwe\": [\"CWE-1321\"], \"url\": \"https://github.com/advisories/GHSA-vh95-rmgr-6w4m\"}}}\n{\"type\":\"auditSummary\",\"data\":{\"vulnerabilities\":{\"info\":0,\"low\":8,\"moderate\":14,\"high\":10,\"critical\":2},\"dependencies\":106,\"devDependencies\":0,\"optionalDependencies\":0,\"totalDependencies\":106}}\n"

export const YARN_BERRY_AUDIT = String.raw`{"value":"express","children":{"ID":1100530,"Issue":"express vulnerable to XSS via response.redirect()","URL":"https://github.com/advisories/GHSA-qw6h-vgh9-j6wx","Severity":"low","Vulnerable Versions":"<4.20.0","Tree Versions":["4.17.1"],"Dependents":["demo-app@workspace:."]}}
{"value":"express","children":{"ID":1111636,"Issue":"Express.js Open Redirect in malformed URLs","URL":"https://github.com/advisories/GHSA-rv95-896h-c2vc","Severity":"moderate","Vulnerable Versions":"<4.19.2","Tree Versions":["4.17.1"],"Dependents":["demo-app@workspace:."]}}
{"value":"lodash","children":{"ID":1106913,"Issue":"Command Injection in lodash","URL":"https://github.com/advisories/GHSA-35jh-r3h4-6jhm","Severity":"high","Vulnerable Versions":"<4.17.21","Tree Versions":["4.17.15"],"Dependents":["demo-app@workspace:."]}}
`

export const PIP_AUDIT = "{\"dependencies\": [{\"name\": \"certifi\", \"version\": \"2026.7.22\", \"vulns\": []}, {\"name\": \"idna\", \"version\": \"2.10\", \"vulns\": [{\"id\": \"PYSEC-2024-60\", \"fix_versions\": [\"3.7\"], \"aliases\": [\"GHSA-jjg7-2v4v-x38h\", \"CVE-2024-3651\"], \"description\": \"### Impact A specially crafted argument to the `idna.encode()` function could consume significant resources. This may lead to a denial-of-service.  ### Patches The function has been refined to reject such strings without the associated resource consumption in version 3.7.  ### Workarounds Domain names cannot exceed 253 characters in length, if this length limit is enforced prior to passing the dom\"}, {\"id\": \"PYSEC-2024-60\", \"fix_versions\": [\"3.7\"], \"aliases\": [\"GHSA-jjg7-2v4v-x38h\", \"CVE-2024-3651\"], \"description\": \"A vulnerability was identified in the kjd/idna library, specifically within the `idna.encode()` function, affecting version 3.6. The issue arises from the function's handling of crafted input strings, which can lead to quadratic complexity and consequently, a denial of service condition. This vulnerability is triggered by a crafted input that causes the `idna.encode()` function to process the inpu\"}]}, {\"name\": \"jinja2\", \"version\": \"2.11.2\", \"vulns\": [{\"id\": \"PYSEC-2021-66\", \"fix_versions\": [\"2.11.3\"], \"aliases\": [\"CVE-2020-28493\", \"SNYK-PYTHON-JINJA2-1012994\", \"GHSA-g3rq-g295-4j3m\"], \"description\": \"This affects the package jinja2 from 0.0.0 and before 2.11.3. The ReDoS vulnerability is mainly due to the `_punctuation_re regex` operator and its use of multiple wildcards. The last wildcard is the most exploitable as it searches for trailing punctuation. This issue can be mitigated by Markdown to format user content instead of the urlize filter, or by implementing request timeouts and limiting \"}, {\"id\": \"PYSEC-2021-66\", \"fix_versions\": [\"2.11.3\"], \"aliases\": [\"CVE-2020-28493\", \"GHSA-g3rq-g295-4j3m\", \"SNYK-PYTHON-JINJA2-1012994\"], \"description\": \"This affects the package jinja2 from 0.0.0 and before 2.11.3. The ReDOS vulnerability of the regex is mainly due to the sub-pattern [a-zA-Z0-9._-]+.[a-zA-Z0-9._-]+ This issue can be mitigated by Markdown to format user content instead of the urlize filter, or by implementing request timeouts and limiting process memory.\"}]}, {\"name\": \"urllib3\", \"version\": \"1.26.20\", \"vulns\": [{\"id\": \"PYSEC-2026-1999\", \"fix_versions\": [\"2.5.0\"], \"aliases\": [\"GHSA-pq67-6m6q-mj2v\", \"CVE-2025-50181\"], \"description\": \"urllib3 handles redirects and retries using the same mechanism, which is controlled by the `Retry` object. The most common way to disable redirects is at the request level, as follows:  ```python resp = urllib3.request(\\\"GET\\\", \\\"https://httpbin.org/redirect/1\\\", redirect=False) print(resp.status) # 302 ```  However, it is also possible to disable redirects, for all requests, by instantiating a `PoolM\"}, {\"id\": \"PYSEC-2026-1998\", \"fix_versions\": [\"2.6.0\"], \"aliases\": [\"CVE-2025-66418\", \"GHSA-gm62-xv2j-4w53\"], \"description\": \"## Impact  urllib3 supports chained HTTP encoding algorithms for response content according to RFC 9110 (e.g., `Content-Encoding: gzip, zstd`).  However, the number of links in the decompression chain was unbounded allowing a malicious server to insert a virtually unlimited number of compression steps leading to high CPU usage and massive memory allocation for the decompressed data.   ## Affected \"}]}], \"fixes\": []}\n"

export const CARGO_AUDIT = String.raw`{"database": {"advisory-count": 1294, "last-commit": "b8a1a33e246a0a9a3b5f377248c41a503defec74", "last-updated": "2026-10-07T16:40:27+02:00"}, "lockfile": {"dependency-count": 14}, "settings": {"target_arch": [], "target_os": [], "severity": null, "ignore": [], "informational_warnings": ["unmaintained", "unsound", "notice"]}, "vulnerabilities": {"found": true, "count": 1, "list": [{"advisory": {"id": "RUSTSEC-2020-0071", "package": "time", "title": "Potential segfault in the time crate", "description": "### Impact\n\nThe affected functions set environment variables without synchronization. On Unix-like operating systems, this can crash in multithreaded programs. Programs may segfault due to dereferencing a dangling pointer if an environment variable is read in a different thread than the affected fun", "date": "2020-11-18", "aliases": ["CVE-2020-26235", "GHSA-wcg3-cvx6-7396"], "related": [], "collection": "crates", "categories": ["code-execution", "memory-corruption"], "keywords": ["segfault"], "cvss": "CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", "informational": null, "references": [], "source": null, "url": "https://github.com/time-rs/time/issues/293", "withdrawn": null, "license": "CC0-1.0", "expect-deleted": false}, "versions": {"patched": [">=0.2.23"], "unaffected": ["=0.2.0", "=0.2.1", "=0.2.2", "=0.2.3", "=0.2.4", "=0.2.5", "=0.2.6"]}, "affected": {"arch": [], "os": ["linux", "redox", "solaris", "android", "ios", "macos", "netbsd", "openbsd", "freebsd"], "functions": {"time::OffsetDateTime::now_local": ["<0.2.23"], "time::OffsetDateTime::try_now_local": ["<0.2.23"], "time::UtcOffset::current_local_offset": ["<0.2.23"], "time::UtcOffset::local_offset_at": ["<0.2.23"], "time::UtcOffset::try_current_local_offset": ["<0.2.23"], "time::UtcOffset::try_local_offset_at": ["<0.2.23"], "time::at": ["^0.1"], "time::at_utc": ["^0.1"], "time::now": ["^0.1"]}}, "package": {"name": "time", "version": "0.1.45", "source": "registry+https://github.com/rust-lang/crates.io-index", "checksum": "1b797afad3f312d1c66a56d11d0316f916356d11bd158fbc6ca6389ff6bf805a", "dependencies": [{"name": "libc", "version": "0.2.190", "source": "registry+https://github.com/rust-lang/crates.io-index"}, {"name": "wasi", "version": "0.10.0+wasi-snapshot-preview1", "source": "registry+https://github.com/rust-lang/crates.io-index"}, {"name": "winapi", "version": "0.3.9", "source": "registry+https://github.com/rust-lang/crates.io-index"}], "replace": null}}]}, "warnings": {}}
`
