# env-example-sync
> Keeps .env.example in sync with the environment variables your code actually reads.

**Category:** Languages & Frameworks · **Version:** 1.0.0

## What it does
After Claude edits or writes a source file, env-example-sync looks for environment variables the change starts to read: `process.env.X`, `import.meta.env.X`, `os.environ['X']`, `os.getenv('X')`, `env('X')`, `ENV['X']`, `os.Getenv("X")` and their relatives in JavaScript, TypeScript, Python, Ruby, PHP, Go, Rust, Java, Kotlin and C#. If the project has a `.env.example` (or `.env.sample`) that does not list the variable, it appends `X=` under a `# added by env-example-sync` comment. Your real `.env` files are never touched.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install env-example-sync@claude-mods
```

## Usage
Nothing to run. You see a toast such as `.env.example: added STRIPE_SECRET_KEY`, and Claude is told which variables were added so it can give them example values or comments. The file ends up like this:

```
PORT=3000
DATABASE_URL=postgres://localhost/app

# added by env-example-sync
STRIPE_SECRET_KEY=
```

A variable that is already listed (a commented `# SENTRY_DSN=` counts), that the edit did not add, that sits in a test file, or that is on the ignore list is skipped. `NODE_ENV`, `PATH`, `HOME`, `CI` and similar are always ignored.

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `file` | string | empty | Name of the example file, relative to the project (or package) root. Empty means `.env.example`, then `.env.sample`. The name must read as an example (`example`, `sample`, `template`, `dist`); a real `.env`, `.env.local` and the like are refused and the defaults are used. |
| `ignore` | string | empty | Comma-separated variable names to leave out, on top of the built-in list. |

## How it works
- Hooks `tool.call` for `Edit`, `MultiEdit` and `Write`. After the edit succeeds it compares the variables read in the new text with those in the text it replaces (for `Write`, the file on disk), looks for the example file in the edited file's folder and each folder up to the project root, and appends what is missing with `$.fs.write`.
- Variable names must be upper case (`[A-Z][A-Z0-9_]+`) and be written as a literal; dynamic names (`process.env[name]`) and comment lines are not seen.
- Limits: it only adds, never removes or reorders, and writes empty values (it cannot know a sensible example). Edits on a remote machine are not scanned. It fails open: if anything throws, the edit stands and the example file is left as it was.
