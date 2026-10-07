# go-mod-tidy
> Runs go mod tidy when Claude changes Go imports, so go.mod and go.sum stay in sync.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
When Claude edits or writes a `.go` file and the change adds or removes an import of a module (`github.com/...`, `golang.org/x/...`), go-mod-tidy waits two seconds for the edits to settle, then runs `go mod tidy` in the folder of the nearest `go.mod`. You get a toast with the result, and Claude is told what changed in `go.mod` (or why tidy failed) with its next tool result.

## Install
```
/plugin install go-mod-tidy --marketplace plagemes/claude-mods
```

## Usage
Nothing to run. Toasts you may see:

```
go mod tidy: go.mod updated (added github.com/google/uuid v1.6.0)
go mod tidy: already tidy
go mod tidy failed: go: finding module for package github.com/nope/x
```

Changes to standard-library or in-module imports do not start it, nor do edits inside `vendor/`. A burst of edits runs it once.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `timeoutSeconds` | number | `60` | How long `go mod tidy` may run (it may download modules) before it is stopped. At most 600. |

## How it works
- Hooks `tool.call` for `Edit`, `MultiEdit` and `Write`: it compares the import lines of the old and new text (for a `Write`, the file on disk), and if a module import was added or removed it queues the file. After a 2 second pause (`$.clock.after`) it finds `go.mod`, runs `go mod tidy` with `$.process.run` and a timeout, and compares `go.mod` and `go.sum` before and after.
- What it learned is handed to Claude as a note on the next tool result, because the edit's own result was already delivered when tidy finishes.
- Limits: it needs `go` on the PATH (if it is missing it says so once and stops), and the modules must be downloadable. It does not handle `go.work` workspaces specially, and it never blocks an edit.
