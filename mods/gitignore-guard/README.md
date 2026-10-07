# gitignore-guard
> Warns before node_modules, build output, OS junk or huge files get staged.

**Category:** Git & Versioning · **Version:** 1.0.0

## What it does
Stops the classic "git add -A staged all of node_modules" mistake before it happens. When Claude runs
`git add -A`, `git add --all`, `git add .` or `git add *`, the mod lists what would be staged with
`git status` and refuses if it includes untracked `node_modules/`, `dist/`, `build/`, `.DS_Store`, `*.log`,
`.env`, caches, or any file over the size limit. The refusal says what it found and which lines to add to
`.gitignore`. Naming a file explicitly (`git add .env`) is also refused for the unambiguous junk.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install gitignore-guard@claude-mods
```

## Usage
Nothing to run. A refused add looks like:

```
gitignore-guard: this git add would stage files that normally stay out of git:
  node_modules/ (1204 files)
  .DS_Store (macOS metadata)
  data/dump.sql (12.0 MB)
Add to .gitignore:
  node_modules/
  .DS_Store
  data/dump.sql
Then stage again, or name the files you want instead of using -A / .
```
`git add -f …` (you decided), `-n`, `-p`, `-u` and templates such as `.env.example` pass.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `maxFileMb` | number | `5` | Refuse to stage files bigger than this. `0` switches the size check off. |
| `extraPatterns` | string | empty | Comma-separated globs for more files or folders to keep out, e.g. `*.sqlite,coverage/`. |

## How it works
- A `tool.call` hook on `Bash` parses the `git add` with the shared claude-mods shell reader (also inside `bash -c`, `eval`, `$(…)`, a heredoc fed to a shell or `docker exec … sh -c`; a `cat <<EOF` note is only text). For a broad add it runs `git status --porcelain=v1 -z --untracked-files=all` (15 s timeout) and checks untracked paths against the patterns, then `$.fs.stat` on up to 300 changed files for the size limit. `git add .` only looks at the working directory's subtree.
- Build folders (`dist/`, `build/`, caches) are only judged for "add everything" commands, since some repositories track a `build/` folder on purpose; `node_modules/`, OS junk, logs and `.env` are refused either way.
- It fails open: if git or the repository cannot be read, the add goes ahead. It sees only what is untracked or modified now; ignored files never show up.
- With [mods-hub](../mods-hub) installed, every refusal is also published as `risk.blocked` (rule `ignored-file` or `big-file`, what would be staged, severity `low`, the command with secrets masked). Without the hub nothing changes.
