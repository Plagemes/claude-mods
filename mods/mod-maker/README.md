# mod-maker
> /new-mod scaffolds a new Claude Code mod with manifest, hooks, test and README, ready to fill in.

**Category:** Mod Ecosystem · **Version:** 1.0.0

## What it does
`/new-mod <name>` writes a complete, working mod: `plugin.json`, `hooks/hooks.json`, a hooks module, a test that passes, and a README in the claude-mods layout. You pick one of four starting points. Inside a collection (a repository with a `mods/` folder) the mod goes to `mods/<name>`, anywhere else to `./<name>`. mod-maker then runs `claude plugin validate` and `claude plugin test` on the new folder and reports the results, so you start from green.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install mod-maker@claude-mods
```

## Usage
```
/new-mod <name> [description] [--kind guard|status|pane|command]
```

| Kind | What the template does |
| --- | --- |
| `guard` | A `tool.call` hook that refuses risky Bash commands, such as force-pushes and `rm -rf /`. Its `.catch` makes it fail closed. |
| `status` | A status line that counts tool calls, with a `label` userConfig field. |
| `pane` | `/<name>` opens a pane listing the session's tool calls. The pane is drawn from `$.state`, with its `types/index.d.ts`. |
| `command` | `/<name> <text>` is answered from a `command.run` hook. |

- **Name:** kebab-case (`my-mod`). It must not exist yet. Pane and command mods register `/<name>`, so mod-maker refuses a name that another command already uses, built-in or plugin.
- **Description:** optional, and may be in quotes. Without one, the template's own description is used.
- **Output:**
  - the files written
  - the validate verdict, with errors when it fails
  - the test results
  - the next steps: what to fill in, `claude --plugin-dir <folder>` to try it, and the marketplace entry to add in a collection

Example: `/new-mod tidy-tabs "Closes panes I forgot" --kind pane`

## Configuration
| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `author` | string | `""` | Your name for the new mod's `plugin.json`. Empty uses `git config user.name`. |
| `defaultKind` | string | `command` | The template used without `--kind`: `guard`, `status`, `pane` or `command`. |
| `runTests` | boolean | `true` | Run `claude plugin test` on the new mod after validating it. |

## How it works
- Registers `/new-mod` at `session.start`.
- The templates are plain functions of the name, the description and the kind. Every kind is checked to pass `claude plugin validate`, `claude plugin test` and a strict `tsc`.
- The command:
  - checks the folder with `$.fs.stat` and `$.fs.exists`, and the command names with `$.command.list`
  - reads the author and the GitHub remote with `git`
  - writes each file with `$.fs.write`
  - runs the `claude` CLI through `$.process.run`
- Limits:
  - It doesn't add the mod to `.claude-plugin/marketplace.json`. The report reminds you to.
  - A write that fails part-way leaves the files already written, and the report lists them.
  - The README's category and "What it does" are left as TODOs for you to write.
