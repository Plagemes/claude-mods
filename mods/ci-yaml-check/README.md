# ci-yaml-check
> Checks edited GitHub Actions workflows and warns about actions not pinned to a version.

**Category:** DevOps & Cloud · **Version:** 1.0.0

## What it does
After Claude edits or writes a file in `.github/workflows/`, ci-yaml-check reads it and tells Claude about: `uses:` actions with no version or pinned to `@main`/`@master`, a missing `permissions:` block, `pull_request_target` workflows that check out the pull request's code, secrets that are echoed or dumped with `toJSON(secrets)`, and tabs in the YAML indentation. If [actionlint](https://github.com/rhysd/actionlint) is installed it runs that too, for syntax and expression errors.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install ci-yaml-check@claude-mods
```

## Usage
Nothing to run. You see a toast such as `3 workflow issues in ci.yml`, and Claude gets the list so it can fix them:

```
ci-yaml-check: 3 issues in /repo/.github/workflows/ci.yml:
  file [warn]: no permissions: block, so the GITHUB_TOKEN gets the repository default (often read and write); add permissions: contents: read at the top and widen per job
  line 7 [warn]: actions/checkout has no version; pin a release tag or, better, a full commit SHA
  line 8 [warn]: actions/setup-node@main follows a moving branch, so a change upstream changes your CI; pin a tag or a full commit SHA
```

Local actions (`./.github/actions/x`) and `docker://` images are not checked. By default a release tag (`@v4`) is accepted; turn on `requireSha` to ask for full commit SHAs.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `requireSha` | boolean | `false` | Also warn about actions pinned to a tag instead of a full 40-character commit SHA. |
| `useActionlint` | boolean | `true` | Run actionlint when it is on the PATH and add its findings to the built-in checks. |

## How it works
- Hooks `tool.call` for `Edit`, `MultiEdit` and `Write`. After a successful change to a workflow file it reads the file and checks it line by line (steps are found by indentation, so no YAML library is needed); it never blocks anything.
- actionlint runs once per edit with a 15 second limit (`actionlint -oneline`); if it is not installed it is not asked again for the session. The built-in checks cover policy that actionlint does not (pinning, permissions, `pull_request_target`, secrets), so they run either way.
- Limits: it reads the whole file, so existing problems are listed again on every edit. It does not parse YAML (a structural error beyond tabs is left to actionlint), expand anchors, or follow reusable workflows.
- With [mods-hub](https://github.com/plagemes/claude-mods/tree/main/mods/mods-hub) installed it publishes `lint.result` (`tool: ci-yaml-check`, the file, and how many findings) after each edit with findings (`errors` for error-level findings, `warnings` for the rest) and sends its warning through `notify` instead of a toast. Without the hub nothing changes; the mod stands alone.
