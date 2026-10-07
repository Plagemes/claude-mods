// The six recipes workflow-studio ships, as YAML (the same format as your own files). `/recipe copy <name>`
// puts one in .claude/recipes/ to adapt: add your project's checks, change the steps.

export const BUILTIN_RECIPES: Readonly<Record<string, string>> = {
  release: `name: release
title: Release
description: Prepare a release of {{version}}, from a clean tree to a tagged commit, with the changelog and version bumps done.
mode: inline
tags: [release, git]
params:
  - name: version
    description: The version to release, e.g. 1.4.0
    required: true
  - name: test_command
    description: The command that runs the test suite
    default: npm test
steps:
  - title: Check the tree
    tier: light
    prompt: |
      Check that the git working tree is clean and on the main branch, and list the commits since the last tag (git describe --tags --abbrev=0).
      If the tree is dirty, stop and tell me what is uncommitted.
  - title: Bump the version
    tier: light
    prompt: Set the version to {{version}} everywhere the project declares it (package manifests, version constants, lockfiles if they carry it). Show me the diff.
  - title: Write the changelog
    tier: standard
    prompt: |
      Add a {{version}} section to the changelog (create CHANGELOG.md in Keep a Changelog style if there is none), grouped as Added / Changed / Fixed / Removed, written from the commits since the last tag for people who use the project, not for its developers.
  - title: Verify
    tier: light
    prompt: Run \`{{test_command}}\` and the build if the project has one. Fix nothing silently; report failures.
  - title: Commit and tag
    tier: light
    prompt: Commit the release as "Release {{version}}" and create an annotated tag v{{version}}. Do not push; tell me the exact push commands instead.
checks:
  - name: Tests
    command: "{{test_command}}"
`,
  'dependency-update': `name: dependency-update
title: Dependency update
description: Update the project's dependencies in safe batches, read the changelogs of major bumps, fix what breaks and keep the tests green.
mode: parallel
tags: [dependencies, maintenance]
params:
  - name: scope
    description: Which updates to take
    default: minor
    options: [patch, minor, major]
  - name: test_command
    description: The command that runs the test suite
    default: npm test
steps:
  - title: List outdated packages
    tier: light
    group: survey
    prompt: List the outdated dependencies with their current, wanted and latest versions (npm outdated, pip list --outdated, cargo outdated, go list -u -m all — whatever this project uses). Mark which updates are within "{{scope}}".
  - title: Read breaking changes
    tier: standard
    group: survey
    prompt: For every dependency with a new major version, read its changelog or release notes and summarise the breaking changes that could touch this codebase, with the files likely affected.
  - title: Update in batches
    tier: standard
    prompt: |
      Update the dependencies within "{{scope}}" in small batches (related packages together). After each batch run \`{{test_command}}\`; fix what breaks, or revert that batch and note why.
  - title: Report
    tier: light
    prompt: Summarise what was updated, what was held back and why, and any follow-ups (deprecations, majors to plan).
checks:
  - name: Tests
    command: "{{test_command}}"
`,
  'security-audit': `name: security-audit
title: Security audit
description: Review the code for security problems from several angles at once, merge the findings and rank them by severity, without changing code.
mode: workflow
tags: [security, review]
params:
  - name: path
    description: The part of the code to audit
    default: .
steps:
  - title: Secrets and config
    tier: standard
    group: review
    prompt: In {{path}}, look for hard-coded secrets, keys and tokens, unsafe defaults, debug flags left on, and permissive CORS or cookie settings. Report findings with file and line; change nothing.
  - title: Injection and input handling
    tier: deep
    group: review
    prompt: In {{path}}, trace user input to SQL, shell, file paths, templates, deserialisation and redirects. Report each injection or traversal risk with file, line and a proof-of-concept input; change nothing.
  - title: Auth and access control
    tier: deep
    group: review
    prompt: In {{path}}, review authentication, session handling and authorisation checks (missing checks, IDOR, privilege escalation, weak password or token handling). Report findings with file and line; change nothing.
  - title: Dependencies
    tier: light
    group: review
    prompt: Run the project's dependency audit (npm audit, pip-audit, cargo audit, govulncheck) and list known vulnerabilities that are reachable from {{path}}.
  - title: Merge and rank
    tier: deep
    prompt: |
      Merge the findings above, drop duplicates and false positives, and rank them as critical / high / medium / low with a one-line fix for each.
      Write the report to SECURITY-AUDIT.md.
`,
  'flaky-test-hunt': `name: flaky-test-hunt
title: Flaky-test hunt
description: Find tests that pass and fail without code changes, find out why, and fix the cause rather than the symptom.
mode: parallel
tags: [tests, reliability]
params:
  - name: test_command
    description: The command that runs the test suite
    default: npm test
  - name: runs
    description: How many times to run the suite
    default: "5"
steps:
  - title: Run the suite repeatedly
    tier: light
    group: find
    prompt: Run \`{{test_command}}\` {{runs}} times and list every test whose result changed between runs, with the failure messages.
  - title: Look for flaky patterns
    tier: standard
    group: find
    prompt: Search the tests for patterns that make them flaky (real timers and sleeps, shared state between tests, order dependence, network calls, unseeded randomness, time zones) and list the suspects with file and line.
  - title: Fix the causes
    tier: deep
    prompt: For each test that flaked or is a strong suspect, find the root cause and fix it (fake timers, isolation, deterministic data). Never skip or delete a test to make it pass.
  - title: Confirm
    tier: light
    prompt: Run \`{{test_command}}\` {{runs}} more times and report whether every run passed.
checks:
  - name: Tests
    command: "{{test_command}}"
`,
  'onboarding-docs': `name: onboarding-docs
title: Onboarding doc refresh
description: Bring the onboarding docs back in line with the code, so a new developer can set up, run and change the project on day one.
mode: parallel
tags: [docs, onboarding]
params:
  - name: doc
    description: The onboarding document to refresh
    default: README.md
steps:
  - title: Check the setup steps
    tier: standard
    group: survey
    prompt: Read {{doc}} and check every setup and run instruction against the project as it is now (manifests, scripts, env files, Docker, versions). List what is wrong or missing.
  - title: Map the codebase
    tier: light
    group: survey
    prompt: Write a short map of the codebase for a newcomer, the main folders, entry points, where tests live and how a request flows through, from the code itself.
  - title: Rewrite the doc
    tier: standard
    prompt: Update {{doc}} with correct setup and run steps, the codebase map and a "your first change" section. Keep the existing voice; remove what is no longer true.
`,
  'perf-pass': `name: perf-pass
title: Performance pass
description: Measure where time goes on one path, fix the biggest costs with evidence, and show the numbers before and after.
mode: parallel
tags: [performance]
params:
  - name: target
    description: The path, endpoint, command or page to make faster
    required: true
  - name: test_command
    description: The command that runs the test suite
    default: npm test
steps:
  - title: Baseline
    tier: standard
    group: measure
    prompt: Measure {{target}} as it is now (a benchmark or a timed run, repeated enough to be stable) and record the numbers and how you measured them.
  - title: Find the hot spots
    tier: deep
    group: measure
    prompt: Profile or read the code behind {{target}} and list the three biggest costs (N+1 queries, repeated work, blocking I/O, large allocations) with evidence.
  - title: Fix the biggest costs
    tier: deep
    prompt: Fix the hot spots one at a time, measuring after each change the same way as the baseline; keep a change only if it helps and keeps \`{{test_command}}\` green.
  - title: Report
    tier: light
    prompt: Report the before and after numbers for {{target}}, what changed, and what is left.
checks:
  - name: Tests
    command: "{{test_command}}"
`,
}
