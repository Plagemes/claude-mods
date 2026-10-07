# debug-catcher
> Warns when console.log, print, debugger or dbg! statements are left in code.

**Category:** Code Quality & Tests · **Version:** 1.0.0

## What it does
After Claude edits or writes a source file, debug-catcher looks at the lines that edit *added* and spots leftover debug output: `console.log`, `debugger`, Python `print(` and `breakpoint()`, Ruby `pp` and `binding.pry`, PHP `var_dump`, Rust `dbg!`, Go `fmt.Println` and Java `System.out.println`. Claude is asked, in a note only it reads, to remove them before finishing, and the status line keeps count of what is still outstanding.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install debug-catcher@claude-mods
```

## Usage
Nothing to run. When an edit adds a debug statement Claude sees a note such as `debug-catcher: this edit added 1 debug statement to src/app.ts: console.log("x")`, and the status line shows `⚠ 1 debug statement to remove`. The count drops when a later edit removes the line. To keep a statement on purpose, put `debug-catcher: ignore` on its line.

Tests, specs, `scripts/`, `fixtures/`, `examples/`, `bin/`, `*.config.*` files, comments and non-source files are never flagged. In a command-line program (a shebang, Python's `if __name__ == "__main__"`, `__main__.py`, Go's `package main`, Java's `main()`) printing is the program's output, so only `debugger`, `breakpoint()`, `dbg!` and the like are flagged there.

## Configuration
No configuration needed.

## How it works
- Hooks `tool.call` for `Edit` and `Write`. It compares the lines before and after (for `Write`, the file on disk against the new content), so a debug line the edit merely leaves in place is not flagged.
- Adds the note through the tool result's `context`, so the model reads it and you do not see extra transcript noise.
- Limits: detection is line-based pattern matching, not parsing, so a string that merely contains `console.log(` can be flagged; the status count resets when the session restarts or the mod reloads.
- With [mods-hub](https://github.com/plagemes/claude-mods/tree/main/mods/mods-hub) installed it publishes `lint.result` (`tool: debug-catcher`, the file, and how many findings) after each edit with findings (it has no toast of its own: the status line and the note to Claude are unchanged). Without the hub nothing changes; the mod stands alone.
