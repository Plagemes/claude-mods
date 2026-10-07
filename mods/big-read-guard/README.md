# big-read-guard
> Stops full reads of huge files and nudges toward offset/limit or grep.

**Category:** Cost, Tokens & Context · **Version:** 1.0.0

## What it does
Before Claude reads a file in full, it checks the file's size. A file over the limit (256 KB by default), or a minified, bundled or lock file of any real size, is refused with a short message that tells the model to read a slice with `offset`/`limit` or to find the relevant lines with Grep. One careless read of a 3 MB lock file can eat a large part of the context window.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install big-read-guard@claude-mods
```

## Usage
Nothing to do. When a read is refused Claude sees: `big-read-guard: /repo/pnpm-lock.yaml is a minified, bundled or lock file (120 KB); reading it whole wastes context. Use Read with offset and limit ...` and normally retries with a slice or a search.

## Configuration
| Key | Default | Meaning |
| --- | --- | --- |
| `maxKb` | `256` | Largest file (in KB) that may be read without `limit`. |

## How it works
- Hooks `tool.call` for `Read`, and lets it through at once when `limit` or `pages` is given, for PDFs and images, and for files on an attached machine.
- Otherwise it calls `$.fs.stat`. Generated files (`*.min.js`, `*.bundle.js`, `*.chunk.js`, `*.js.map`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum` and other lock files) are refused above 16 KB; smaller ones are harmless and pass.
- It is a cost guard, not a security guard: if the check itself fails (file missing, stat error) the read goes ahead and the Read tool reports what is wrong. Detection is by file name only, the content is not inspected.
